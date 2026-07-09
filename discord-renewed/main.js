// main.js — the Electron "main process".
// This file runs in Node.js (not the browser). Its job is to create the
// application window and load Discord into it. Later we'll use this same
// process to wire up our custom settings.

const { app, BrowserWindow, ipcMain, dialog, session, protocol, net, shell, screen, desktopCapturer, Tray, Menu, nativeImage, clipboard } = require("electron");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const { pathToFileURL } = require("url");
const spotify = require("./spotify");
const { RpcTransport } = require("./rpc");

const ICON_PATH = path.join(__dirname, "assets", "icon.ico");

// Windows groups notifications/taskbar entries by this ID. Without it, Electron
// apps show up as generic "Electron" — setting our own AppUserModelID is what
// makes native Windows notifications (and the taskbar icon) read as "Discord
// Renewed" instead. Must be set before window/notification creation.
app.setAppUserModelId("com.baileymontoya.discordrenewed");

// Register a private URL scheme we use to stream background VIDEOS straight
// from disk. Images are small enough to hand to the page as base64 data URLs,
// but a looping video would make an enormous data URL and load entirely into
// memory. Instead the page references the video as "dr-media://media/<file>"
// and the handler below streams the file (supporting seeking/looping) with
// almost no memory cost. Must be declared before the app is "ready".
protocol.registerSchemesAsPrivileged([
  {
    scheme: "dr-media",
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: true },
  },
]);

// Discord's web app refuses to load in "unsupported" browsers. Electron's
// default user-agent string says "Electron", which trips that check, so we
// pretend to be a normal, recent Chrome on Windows.
const CHROME_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function createWindow(startHidden) {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "Discord Renewed",
    icon: ICON_PATH,
    // Start hidden in the tray when the user asked to (startMinimized / launched
    // at login with --start-minimized). The tray brings it up on demand.
    show: !startHidden,
    // Frameless: drop the OS title bar + window buttons. We draw our own
    // Discord-style title bar in the page (see syncTitlebar in preload.js) so the
    // window doesn't look like a browser tab. Still resizable from the edges.
    frame: false,
    backgroundColor: "#1e1f22", // avoid a white flash before Discord paints
    webPreferences: {
      // Discord's page still gets NO direct Node access (nodeIntegration off,
      // context isolated). But we turn the preload's own sandbox OFF so the
      // preload can require Node modules — specifically Discord's REAL prebuilt
      // native addons (erlpack/voice/krisp/…), which it then exposes to the page
      // through contextBridge. This mirrors how the real desktop client works and
      // is required for the native-desktop-parity ("desktopSpoof") feature. The
      // page itself remains isolated from Node.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      // Run our script inside the Discord page (this is the safe bridge).
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // Forward the page's console output to our terminal so we can see what the
  // preload script reports (temporary debugging aid). Also forward warnings/
  // errors from Discord's OWN code (not just our "[DiscordRenewed]"-tagged
  // logs) — otherwise a real failure (e.g. a thrown error when Go Live fails)
  // is invisible to us since DevTools may not be reachable.
  win.webContents.on("console-message", (e, level, message) => {
    const lvl = typeof level === "number" ? level : e && e.level;
    const text = typeof message === "string" ? message : e && e.message;
    if (typeof text !== "string") return;
    if (text.includes("[DiscordRenewed]") || lvl >= 3) console.log(text);
  });

  // Our frameless window has no menu bar, and without an application Menu set,
  // Electron doesn't register the usual Ctrl+Shift+I/F12 devtools accelerators
  // — so wire them up ourselves directly on the window's key events.
  win.webContents.on("before-input-event", (_event, input) => {
    if (input.type !== "keyDown") return;
    const key = input.key.toLowerCase();
    if (key === "f12" || ((input.control || input.meta) && input.shift && key === "i")) {
      console.log("[DiscordRenewed] devtools shortcut caught, isDevToolsOpened=", win.webContents.isDevToolsOpened());
      if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
      else win.webContents.openDevTools({ mode: "detach" });
    }
  });

  // Surface renderer crashes/hangs in our terminal — otherwise a native-module
  // crash (e.g. from the desktop-spoof bridge) just shows a blank window with no
  // clue why. These are diagnostics; they don't change behavior.
  win.webContents.on("render-process-gone", (_e, details) => {
    console.log("[DiscordRenewed] RENDERER GONE:", JSON.stringify(details));
  });
  win.webContents.on("unresponsive", () => console.log("[DiscordRenewed] renderer unresponsive"));

  // --- Web-mode desktop integration --------------------------------------
  // We load Discord's WEB app, so a few things a real browser tab (or the native
  // desktop client) would handle need wiring up here, or image/link actions in
  // Discord's right-click menu silently do nothing.

  // "Open Link" / "Open Original" / any external link → open in the user's real
  // browser instead of a blank in-app popup. Discord's own popout windows
  // (voice/stream popouts on discord.com) are allowed to open in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (/(^|\.)discord\.com$/i.test(u.hostname) && u.pathname.startsWith("/popout")) {
        return { action: "allow" };
      }
    } catch {}
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  // Grant the browser permissions Discord's web app needs to behave like the
  // desktop client — notably clipboard write (so "Copy Image" works) and media
  // (mic/camera/screenshare). Electron denies several of these by default.
  const GRANTED_PERMISSIONS = new Set([
    "media", "mediaKeySystem", "clipboard-read", "clipboard-sanitized-write",
    "display-capture", "notifications", "fullscreen", "pointerLock", "idle-detection",
  ]);
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    const ok = GRANTED_PERMISSIONS.has(permission);
    if (!ok) console.log("[DiscordRenewed] permission DENIED:", permission);
    callback(ok);
  });
  // Some Chromium checks use the synchronous check handler instead.
  win.webContents.session.setPermissionCheckHandler((_wc, permission) => GRANTED_PERMISSIONS.has(permission));

  // "Save Image" / attachment downloads: let Electron prompt with a Save dialog
  // (default when no savePath is set). Logged so we can confirm it fires.
  win.webContents.session.on("will-download", (_event, item) => {
    console.log("[DiscordRenewed] will-download:", item.getFilename());
  });

  // Image actions in the right-click menu. Discord's WEB app never adds
  // Copy/Save/Open-image to its context menu (the native desktop client does),
  // so the preload injects those items into Discord's own menu and they call
  // back here to run with real Electron capabilities (see ipcMain
  // "dr:image-action": clipboard image write, download, external open).

  // Load the real Discord web app, using our Chrome-like user agent.
  win.loadURL("https://discord.com/app", { userAgent: CHROME_USER_AGENT });

  return win;
}

