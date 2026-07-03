// spotify.js — all the Spotify talking-to lives here, out of main.js.
//
// What this does, in plain terms:
//   1. connect(): sends you to Spotify's login page in your browser, catches the
//      reply on a tiny local web server, and trades it for an access token.
//   2. Stores that token (and a "refresh" token) in our settings.json, so you
//      only ever connect once — it survives restarts like everything else.
//   3. nowPlaying(): asks Spotify what you're currently listening to.
//
// It uses "OAuth with PKCE", which is the login method meant for desktop apps:
// it needs only a public Client ID, never a secret password baked into the app.

const crypto = require("crypto");
const http = require("http");
const { shell } = require("electron");

// Public identifier for our Spotify developer app (safe to embed — it is NOT a
// secret). Created by Bailey at developer.spotify.com/dashboard.
const CLIENT_ID = "a81ee6bb8cbb448da8b80f3078e45516";

// Where Spotify sends the browser back to after you approve. This must match the
// Redirect URI registered in the Spotify dashboard EXACTLY. We listen on this
// loopback address with a throwaway local server only during the login moment.
const PORT = 8888;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;

// What we ask permission to do: read what's currently playing / the player state,
// and (for future play-pause-skip buttons) control playback.
const SCOPES = "user-read-currently-playing user-read-playback-state user-modify-playback-state";

// The persistent store (main.js hands us its read/write helpers via init()).
let store = null;
function init(s) {
  store = s;
}

// ---------------------------------------------------------------------------
// PKCE helpers (the cryptographic proof that ties our login request to us)
// ---------------------------------------------------------------------------

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomString(bytes) {
  return base64url(crypto.randomBytes(bytes));
}
function sha256(str) {
  return crypto.createHash("sha256").update(str).digest();
}

// ---------------------------------------------------------------------------
// Token storage (kept under the "spotify" key inside settings.json)
// ---------------------------------------------------------------------------

function saveTokens(tokens, name) {
  const s = store.read();
  const prev = s.spotify || {};
  s.spotify = {
    accessToken: tokens.access_token,
    // Refresh may or may not hand back a new refresh token; keep the old one if not.
    refreshToken: tokens.refresh_token || prev.refreshToken,
    // Expire a minute early to be safe against clock/network slop.
    expiresAt: Date.now() + (tokens.expires_in - 60) * 1000,
    name: name !== undefined ? name : prev.name || null,
  };
  store.write(s);
}

// Is an account connected? (Returns { connected, name } for the UI.)
function status() {
  const sp = store.read().spotify;
  return { connected: Boolean(sp && sp.refreshToken), name: (sp && sp.name) || null };
}

function disconnect() {
  const s = store.read();
  delete s.spotify;
  store.write(s);
}

// Return a currently-valid access token, transparently refreshing it if the old
// one has expired. Returns null if we're not connected (or the refresh fails).
async function getAccessToken() {
  const sp = store.read().spotify;
  if (!sp || !sp.refreshToken) return null;
  if (sp.accessToken && Date.now() < sp.expiresAt) return sp.accessToken;

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: sp.refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) return null;
  const tokens = await res.json();
  saveTokens(tokens); // keeps the existing display name
  return tokens.access_token;
}

// ---------------------------------------------------------------------------
// The one-time login (connect) flow
// ---------------------------------------------------------------------------

// Start a throwaway local web server, open Spotify's approval page in the user's
// browser, and resolve with the "authorization code" Spotify redirects back with.
function waitForCode(authUrl, expectedState) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      // Show a friendly page in the browser tab, then shut the server down.
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<html><body style='font-family:sans-serif;background:#1e1f22;color:#fff;" +
          "text-align:center;padding-top:80px'><h2>Discord Renewed</h2>" +
          `<p>${error ? "Spotify connection was cancelled." : "Spotify connected ✓"}</p>` +
          "<p style='opacity:.6'>You can close this tab and return to the app.</p></body></html>"
      );
      clearTimeout(timer);
      server.close();

      if (error) return reject(new Error(error));
      if (returnedState !== expectedState) return reject(new Error("state mismatch"));
      if (!code) return reject(new Error("no code returned"));
      resolve(code);
    });

    // If the user never finishes, don't leave the server (or promise) hanging.
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("timed out waiting for Spotify login"));
    }, 120000);

    server.on("error", (e) => {
      clearTimeout(timer);
      reject(e); // e.g. port 8888 already in use
    });

    server.listen(PORT, "127.0.0.1", () => shell.openExternal(authUrl));
  });
}

// Trade the authorization code for real tokens.
async function exchangeCode(code, verifier) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error("token exchange failed (" + res.status + ")");
  return res.json();
}

// Look up the connected account's display name (nice to show in the UI).
async function fetchDisplayName(token) {
  try {
    const res = await fetch("https://api.spotify.com/v1/me", {
      headers: { Authorization: "Bearer " + token },
    });
    if (!res.ok) return null;
    const me = await res.json();
    return me.display_name || me.id || null;
  } catch {
    return null;
  }
}

// The full connect handshake. Resolves to { connected, name }.
async function connect() {
  const verifier = randomString(64);
  const challenge = base64url(sha256(verifier));
  const state = randomString(16);

  const authUrl = new URL("https://accounts.spotify.com/authorize");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("state", state);

  const code = await waitForCode(authUrl.toString(), state);
  const tokens = await exchangeCode(code, verifier);
  const name = await fetchDisplayName(tokens.access_token);
  saveTokens(tokens, name);
  return { connected: true, name };
}

// ---------------------------------------------------------------------------
// Now playing
// ---------------------------------------------------------------------------

// Ask Spotify what's playing right now. Returns a small, UI-ready summary.
async function nowPlaying() {
  const token = await getAccessToken();
  if (!token) return { connected: false };

  const res = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
    headers: { Authorization: "Bearer " + token },
  });
  // 204 (nothing playing) / 202 (device waking) → connected but idle.
  if (res.status === 204 || res.status === 202) return { connected: true, playing: false };
  if (!res.ok) return { connected: true, playing: false, error: res.status };

  const data = await res.json();
  if (!data || !data.item) return { connected: true, playing: false };

  const album = data.item.album || {};
  return {
    connected: true,
    playing: Boolean(data.is_playing),
    track: data.item.name,
    artists: (data.item.artists || []).map((a) => a.name).join(", "),
    album: album.name || null,
    art: (album.images && album.images[0] && album.images[0].url) || null,
    progressMs: data.progress_ms || 0,
    durationMs: data.item.duration_ms || 0,
    trackUrl: (data.item.external_urls && data.item.external_urls.spotify) || null,
  };
}

module.exports = { init, connect, disconnect, status, nowPlaying };
