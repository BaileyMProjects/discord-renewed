// main.js — the Electron "main process".
// This file runs in Node.js (not the browser). Its job is to create the
// application window and load Discord into it. Later we'll use this same
// process to wire up our custom settings.

const { app, BrowserWindow, ipcMain, dialog, session } = require("electron");
const path = require("path");
const fs = require("fs");

// Discord's web app refuses to load in "unsupported" browsers. Electron's
// default user-agent string says "Electron", which trips that check, so we
// pretend to be a normal, recent Chrome on Windows.
const CHROME_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "Discord Renewed",
    autoHideMenuBar: true, // hide the default File/Edit/View menu bar
    webPreferences: {
      // Security defaults — we keep Node out of the Discord page itself.
      // Our customization runs in the preload script below, NOT in Discord's
      // own code, so Discord never gets access to Node.
      nodeIntegration: false,
      contextIsolation: true,
      // Run our script inside the Discord page (this is the safe bridge).
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // Forward the page's console output to our terminal so we can see what the
  // preload script reports (temporary debugging aid).
  win.webContents.on("console-message", (e, level, message) => {
    const text = message !== undefined ? message : e && e.message;
    if (typeof text === "string" && text.includes("[DiscordRenewed]")) {
      console.log(text);
    }
  });

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

// Read the saved background image (if any) back as a data URL the page can use.
function backgroundDataUrl(settings) {
  if (!settings.backgroundFile) return null;
  try {
    const p = path.join(settingsDir(), settings.backgroundFile);
    const ext = path.extname(p).slice(1).toLowerCase();
    const mime = IMAGE_MIME[ext] || "application/octet-stream";
    return `data:${mime};base64,${fs.readFileSync(p).toString("base64")}`;
  } catch {
    return null; // file went missing
  }
}

// On startup the preload asks for the saved settings so it can re-apply them.
// Returns every saved setting plus the background image as a data URL.
ipcMain.handle("dr:get-settings", () => {
  const s = readSettings();
  return { ...s, image: backgroundDataUrl(s) };
});

// Generic setter: persist any customization value by key.
ipcMain.handle("dr:set-setting", (_event, key, value) => {
  const s = readSettings();
  s[key] = value;
  writeSettings(s);
});

// Open the native file picker, COPY the chosen image into the app data folder,
// record it, and return it as a data URL (https pages can't load file:// images).
ipcMain.handle("dr:pick-background", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose a background image",
    properties: ["openFile"],
    filters: [{ name: "Images", extensions: Object.keys(IMAGE_MIME) }],
  });

  if (result.canceled || result.filePaths.length === 0) return null;

  const src = result.filePaths[0];
  const ext = path.extname(src).slice(1).toLowerCase();
  const destName = `background.${ext}`;
  const dest = path.join(settingsDir(), destName);
  fs.copyFileSync(src, dest);

  const s = readSettings();
  // Clean up a previous background that had a different extension.
  if (s.backgroundFile && s.backgroundFile !== destName) {
    try {
      fs.unlinkSync(path.join(settingsDir(), s.backgroundFile));
    } catch {}
  }
  s.backgroundFile = destName;
  writeSettings(s);

  const mime = IMAGE_MIME[ext] || "application/octet-stream";
  return `data:${mime};base64,${fs.readFileSync(dest).toString("base64")}`;
});

// Report current memory use across all of the app's processes. Numbers come
// from Electron's per-process metrics (workingSetSize is in KB); we sum them and
// convert to MB, plus a per-process-type breakdown for the readout.
ipcMain.handle("dr:get-metrics", () => {
  const metrics = app.getAppMetrics();
  let totalKB = 0;
  const byType = {};
  for (const m of metrics) {
    const kb = (m.memory && m.memory.workingSetSize) || 0;
    totalKB += kb;
    const type = m.type || "other";
    byType[type] = (byType[type] || 0) + kb;
  }
  const toMB = (kb) => Math.round(kb / 1024);
  const breakdown = Object.fromEntries(
    Object.entries(byType).map(([type, kb]) => [type, toMB(kb)])
  );
  return { totalMB: toMB(totalKB), processCount: metrics.length, byType: breakdown };
});

// Free up memory on demand by clearing the on-disk/in-memory HTTP cache. This is
// safe (it doesn't touch the login session), so it won't log the user out.
ipcMain.handle("dr:clear-cache", async () => {
  await session.defaultSession.clearCache();
  return true;
});

// Forget the background image.
ipcMain.handle("dr:remove-background", () => {
  const s = readSettings();
  if (s.backgroundFile) {
    try {
      fs.unlinkSync(path.join(settingsDir(), s.backgroundFile));
    } catch {}
    delete s.backgroundFile;
    writeSettings(s);
  }
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
  // Performance tiers (measured 2026-07-01, committed RAM):
  //   Smooth (default) → no flags, full GPU acceleration (~620-700MB).
  //   Light            → --disable-gpu skips the GPU process, the big saver
  //                      (~450MB, ~35% less), at the cost of smoother video /
  //                      screen share / animation. disableHardwareAcceleration()
  //                      does NOT do this — it keeps a software-GL GPU process
  //                      alive still allocating memory, so we use the switch.
  //                      low-end-device-mode trims caches on top.
  const mode = startup.perfMode || (startup.lowMemoryMode ? "Light" : "Smooth");
  if (mode === "Light") {
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
    stripContentSecurityPolicy();
    createWindow();

    // On macOS, apps usually stay open with no windows; re-create one when the
    // dock icon is clicked and there are none. (Harmless on Windows.)
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

// On Windows/Linux, quit the app once every window is closed.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