// Map file extensions to the MIME type a data URL needs.
const IMAGE_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

// Video formats we accept for a moving background. These stream via the
// dr-media:// scheme rather than being inlined as data URLs.
const VIDEO_MIME = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  mov: "video/quicktime",
};

// ---------------------------------------------------------------------------
// Persistent settings
// ---------------------------------------------------------------------------
// Everything the user customizes is saved to a JSON file in the app's data
// folder, so nothing resets when the app is closed. Background images are
// COPIED into that folder (so the original file can move/delete freely) and the
// settings file just records the copy's name + other preferences like dimming.

function settingsDir() {
  return app.getPath("userData");
}
function settingsFile() {
  return path.join(settingsDir(), "settings.json");
}

// Strip a leading UTF-8 BOM (some editors/tools, e.g. PowerShell's Set-Content
// -Encoding utf8, prepend one) — JSON.parse rejects it otherwise.
function parseSettings(text) {
  return JSON.parse(text.replace(/^﻿/, ""));
}

function readSettings() {
  try {
    return parseSettings(fs.readFileSync(settingsFile(), "utf8"));
  } catch {
    return {}; // no file yet, or unreadable → start fresh
  }
}

function writeSettings(settings) {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error("[DiscordRenewed] failed to save settings:", err);
  }
}

// Read the saved background (if any) back as something the page can display.
// Images come back as a base64 data URL; videos come back as a dr-media:// URL
// that the page's <video> element streams (with a cache-busting "?v=<mtime>" so
// replacing the file actually reloads it). Returns { type, url } or null.
function resourceForFile(fileName) {
  if (!fileName) return null;
  const p = path.join(settingsDir(), fileName);
  const ext = path.extname(p).slice(1).toLowerCase();
  try {
    if (VIDEO_MIME[ext]) {
      const mtime = Math.round(fs.statSync(p).mtimeMs);
      return { type: "video", url: `dr-media://media/${fileName}?v=${mtime}` };
    }
    const mime = IMAGE_MIME[ext] || "application/octet-stream";
    return { type: "image", url: `data:${mime};base64,${fs.readFileSync(p).toString("base64")}` };
  } catch {
    return null; // file went missing
  }
}

// The saved main background (image or video) as a { type, url } resource.
function backgroundResource(settings) {
  return resourceForFile(settings.backgroundFile);
}

// The preload is sandboxed (no fs), so it can't read our main-world scripts
// itself. We read them here and hand the source over synchronously at
// document-start, where the preload injects them into Discord's page context.
// Read fresh each launch so edits take effect on restart.
function readInjectedSource(file) {
  try {
    return fs.readFileSync(path.join(__dirname, file), "utf8");
  } catch (err) {
    console.error(`[DiscordRenewed] failed to read ${file}:`, err.message);
    return "";
  }
}

