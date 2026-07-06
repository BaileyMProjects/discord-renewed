// native-modules.js — runs in the preload's Node context (preload has sandbox
// OFF). Loads Discord's REAL prebuilt native addons (.node) from the installed
// desktop client, so our spoofed client has genuine erlpack/voice/krisp/etc.
// instead of inert stubs. Confirmed ABI-compatible with our Electron 43.
//
// These load in the RENDERER process (the preload's process), so the functions
// they expose can be called from the page via contextBridge with no cross-PROCESS
// hop — important for erlpack, whose unpack() runs on every inbound gateway event.
//
// Everything here is best-effort and wrapped in try/catch: if Discord isn't
// installed, or a module fails to load, we return nothing for it and the shim
// falls back to its auto-stub (that feature just stays inert) rather than
// breaking the preload.

const fs = require("fs");
const path = require("path");

// Compare two dotted version strings ("1.0.9244") numerically.
function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Locate the installed desktop client's `modules` folder, picking the newest
// app-<version> build. Discord installs per-user under %LocalAppData%\Discord.
function findDiscordModulesDir() {
  const base = path.join(process.env.LOCALAPPDATA || "", "Discord");
  let apps;
  try {
    apps = fs.readdirSync(base).filter((d) => /^app-\d/.test(d));
  } catch {
    return null;
  }
  if (!apps.length) return null;
  apps.sort((x, y) => compareVersions(x.slice(4), y.slice(4)));
  const dir = path.join(base, apps[apps.length - 1], "modules");
  return fs.existsSync(dir) ? dir : null;
}

// Require one native module by its base name (e.g. "discord_erlpack"). The module
// lives at <modulesDir>/<name>-<n>/<name>/index.js (index.js requires the .node).
// Picks the highest -<n> revision if several are present.
function requireDiscordModule(modulesDir, name) {
  let variants;
  try {
    variants = fs.readdirSync(modulesDir).filter((d) => d.startsWith(name + "-"));
  } catch {
    return null;
  }
  if (!variants.length) return null;
  variants.sort(); // "-1", "-2"… lexical is fine for these small suffixes
  const inner = path.join(modulesDir, variants[variants.length - 1], name, "index.js");
  try {
    return require(inner);
  } catch (e) {
    console.log("[DiscordRenewed][native] failed to load", name, ":", e && e.message);
    return null;
  }
}

// Generic bridge: expose every function a native module exports as a plain
// pass-through wrapper (so `this` binds to the module, and return values —
// including Promises — cross the contextBridge unchanged). Used for the
// "info/utility" modules whose methods take plain data or callbacks (contextBridge
// proxies function arguments too). Modules needing special data coercion
// (erlpack/zstd Buffers, voice/krisp host wiring) are wrapped by hand instead.
function bridgeAll(mod, only) {
  const out = {};
  const keys = only ? only.filter((k) => k in mod) : Object.keys(mod);
  for (const key of keys) {
    const v = mod[key];
    out[key] = typeof v === "function" ? (...args) => mod[key](...args) : v;
  }
  return out;
}

// Load the native modules we currently bridge and wrap each into the exact shape
// Discord's code expects. Returns { dir, modules: { <name>: {…methods} } }.
// Start with erlpack (needed just to CONNECT — the desktop gateway uses ETF and
// has no JSON fallback once spoofed); more modules get added here in later phases.
function load() {
  const dir = findDiscordModulesDir();
  const modules = {};
  if (dir) {
    const erlpack = requireDiscordModule(dir, "discord_erlpack");
    if (erlpack && typeof erlpack.pack === "function" && typeof erlpack.unpack === "function") {
      modules.discord_erlpack = {
        pack: (data) => erlpack.pack(data),
        // unpack expects a Node Buffer; data arriving from the page over
        // contextBridge is a cloned ArrayBuffer/TypedArray, so coerce it.
        unpack: (data) => erlpack.unpack(Buffer.isBuffer(data) ? data : Buffer.from(data)),
      };
    }

    // NOTE: discord_zstd is intentionally NOT bridged. Feeding gateway frames to
    // the real native streaming decompressor across the contextBridge boundary
    // fais-fast-crashed the renderer (0xC0000409). Instead the shim reports zstd
    // as UNAVAILABLE (requireModule → null), so Discord falls back to zlib-stream
    // gateway compression — the same path the web app uses, pure-JS, no native
    // module needed. Real zstd can be revisited later (e.g. running it in-process
    // without the bridge hop) but it's not required for parity.

    // NOTE: discord_utils / discord_media are NOT bridged as real native modules
    // (yet) — doing so crashed the renderer (they expect host state/callbacks we
    // don't provide from this preload context). The DiscordNative shim supplies
    // safe main-world JS stubs for their boot-critical methods instead. Real
    // bridging of these comes in the Rich-Presence / Phase-4 work once each
    // module's host contract is understood.
  }
  return { dir, modules };
}

module.exports = { load };
