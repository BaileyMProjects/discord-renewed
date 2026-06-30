// main.js — the Electron "main process".
// This file runs in Node.js (not the browser). Its job is to create the
// application window and load Discord into it. Later we'll use this same
// process to wire up our custom settings.

const { app, BrowserWindow } = require("electron");

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
      // When we add customization we'll do it through a separate preload
      // script, not by exposing Node to Discord's code.
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Load the real Discord web app, using our Chrome-like user agent.
  win.loadURL("https://discord.com/app", { userAgent: CHROME_USER_AGENT });

  return win;
}

// Electron isn't ready to create windows until the "ready" event fires.
app.whenReady().then(() => {
  createWindow();

  // On macOS, apps usually stay open with no windows; re-create one when the
  // dock icon is clicked and there are none. (Harmless on Windows.)
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// On Windows/Linux, quit the app once every window is closed.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