// webpack.js: the webpack patcher (main-world module access).
ipcMain.on("dr:get-patcher-source", (event) => {
  event.returnValue = readInjectedSource("webpack.js");
});

// nativebridge.js: the DiscordNative shim that makes Discord's web app believe
// it's the native desktop client (unlocks the full desktop feature set). Must be
// injected before Discord's own bundle runs.
//
// GATED OFF BY DEFAULT (settings key `desktopSpoof`). This is the in-progress
// native-desktop-parity work: once DiscordNative is present Discord loads its
// full desktop bundle, but its desktop connection path requires real native
// modules (erlpack for the gateway, etc.) that aren't bridged yet — so with the
// spoof ON the app currently can't finish connecting. Keeping it opt-in means
// the normal (web) client keeps working perfectly until the bridge lands.
ipcMain.on("dr:get-native-bridge-source", (event) => {
  const enabled = readSettings().desktopSpoof === true;
  event.returnValue = enabled ? readInjectedSource("nativebridge.js") : "";
});

// On startup the preload asks for the saved settings so it can re-apply them.
// Returns every saved setting plus the background as a { type, url } resource.
ipcMain.handle("dr:get-settings", () => {
  const s = readSettings();
  return { ...s, background: backgroundResource(s), tabImage: resourceForFile(s.tabImageFile) };
});

// Generic setter: persist any customization value by key.
ipcMain.handle("dr:set-setting", (_event, key, value) => {
  const s = readSettings();
  s[key] = value;
  writeSettings(s);
});

// Register/deregister the app with Windows startup, per the launchOnStartup /
// startMinimized settings. `openAsHidden` is macOS-only, so on Windows we pass a
// --start-minimized arg instead and honour it in createWindow. NB: in dev
// (electron .) process.execPath is the Electron binary, so real auto-launch only
// works once the app is packaged; the wiring + start-minimized are testable now.
function applyLoginItemSettings(s) {
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(s.launchOnStartup),
      path: process.execPath,
      args: s.startMinimized ? ["--start-minimized"] : [],
    });
  } catch (err) {
    console.log("[DiscordRenewed] setLoginItemSettings error:", err && err.message);
  }
}

// Keep the official Discord from ALSO auto-starting when our client is set to.
// We back its startup registration up into our settings first, so turning our
// auto-start off restores Discord's exactly. Reads are safe; the only value that
// ever goes on a command line (restore) is base64-encoded to dodge quote issues
// with Discord's quoted Update.exe command string.
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const DISCORD_RUN_NAMES = ["Discord", "DiscordCanary", "DiscordPTB", "DiscordDevelopment"];

function regQuery(name) {
  return new Promise((resolve) => {
    execFile("reg", ["query", RUN_KEY, "/v", name], { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const line = stdout.split(/\r?\n/).find((l) => l.includes("REG_SZ"));
      resolve(line ? line.slice(line.indexOf("REG_SZ") + 6).trim() : null);
    });
  });
}
function regDelete(name) {
  return new Promise((resolve) =>
    execFile("reg", ["delete", RUN_KEY, "/v", name, "/f"], { windowsHide: true }, () => resolve()));
}
function regAddSafe(name, value) {
  // Pass the value base64-encoded through PowerShell so embedded quotes/spaces in
  // Discord's command string can't be mangled by command-line parsing.
  const b64 = Buffer.from(value, "utf8").toString("base64");
  const ps = `$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'));` +
    `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${name}' -Value $v`;
  return new Promise((resolve) =>
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true }, () => resolve()));
}

async function disableDiscordAutostart() {
  const s = readSettings();
  const backup = s.discordAutostartBackup || {};
  for (const name of DISCORD_RUN_NAMES) {
    const val = await regQuery(name);
    if (val != null) {
      backup[name] = val; // remember the original so we can restore it later
      await regDelete(name);
      console.log("[DiscordRenewed] disabled Discord autostart:", name);
    }
  }
  s.discordAutostartBackup = backup;
  writeSettings(s);
}

async function restoreDiscordAutostart() {
  const s = readSettings();
  const backup = s.discordAutostartBackup;
  if (!backup) return; // we never disabled anything → leave Discord alone
  for (const name of Object.keys(backup)) {
    if ((await regQuery(name)) == null) { // don't clobber a value Discord re-added
      await regAddSafe(name, backup[name]);
      console.log("[DiscordRenewed] restored Discord autostart:", name);
    }
  }
  delete s.discordAutostartBackup;
  writeSettings(s);
}

// Discord's autostart should be OFF exactly while ours is ON. Enforced on boot and
// whenever the toggle changes. Only ever touches Discord's entry if WE disabled it.
async function syncDiscordAutostart(s) {
  if (process.platform !== "win32") return;
  try {
    if (s.launchOnStartup) await disableDiscordAutostart();
    else await restoreDiscordAutostart();
  } catch (err) {
    console.log("[DiscordRenewed] syncDiscordAutostart error:", err && err.message);
  }
}

ipcMain.on("dr:apply-login-settings", () => {
  const s = readSettings();
  applyLoginItemSettings(s);
  syncDiscordAutostart(s);
});

// Open the native file picker, COPY the chosen image or video into the app data
// folder, record it, and return it as a { type, url } resource the page can use
// (https pages can't load file:// URLs directly, so images become data URLs and
// videos are streamed through our dr-media:// scheme).
ipcMain.handle("dr:pick-background", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose a background image or video",
    properties: ["openFile"],
    filters: [
      { name: "Images & Videos", extensions: [...Object.keys(IMAGE_MIME), ...Object.keys(VIDEO_MIME)] },
      { name: "Images", extensions: Object.keys(IMAGE_MIME) },
      { name: "Videos", extensions: Object.keys(VIDEO_MIME) },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) return null;

  const src = result.filePaths[0];
  const ext = path.extname(src).slice(1).toLowerCase();
  const destName = `background.${ext}`;
  const dest = path.join(settingsDir(), destName);
  fs.copyFileSync(src, dest);

  const s = readSettings();
  // Clean up a previous background that had a different extension (e.g. switching
  // from an image to a video, or png to jpg).
  if (s.backgroundFile && s.backgroundFile !== destName) {
    try {
      fs.unlinkSync(path.join(settingsDir(), s.backgroundFile));
    } catch {}
  }
  s.backgroundFile = destName;
  s.backgroundType = VIDEO_MIME[ext] ? "video" : "image";
  writeSettings(s);

  return backgroundResource(s);
});

// Pick / copy an image to use as the Spotify mini-player's background. Stored the
// same way as the main background (copied into the app data folder) but under its
// own key so the two never collide.
ipcMain.handle("dr:pick-tab-image", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose a mini-player background image",
    properties: ["openFile"],
    filters: [{ name: "Images", extensions: Object.keys(IMAGE_MIME) }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const src = result.filePaths[0];
  const ext = path.extname(src).slice(1).toLowerCase();
  const destName = `tabimage.${ext}`;
  const dest = path.join(settingsDir(), destName);
  fs.copyFileSync(src, dest);

  const s = readSettings();
  if (s.tabImageFile && s.tabImageFile !== destName) {
    try {
      fs.unlinkSync(path.join(settingsDir(), s.tabImageFile));
    } catch {}
  }
  s.tabImageFile = destName;
  writeSettings(s);

  return resourceForFile(destName);
});

ipcMain.handle("dr:remove-tab-image", () => {
  const s = readSettings();
  if (s.tabImageFile) {
    try {
      fs.unlinkSync(path.join(settingsDir(), s.tabImageFile));
    } catch {}
    delete s.tabImageFile;
    writeSettings(s);
  }
});

// Report the real RAM the app is using = the summed PRIVATE working set across
// all its processes, which is what Task Manager's "Memory" column shows. We can't
// use app.getAppMetrics() for this: it only exposes total working set, which
// double-counts Chromium's shared memory and reads roughly 2x too high (~1GB vs
// the true ~470MB). Instead we query Windows' typeperf. It spawns a short-lived
// process, but the meter is only polled while the settings page is open, so the
// cost is negligible. Falls back to the (over-reporting) working-set sum on error.
ipcMain.handle("dr:get-metrics", () => {
  const processCount = app.getAppMetrics().length;
  return new Promise((resolve) => {
    execFile(
      "typeperf",
      ["\\Process(electron*)\\Working Set - Private", "-sc", "1"],
      { timeout: 6000, windowsHide: true },
      (err, stdout) => {
        let totalMB = null;
        if (!err && stdout) {
          // typeperf prints a header line then one CSV sample line; each column
          // after the timestamp is one electron process's private working set.
          const rows = stdout.split(/\r?\n/).filter((l) => l.startsWith('"'));
          const sample = rows[rows.length - 1];
          if (sample) {
            const cols = sample.split('","').map((s) => s.replace(/"/g, ""));
            const bytes = cols.slice(1).reduce((sum, v) => sum + (parseFloat(v) || 0), 0);
            if (bytes > 0) totalMB = Math.round(bytes / (1024 * 1024));
          }
        }
        if (totalMB !== null) return resolve({ totalMB, processCount, approximate: false });
        // Fallback: summed working set (over-reports, but better than nothing).
        const kb = app
          .getAppMetrics()
          .reduce((s, m) => s + ((m.memory && m.memory.workingSetSize) || 0), 0);
        resolve({ totalMB: Math.round(kb / 1024), processCount, approximate: true });
      }
    );
  });
});

// Free up memory on demand by clearing the on-disk/in-memory HTTP cache. This is
// safe (it doesn't touch the login session), so it won't log the user out.
ipcMain.handle("dr:clear-cache", async () => {
  await session.defaultSession.clearCache();
  return true;
});

// Forget the background image or video.
ipcMain.handle("dr:remove-background", () => {
  const s = readSettings();
  if (s.backgroundFile) {
    try {
      fs.unlinkSync(path.join(settingsDir(), s.backgroundFile));
    } catch {}
    delete s.backgroundFile;
    delete s.backgroundType;
    writeSettings(s);
  }
});

// ---------------------------------------------------------------------------
// Spotify integration (the OAuth flow + API live in spotify.js). We give that
// module our persistent-store helpers so it can save/read tokens like any other
// setting, then expose its actions to the settings page over IPC.
// ---------------------------------------------------------------------------
spotify.init({ read: readSettings, write: writeSettings });

ipcMain.handle("dr:spotify-status", () => spotify.status());

ipcMain.handle("dr:spotify-connect", async () => {
  try {
    return await spotify.connect();
  } catch (err) {
    console.error("[DiscordRenewed] Spotify connect failed:", err.message);
    return { connected: false, error: err.message };
  }
});

ipcMain.handle("dr:spotify-disconnect", () => {
  spotify.disconnect();
  return { connected: false };
});

ipcMain.handle("dr:spotify-now-playing", () => spotify.nowPlaying());

ipcMain.handle("dr:spotify-control", (_event, action) => spotify.control(action));

ipcMain.handle("dr:spotify-seek", (_event, positionMs) => spotify.seek(positionMs));

// Window controls for our custom (frameless) title bar.
ipcMain.on("dr:win-minimize", (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.on("dr:win-maximize", (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
});
ipcMain.on("dr:win-close", (e) => BrowserWindow.fromWebContents(e.sender)?.close());
ipcMain.on("dr:win-back", (e) => {
  const wc = BrowserWindow.fromWebContents(e.sender)?.webContents;
  if (wc?.navigationHistory?.canGoBack()) wc.navigationHistory.goBack();
});
ipcMain.on("dr:win-forward", (e) => {
  const wc = BrowserWindow.fromWebContents(e.sender)?.webContents;
  if (wc?.navigationHistory?.canGoForward()) wc.navigationHistory.goForward();
});
ipcMain.on("dr:open-external", (_e, url) => {
  if (typeof url === "string" && url.startsWith("https://")) shell.openExternal(url);
});

// Fetch a URL and decode it into a nativeImage (from the main process, so no CORS
// limits). Returns null on failure. Logs content-type so we can see webp cases.
async function fetchAsImage(url) {
  try {
    const res = await net.fetch(url);
    const img = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()));
    // Discord serves webp by default, which nativeImage can't decode → empty;
    // the caller retries with format=png. Only log the miss, not every copy.
    if (img.isEmpty()) console.log("[DiscordRenewed] copy: undecodable", res.headers.get("content-type"), url.slice(0, 80));
    return img;
  } catch (err) {
    console.log("[DiscordRenewed] copy fetch error:", err && err.message);
    return null;
  }
}

// Rewrite a Discord CDN image URL to force a decodable format (e.g. png).
function forceImageFormat(url, format) {
  try {
    const u = new URL(url);
    u.searchParams.set("format", format);
    return u.toString();
  } catch {
    return url;
  }
}

// Run an image action chosen from the items we inject into Discord's OWN context
// menu (preload). Discord's web app never wires these up, so we do it here with
// real Electron capabilities: clipboard image write, download, external open.
ipcMain.on("dr:image-action", async (e, data) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || !data || typeof data.srcURL !== "string") return;
  const wc = win.webContents;
  const { action, srcURL, x, y } = data;
  try {
    if (action === "copy") {
      // Fetch the bytes and put a real image on the clipboard. Discord serves
      // most images as webp, which nativeImage can't decode — so if the first
      // fetch yields an empty image, refetch forcing PNG from Discord's CDN.
      // Fall back to copyImageAt (hit-tests the page) for blob:/data: or failures.
      let img = null;
      if (/^https?:/.test(srcURL)) {
        img = await fetchAsImage(srcURL);
        if ((!img || img.isEmpty()) && /discordapp\.(net|com)/.test(srcURL)) {
          img = await fetchAsImage(forceImageFormat(srcURL, "png"));
        }
      }
      if (img && !img.isEmpty()) clipboard.writeImage(img);
      else wc.copyImageAt(Math.round(x), Math.round(y));
    } else if (action === "save") {
      wc.downloadURL(srcURL);
    } else if (action === "copy-link") {
      clipboard.writeText(srcURL);
    } else if (action === "open") {
      shell.openExternal(srcURL);
    }
  } catch (err) {
    console.log("[DiscordRenewed] image-action error:", action, err && err.message);
    if (action === "copy") { try { wc.copyImageAt(Math.round(x), Math.round(y)); } catch {} }
  }
});

// Window controls driven by Discord's OWN desktop title bar under the spoof
// (via DiscordNative.window.* → the dr-native-cmd bridge in preload). One
// channel dispatches all the actions Discord's title bar uses.
ipcMain.on("dr:win-ctl", (e, action) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  switch (action) {
    case "minimize": return w.minimize();
    case "maximize": return w.maximize();
    case "restore": return w.unmaximize();
    case "close": return w.close();
    case "focus": return w.focus();
  }
});

// Taskbar badge / dock count (DiscordNative.app.setBadgeCount). On Windows there's
// no numeric taskbar badge, but setting a non-zero count shows the overlay dot.
ipcMain.on("dr:set-badge", (_e, count) => {
  try { app.setBadgeCount(typeof count === "number" ? count : 0); } catch {}
});

// Web-mode taskbar unread badge + flash. The preload reads Discord's unread count
// from the window title and hands us a pre-drawn PNG badge. We show it as a
// Windows taskbar overlay icon, flash the taskbar on a NEW ping while unfocused,
// and reflect the count in the tray tooltip.
let lastUnreadCount = 0;
ipcMain.on("dr:set-unread", (e, data) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  const count = data && typeof data.count === "number" ? data.count : 0;
  try {
    if (process.platform === "win32" || process.platform === "linux") {
      if (count > 0 && data.badge) {
        win.setOverlayIcon(nativeImage.createFromDataURL(data.badge), `${count} unread`);
      } else {
        win.setOverlayIcon(null, "");
      }
    }
    if (count > lastUnreadCount && !win.isFocused()) win.flashFrame(true);
    if (count === 0) win.flashFrame(false);
    lastUnreadCount = count;
    if (trayRef) trayRef.setToolTip(count > 0 ? `Discord Renewed — ${count} unread` : "Discord Renewed");
  } catch (err) {
    console.log("[DiscordRenewed] set-unread error:", err && err.message);
  }
});

ipcMain.on("dr:set-zoom", (e, percent) => {
  // Discord restores its saved zoom via DiscordNative.window.setZoomFactor, and it
  // passes a PERCENTAGE (100 = 100%), whereas Electron's setZoomFactor wants a
  // ratio (1.0 = 100%) — passing 100 straight through zoomed the UI 100x. Convert.
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && typeof percent === "number" && percent > 0) {
    w.webContents.setZoomFactor(percent / 100);
  }
});

ipcMain.on("dr:relaunch", () => {
  app.relaunch();
  app.exit(0);
});

ipcMain.on("dr:capture-source-chosen", handleCaptureChoice);

// Reload Discord's page. Used by the Streaming tab's "Reload" button: the
// stream-quality patch only affects Go Live/quality calls made AFTER it's
// applied, so an already-open connection won't pick up a change mid-session —
// reloading (or restarting the stream) guarantees the new setting takes effect.
ipcMain.on("dr:reload", (e) => BrowserWindow.fromWebContents(e.sender)?.webContents.reload());

// The primary display's resolution, used to resolve the Streaming tab's
// "Auto (match my display)" option to an actual target height.
ipcMain.handle("dr:get-display-size", () => {
  const { width, height } = screen.getPrimaryDisplay().size;
  return { width, height };
});

// Discord sends a strict Content-Security-Policy that would block the styles
// and images we inject. Because we own this desktop shell, we strip that
// header from Discord's responses. Trade-off: this lowers the page's built-in
// protections — acceptable for a personal customization client, but worth
// remembering if this ever ships more widely.
function stripContentSecurityPolicy() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders || {};
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase().startsWith("content-security-policy")) {
        delete headers[key];
      }
    }
    callback({ responseHeaders: headers });
  });
}

// ---------------------------------------------------------------------------
// System tray. Closing the window (the X button) minimizes to tray instead of
// quitting, like the real Discord desktop app — the window just hides, the
// process keeps running so calls/notifications keep coming, and the tray icon
// brings it back. Controlled by the "minimizeToTray" setting (default on);
// the actual quit path (tray menu, Alt+F4-then-confirm, OS shutdown) sets
// isQuitting first so the close handler lets it through instead of hiding.
// ---------------------------------------------------------------------------

let isQuitting = false;
app.on("before-quit", () => {
  isQuitting = true;
});

let trayRef = null; // held so the unread handler can update the tray tooltip
function setupTray(win) {
  const tray = new Tray(nativeImage.createFromPath(ICON_PATH));
  trayRef = tray;
  tray.setToolTip("Discord Renewed");

  // Stop the taskbar flashing as soon as Bailey looks at the window.
  win.on("focus", () => { try { win.flashFrame(false); } catch {} });

  const showWindow = () => {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };

  const menu = Menu.buildFromTemplate([
    { label: "Open Discord Renewed", click: showWindow },
    { type: "separator" },
    { label: "Quit Discord Renewed", click: () => app.quit() },
  ]);

  // Left-click toggles the window; right-click shows the menu. (We don't call
  // tray.setContextMenu() — on Windows that also pops the menu on left-click,
  // which isn't what we want here.)
  tray.on("click", () => {
    if (win.isVisible() && !win.isMinimized()) win.hide();
    else showWindow();
  });
  tray.on("right-click", () => tray.popUpContextMenu(menu));
  tray.on("double-click", showWindow);

  win.on("close", (e) => {
    const s = readSettings();
    const minimizeToTray = s.minimizeToTray !== false; // default on
    if (!isQuitting && minimizeToTray) {
      e.preventDefault();
      win.hide();
    }
  });

  return tray;
}

// ---------------------------------------------------------------------------
// Rich Presence (Discord RPC). Only under the desktop spoof — the web app tries
// to run the RPC server via the native discord_rpc module (which we can't bridge
// cleanly), so we run our own IPC pipe server (rpc.js) and forward received
// activities to the renderer, which injects them into Discord via webpack. Games
// / apps that use discord-rpc / the Game SDK connect to the pipe and set presence.
// ---------------------------------------------------------------------------
let rpcTransport = null;
function setupRichPresence(win) {
  if (readSettings().desktopSpoof !== true) return; // spoof-only feature
  // The transport relays events to the renderer, where the DiscordNative shim's
  // discord_rpc facade drives Discord's own RPC code.
  rpcTransport = new RpcTransport((type, payload) => {
    if (type === "listening") console.log("[DiscordRenewed][rpc] RPC server listening on", payload.path);
    try { win.webContents.send("dr:rpc-evt", Object.assign({ type }, payload)); } catch {}
  });
  ipcMain.handle("dr:rpc-find-slot", () => rpcTransport.findFreeSlot());
  ipcMain.on("dr:rpc-listen", (_e, path) => rpcTransport.listen(path));
  ipcMain.on("dr:rpc-write", (_e, id, data) => rpcTransport.write(id, data));
  ipcMain.on("dr:rpc-end", (_e, id) => rpcTransport.end(id));
  ipcMain.on("dr:rpc-destroy", (_e, id) => rpcTransport.destroy(id));
}

// ---------------------------------------------------------------------------
// Screen/window share. We load Discord's real WEB app, which calls the
// standard navigator.mediaDevices.getDisplayMedia() for Go Live/screenshare —
// that works in a real browser tab because Chrome supplies its own OS picker,
// but Electron does NOT do that for an arbitrary loaded page. Without wiring
// this up, getDisplayMedia() has no source to resolve to and screenshare
// silently does nothing. setDisplayMediaRequestHandler is the documented fix:
// we fetch the available screens/windows via desktopCapturer, hand them to
// preload to show a picker, and resolve Discord's request with whatever the
// user picks (or {} to signal "cancelled" if they back out).
// ---------------------------------------------------------------------------

let pendingCaptureCallback = null;
let pendingCaptureSources = [];

function setupScreenShareHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    if (pendingCaptureCallback) {
      pendingCaptureCallback({}); // a stale request was still open — cancel it
      pendingCaptureCallback = null;
    }
    const win = BrowserWindow.getAllWindows()[0];
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 300, height: 170 },
      });
      pendingCaptureSources = sources;
      pendingCaptureCallback = callback;
      win?.webContents.send(
        "dr:show-source-picker",
        sources.map((s) => ({ id: s.id, name: s.name, isScreen: s.id.startsWith("screen:"), thumbnail: s.thumbnail.toDataURL() }))
      );
    } catch (err) {
      console.error("[DiscordRenewed] desktopCapturer.getSources failed:", err.message);
      callback({});
    }
  });
}

// The renderer's answer to the picker: { id, withAudio } for a choice, or
// { id: null } to cancel. "loopback" system-audio capture is confirmed stable
// on Windows (the Electron bug where it silently returns silence is macOS-only
// — issue #49607) so it's only offered for full-screen sources, matching
// Discord's own official picker (per-window audio loopback isn't reliable).
function handleCaptureChoice(_event, choice) {
  const cb = pendingCaptureCallback;
  pendingCaptureCallback = null;
  if (!cb) return;
  const source = choice && choice.id ? pendingCaptureSources.find((s) => s.id === choice.id) : null;
  pendingCaptureSources = [];
  if (!source) {
    cb({}); // cancelled, or the chosen id vanished (window closed mid-pick)
    return;
  }
  cb({ video: source, audio: choice.withAudio ? "loopback" : undefined });
}

// If the user turned on "Low memory mode", apply memory-saving Chromium
// switches. These MUST be set before the app is ready, so we read the saved
// settings synchronously here (wrapped in try/catch so a bad read just skips it).
// Measured effect (A/B, 2026-07-01): ~40% less committed RAM (~700MB → ~430MB),
// driven almost entirely by --disable-gpu (GPU-process buffers/caches are the
// hog). Trade-off: rendering falls back to the CPU, so video calls / screen
// sharing / heavy animation get less smooth — that's why it's an opt-in toggle.
try {
  // NOTE: this runs before app 'ready', when app.getPath("userData") resolves to
  // the wrong folder (the app name isn't applied yet) — so readSettings() would
  // read the wrong file and miss the flag. Build the path from "appData" (stable
  // pre-ready) + the app folder name instead. Keep in sync with package.json name.
  const earlyFile = path.join(app.getPath("appData"), "discord-renewed", "settings.json");
  const startup = parseSettings(fs.readFileSync(earlyFile, "utf8"));
  // Performance modes — measured on private working set (real physical RAM),
  // 2026-07-01, vs Discord's ~590MB:
  //   Smooth (default) → no flags, full GPU. ~490MB (~17% lighter). Buttery.
  //   Optimised        → --disable-gpu skips the GPU process (the only real
  //                      saver): ~380MB (~36% lighter) but video / screen share /
  //                      animation get clunkier. NB: disableHardwareAcceleration()
  //                      does NOT do this — it keeps a software-GL GPU process
  //                      alive still allocating memory, so use the switch. We add
  //                      low-end-device-mode too (trims caches). A "GPU-on but
  //                      lighter" middle mode was tested and dropped — it saved no
  //                      real RAM (can't cut it without killing the GPU process).
  let mode = startup.perfMode || (startup.lowMemoryMode ? "Optimised" : "Smooth");
  if (mode === "Smoothness") mode = "Smooth"; // migrate older names
  if (mode === "Light") mode = "Optimised";
  if (mode === "Optimised") {
    app.commandLine.appendSwitch("disable-gpu");
    app.commandLine.appendSwitch("disable-software-rasterizer");
    app.commandLine.appendSwitch("enable-low-end-device-mode");
  }
} catch {}

// Allow only ONE instance at a time. Running several at once makes them fight
// over the same cache folder (the "disk_cache: Access is denied" errors), which
// can corrupt the session and log you out. A second launch just focuses the
// existing window instead.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // Electron isn't ready to create windows until the "ready" event fires.
  app.whenReady().then(() => {
    // Serve background videos from the app data folder over dr-media://. We only
    // ever hand out our own filenames, but guard against path escapes anyway and
    // confine reads to the settings folder.
    protocol.handle("dr-media", (request) => {
      try {
        const name = path.basename(decodeURIComponent(new URL(request.url).pathname));
        const filePath = path.join(settingsDir(), name);
        if (!filePath.startsWith(settingsDir())) return new Response("Not found", { status: 404 });
        return net.fetch(pathToFileURL(filePath).toString());
      } catch {
        return new Response("Error", { status: 500 });
      }
    });

    stripContentSecurityPolicy();
    setupScreenShareHandler();
    const bootSettings = readSettings();
    applyLoginItemSettings(bootSettings); // keep the OS startup registration in sync
    syncDiscordAutostart(bootSettings); // keep official Discord suppressed while ours autostarts
    const startHidden = Boolean(bootSettings.startMinimized) || process.argv.includes("--start-minimized");
    const win = createWindow(startHidden);
    setupTray(win);
    setupRichPresence(win);

    // On macOS, apps usually stay open with no windows; re-create one when the
    // dock icon is clicked and there are none. (Harmless on Windows.)
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

// On Windows/Linux, quit the app once every window is closed. With the tray
// wired up, "close" hides instead of destroying the window (see setupTray),
// so this now only fires on a real quit (tray menu, or minimizeToTray off).
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
