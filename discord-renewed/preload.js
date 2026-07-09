// preload.js — runs INSIDE the Discord page, before it loads.
//
// Our "safe bridge": it can touch the Discord page's DOM, but Discord's own code
// can't reach Node. Customization is reached through Discord's own settings: we
// add a "Discord Renewed" section to the settings sidebar, and our item opens a
// settings page whose controls are generated from a SCHEMA (below). Every
// control auto-saves to the persistent store and auto-applies. To add a new
// customization, add an entry to SCHEMA and (if needed) a line to buildCss().

const { contextBridge, ipcRenderer } = require("electron");

// Image right-click actions. Discord's WEB app (unlike the native desktop
// client) never adds "Copy Image"/"Save Image" to its context menu — it leaves
// image actions to the browser, which Electron doesn't supply. So we add those
// items INTO Discord's own context menu, cloned from a real menu item so they
// look 100% native, and wire them to Electron capabilities in main.js. We do NOT
// replace or intercept Discord's menu — we let it render, then inject.
//
// UI images that have their OWN Discord right-click menu (or none) — we must
// NOT hijack these: avatars (user menu), custom emoji, reactions, stickers, and
// guild/server icons (server menu). Only real posted/embedded content images
// should get our native menu. Matched against the class names of the image and
// a few ancestors; guild icons are matched by their data-list-item-id instead.
const UI_IMAGE_SKIP = /avatar|emoji|reaction|sticker|guildIcon|roleIcon|banner|status/i;
function isUiImage(el) {
  for (let a = el, i = 0; a && i < 6; a = a.parentElement, i++) {
    const cls = typeof a.className === "string" ? a.className : "";
    if (UI_IMAGE_SKIP.test(cls)) return true;
    const lid = a.getAttribute && a.getAttribute("data-list-item-id");
    if (lid && lid.indexOf("guildsnav") === 0) return true;
  }
  return false;
}
function imageUrlAtPoint(x, y) {
  let els;
  try { els = document.elementsFromPoint(x, y); } catch { return ""; }
  for (const el of els) {
    let src = "";
    if (el.tagName === "IMG") {
      src = el.currentSrc || el.src;
    } else {
      const bg = el.style && el.style.backgroundImage;
      if (bg && bg.indexOf("url(") !== -1) {
        const m = bg.match(/url\(["']?(.*?)["']?\)/);
        if (m) src = m[1];
      }
    }
    if (!src || !/^(https?:|blob:|data:)/.test(src)) continue;
    if (isUiImage(el)) return ""; // avatar/emoji/server icon → let Discord handle it
    return src;
  }
  return "";
}
// Icons (24×24 path data, drawn in Discord's currentColor) for our injected items.
const DR_IMG_ICONS = {
  copy: "M3 5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1a1 1 0 1 1-2 0V5H5v9h1a1 1 0 1 1 0 2H5a2 2 0 0 1-2-2V5Z M8 10a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9Zm2 0v9h9v-9h-9Z",
  save: "M12 3a1 1 0 0 1 1 1v9.59l2.3-2.3a1 1 0 0 1 1.4 1.42l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 1.4-1.42l2.3 2.3V4a1 1 0 0 1 1-1ZM5 19a1 1 0 0 1 1-1h12a1 1 0 0 1 0 2H6a1 1 0 0 1-1-1Z",
  link: "M16.32 14.72a1 1 0 0 1 0-1.41l2.51-2.51a3.98 3.98 0 0 0-5.62-5.63l-2.52 2.51a1 1 0 0 1-1.41-1.41l2.52-2.52a5.98 5.98 0 0 1 8.45 8.46l-2.52 2.51a1 1 0 0 1-1.41 0ZM7.68 9.29a1 1 0 0 1 0 1.41l-2.52 2.51a3.98 3.98 0 1 0 5.63 5.63l2.51-2.52a1 1 0 0 1 1.42 1.42l-2.52 2.51a5.98 5.98 0 0 1-8.45-8.45l2.51-2.51a1 1 0 0 1 1.42 0Z M14.7 10.7a1 1 0 0 0-1.4-1.4l-4 4a1 1 0 1 0 1.4 1.4l4-4Z",
  open: "M14 4a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-2 0V6.41l-7.3 7.3a1 1 0 0 1-1.4-1.42L17.59 5H15a1 1 0 0 1-1-1ZM5 7a2 2 0 0 1 2-2h4a1 1 0 0 1 0 2H7v10h10v-4a1 1 0 0 1 2 0v4a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7Z",
};

// Record the image (if any) under the cursor on every right-click, so the menu
// observer below knows whether to inject image items — and for which URL.
let drLastImage = null;
window.addEventListener("contextmenu", (e) => {
  const srcURL = imageUrlAtPoint(e.clientX, e.clientY);
  drLastImage = srcURL ? { srcURL, x: e.clientX, y: e.clientY } : null;
}, true);

// Build one injected menu item by cloning a real Discord item (so classes/layout
// match the current build), then relabelling + reskinning it.
function drBuildMenuItem(template, id, label, iconPath, onClick) {
  const item = template.cloneNode(true);
  item.id = id;
  item.setAttribute("data-dr-item", "1");
  item.removeAttribute("aria-describedby");
  item.setAttribute("aria-label", label);
  const labelEl = item.querySelector('[class*="label_"]') || item.firstElementChild;
  if (labelEl) labelEl.textContent = label;
  const svg = item.querySelector("svg");
  if (svg) svg.innerHTML = '<path fill="currentColor" d="' + iconPath + '"></path>';
  // Discord highlights the focused row via a `focused_<hash>` class from the same
  // CSS module as the item classes — derive that hash so hover matches natively.
  const hashMatch = (template.className.match(/\bitem_(\w+)/) || [])[1];
  const focusedClass = hashMatch ? "focused_" + hashMatch : null;
  if (focusedClass) {
    item.addEventListener("mouseenter", () => item.classList.add(focusedClass));
    item.addEventListener("mouseleave", () => item.classList.remove(focusedClass));
  }
  item.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    try { onClick(); } catch {}
    // Close Discord's menu the way it closes itself — Escape dismisses the layer.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true }));
  });
  return item;
}

// Inject "Copy Image / Save Image / Copy Image Link / Open Image in Browser" into
// a freshly-opened Discord message context menu when the right-click was on a
// content image.
function drInjectImageItems(menu) {
  if (!drLastImage || menu.getAttribute("data-dr-image-items")) return;
  // Only the message menu (image right-clicks land here); avatars/servers/etc.
  // open different menus with different item ids, which we leave untouched.
  const template = menu.querySelector('#message-copy-link') || menu.querySelector('[role="menuitem"][id^="message-"]');
  if (!template || template.id.indexOf("message-") !== 0) return;
  menu.setAttribute("data-dr-image-items", "1");

  const { srcURL, x, y } = drLastImage;
  const isHttp = /^https?:/.test(srcURL);
  const send = (action) => ipcRenderer.send("dr:image-action", { action, srcURL, x, y });
  const specs = [
    { id: "dr-copy-image", label: "Copy Image", icon: DR_IMG_ICONS.copy, on: () => send("copy") },
    { id: "dr-save-image", label: "Save Image As…", icon: DR_IMG_ICONS.save, on: () => send("save") },
  ];
  if (isHttp) {
    specs.push({ id: "dr-copy-image-link", label: "Copy Image Link", icon: DR_IMG_ICONS.link, on: () => send("copy-link") });
    specs.push({ id: "dr-open-image", label: "Open Image in Browser", icon: DR_IMG_ICONS.open, on: () => send("open") });
  }
  const nodes = specs.map((s) => drBuildMenuItem(template, s.id, s.label, s.icon, s.on));

  // Place them at the very bottom, under "Delete Message" — inserting near
  // "Add Reaction" lands them in the horizontal quick-react row's flex group,
  // which breaks their layout. The bottom group is a normal vertical list.
  const allItems = [...menu.querySelectorAll('[role="menuitem"][id^="message-"]')];
  const anchor = menu.querySelector('#message-delete') || allItems[allItems.length - 1] || template;
  let after = anchor;
  for (const n of nodes) { after.parentNode.insertBefore(n, after.nextSibling); after = n; }
}

// Context menus render into a portal appended late in the DOM, so watch the whole
// body subtree for a menu appearing and inject once. The check is cheap (a match
// + one scoped query per added node).
new MutationObserver((records) => {
  if (!drLastImage) return;
  for (const rec of records) {
    for (const node of rec.addedNodes) {
      if (node.nodeType !== 1) continue;
      const menu = node.matches && node.matches('[role="menu"]') ? node
        : (node.querySelector ? node.querySelector('[role="menu"]') : null);
      if (menu) { try { drInjectImageItems(menu); } catch {} }
    }
  }
}).observe(document, { childList: true, subtree: true });

// Taskbar unread badge + flash. Discord keeps its unread/mention count in the
// window title as a leading "(N)". We read it, draw a small red numbered badge on
// a canvas, and hand it to main to show as a Windows taskbar OVERLAY icon (and to
// flash the taskbar on a new ping). Drawing here (not in main) is because
// nativeImage can't rasterise text; main just decodes the PNG we produce.
let drLastUnread = -1;
function drDrawBadge(count) {
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#f23f42"; // Discord's mention red
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();
  // Match the real desktop client: the tiny taskbar overlay caps at "9+".
  const text = count > 9 ? "9+" : String(count);
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${text.length === 2 ? 18 : 22}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, size / 2, size / 2 + 1);
  return canvas.toDataURL("image/png");
}
function drUpdateUnread() {
  const count = parseInt((document.title.match(/^\((\d+)\)/) || [])[1] || "0", 10) || 0;
  if (count === drLastUnread) return; // only tell main on an actual change
  drLastUnread = count;
  ipcRenderer.send("dr:set-unread", { count, badge: count > 0 ? drDrawBadge(count) : null });
}
function drSetupUnreadBadge() {
  const titleEl = document.querySelector("title");
  if (!titleEl) { setTimeout(drSetupUnreadBadge, 500); return; } // <title> not in the DOM yet
  drUpdateUnread();
  new MutationObserver(drUpdateUnread).observe(titleEl, { childList: true, characterData: true, subtree: true });
}
drSetupUnreadBadge();

// Inject a MAIN-WORLD script into Discord's page context. Our preload lives in an
// isolated world and can't see (or define globals on) Discord's own window, so
// these have to run as page <script>s. We do it at the very top of preload
// (document-start) so they're in place BEFORE Discord's bundle loads. Discord's
// CSP is stripped in main.js, so the inline scripts run.
function injectSourceIntoMainWorld(code, label) {
  const run = () => {
    const root = document.documentElement || document.head || document.body;
    if (!root) return false; // <html> not created yet — try again when it is
    try {
      const script = document.createElement("script");
      script.textContent = code;
      root.appendChild(script);
      script.remove(); // its code has already executed; keep the DOM tidy
    } catch (e) {
      console.log(`[DiscordRenewed] ${label} inject error:`, e && e.message);
    }
    return true;
  };

  // At document-start the <html> element may not exist yet; if so, watch the
  // document and inject the moment it appears (still before Discord's bundle runs).
  if (!run()) {
    const obs = new MutationObserver(() => {
      if (run()) obs.disconnect();
    });
    obs.observe(document, { childList: true, subtree: true });
  }
}

// Fetch a main-world script's source from the main process (the preload can't
// read files reliably itself) and inject it.
function fetchAndInject(channel, label) {
  let code;
  try {
    code = ipcRenderer.sendSync(channel);
  } catch (e) {
    return console.log(`[DiscordRenewed] ${label} source failed:`, e && e.message);
  }
  if (!code) return console.log(`[DiscordRenewed] ${label} source empty`);
  injectSourceIntoMainWorld(code, label);
}

// Expose Discord's REAL native modules (loaded in this now-unsandboxed preload's
// Node context) to the page over contextBridge, so the DiscordNative shim's
// `nativeModules.requireModule(name)` can hand back genuine addons (erlpack, etc.)
// instead of inert stubs. Functions are proxied across the isolated↔main-world
// boundary; calls run here in the preload (same process → no IPC hop).
function setupNativeModuleBridge() {
  try {
    const native = require("./native-modules").load();
    const names = Object.keys(native.modules);
    contextBridge.exposeInMainWorld("__drNativeBridge", {
      availableModules: names,
      requireModule: (name) => native.modules[name] || null,
    });
    console.log(
      "[DiscordRenewed][native] bridged modules:",
      names.join(", ") || "(none)",
      "@",
      native.dir || "(Discord install not found)"
    );
  } catch (e) {
    console.log("[DiscordRenewed][native] bridge setup failed:", e && e.message);
  }
}

// The native-desktop spoof is opt-in (settings key `desktopSpoof`). main.js only
// returns the shim source when it's enabled, so an empty result = spoof OFF and
// we do nothing extra (normal web client). When ON, we ALSO bridge the real
// native modules, then inject the DiscordNative shim FIRST (so the global exists
// before anything else), and finally the webpack patcher.
const nativeBridgeSource = (() => {
  try {
    return ipcRenderer.sendSync("dr:get-native-bridge-source");
  } catch (e) {
    console.log("[DiscordRenewed] native bridge source failed:", e && e.message);
    return "";
  }
})();

// True when the native-desktop spoof is active this launch. main.js only returns
// the shim source when the `desktopSpoof` setting is on, so a non-empty source
// doubles as the flag. Used to suppress our hand-drawn title bar (Discord renders
// its own desktop one under the spoof) and to enable the native-command bridge.
const desktopSpoof = Boolean(nativeBridgeSource);

if (desktopSpoof) {
  setupNativeModuleBridge();
  injectSourceIntoMainWorld(nativeBridgeSource, "native bridge");
}
fetchAndInject("dr:get-patcher-source", "patcher");

// Bridge for commands the DiscordNative shim (main world) posts to us — it can't
// do IPC itself, so it postMessages {source:"dr-native-cmd", type, payload} and we
// relay to the main process. This is what makes Discord's OWN desktop title bar
// buttons (and other DiscordNative.window/app calls) actually work under the spoof.
window.addEventListener("message", (e) => {
  const d = e.data;
  if (!d || d.source !== "dr-native-cmd") return;
  if (d.type === "win") {
    // payload = "minimize" | "maximize" | "restore" | "close" | "focus"
    ipcRenderer.send("dr:win-ctl", d.payload);
  } else if (d.type === "setBadgeCount") {
    ipcRenderer.send("dr:set-badge", d.payload);
  } else if (d.type === "setZoomFactor") {
    ipcRenderer.send("dr:set-zoom", d.payload);
  } else if (d.type === "relaunch") {
    ipcRenderer.send("dr:relaunch");
  }
});

// Rich Presence transport relay. Our main-process IPC pipe server (rpc.js) is a
// RAW transport; Discord's own RPC code (driven through the DiscordNative shim's
// discord_rpc facade in the main world) does the protocol. We shuttle bytes and
// connection events between them. Only active under the desktop spoof.
if (desktopSpoof) {
  ipcRenderer.on("dr:rpc-evt", (_e, evt) => {
    window.postMessage(Object.assign({ source: "dr-rpc-evt" }, evt), "*");
  });
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.source !== "dr-rpc-cmd") return;
    if (d.cmd === "listen") ipcRenderer.send("dr:rpc-listen", d.path);
    else if (d.cmd === "write") ipcRenderer.send("dr:rpc-write", d.id, d.data);
    else if (d.cmd === "end") ipcRenderer.send("dr:rpc-end", d.id);
    else if (d.cmd === "destroy") ipcRenderer.send("dr:rpc-destroy", d.id);
    else if (d.cmd === "find-slot") {
      ipcRenderer.invoke("dr:rpc-find-slot").then((path) => {
        window.postMessage({ source: "dr-rpc-evt", type: "slot", reqId: d.reqId, path }, "*");
      });
    }
  });
}

// Bridge for messages coming back from the main-world patcher (webpack.js).
let webpackStatus = null; // last { ok, moduleCount, ... } reported by the patcher
let latestStreamStatus = null; // last { active, reason? } reported for the stream-quality unlock
let streamStatusListeners = []; // settings-page callbacks to repaint on a new status
window.addEventListener("message", (e) => {
  const d = e.data;
  if (!d || d.source !== "dr-wp") return;
  if (d.type === "status") {
    webpackStatus = d.status;
    console.log("[DiscordRenewed] webpack status:", JSON.stringify(d.status));
    // Discord's modules may not have been searchable yet when we first sent the
    // stream config (right after load); once webpack reports ready, resend it so
    // an already-enabled unlock actually gets applied.
    if (d.status && d.status.ok) sendStreamConfig();
  } else if (d.type === "stream-status") {
    latestStreamStatus = d.status;
    streamStatusListeners.forEach((fn) => {
      try {
        fn(d.status);
      } catch {}
    });
  }
});

// The persisted stream-unlock settings, resolved into the config the patcher
// understands. "auto" resolution resolves to the primary display's height
// (fetched once at startup) so the unlock targets your actual monitor.
let displaySize = null;
ipcRenderer.invoke("dr:get-display-size").then((d) => {
  displaySize = d;
});

function currentStreamConfig() {
  const resSetting = val("streamRes");
  const resolution =
    resSetting === "auto" || !resSetting ? (displaySize && displaySize.height) || 2160 : Number(resSetting) || 2160;
  return {
    enabled: Boolean(val("streamUnlock")),
    resolution,
    fps: Number(val("streamFps")) || 60,
    bitrateKbps: Number(val("streamBitrate")) || 8000,
  };
}

function sendStreamConfig() {
  window.postMessage({ source: "dr-wp-cmd", type: "config", config: currentStreamConfig() }, "*");
}

// Human-readable status line for the Streaming tab's readout.
function streamStatusText(status) {
  if (!val("streamUnlock")) return "Off.";
  if (!status) return "Waiting for Discord to finish loading…";
  if (status.active) return "Active — resolution / framerate / bitrate ceiling raised for new streams.";
  if (status.reason === "modules not found") {
    return "Inactive — Discord's client changed and the patch points weren't found. Nothing was modified.";
  }
  if (status.reason === "webpack not ready") return "Waiting for Discord to finish loading…";
  return "Off.";
}

const STYLE_ID = "dr-styles";
const SECTION_ID = "dr-settings-section";
const PAGE_ID = "dr-settings-page";
const VIDEO_ID = "dr-video-bg";

const log = (...args) => console.log("[DiscordRenewed]", ...args);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let settings = {}; // all saved customization values, keyed by schema id
let currentBackground = null; // { type: "image"|"video", url } or null
let currentTabImage = null; // { type: "image", url } or null — mini-player bg image

// ---------------------------------------------------------------------------
// Customization schema — add entries here to add options.
// ---------------------------------------------------------------------------

const SCHEMA = [
  { section: "Background", id: "background", type: "background", label: "Background image or video" },
  { section: "Background", id: "dim", type: "slider", label: "Background dimming", min: 0, max: 100, step: 1, def: 50, suffix: "%" },
  { section: "System", id: "memory", type: "readout", label: "Memory usage" },
  { section: "System", id: "clearCache", type: "button", label: "Free up memory now", action: "clear-cache" },
  { section: "System", id: "perfMode", type: "select", label: "Performance mode (applies after restart). Measured RAM vs Discord's ~590 MB — Smooth: full GPU, ~490 MB (~17% lighter), buttery. Optimised: GPU off, ~380 MB (~36% lighter) but video/screen-share/animation get clunkier.", choices: ["Smooth", "Optimised"], def: "Smooth" },
  { section: "System", id: "minimizeToTray", type: "toggle", label: "Keep running in the system tray when closed (like the real Discord app), instead of quitting", def: true },
  { section: "System", id: "launchOnStartup", type: "toggle", label: "Launch Discord Renewed automatically when Windows starts (and stop the official Discord from auto-starting, so you don't get both)", def: false },
  { section: "System", id: "startMinimized", type: "toggle", label: "Start hidden in the system tray (no window) — pair with launch on startup for a silent boot", def: false },
  { section: "Spotify", id: "spotify", type: "spotify", label: "Spotify" },
  { section: "Spotify", id: "dockedPlayer", type: "toggle", label: "Show a Spotify mini-player docked above your profile (pop it out with ⤢ to drag it anywhere)", def: false },
  { section: "Spotify", id: "tabColor", type: "color", label: "Mini-player background colour", def: "", defColor: "#1e1f22" },
  { section: "Spotify", id: "tabLineColor", type: "color", label: "Progress bar colour", def: "", defColor: "#1DB954" },
  { section: "Spotify", id: "tabImage", type: "tabImage", label: "Mini-player background image" },
  { section: "Spotify", id: "tabDim", type: "slider", label: "Mini-player image dimming", min: 0, max: 100, step: 1, def: 0, suffix: "%" },
  {
    section: "Streaming",
    id: "streamUnlock",
    type: "toggle",
    label:
      "⚠ Unlock source-quality screen share — raises Discord's built-in resolution/framerate/bitrate ceiling by " +
      "modifying its client. This is against Discord's Terms of Service and could get your account actioned. " +
      "Off by default; enable at your own risk.",
    def: false,
  },
  {
    section: "Streaming",
    id: "streamRes",
    type: "select",
    label: "Resolution",
    choices: ["auto", "720", "1080", "1440", "2160"],
    labels: { auto: "Auto (match my display)", "720": "720p", "1080": "1080p", "1440": "1440p", "2160": "2160p (4K)" },
    def: "auto",
  },
  {
    section: "Streaming",
    id: "streamFps",
    type: "select",
    label: "Frame rate",
    choices: ["15", "30", "60"],
    labels: { "15": "15 fps", "30": "30 fps", "60": "60 fps" },
    def: "60",
  },
  { section: "Streaming", id: "streamStatus", type: "streamStatus", label: "Patch status" },
  { section: "Streaming", id: "streamReload", type: "button", label: "Reload Discord (apply / fully remove changes)", action: "reload" },
];

// Sidebar tabs: each becomes its own item under our "Discord Renewed" settings
// section and shows only its listed sections' controls. To add a tab, add an
// entry here; to move a section between tabs, edit its `sections` list.
const TABS = [
  {
    id: "customize",
    label: "Customize",
    sections: ["Background", "System"],
    // "sliders" icon (Feather) — inherits the item's text colour via currentColor.
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>',
  },
  {
    id: "spotify",
    label: "Spotify",
    sections: ["Spotify"],
    // Spotify brand mark.
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.586 14.424c-.18.295-.563.387-.857.207-2.35-1.435-5.305-1.76-8.786-.963-.335.077-.67-.133-.746-.469-.077-.336.132-.67.469-.746 3.809-.871 7.076-.496 9.713 1.115.294.18.386.563.207.856zm1.223-2.722c-.226.367-.706.482-1.073.257-2.687-1.652-6.785-2.13-9.965-1.166-.413.127-.85-.106-.977-.518-.126-.413.106-.849.519-.976 3.632-1.102 8.147-.568 11.234 1.328.366.226.482.707.256 1.073zm.105-2.835C14.692 8.95 9.375 8.775 6.297 9.71c-.493.15-1.016-.128-1.166-.62-.149-.493.129-1.016.622-1.166 3.532-1.073 9.404-.865 13.115 1.338.445.264.59.837.327 1.282-.264.444-.838.59-1.282.327z"/></svg>',
  },
  {
    id: "streaming",
    label: "Streaming",
    sections: ["Streaming"],
    // "video" icon (Feather).
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>',
  },
];

function schemaFor(id) {
  return SCHEMA.find((c) => c.id === id);
}

// Current value for a setting, falling back to its schema default.
function val(id) {
  const v = settings[id];
  if (v !== undefined && v !== null) return v;
  const c = schemaFor(id);
  return c ? c.def : undefined;
}

function setSetting(id, value) {
  settings[id] = value;
  ipcRenderer.invoke("dr:set-setting", id, value);
  applyStyles();
  sendStreamConfig(); // cheap no-op unless a "stream*" setting changed
  // These need main to re-apply the OS auto-launch registration on change.
  if (id === "launchOnStartup" || id === "startMinimized") ipcRenderer.send("dr:apply-login-settings");
}

// ---------------------------------------------------------------------------
// Building & applying all CSS from the current settings
// ---------------------------------------------------------------------------

// The panel-clearing rules shared by both image and video wallpapers: they make
// Discord's opaque surfaces see-through so the wallpaper behind them shows, while
// content (avatars, banners, text) stays on top and visible.
function panelTransparencyCss() {
  return `
    /* Clear opaque region fills so the wallpaper shows behind the panels. */
    aside,
    [class*="guilds__"],
    [class*="container_"],
    [class*="privateChannels_"],
    [class*="chat_"],
    [class*="chatContent_"],
    [class*="scrollableContainer"],
    [class*="scroller_"],
    [class*="tabBody__"],
    [class*="nowPlayingColumn__"],
    [class*="itemCard"],
    [class*="member"],
    [class*="outerContainer_"],
    [class*="modalContent_"] {
      background-color: transparent !important;
    }

    /* Keep the Settings window panels normal; only the area around them shows
       the wallpaper. */
    [class*="outerContainer_"] [class*="sidebar_"] { background-color: #2b2d31 !important; }
    [class*="outerContainer_"] [class*="content_"] { background-color: #313338 !important; }

    /* User bar + message box: transparent with a subtle outline so they read
       as distinct bars. */
    [class*="panels_"],
    [class*="channelTextArea_"] {
      background-color: transparent !important;
      border: 1px solid rgba(255, 255, 255, 0.12) !important;
      border-radius: 8px !important;
    }
  `;
}

function backgroundCss() {
  if (!currentBackground) return ""; // no wallpaper → leave Discord fully normal

  if (currentBackground.type === "video") {
    // The moving wallpaper is a real <video> element (see syncVideoElement),
    // sitting behind the app. Here we just make the full-window base elements
    // transparent so it shows through; dimming is a separate overlay on the video.
    return `
      html, body, [class*="appMount__"], [class*="app__"], [class*="bg__"] {
        background: transparent !important;
      }
    ${panelTransparencyCss()}`;
  }

  // Static image: paint the dimmed wallpaper directly on the base elements.
  const dim = clamp(Number(val("dim")) || 0, 0, 100) / 100;
  const dimC = `rgba(0, 0, 0, ${dim})`;
  return `
    html, body, [class*="appMount__"], [class*="app__"], [class*="bg__"] {
      background-image: linear-gradient(${dimC}, ${dimC}), url("${currentBackground.url}") !important;
      background-size: cover !important;
      background-position: center !important;
      background-repeat: no-repeat !important;
    }
  ${panelTransparencyCss()}`;
}

// Create, update, or remove the <video> element used for a moving wallpaper.
// It lives behind Discord (fixed, z-index -1) with a dimming overlay on top.
function syncVideoElement() {
  let wrap = document.getElementById(VIDEO_ID);
  const isVideo = currentBackground && currentBackground.type === "video";

  if (!isVideo) {
    wrap?.remove();
    return;
  }

  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = VIDEO_ID;
    Object.assign(wrap.style, {
      position: "fixed",
      inset: "0",
      zIndex: "-1",
      overflow: "hidden",
      pointerEvents: "none",
    });

    const video = document.createElement("video");
    video.autoplay = true;
    video.loop = true;
    video.muted = true; // required for autoplay to be allowed
    video.playsInline = true;
    Object.assign(video.style, { width: "100%", height: "100%", objectFit: "cover" });

    const overlay = document.createElement("div");
    overlay.className = "dr-video-dim";
    Object.assign(overlay.style, { position: "absolute", inset: "0" });

    wrap.append(video, overlay);
    (document.body || document.documentElement).appendChild(wrap);
  }

  const video = wrap.querySelector("video");
  if (video.dataset.drSrc !== currentBackground.url) {
    video.dataset.drSrc = currentBackground.url;
    video.src = currentBackground.url;
    video.play?.().catch(() => {}); // ignore autoplay rejections
  }

  const dim = clamp(Number(val("dim")) || 0, 0, 100) / 100;
  wrap.querySelector(".dr-video-dim").style.background = `rgba(0, 0, 0, ${dim})`;
}

// ---------------------------------------------------------------------------
// Docked Spotify mini-player (a small, draggable now-playing card that floats
// on the main screen, so you can see/control music without opening settings).
// Toggled by the "dockedPlayer" setting; its position is persisted.
// ---------------------------------------------------------------------------

const DOCK_ID = "dr-docked-player"; // floating (popped-out) card
const DOCK_INLINE_ID = "dr-dock-inline"; // docked into the sidebar above the profile
const DOCK_RESERVE_ID = "dr-dock-reserve"; // <style> that pushes sidebar content below the docked player
let dockInterval = null;
let dockTicker = null; // ticks the progress bar/elapsed forward locally every ~0.5s between polls
let dockAnchor = null; // { progressMs, durationMs, playing, ts } — last synced position + when we got it
let dockBusy = false;
let dockScrubbing = false; // true while dragging the progress bar to seek
let dockInlineReserve = 0; // px of sidebar top space currently reserved for the docked player

// Crisp media-control icons (SVG). Filled transport glyphs render more cleanly
// and consistently than the ⏮ ▶ ⏭ text characters, and ⤢/⤓ text was ambiguous
// (looked like a download arrow), so pop-out/dock get proper expand/collapse icons.
const ICONS = {
  prev: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zM20 6v12L9.5 12z"/></svg>',
  next: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zM4 6l10.5 6L4 18z"/></svg>',
  play: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>',
  popout: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
  dock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
};

// A round control button, shared by the settings widget and the dock. `icon` may
// be an SVG string (rendered as-is) or a text glyph. `opts.primary` gives the
// filled-white "main action" look (used for play/pause), matching Spotify.
function circleButton(icon, title, size = 36, opts = {}) {
  const b = document.createElement("button");
  const isSvg = typeof icon === "string" && icon.trim().startsWith("<");
  if (isSvg) b.innerHTML = icon;
  else b.textContent = icon;
  b.title = title;

  const primary = Boolean(opts.primary);
  const rest = primary ? "#fff" : "rgba(255,255,255,0.08)";
  const hover = primary ? "#f2f2f2" : "rgba(255,255,255,0.2)";
  Object.assign(b.style, {
    width: `${size}px`,
    height: `${size}px`,
    borderRadius: "50%",
    border: "none",
    background: rest,
    color: primary ? "#000" : "#fff",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0",
    lineHeight: "1",
    flex: "0 0 auto",
    transition: "background 0.12s ease, transform 0.12s ease",
    ...(isSvg ? {} : { fontSize: `${Math.round(size * 0.4)}px` }),
  });
  b.addEventListener("mouseenter", () => {
    b.style.background = hover;
    b.style.transform = "scale(1.08)";
  });
  b.addEventListener("mouseleave", () => {
    b.style.background = rest;
    b.style.transform = "none";
  });
  return b;
}

const spotifyControl = (action) => ipcRenderer.invoke("dr:spotify-control", action);
const spotifySeek = (ms) => ipcRenderer.invoke("dr:spotify-seek", ms);

// The mini-player's background: the user's chosen colour if set, else the
// built-in look (a subtle fill inline, a solid frosted card when floating).
function dockBgFor(inline) {
  const color = val("tabColor");
  if (currentTabImage && currentTabImage.url) {
    // Dimming overlay on top, image, then the chosen colour (or a solid fallback)
    // behind it for any gaps.
    const behind = color || (inline ? "#000" : "#18191c");
    const dim = clamp(Number(val("tabDim")) || 0, 0, 100) / 100;
    const dimC = `rgba(0,0,0,${dim})`;
    return `linear-gradient(${dimC}, ${dimC}), url("${currentTabImage.url}") center/cover no-repeat, ${behind}`;
  }
  if (color) return color;
  return inline ? "rgba(0,0,0,0.22)" : "rgba(24,25,28,0.92)";
}

// The progress-bar fill colour: the user's choice if set, else Spotify green.
function dockLineColor() {
  return val("tabLineColor") || "#1DB954";
}

// Re-apply the chosen background + line colour to whichever mini-player is on
// screen, so colour changes preview live without rebuilding the element.
function applyDockAppearance() {
  const line = dockLineColor();
  [document.getElementById(DOCK_ID), document.getElementById(DOCK_INLINE_ID)].forEach((el) => {
    if (!el) return;
    el.style.background = dockBgFor(el.id === DOCK_INLINE_ID);
    if (el._refs && el._refs.barFill) el._refs.barFill.style.background = line;
  });
}

// Let the dock be dragged around by its body (but not when a button is clicked),
// clamped to the window, saving its final position so it stays put next launch.
function makeDockDraggable(dock) {
  let startX = 0, startY = 0, origLeft = 0, origTop = 0, dragging = false;

  dock.addEventListener("mousedown", (e) => {
    // Let control clicks and progress-bar seeking through without dragging the card.
    if (e.target.closest("button") || e.target.closest("[data-dr-seek]")) return;
    dragging = true;
    dock.style.cursor = "grabbing";
    startX = e.clientX;
    startY = e.clientY;
    const rect = dock.getBoundingClientRect();
    origLeft = rect.left;
    origTop = rect.top;
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const nl = clamp(origLeft + (e.clientX - startX), 0, window.innerWidth - dock.offsetWidth);
    const nt = clamp(origTop + (e.clientY - startY), 0, window.innerHeight - dock.offsetHeight);
    dock.style.left = `${nl}px`;
    dock.style.top = `${nt}px`;
  });

  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    dock.style.cursor = "grab";
    const rect = dock.getBoundingClientRect();
    settings.dockLeft = Math.round(rect.left);
    settings.dockTop = Math.round(rect.top);
    ipcRenderer.invoke("dr:set-setting", "dockLeft", settings.dockLeft);
    ipcRenderer.invoke("dr:set-setting", "dockTop", settings.dockTop);
  });
}

// Build a mini-player element. `inline` = true makes the compact version that
// sits inside Discord's sidebar above the profile card; false makes the floating
// draggable card. Both share the same content refs so updateDock() drives either.
function buildDock(inline) {
  const dock = document.createElement("div");
  dock.id = inline ? DOCK_INLINE_ID : DOCK_ID;

  if (inline) {
    // A fixed overlay pinned at the top-left (its previous spot), so it looks
    // docked there WITHOUT taking layout space — Discord's server list and
    // channels fill the whole height normally instead of leaving a blank row.
    Object.assign(dock.style, {
      boxSizing: "border-box",
      position: "fixed",
      left: "78px", // clear the guild rail
      top: `${TITLEBAR_H + 4}px`, // just below our title bar
      width: "296px",
      zIndex: "1000",
      padding: "8px 10px",
      background: dockBgFor(true),
      border: "1px solid rgba(255,255,255,0.08)",
      borderRadius: "8px",
      color: "var(--text-normal, #dbdee1)",
      display: "none", // shown by updateDock when there's a track
      boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
    });
  } else {
    Object.assign(dock.style, {
      position: "fixed",
      left: `${settings.dockLeft ?? 16}px`,
      top: `${settings.dockTop ?? Math.max(16, window.innerHeight - 170)}px`,
      width: "300px",
      zIndex: "9999",
      background: dockBgFor(false),
      border: "1px solid rgba(255,255,255,0.1)",
      borderRadius: "10px",
      padding: "12px",
      boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
      color: "#fff",
      display: "none",
      cursor: "grab",
      userSelect: "none",
      backdropFilter: "blur(4px)",
    });
  }

  const artSize = inline ? 34 : 48;
  const btnSize = inline ? 26 : 30;

  const row = document.createElement("div");
  Object.assign(row.style, { display: "flex", gap: "10px", alignItems: "center" });

  // A soft dark shadow keeps text/art legible over any background image the user
  // picks for the mini-player, without dimming their whole image.
  const textShadow = "0 1px 3px rgba(0,0,0,0.9)";

  const art = document.createElement("img");
  Object.assign(art.style, {
    width: `${artSize}px`, height: `${artSize}px`, borderRadius: "6px", flex: "0 0 auto",
    boxShadow: "0 2px 6px rgba(0,0,0,0.45)",
  });

  const info = document.createElement("div");
  Object.assign(info.style, { minWidth: "0", flex: "1 1 auto" });
  const title = document.createElement("div");
  Object.assign(title.style, {
    fontWeight: "600", fontSize: inline ? "12px" : "13px", whiteSpace: "nowrap",
    overflow: "hidden", textOverflow: "ellipsis", textShadow,
  });
  const artist = document.createElement("div");
  Object.assign(artist.style, {
    fontSize: inline ? "11px" : "12px", opacity: "0.75", whiteSpace: "nowrap",
    overflow: "hidden", textOverflow: "ellipsis", textShadow,
  });
  info.append(title, artist);
  row.append(art, info);

  // Song progress: a thin green bar with elapsed / total times under it. The bar
  // sits inside a taller transparent hit area (data-dr-seek) so it's easy to grab
  // and so dragging it seeks the song instead of dragging the whole card.
  const barTrack = document.createElement("div");
  Object.assign(barTrack.style, {
    height: "4px", borderRadius: "2px",
    background: "rgba(255,255,255,0.15)", overflow: "hidden",
  });
  const barFill = document.createElement("div");
  Object.assign(barFill.style, { height: "100%", width: "0%", background: dockLineColor() });
  barTrack.appendChild(barFill);

  const seekArea = document.createElement("div");
  seekArea.dataset.drSeek = "1";
  Object.assign(seekArea.style, {
    marginTop: inline ? "8px" : "10px", padding: "6px 0", cursor: "pointer",
  });
  seekArea.appendChild(barTrack);

  const times = document.createElement("div");
  Object.assign(times.style, {
    display: "flex", justifyContent: "space-between",
    fontSize: "11px", opacity: "0.75", marginTop: "3px",
    textShadow: "0 1px 2px rgba(0,0,0,0.9)",
  });
  const elapsed = document.createElement("span");
  const duration = document.createElement("span");
  times.append(elapsed, duration);

  // Click or drag the bar to seek. We preview the fill/elapsed live as you drag,
  // then send one seek on release; dockScrubbing tells updateDock not to fight it.
  const fracFromEvent = (e) => {
    const rect = barTrack.getBoundingClientRect();
    return clamp((e.clientX - rect.left) / rect.width, 0, 1);
  };
  const previewFrac = (f) => {
    barFill.style.width = `${f * 100}%`;
    elapsed.textContent = msToClock(f * (dock._durationMs || 0));
  };
  let scrubFrac = null;
  seekArea.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    dockScrubbing = true;
    seekArea.setPointerCapture(e.pointerId);
    scrubFrac = fracFromEvent(e);
    previewFrac(scrubFrac);
  });
  seekArea.addEventListener("pointermove", (e) => {
    if (!dockScrubbing) return;
    scrubFrac = fracFromEvent(e);
    previewFrac(scrubFrac);
  });
  const endScrub = () => {
    if (!dockScrubbing) return;
    dockScrubbing = false;
    const dur = dock._durationMs || 0;
    if (dur && scrubFrac != null) {
      spotifySeek(Math.round(scrubFrac * dur)).then(() => setTimeout(pollDock, 350));
    }
    scrubFrac = null;
  };
  seekArea.addEventListener("pointerup", endScrub);
  seekArea.addEventListener("pointercancel", endScrub);

  const ctl = document.createElement("div");
  Object.assign(ctl.style, {
    display: "flex", gap: "8px", alignItems: "center",
    justifyContent: inline ? "flex-start" : "center", marginTop: inline ? "8px" : "10px",
  });
  const prev = circleButton(ICONS.prev, "Previous", btnSize);
  const play = circleButton(ICONS.play, "Play / Pause", btnSize + 4, { primary: true });
  const next = circleButton(ICONS.next, "Next", btnSize);

  // Mode button: docked → pop out into a floating card; floating → dock back.
  const modeBtn = inline
    ? circleButton(ICONS.popout, "Pop out (drag anywhere)", btnSize)
    : circleButton(ICONS.dock, "Dock to sidebar", btnSize);
  modeBtn.style.marginLeft = "auto"; // push to the far end of the row
  modeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setSetting("dockMode", inline ? "floating" : "docked");
  });

  ctl.append(prev, play, next, modeBtn);

  const afterAction = () => setTimeout(pollDock, 350);
  prev.addEventListener("click", () => { spotifyControl("previous").then(afterAction); });
  next.addEventListener("click", () => { spotifyControl("next").then(afterAction); });
  play.addEventListener("click", () => {
    spotifyControl(play.dataset.playing === "1" ? "pause" : "play").then(afterAction);
  });

  dock.append(row, seekArea, times, ctl);
  dock._refs = { art, title, artist, play, barFill, elapsed, duration };
  if (!inline) makeDockDraggable(dock);
  return dock;
}

// Paint a mini-player from a nowPlaying() result; hide it when there's no track.
function updateDock(dock, data) {
  const r = dock._refs;
  const inline = dock.id === DOCK_INLINE_ID;
  if (!data || !data.connected || !data.track) {
    dock.style.display = "none";
    dockAnchor = null;
    if (inline) updateInlineReserve();
    return;
  }
  dock.style.display = "block";
  if (data.art) {
    r.art.src = data.art;
    r.art.style.display = "block";
  } else {
    r.art.style.display = "none";
  }
  r.title.textContent = data.track;
  r.artist.textContent = data.artists || "";
  dock._durationMs = data.durationMs || 0;
  r.duration.textContent = msToClock(data.durationMs);
  const playing = Boolean(data.playing);
  // Anchor the local ticker to this fresh position so it can advance the bar/time
  // every ~0.5s between the 3s polls (Spotify's own time only arrives each poll).
  dockAnchor = { progressMs: data.progressMs || 0, durationMs: data.durationMs || 0, playing, ts: Date.now() };
  // Don't overwrite the bar/elapsed while the user is dragging it to seek.
  if (!dockScrubbing) {
    const pct = data.durationMs ? Math.min(100, (data.progressMs / data.durationMs) * 100) : 0;
    r.barFill.style.width = `${pct}%`;
    r.elapsed.textContent = msToClock(data.progressMs);
  }
  r.play.dataset.playing = playing ? "1" : "0";
  r.play.innerHTML = playing ? ICONS.pause : ICONS.play;

  // Now that the card is populated (final height known), reserve its footprint
  // so the sidebar's own content sits below it instead of behind it.
  if (inline) updateInlineReserve();
}

// The single active mini-player element, whichever mode we're in.
function currentDock() {
  return document.getElementById(DOCK_ID) || document.getElementById(DOCK_INLINE_ID);
}

function pollDock() {
  const dock = currentDock();
  if (!dock || dockBusy) return;
  dockBusy = true;
  ipcRenderer
    .invoke("dr:spotify-now-playing")
    .then((data) => updateDock(dock, data))
    .finally(() => (dockBusy = false));
}

// Advance the progress bar + elapsed time locally between polls, so a playing
// track ticks smoothly every half-second instead of jumping every 3s poll. Pure
// local rendering — no extra Spotify API calls. Skips while paused or scrubbing.
function tickDock() {
  if (!dockAnchor || !dockAnchor.playing || dockScrubbing) return;
  const dock = currentDock();
  if (!dock || dock.style.display === "none") return;
  const r = dock._refs;
  const dur = dockAnchor.durationMs;
  const elapsedMs = Math.min(dur || Infinity, dockAnchor.progressMs + (Date.now() - dockAnchor.ts));
  r.elapsed.textContent = msToClock(elapsedMs);
  r.barFill.style.width = `${dur ? Math.min(100, (elapsedMs / dur) * 100) : 0}%`;
}

// Add the docked (inline) mini-player. It's a FIXED overlay pinned above the
// user panel, so it reads as docked there but never disturbs Discord's layout.
function injectInlineDock() {
  if (document.getElementById(DOCK_INLINE_ID)) return;
  document.documentElement.appendChild(buildDock(true));
}

// The left column that holds the search box + nav + DM/channel list. In both the
// Home/DMs view and inside a server it's a <nav> wrapped by `sidebarList__`
// (the inner nav's own class differs per view — privateChannels_ vs a generic
// container__ — so we anchor on the stable wrapper). Padding its top pushes the
// column's own content down below the docked player.
const SIDEBAR_SELECTOR = '[class*="sidebarList"] > nav';

// Reserve vertical space at the top of the left sidebar column so the docked
// player floats there WITHOUT covering the search box / nav — Discord's content
// flows below it instead. The rule lives in its own <style> so Discord's frequent
// re-renders don't wipe it (inline styles on Discord's own nodes get replaced).
function setSidebarReserve(px) {
  if (px === dockInlineReserve) return;
  dockInlineReserve = px;
  let el = document.getElementById(DOCK_RESERVE_ID);
  if (!px) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("style");
    el.id = DOCK_RESERVE_ID;
    document.head.appendChild(el);
  }
  el.textContent =
    `${SIDEBAR_SELECTOR} { padding-top: ${px}px !important; box-sizing: border-box !important; }`;
}

// Reserve exactly the gap between the docked player's bottom edge and the top of
// the sidebar column, so the column's content begins just below the player. When
// the player is hidden (no track) or not docked, clear the reservation.
function updateInlineReserve() {
  const dock = document.getElementById(DOCK_INLINE_ID);
  const visible = dock && dock.style.display !== "none";
  const col = document.querySelector(SIDEBAR_SELECTOR);
  if (!visible || !col) {
    setSidebarReserve(0);
    return;
  }
  // Padding is inside the column, so its own top edge doesn't move — measuring it
  // after a previous reserve stays stable (no feedback loop).
  const colTop = col.getBoundingClientRect().top;
  const dockBottom = dock.getBoundingClientRect().bottom;
  setSidebarReserve(Math.max(0, Math.round(dockBottom + 8 - colTop)));
}

// Create/remove the mini-player (in whichever mode) and its polling timer to
// match the settings. Called from applyStyles, so it re-syncs on any change.
function syncDockedPlayer() {
  const enabled = Boolean(val("dockedPlayer"));

  if (!enabled) {
    document.getElementById(DOCK_ID)?.remove();
    document.getElementById(DOCK_INLINE_ID)?.remove();
    setSidebarReserve(0);
    if (dockInterval) {
      clearInterval(dockInterval);
      dockInterval = null;
    }
    if (dockTicker) {
      clearInterval(dockTicker);
      dockTicker = null;
    }
    dockAnchor = null;
    return;
  }

  if ((val("dockMode") || "docked") === "floating") {
    document.getElementById(DOCK_INLINE_ID)?.remove();
    setSidebarReserve(0); // floating card doesn't displace sidebar content
    if (!document.getElementById(DOCK_ID)) {
      (document.body || document.documentElement).appendChild(buildDock(false));
    }
  } else {
    document.getElementById(DOCK_ID)?.remove();
    injectInlineDock();
  }

  if (!dockInterval) dockInterval = setInterval(pollDock, 3000);
  if (!dockTicker) dockTicker = setInterval(tickDock, 500);
  pollDock();
}

// Discord re-renders its sidebar constantly, which can wipe out our inline dock.
// Called from the MutationObserver to re-insert it (cheaply) if it went missing.
function ensureDockPresent() {
  if (!Boolean(val("dockedPlayer"))) return;
  if ((val("dockMode") || "docked") !== "docked") return;
  if (document.getElementById(DOCK_INLINE_ID)) return;
  injectInlineDock();
  if (document.getElementById(DOCK_INLINE_ID)) pollDock(); // refresh once after re-insert
}

// ---------------------------------------------------------------------------
// Custom (frameless) title bar. The OS frame is off (main.js frame:false), so we
// draw a thin Discord-style bar with minimize / maximize / close, draggable to
// move the window. A CSS rule reserves the strip so Discord sits below it.
// ---------------------------------------------------------------------------

const TITLEBAR_ID = "dr-titlebar";
const TITLEBAR_H = 30;

const winCtl = (action) => ipcRenderer.send(`dr:win-${action}`);

// A full-height title-bar button (window controls, and the inbox/help icons).
function titlebarButton(svg, hoverBg, width = 46) {
  const b = document.createElement("button");
  b.innerHTML = svg;
  Object.assign(b.style, {
    width: `${width}px`, height: `${TITLEBAR_H}px`, border: "none", background: "transparent",
    color: "#b5bac1", cursor: "pointer", display: "flex", alignItems: "center",
    justifyContent: "center", padding: "0",
  });
  b.style.setProperty("-webkit-app-region", "no-drag"); // buttons click, don't drag
  b.addEventListener("mouseenter", () => (b.style.background = hoverBg));
  b.addEventListener("mouseleave", () => (b.style.background = "transparent"));
  return b;
}

// A small rounded nav button (back / forward), like Discord's.
function titlebarNavButton(svg) {
  const b = document.createElement("button");
  b.innerHTML = svg;
  Object.assign(b.style, {
    width: "28px", height: "22px", border: "none", background: "transparent",
    color: "#b5bac1", cursor: "pointer", display: "flex", alignItems: "center",
    justifyContent: "center", padding: "0", borderRadius: "4px",
  });
  b.style.setProperty("-webkit-app-region", "no-drag");
  b.addEventListener("mouseenter", () => (b.style.background = "rgba(255,255,255,0.08)"));
  b.addEventListener("mouseleave", () => (b.style.background = "transparent"));
  return b;
}

function syncTitlebar() {
  // Under the desktop spoof, Discord renders its OWN native title bar, so we don't
  // draw ours (avoids a doubled bar and doubled window controls).
  if (desktopSpoof) return;
  if (document.getElementById(TITLEBAR_ID)) return;

  const bar = document.createElement("div");
  bar.id = TITLEBAR_ID;
  Object.assign(bar.style, {
    position: "fixed", top: "0", left: "0", right: "0", height: `${TITLEBAR_H}px`,
    zIndex: "100000", display: "flex", alignItems: "center",
    background: "#121214", // matches the real Discord desktop title bar
    // Use Discord's own font (loaded by the page) so the title text matches.
    fontFamily: 'var(--font-primary, "gg sans", "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif)',
  });
  bar.style.setProperty("-webkit-app-region", "drag"); // whole bar drags the window

  // Left: back / forward (navigate Discord's history), like the real client.
  const navWrap = document.createElement("div");
  Object.assign(navWrap.style, { display: "flex", alignItems: "center", gap: "2px", paddingLeft: "8px" });
  const back = titlebarNavButton('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>');
  const fwd = titlebarNavButton('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>');
  back.addEventListener("click", () => winCtl("back"));
  fwd.addEventListener("click", () => winCtl("forward"));
  navWrap.append(back, fwd);

  // Center: the current Discord context (uses the page title, which Discord keeps
  // updated to the active channel/server) so the bar feels native.
  const title = document.createElement("div");
  Object.assign(title.style, {
    position: "absolute", left: "50%", top: "0", height: `${TITLEBAR_H}px`,
    transform: "translateX(-50%)", display: "flex", alignItems: "center",
    fontSize: "14px", fontWeight: "600", color: "#dbdee1", pointerEvents: "none",
    maxWidth: "50%", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis",
  });
  const setTitle = () => {
    let t = (document.title || "").replace(/^\(\d+\)\s*/, "").trim(); // drop "(3)" unread badge
    if (!t || t.toLowerCase() === "discord") t = "Discord Renewed";
    title.textContent = t;
  };
  setTitle();
  const titleEl = document.querySelector("title");
  if (titleEl) new MutationObserver(setTitle).observe(titleEl, { childList: true, characterData: true, subtree: true });

  // Right: Discord's inbox + help icons, a divider, then the window controls —
  // matching the real client's title-bar layout.
  const controls = document.createElement("div");
  Object.assign(controls.style, { marginLeft: "auto", display: "flex", alignItems: "center" });

  // Customisation Mode toggle (paint palette).
  const customise = titlebarButton(
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.49 2 2 6.49 2 12s4.49 10 10 10c.93 0 1.5-.76 1.5-1.5 0-.4-.16-.76-.42-1.03-.24-.26-.42-.62-.42-1.02 0-.83.67-1.5 1.5-1.5H16c3.31 0 6-2.69 6-6 0-4.96-4.49-9-10-9Zm-5 10a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm3-4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm3 4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z"/></svg>',
    "rgba(255,255,255,0.08)", 34
  );
  customise.title = "Customisation Mode (Ctrl+Shift+C)";
  customise.addEventListener("click", () => toggleCustomiseMode());

  const inbox = titlebarButton(
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 12h-4c0 1.66-1.34 3-3 3s-3-1.34-3-3H5V5h14v10z"/></svg>',
    "rgba(255,255,255,0.08)", 34
  );
  inbox.title = "Inbox";
  // Best-effort: open Discord's own inbox popout if its button is present.
  inbox.addEventListener("click", () => {
    document.querySelector('[aria-label="Inbox"]')?.click();
  });

  const help = titlebarButton(
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M11 18h2v-2h-2v2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5 0-2.21-1.79-4-4-4z"/></svg>',
    "rgba(255,255,255,0.08)", 34
  );
  help.title = "Help";
  help.addEventListener("click", () => ipcRenderer.send("dr:open-external", "https://support.discord.com"));

  const divider = document.createElement("div");
  Object.assign(divider.style, { width: "1px", height: "16px", background: "rgba(255,255,255,0.12)", margin: "0 6px" });

  const min = titlebarButton('<svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="5.5" width="8" height="1" fill="currentColor"/></svg>', "rgba(255,255,255,0.1)");
  const max = titlebarButton('<svg width="12" height="12" viewBox="0 0 12 12"><rect x="2.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/></svg>', "rgba(255,255,255,0.1)");
  const close = titlebarButton('<svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" stroke-width="1.2"/></svg>', "#e81123");
  close.addEventListener("mouseenter", () => (close.style.color = "#fff"));
  close.addEventListener("mouseleave", () => (close.style.color = "#b5bac1"));
  min.addEventListener("click", () => winCtl("minimize"));
  max.addEventListener("click", () => winCtl("maximize"));
  close.addEventListener("click", () => winCtl("close"));
  controls.append(customise, inbox, help, divider, min, max, close);

  bar.append(navWrap, title, controls);
  document.documentElement.appendChild(bar);
}

// Reserve the title-bar strip so Discord's root sits below it, and hide Discord's
// own (web) title bar — it has no window controls and would duplicate ours.
// Under the desktop spoof we do NEITHER: Discord renders its own real desktop
// title bar (with working window controls), so we leave its layout alone.
function titlebarCss() {
  if (desktopSpoof) return "";
  return `
    #app-mount { position: absolute !important; inset: ${TITLEBAR_H}px 0 0 0 !important; }
    [class*="bar_"]:has(> [class*="title_"]) { display: none !important; }
  `;
}

// ---------------------------------------------------------------------------
// Screen/window share picker. Electron doesn't supply an OS-level picker for a
// loaded page's getDisplayMedia() calls (only real browsers do that), so
// main.js's setDisplayMediaRequestHandler asks us to show one: it sends the
// available sources here, we render a thumbnail grid, and send back which one
// (if any) the user picked.
// ---------------------------------------------------------------------------

const PICKER_ID = "dr-source-picker";
const STREAM_MENU_ID = "dr-stream-menu";
const STREAM_SUBMENU_ID = "dr-stream-submenu";

function closeSourcePicker(choice) {
  document.getElementById(STREAM_SUBMENU_ID)?.remove();
  document.getElementById(STREAM_MENU_ID)?.remove();
  document.getElementById(PICKER_ID)?.remove();
  ipcRenderer.send("dr:capture-source-chosen", choice || { id: null });
}

// Stream quality options. These drive the SAME settings the stream-unlock reads
// (see currentStreamConfig), so choosing quality here actually raises what gets
// delivered — the picker and the unlock are one system now.
const STREAM_RES_OPTS = [
  { label: "720p", value: "720" },
  { label: "1080p", value: "1080" },
  { label: "1440p", value: "1440" },
  { label: "Source", value: "auto" },
];
const STREAM_FPS_OPTS = [
  { label: "15 FPS", value: "15" },
  { label: "30 FPS", value: "30" },
  { label: "60 FPS", value: "60" },
];
// Bitrate lives under the gear's "Advanced" submenu (values in kbps, shown Mbps).
const STREAM_BITRATE_OPTS = [
  { label: "2.5 Mbps", value: 2500 },
  { label: "5 Mbps", value: 5000 },
  { label: "8 Mbps", value: 8000 },
  { label: "10 Mbps", value: 10000 },
];
function pickerResText() {
  const rs = val("streamRes");
  if (!rs || rs === "auto") return ((displaySize && displaySize.height) || 1440) + "p";
  return rs + "p";
}
function pickerFpsText() {
  return (Number(val("streamFps")) || 60) + "fps";
}
function pickerModeName() {
  const m = val("streamMode") || "custom";
  return m === "gaming" ? "Gaming" : m === "screenshare" ? "Screenshare" : "Custom";
}

const PICKER_ICONS = {
  apps: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M5 3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h6v2H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-2h6a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H5Zm0 2h14v10H5V5Z"/></svg>',
  screen: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M4 4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h6v1H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-2v-1h6a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H4Z"/></svg>',
  gear: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M14.6 3.2a1 1 0 0 0-1-.8h-3.2a1 1 0 0 0-1 .8l-.3 1.7a7.5 7.5 0 0 0-1.6.9l-1.6-.6a1 1 0 0 0-1.2.4L2.5 8.4a1 1 0 0 0 .2 1.3l1.3 1.1a7.6 7.6 0 0 0 0 1.8l-1.3 1.1a1 1 0 0 0-.2 1.3l1.6 2.8a1 1 0 0 0 1.2.4l1.6-.6c.5.4 1 .7 1.6.9l.3 1.7a1 1 0 0 0 1 .8h3.2a1 1 0 0 0 1-.8l.3-1.7c.6-.2 1.1-.5 1.6-.9l1.6.6a1 1 0 0 0 1.2-.4l1.6-2.8a1 1 0 0 0-.2-1.3l-1.3-1.1a7.6 7.6 0 0 0 0-1.8l1.3-1.1a1 1 0 0 0 .2-1.3l-1.6-2.8a1 1 0 0 0-1.2-.4l-1.6.6a7.5 7.5 0 0 0-1.6-.9l-.3-1.7ZM12 15a3 3 0 1 1 0-6 3 3 0 0 1 0 6Z"/></svg>',
  chevron: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>',
  check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 12 10 17 19 7"/></svg>',
};

function showSourcePicker(sources) {
  document.getElementById(PICKER_ID)?.remove();

  const overlay = document.createElement("div");
  overlay.id = PICKER_ID;
  Object.assign(overlay.style, {
    position: "fixed", inset: "0", zIndex: "200000",
    background: "rgba(0,0,0,0.75)", display: "flex",
    alignItems: "center", justifyContent: "center",
    fontFamily: "var(--font-primary, 'gg sans', sans-serif)",
  });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeSourcePicker(null); });

  const card = document.createElement("div");
  Object.assign(card.style, {
    width: "min(840px, 92vw)", maxHeight: "86vh",
    display: "flex", flexDirection: "column",
    background: "#232428", borderRadius: "8px",
    boxShadow: "0 8px 32px rgba(0,0,0,0.6)", color: "#f2f3f5", overflow: "hidden",
  });

  // --- Tabs: Applications | Entire Screen (Devices intentionally skipped) ---
  const tabBar = document.createElement("div");
  Object.assign(tabBar.style, { display: "flex", gap: "4px", padding: "8px", borderBottom: "1px solid rgba(0,0,0,0.3)" });
  let activeTab = "apps";
  const tabs = [
    { id: "apps", label: "Applications", icon: PICKER_ICONS.apps },
    { id: "screen", label: "Entire Screen", icon: PICKER_ICONS.screen },
  ];
  const tabEls = {};
  for (const t of tabs) {
    const b = document.createElement("button");
    b.innerHTML = t.icon + `<span style="margin-left:8px">${t.label}</span>`;
    Object.assign(b.style, {
      flex: "1", display: "flex", alignItems: "center", justifyContent: "center",
      padding: "10px", borderRadius: "8px", border: "none", cursor: "pointer",
      background: "transparent", color: "#b5bac1", fontSize: "15px", fontWeight: "500",
    });
    b.addEventListener("click", () => { activeTab = t.id; renderTabs(); renderGrid(); });
    tabEls[t.id] = b;
    tabBar.appendChild(b);
  }
  function renderTabs() {
    for (const t of tabs) {
      const on = t.id === activeTab;
      Object.assign(tabEls[t.id].style, { background: on ? "#3f4248" : "transparent", color: on ? "#ffffff" : "#b5bac1" });
    }
  }
  card.appendChild(tabBar);

  // --- Source grid (filtered by tab) ---
  const grid = document.createElement("div");
  Object.assign(grid.style, { display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "12px", padding: "16px", overflowY: "auto" });
  function renderGrid() {
    grid.innerHTML = "";
    const list = sources.filter((s) => s.isScreen === (activeTab === "screen"));
    if (!list.length) {
      const empty = document.createElement("div");
      empty.textContent = activeTab === "screen" ? "No screens found." : "No application windows found.";
      Object.assign(empty.style, { gridColumn: "1 / -1", textAlign: "center", padding: "40px", color: "#949ba4" });
      grid.appendChild(empty);
      return;
    }
    for (const src of list) {
      const tile = document.createElement("button");
      Object.assign(tile.style, {
        display: "flex", flexDirection: "column", gap: "8px", padding: "8px",
        background: "transparent", border: "1px solid transparent", borderRadius: "8px",
        cursor: "pointer", color: "inherit", textAlign: "left", minWidth: "0",
      });
      tile.addEventListener("mouseenter", () => { tile.style.background = "rgba(255,255,255,0.04)"; tile.style.borderColor = "rgba(255,255,255,0.08)"; });
      tile.addEventListener("mouseleave", () => { tile.style.background = "transparent"; tile.style.borderColor = "transparent"; });

      const img = document.createElement("img");
      img.src = src.thumbnail;
      Object.assign(img.style, { width: "100%", aspectRatio: "16 / 9", objectFit: "cover", background: "#1a1b1e", borderRadius: "6px" });

      const nameRow = document.createElement("div");
      Object.assign(nameRow.style, { display: "flex", alignItems: "center", gap: "8px", minWidth: "0" });
      if (src.appIcon) {
        const ic = document.createElement("img");
        ic.src = src.appIcon;
        Object.assign(ic.style, { width: "16px", height: "16px", flex: "0 0 auto" });
        nameRow.appendChild(ic);
      }
      const label = document.createElement("span");
      label.textContent = src.name || (src.isScreen ? "Screen" : "Window");
      Object.assign(label.style, { fontSize: "14px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
      nameRow.appendChild(label);

      tile.append(img, nameRow);
      tile.addEventListener("click", () => closeSourcePicker({ id: src.id, muteAudio: Boolean(val("muteStreamAudio")) }));
      grid.appendChild(tile);
    }
  }
  card.appendChild(grid);

  // --- Bottom bar: quality summary (left) + gear (right) ---
  const bar = document.createElement("div");
  Object.assign(bar.style, { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderTop: "1px solid rgba(0,0,0,0.3)" });
  const qualityBox = document.createElement("div");
  const modeLine = document.createElement("div");
  Object.assign(modeLine.style, { fontSize: "15px", fontWeight: "700" });
  const detailLine = document.createElement("div");
  Object.assign(detailLine.style, { fontSize: "12px", color: "#949ba4", marginTop: "2px" });
  qualityBox.append(modeLine, detailLine);
  function refreshQuality() {
    modeLine.textContent = pickerModeName();
    detailLine.textContent = pickerResText() + " · " + pickerFpsText();
  }
  const gearBtn = document.createElement("button");
  gearBtn.innerHTML = PICKER_ICONS.gear;
  Object.assign(gearBtn.style, { width: "40px", height: "40px", borderRadius: "50%", border: "none", cursor: "pointer", background: "#2b2d31", color: "#dbdee1", display: "flex", alignItems: "center", justifyContent: "center", flex: "0 0 auto" });
  gearBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleStreamMenu(gearBtn, refreshQuality); });
  bar.append(qualityBox, gearBtn);
  card.appendChild(bar);

  overlay.appendChild(card);
  document.documentElement.appendChild(overlay);
  renderTabs();
  renderGrid();
  refreshQuality();
}

// The gear's "Stream Mode" context menu — Discord-styled. Drives the persisted
// stream settings (streamMode / streamRes / streamFps / muteStreamAudio), which
// the stream-unlock reads, so changing quality here applies to the next stream.
function toggleStreamMenu(gearBtn, onChange) {
  if (document.getElementById(STREAM_MENU_ID)) { closeStreamMenu(); return; }

  const menu = document.createElement("div");
  menu.id = STREAM_MENU_ID;
  Object.assign(menu.style, {
    position: "fixed", zIndex: "200001", minWidth: "244px",
    background: "#111214", borderRadius: "4px", padding: "6px 8px",
    boxShadow: "0 8px 16px rgba(0,0,0,0.24)", color: "#dbdee1",
    fontFamily: "var(--font-primary, 'gg sans', sans-serif)", fontSize: "14px",
  });

  const mkRow = () => {
    const r = document.createElement("div");
    Object.assign(r.style, { display: "flex", alignItems: "center", gap: "8px", padding: "8px", borderRadius: "4px", cursor: "pointer" });
    r.addEventListener("mouseenter", () => (r.style.background = "#4752c4"));
    r.addEventListener("mouseleave", () => (r.style.background = "transparent"));
    return r;
  };
  const mkSection = (text) => {
    const d = document.createElement("div");
    d.textContent = text;
    Object.assign(d.style, { fontSize: "11px", fontWeight: "700", color: "#949ba4", padding: "8px 8px 4px", letterSpacing: "0.02em" });
    return d;
  };
  const mkDivider = () => {
    const d = document.createElement("div");
    Object.assign(d.style, { height: "1px", background: "rgba(255,255,255,0.06)", margin: "6px 4px" });
    return d;
  };
  const rebuild = () => { document.getElementById(STREAM_SUBMENU_ID)?.remove(); menu.innerHTML = ""; build(); if (onChange) onChange(); };

  function radioItem(title, subtitle, selected, onClick) {
    const r = mkRow();
    const txt = document.createElement("div"); txt.style.flex = "1"; txt.style.minWidth = "0";
    const t = document.createElement("div"); t.textContent = title; t.style.fontWeight = "600"; txt.appendChild(t);
    if (subtitle) { const s = document.createElement("div"); s.textContent = subtitle; Object.assign(s.style, { fontSize: "12px", color: "#b5bac1" }); txt.appendChild(s); }
    const radio = document.createElement("div");
    Object.assign(radio.style, { width: "20px", height: "20px", borderRadius: "50%", boxSizing: "border-box", flex: "0 0 auto", border: selected ? "6px solid #5865f2" : "2px solid #80848e" });
    r.append(txt, radio);
    r.addEventListener("click", () => { onClick(); rebuild(); });
    return r;
  }
  function submenuItem(title, opts, currentValue, onPick, flyoutTitle) {
    const r = mkRow();
    const t = document.createElement("div"); t.textContent = title; t.style.flex = "1"; t.style.fontWeight = "500";
    const chev = document.createElement("div"); chev.innerHTML = PICKER_ICONS.chevron; chev.style.color = "#b5bac1";
    r.append(t, chev);
    r.addEventListener("click", (e) => {
      e.stopPropagation();
      openStreamSubMenu(r.getBoundingClientRect(), opts, currentValue, (v) => { onPick(v); rebuild(); }, flyoutTitle);
    });
    return r;
  }
  function checkItem(title, checked, onToggle) {
    const r = mkRow();
    const t = document.createElement("div"); t.textContent = title; t.style.flex = "1"; t.style.fontWeight = "500";
    const box = document.createElement("div");
    Object.assign(box.style, { width: "20px", height: "20px", borderRadius: "6px", boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", flex: "0 0 auto", border: checked ? "none" : "2px solid #80848e", background: checked ? "#5865f2" : "transparent" });
    if (checked) box.innerHTML = PICKER_ICONS.check;
    r.append(t, box);
    r.addEventListener("click", () => { onToggle(); rebuild(); });
    return r;
  }

  function build() {
    const mode = val("streamMode") || "custom";
    menu.appendChild(mkSection("STREAM MODE"));
    menu.appendChild(radioItem("Gaming", "Smoother video (Source, 60fps)", mode === "gaming", () => {
      setSetting("streamMode", "gaming"); setSetting("streamRes", "auto"); setSetting("streamFps", "60");
    }));
    menu.appendChild(radioItem("Screenshare", "Clearer text (Source, 15fps)", mode === "screenshare", () => {
      setSetting("streamMode", "screenshare"); setSetting("streamRes", "auto"); setSetting("streamFps", "15");
    }));
    menu.appendChild(radioItem("Custom", "", mode === "custom", () => setSetting("streamMode", "custom")));
    menu.appendChild(mkDivider());
    menu.appendChild(submenuItem("Screen Resolution", STREAM_RES_OPTS, val("streamRes") || "auto", (v) => { setSetting("streamRes", v); setSetting("streamMode", "custom"); }));
    menu.appendChild(submenuItem("Frame Rate", STREAM_FPS_OPTS, String(val("streamFps") || "60"), (v) => { setSetting("streamFps", v); setSetting("streamMode", "custom"); }));
    menu.appendChild(mkDivider());
    menu.appendChild(checkItem("Mute stream audio", Boolean(val("muteStreamAudio")), () => setSetting("muteStreamAudio", !val("muteStreamAudio"))));
    menu.appendChild(submenuItem("Advanced", STREAM_BITRATE_OPTS, val("streamBitrate") || 8000, (v) => setSetting("streamBitrate", v), "Bitrate"));
  }
  build();

  document.documentElement.appendChild(menu);
  const gr = gearBtn.getBoundingClientRect();
  const mr = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, gr.right - mr.width) + "px";
  menu.style.top = Math.max(8, gr.top - mr.height - 8) + "px";

  setTimeout(() => {
    const off = (e) => {
      if (menu.contains(e.target) || e.target === gearBtn || document.getElementById(STREAM_SUBMENU_ID)?.contains(e.target)) return;
      closeStreamMenu();
      document.removeEventListener("mousedown", off);
    };
    menu._off = off;
    document.addEventListener("mousedown", off);
  }, 0);
}

function closeStreamMenu() {
  document.getElementById(STREAM_SUBMENU_ID)?.remove();
  const m = document.getElementById(STREAM_MENU_ID);
  if (m && m._off) document.removeEventListener("mousedown", m._off);
  m?.remove();
}

// A flyout submenu (Screen Resolution / Frame Rate / Advanced) opened to the left
// of a row. `title` renders an optional section header (used for Advanced→Bitrate).
function openStreamSubMenu(anchorRect, opts, currentValue, onPick, title) {
  document.getElementById(STREAM_SUBMENU_ID)?.remove();
  const sub = document.createElement("div");
  sub.id = STREAM_SUBMENU_ID;
  Object.assign(sub.style, {
    position: "fixed", zIndex: "200002", minWidth: "150px",
    background: "#111214", borderRadius: "4px", padding: "6px 8px",
    boxShadow: "0 8px 16px rgba(0,0,0,0.24)", color: "#dbdee1",
    fontFamily: "var(--font-primary, 'gg sans', sans-serif)", fontSize: "14px",
  });
  if (title) {
    const h = document.createElement("div");
    h.textContent = title;
    Object.assign(h.style, { fontSize: "11px", fontWeight: "700", color: "#949ba4", padding: "8px 8px 4px", letterSpacing: "0.02em" });
    sub.appendChild(h);
  }
  for (const o of opts) {
    const r = document.createElement("div");
    Object.assign(r.style, { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", padding: "8px", borderRadius: "4px", cursor: "pointer" });
    r.addEventListener("mouseenter", () => (r.style.background = "#4752c4"));
    r.addEventListener("mouseleave", () => (r.style.background = "transparent"));
    const t = document.createElement("span"); t.textContent = o.label; r.appendChild(t);
    if (String(o.value) === String(currentValue)) { const c = document.createElement("span"); c.innerHTML = PICKER_ICONS.check; r.appendChild(c); }
    r.addEventListener("click", (e) => { e.stopPropagation(); onPick(o.value); });
    sub.appendChild(r);
  }
  document.documentElement.appendChild(sub);
  const sr = sub.getBoundingClientRect();
  sub.style.left = Math.max(8, anchorRect.left - sr.width - 4) + "px";
  sub.style.top = Math.max(8, Math.min(anchorRect.top - 6, window.innerHeight - sr.height - 8)) + "px";
}

ipcRenderer.on("dr:show-source-picker", (_event, sources) => showSourcePicker(sources));

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.getElementById(PICKER_ID)) closeSourcePicker(null);
});

// ---------------------------------------------------------------------------
// Customisation Mode — treat Discord's main sections as blocks you can restyle
// (font / background colour / image) and (Phase 2) rearrange. An inline overlay
// toggle (Ctrl+Shift+C, or the floating button) draws labelled boxes over each
// live section; clicking one opens its style panel. Everything persists and is
// applied via the normal CSS pipeline (customisationCss → buildCss).
// ---------------------------------------------------------------------------

// The rearrangeable/stylable blocks. `selectors` are tried in order (Discord's
// DMs vs server views use different classes); first match wins. Found by live
// DOM probe 2026-07-09 — classes are volatile, so match by substring not hash.
const SECTIONS = [
  { id: "serverList", label: "Server List", selectors: ['[class*="guilds_"]'] },
  { id: "channelList", label: "Channel List", selectors: ['[class*="sidebarList"]'] },
  { id: "chat", label: "Chat", selectors: ['[class*="chatContent_"]', '[class*="page_"]'] },
  { id: "memberList", label: "Member List", selectors: ['[class*="membersWrap"]', '[class*="members_"]'] },
];

const SECTION_FONTS = [
  { label: "Default", value: "" },
  { label: "gg sans", value: "'gg sans', sans-serif" },
  { label: "Arial", value: "Arial, sans-serif" },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "Times New Roman", value: "'Times New Roman', serif" },
  { label: "Courier New", value: "'Courier New', monospace" },
  { label: "Comic Sans MS", value: "'Comic Sans MS', 'Comic Sans', cursive" },
  { label: "Trebuchet MS", value: "'Trebuchet MS', sans-serif" },
  { label: "Impact", value: "Impact, sans-serif" },
];

const CUSTOMISE_LAYER_ID = "dr-customise-layer";
const SECTION_PANEL_ID = "dr-section-panel";
let customiseModeOn = false;
let customiseRaf = null;

function findSectionEl(section) {
  for (const sel of section.selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

// Persisted per-section styles: { serverList: {font,bgColor,bgImage,dim}, ... }
function allSectionStyles() {
  return val("sectionStyles") || {};
}
function sectionStyle(id) {
  return allSectionStyles()[id] || {};
}
function setSectionStyle(id, key, value) {
  const all = { ...allSectionStyles() };
  const one = { ...(all[id] || {}) };
  if (value === "" || value == null) delete one[key];
  else one[key] = value;
  all[id] = one;
  setSetting("sectionStyles", all); // persists + re-applies via applyStyles → buildCss
}

// Emit per-section CSS. Placed LAST in buildCss so it wins over the wallpaper's
// panel-transparency rules when the user sets a section colour/image.
// Inner containers that carry Discord's own opaque fills — cleared (scoped to a
// section) so a section's chosen colour/image shows through. Kept modest to avoid
// wiping content surfaces (avatars, badges) like the wallpaper feature learned.
const SECTION_BG_CLEAR = ['[class*="scroller_"]', '[class*="scrollerContent_"]', '[class*="scrollableContainer"]', '[class*="content_"]', '[class*="chatContent_"]', '[class*="chat_"]', '[class*="messagesWrapper_"]', '[class*="base_"]', '[class*="privateChannels_"]', '[class*="container_"]', '[class*="members_"]'];

function customisationCss() {
  const all = allSectionStyles();
  let css = "";
  for (const s of SECTIONS) {
    const st = all[s.id];
    if (!st) continue;
    const sel = s.selectors.join(", ");

    // Font: apply to the section AND every descendant — Discord sets explicit
    // font-family on text nodes, so plain inheritance won't take.
    if (st.font) {
      const fontSel = s.selectors.map((x) => `${x}, ${x} *`).join(", ");
      css += `${fontSel} { font-family: ${st.font} !important; }\n`;
    }

    // Background colour / image: paint the section base, then clear the inner
    // opaque panel fills within it so the paint is visible.
    if (st.bgColor || st.bgImage) {
      let paint = "";
      if (st.bgColor) paint += `background-color: ${st.bgColor} !important;`;
      if (st.bgImage) {
        const dim = clamp(Number(st.dim) || 0, 0, 100) / 100;
        const dimC = `rgba(0,0,0,${dim})`;
        paint += `background-image: linear-gradient(${dimC}, ${dimC}), url("${st.bgImage}") !important; background-size: cover !important; background-position: center !important; background-repeat: no-repeat !important;`;
      }
      css += `${sel} { ${paint} }\n`;
      const clearSel = s.selectors.flatMap((x) => SECTION_BG_CLEAR.map((c) => `${x} ${c}`)).join(", ");
      css += `${clearSel} { background-color: transparent !important; background-image: none !important; }\n`;
    }
  }
  return css;
}

function toggleCustomiseMode() {
  if (customiseModeOn) exitCustomiseMode();
  else enterCustomiseMode();
}

function enterCustomiseMode() {
  if (customiseModeOn) return;
  customiseModeOn = true;

  const layer = document.createElement("div");
  layer.id = CUSTOMISE_LAYER_ID;
  Object.assign(layer.style, { position: "fixed", inset: "0", zIndex: "180000", pointerEvents: "none", fontFamily: "var(--font-primary, sans-serif)" });
  document.documentElement.appendChild(layer);

  // Top banner: mode indicator + hint + exit.
  const banner = document.createElement("div");
  Object.assign(banner.style, { position: "fixed", top: `${TITLEBAR_H + 8}px`, left: "50%", transform: "translateX(-50%)", zIndex: "180001", background: "#5865f2", color: "#fff", padding: "8px 14px", borderRadius: "8px", boxShadow: "0 4px 16px rgba(0,0,0,0.4)", display: "flex", alignItems: "center", gap: "12px", pointerEvents: "auto", fontSize: "14px", fontWeight: "600" });
  const bannerText = document.createElement("span");
  bannerText.textContent = "🎨 Customisation Mode — click a section to style it";
  const exitBtn = document.createElement("button");
  exitBtn.textContent = "Done";
  Object.assign(exitBtn.style, { background: "#fff", color: "#5865f2", border: "none", borderRadius: "6px", padding: "4px 12px", fontWeight: "700", cursor: "pointer" });
  exitBtn.addEventListener("click", exitCustomiseMode);
  banner.append(bannerText, exitBtn);
  layer.appendChild(banner);

  // One labelled box per section, repositioned to track the live rects.
  const boxes = {};
  for (const s of SECTIONS) {
    const box = document.createElement("div");
    Object.assign(box.style, { position: "fixed", boxSizing: "border-box", border: "2px dashed rgba(88,101,242,0.9)", background: "rgba(88,101,242,0.08)", borderRadius: "6px", cursor: "pointer", pointerEvents: "auto", display: "none", transition: "background 0.1s" });
    box.addEventListener("mouseenter", () => (box.style.background = "rgba(88,101,242,0.18)"));
    box.addEventListener("mouseleave", () => (box.style.background = "rgba(88,101,242,0.08)"));
    const label = document.createElement("div");
    label.textContent = s.label;
    Object.assign(label.style, { position: "absolute", top: "8px", left: "8px", background: "#5865f2", color: "#fff", padding: "3px 10px", borderRadius: "6px", fontSize: "13px", fontWeight: "700", pointerEvents: "none", boxShadow: "0 2px 8px rgba(0,0,0,0.4)" });
    box.appendChild(label);
    box.addEventListener("click", (e) => { e.stopPropagation(); openSectionStylePanel(s); });
    layer.appendChild(box);
    boxes[s.id] = box;
  }

  const reposition = () => {
    if (!customiseModeOn) return;
    for (const s of SECTIONS) {
      const el = findSectionEl(s);
      const box = boxes[s.id];
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          Object.assign(box.style, { display: "block", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
        } else box.style.display = "none";
      } else box.style.display = "none";
    }
    customiseRaf = requestAnimationFrame(reposition);
  };
  reposition();
}

function exitCustomiseMode() {
  customiseModeOn = false;
  if (customiseRaf) cancelAnimationFrame(customiseRaf);
  customiseRaf = null;
  document.getElementById(CUSTOMISE_LAYER_ID)?.remove();
  document.getElementById(SECTION_PANEL_ID)?.remove();
}

// The per-section style editor (font / background colour / background image).
function openSectionStylePanel(section) {
  document.getElementById(SECTION_PANEL_ID)?.remove();
  const panel = document.createElement("div");
  panel.id = SECTION_PANEL_ID;
  Object.assign(panel.style, { position: "fixed", zIndex: "200500", top: `${TITLEBAR_H + 56}px`, right: "24px", width: "268px", background: "#232428", borderRadius: "10px", boxShadow: "0 12px 40px rgba(0,0,0,0.6)", color: "#f2f3f5", fontFamily: "var(--font-primary, sans-serif)", padding: "18px", pointerEvents: "auto" });

  const header = document.createElement("div");
  Object.assign(header.style, { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" });
  const title = document.createElement("div");
  title.textContent = section.label;
  Object.assign(title.style, { fontSize: "17px", fontWeight: "700" });
  const close = document.createElement("button");
  close.textContent = "✕";
  Object.assign(close.style, { background: "transparent", border: "none", color: "#b5bac1", fontSize: "16px", cursor: "pointer" });
  close.addEventListener("click", () => panel.remove());
  header.append(title, close);
  panel.appendChild(header);

  const fieldLabel = (text) => { const d = document.createElement("div"); d.textContent = text; Object.assign(d.style, { fontSize: "12px", fontWeight: "700", color: "#b5bac1", textTransform: "uppercase", margin: "12px 0 6px" }); return d; };

  // Font
  panel.appendChild(fieldLabel("Font"));
  const fontSel = document.createElement("select");
  Object.assign(fontSel.style, { width: "100%", padding: "8px", borderRadius: "6px", background: "#1e1f22", color: "#f2f3f5", border: "1px solid rgba(255,255,255,0.1)", cursor: "pointer" });
  for (const f of SECTION_FONTS) { const o = document.createElement("option"); o.value = f.value; o.textContent = f.label; if ((sectionStyle(section.id).font || "") === f.value) o.selected = true; fontSel.appendChild(o); }
  fontSel.addEventListener("change", () => setSectionStyle(section.id, "font", fontSel.value));
  panel.appendChild(fontSel);

  // Background colour
  panel.appendChild(fieldLabel("Background colour"));
  const colorRow = document.createElement("div");
  Object.assign(colorRow.style, { display: "flex", alignItems: "center", gap: "10px" });
  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.value = sectionStyle(section.id).bgColor || "#313338";
  Object.assign(colorInput.style, { width: "48px", height: "34px", border: "none", background: "transparent", cursor: "pointer" });
  colorInput.addEventListener("input", () => setSectionStyle(section.id, "bgColor", colorInput.value));
  const colorClear = document.createElement("button");
  colorClear.textContent = "Clear";
  Object.assign(colorClear.style, { background: "#4e5058", color: "#fff", border: "none", borderRadius: "6px", padding: "6px 12px", cursor: "pointer" });
  colorClear.addEventListener("click", () => setSectionStyle(section.id, "bgColor", ""));
  colorRow.append(colorInput, colorClear);
  panel.appendChild(colorRow);

  document.documentElement.appendChild(panel);
}

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.shiftKey && (e.key === "C" || e.key === "c")) { e.preventDefault(); toggleCustomiseMode(); }
});

// Combine every section's CSS. Future sections (theme, fonts, custom CSS) get
// appended here.
function buildCss() {
  // customisationCss last so per-section colours/images win over the wallpaper.
  return backgroundCss() + titlebarCss() + customisationCss();
}

function applyStyles() {
  // Keep the moving-wallpaper <video> (if any) in sync with the current settings,
  // then rebuild the CSS. Every place that changes a setting calls this, so the
  // video element and dimming overlay update alongside the styles.
  syncVideoElement();
  syncDockedPlayer();
  applyDockAppearance();
  syncTitlebar();

  let style = document.getElementById(STYLE_ID);
  const css = buildCss();
  if (!css.trim()) {
    style?.remove();
    return;
  }
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = css;
}

// ---------------------------------------------------------------------------
// Background image (stored as a file, so handled specially)
// ---------------------------------------------------------------------------

async function pickBackground() {
  const resource = await ipcRenderer.invoke("dr:pick-background");
  if (resource) {
    currentBackground = resource;
    applyStyles();
  }
}

function removeBackgroundImage() {
  currentBackground = null;
  applyStyles();
  ipcRenderer.invoke("dr:remove-background");
}

// Load saved settings on startup and apply them, so nothing resets on close.
function loadSavedSettings() {
  ipcRenderer.invoke("dr:get-settings").then((s) => {
    if (!s) return;
    const { background, backgroundFile, backgroundType, image, tabImage, tabImageFile, ...values } = s;
    settings = values;
    if (tabImage) currentTabImage = tabImage;
    // Migrate an older 0–1 dim value to the 0–100 slider scale.
    if (typeof settings.dim === "number" && settings.dim <= 1) {
      settings.dim = Math.round(settings.dim * 100);
    }
    // Migrate older performance settings to the current mode names.
    if (!settings.perfMode && settings.lowMemoryMode) settings.perfMode = "Optimised";
    if (settings.perfMode === "Smoothness" || settings.perfMode === "Balanced") settings.perfMode = "Smooth";
    if (settings.perfMode === "Light") settings.perfMode = "Optimised";
    if (background) currentBackground = background;
    else if (image) currentBackground = { type: "image", url: image }; // legacy
    applyStyles();
    sendStreamConfig(); // best-effort now; resent once webpack reports ready (see the "dr-wp" listener)
  });
}

// ---------------------------------------------------------------------------
// Rendering the settings page from the schema
// ---------------------------------------------------------------------------

function makeButton(text, bg) {
  const b = document.createElement("button");
  b.textContent = text;
  Object.assign(b.style, {
    padding: "8px 16px",
    border: "none",
    borderRadius: "8px",
    background: bg,
    color: "#fff",
    fontSize: "14px",
    fontWeight: "600",
    cursor: "pointer",
  });
  return b;
}

function controlLabel(text) {
  const el = document.createElement("label");
  el.textContent = text;
  Object.assign(el.style, {
    display: "block",
    marginBottom: "8px",
    fontSize: "12px",
    fontWeight: "700",
    letterSpacing: "0.02em",
    textTransform: "uppercase",
    color: "var(--header-secondary, #b5bac1)",
  });
  return el;
}

// Paint a memory-metrics object (from dr:get-metrics) into a container element.
// totalMB is the real physical RAM (private working set), matching Task Manager.
function renderMetrics(box, m) {
  box.innerHTML = "";

  const total = document.createElement("div");
  Object.assign(total.style, {
    fontSize: "22px",
    fontWeight: "700",
    color: "var(--header-primary, #f2f3f5)",
  });
  total.textContent = `${m.totalMB} MB`;

  const sub = document.createElement("div");
  Object.assign(sub.style, { fontSize: "12px", opacity: "0.7" });
  sub.textContent =
    `real RAM · ${m.processCount} process${m.processCount === 1 ? "" : "es"}` +
    (m.approximate ? " · approx" : "");

  box.append(total, sub);
}

const msToClock = (ms) => {
  const total = Math.floor((ms || 0) / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

// Build the Spotify control for the SETTINGS page: connection status + a
// Connect/Disconnect button. The live now-playing readout and playback controls
// live in the docked mini-player (see buildDock), so settings only holds options.
function renderSpotify(wrap) {
  wrap.appendChild(controlLabel("Spotify"));

  const box = document.createElement("div");
  Object.assign(box.style, {
    padding: "16px",
    borderRadius: "8px",
    background: "rgba(0, 0, 0, 0.25)",
    border: "1px solid rgba(255, 255, 255, 0.08)",
    color: "var(--text-normal, #dbdee1)",
  });

  const statusLine = document.createElement("div");
  Object.assign(statusLine.style, { fontSize: "14px", marginBottom: "12px" });

  const btn = makeButton("Connect Spotify", "#1DB954"); // Spotify green

  // Paint the box for a given status object { connected, name }.
  function render(status) {
    if (status && status.connected) {
      statusLine.textContent = status.name ? `Connected as ${status.name} ✓` : "Connected ✓";
      btn.textContent = "Disconnect";
      btn.style.background = "#4e5058";
    } else {
      statusLine.textContent = status && status.error ? `Not connected — ${status.error}` : "Not connected.";
      btn.textContent = "Connect Spotify";
      btn.style.background = "#1DB954";
    }
    btn.disabled = false;
  }

  btn.addEventListener("click", async () => {
    const connected = btn.textContent === "Disconnect";
    btn.disabled = true;
    if (connected) {
      render(await ipcRenderer.invoke("dr:spotify-disconnect"));
    } else {
      btn.textContent = "Connecting… approve in your browser";
      render(await ipcRenderer.invoke("dr:spotify-connect"));
    }
  });

  box.append(statusLine, btn);
  wrap.appendChild(box);

  ipcRenderer.invoke("dr:spotify-status").then(render);
  return wrap;
}

// Handle a button control's action, with brief visual feedback on the button.
function runButtonAction(action, btn) {
  if (action === "clear-cache") {
    const original = btn.textContent;
    btn.disabled = true;
    ipcRenderer.invoke("dr:clear-cache").then(() => {
      btn.textContent = "Cache cleared ✓";
      setTimeout(() => {
        btn.textContent = original;
        btn.disabled = false;
      }, 1500);
    });
  }
  if (action === "reload") {
    btn.disabled = true;
    btn.textContent = "Reloading…";
    ipcRenderer.send("dr:reload");
  }
}

function renderControl(ctrl) {
  const wrap = document.createElement("div");
  wrap.style.marginBottom = "24px";

  if (ctrl.type === "background") {
    wrap.appendChild(controlLabel(ctrl.label));
    const pick = makeButton("Choose image or video…", "#5865F2");
    pick.addEventListener("click", pickBackground);
    const remove = makeButton("Remove background", "#4e5058");
    remove.style.marginLeft = "10px";
    remove.addEventListener("click", removeBackgroundImage);
    wrap.append(pick, remove);

    const hint = document.createElement("div");
    hint.textContent =
      "Images (PNG, JPG, GIF, WebP) or short looping videos (MP4, WebM, MOV). " +
      "Video plays smoothest on the Smooth performance mode.";
    Object.assign(hint.style, { marginTop: "10px", fontSize: "12px", opacity: "0.6" });
    wrap.appendChild(hint);
    return wrap;
  }

  if (ctrl.type === "slider") {
    const label = controlLabel(`${ctrl.label} — ${val(ctrl.id)}${ctrl.suffix || ""}`);
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(ctrl.min);
    input.max = String(ctrl.max);
    input.step = String(ctrl.step || 1);
    input.value = String(val(ctrl.id));
    input.style.width = "320px";
    input.style.maxWidth = "100%";
    input.addEventListener("input", () => {
      label.textContent = `${ctrl.label} — ${input.value}${ctrl.suffix || ""}`;
      settings[ctrl.id] = Number(input.value);
      applyStyles(); // live preview
    });
    input.addEventListener("change", () => {
      setSetting(ctrl.id, Number(input.value)); // persist on release
    });
    wrap.append(label, input);
    return wrap;
  }

  if (ctrl.type === "toggle") {
    const row = document.createElement("label");
    Object.assign(row.style, {
      display: "flex",
      alignItems: "center",
      gap: "12px",
      cursor: "pointer",
      fontSize: "14px",
      color: "var(--text-normal, #dbdee1)",
    });
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(val(ctrl.id));
    input.style.width = "18px";
    input.style.height = "18px";
    input.style.cursor = "pointer";
    input.addEventListener("change", () => setSetting(ctrl.id, input.checked));
    const text = document.createElement("span");
    text.textContent = ctrl.label;
    row.append(input, text);
    wrap.appendChild(row);
    return wrap;
  }

  if (ctrl.type === "readout") {
    wrap.appendChild(controlLabel(ctrl.label));
    const box = document.createElement("div");
    Object.assign(box.style, {
      padding: "14px 16px",
      borderRadius: "8px",
      background: "rgba(0, 0, 0, 0.25)",
      border: "1px solid rgba(255, 255, 255, 0.08)",
      fontSize: "14px",
      color: "var(--text-normal, #dbdee1)",
    });
    box.textContent = "Measuring…";
    // The query spawns typeperf (~1-2s), so guard against overlapping polls.
    let busy = false;
    const refresh = () => {
      if (busy) return;
      busy = true;
      ipcRenderer
        .invoke("dr:get-metrics")
        .then((m) => m && renderMetrics(box, m))
        .finally(() => (busy = false));
    };
    refresh();
    pageIntervals.push(setInterval(refresh, 3000)); // stopped in hidePage()
    wrap.appendChild(box);
    return wrap;
  }

  if (ctrl.type === "button") {
    const b = makeButton(ctrl.label, ctrl.bg || "#4e5058");
    b.addEventListener("click", () => runButtonAction(ctrl.action, b));
    wrap.appendChild(b);
    return wrap;
  }

  if (ctrl.type === "color") {
    wrap.appendChild(controlLabel(ctrl.label));
    const rowc = document.createElement("div");
    Object.assign(rowc.style, { display: "flex", gap: "10px", alignItems: "center" });

    const swatchDefault = ctrl.defColor || "#1e1f22";

    // The native <input type=color> always paints a white swatch we can't restyle,
    // so we hide it and show our own dark-framed swatch that reflects the colour.
    const swatch = document.createElement("div");
    Object.assign(swatch.style, {
      position: "relative", width: "48px", height: "34px", borderRadius: "6px",
      border: "1px solid rgba(255,255,255,0.15)", background: val(ctrl.id) || swatchDefault,
      cursor: "pointer", overflow: "hidden",
    });

    const input = document.createElement("input");
    input.type = "color";
    input.value = val(ctrl.id) || swatchDefault;
    Object.assign(input.style, {
      position: "absolute", inset: "0", width: "100%", height: "100%",
      opacity: "0", border: "none", padding: "0", cursor: "pointer",
    });
    input.addEventListener("input", () => {
      swatch.style.background = input.value;
      settings[ctrl.id] = input.value;
      applyStyles(); // live preview
    });
    input.addEventListener("change", () => setSetting(ctrl.id, input.value));
    swatch.appendChild(input);

    const reset = makeButton("Default", "#4e5058");
    reset.addEventListener("click", () => {
      input.value = swatchDefault;
      swatch.style.background = swatchDefault;
      setSetting(ctrl.id, ""); // empty → fall back to the built-in look
    });

    rowc.append(swatch, reset);
    wrap.appendChild(rowc);
    return wrap;
  }

  if (ctrl.type === "tabImage") {
    wrap.appendChild(controlLabel(ctrl.label));
    const pick = makeButton("Choose image…", "#5865F2");
    pick.addEventListener("click", async () => {
      const res = await ipcRenderer.invoke("dr:pick-tab-image");
      if (res) {
        currentTabImage = res;
        applyStyles();
      }
    });
    const remove = makeButton("Remove", "#4e5058");
    remove.style.marginLeft = "10px";
    remove.addEventListener("click", () => {
      currentTabImage = null;
      applyStyles();
      ipcRenderer.invoke("dr:remove-tab-image");
    });
    wrap.append(pick, remove);

    const hint = document.createElement("div");
    hint.textContent = "An image covers the mini-player background (overrides the colour above).";
    Object.assign(hint.style, { marginTop: "10px", fontSize: "12px", opacity: "0.6" });
    wrap.appendChild(hint);
    return wrap;
  }

  if (ctrl.type === "spotify") {
    return renderSpotify(wrap);
  }

  if (ctrl.type === "streamStatus") {
    wrap.appendChild(controlLabel(ctrl.label));
    const box = document.createElement("div");
    Object.assign(box.style, {
      padding: "14px 16px",
      borderRadius: "8px",
      background: "rgba(0, 0, 0, 0.25)",
      border: "1px solid rgba(255, 255, 255, 0.08)",
      fontSize: "14px",
      color: "var(--text-normal, #dbdee1)",
    });
    const render = (status) => {
      box.textContent = streamStatusText(status);
    };
    render(latestStreamStatus);
    streamStatusListeners.push(render); // cleared in hidePage()
    wrap.appendChild(box);
    return wrap;
  }

  if (ctrl.type === "select") {
    wrap.appendChild(controlLabel(ctrl.label));
    const select = document.createElement("select");
    Object.assign(select.style, {
      padding: "8px 10px",
      borderRadius: "6px",
      background: "#1e1f22",
      color: "#dbdee1",
      border: "1px solid rgba(255,255,255,0.1)",
      fontSize: "14px",
      textTransform: "capitalize",
    });
    ctrl.choices.forEach((choice) => {
      const opt = document.createElement("option");
      opt.value = choice;
      opt.textContent = (ctrl.labels && ctrl.labels[choice]) || choice;
      if (choice === val(ctrl.id)) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener("change", () => setSetting(ctrl.id, select.value));
    wrap.appendChild(select);
    return wrap;
  }

  return wrap;
}

function buildPageContent(tab) {
  const inner = document.createElement("div");
  Object.assign(inner.style, { maxWidth: "740px", padding: "60px 40px 80px", boxSizing: "border-box" });

  const title = document.createElement("h2");
  title.textContent = tab ? tab.label : "Discord Renewed";
  Object.assign(title.style, {
    margin: "0 0 24px",
    fontSize: "20px",
    fontWeight: "700",
    color: "var(--header-primary, #f2f3f5)",
  });
  inner.appendChild(title);

  // Group this tab's controls by section, in first-seen order.
  const wanted = tab ? tab.sections : null;
  const sections = [];
  for (const ctrl of SCHEMA) {
    if (wanted && !wanted.includes(ctrl.section)) continue;
    let group = sections.find((g) => g.name === ctrl.section);
    if (!group) {
      group = { name: ctrl.section, controls: [] };
      sections.push(group);
    }
    group.controls.push(ctrl);
  }

  for (const group of sections) {
    // With a single section the tab title already names it, so skip the heading.
    if (sections.length > 1) {
      const heading = document.createElement("h3");
      heading.textContent = group.name;
      Object.assign(heading.style, {
        margin: "8px 0 16px",
        fontSize: "16px",
        fontWeight: "600",
        color: "var(--header-primary, #f2f3f5)",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
        paddingBottom: "8px",
      });
      inner.appendChild(heading);
    }
    group.controls.forEach((ctrl) => inner.appendChild(renderControl(ctrl)));
  }

  return inner;
}

// ---------------------------------------------------------------------------
// Small DOM helpers for injecting into Discord's settings
// ---------------------------------------------------------------------------

function findLeavesByText(text) {
  return Array.from(document.querySelectorAll("div,button,a,span,h1,h2")).filter(
    (el) =>
      (el.textContent || "").trim() === text &&
      !Array.from(el.children).some((c) => (c.textContent || "").trim() === text)
  );
}

function relabelItem(root, newText) {
  const content = root.querySelector('[class*="itemContent_"]') || root;
  const leaf = Array.from(content.querySelectorAll("*")).find(
    (el) => el.childElementCount === 0 && (el.textContent || "").trim().length > 0
  );
  if (leaf) leaf.textContent = newText;
  else content.textContent = newText;
}

// ---------------------------------------------------------------------------
// Our settings PAGE (rendered into Discord's settings content pane)
// ---------------------------------------------------------------------------

function findContentPane() {
  const ours = document.getElementById(SECTION_ID);
  const aside = ours
    ? ours.closest('[class*="sidebar__"]')
    : document.querySelector('[class*="sidebar__"]');
  if (!aside || !aside.parentElement) return null;
  return aside.parentElement.querySelector(':scope > [class*="content_"]');
}

// Highlight the given tab's sidebar item (by dr-item-<id>), clearing the others.
// Pass null to clear all.
function setActiveItem(activeId) {
  for (const tab of TABS) {
    const li = document.getElementById(`dr-item-${tab.id}`);
    if (!li) continue;
    const clickable = li.querySelector('[class*="itemContent_"]')?.parentElement || li;
    clickable.style.backgroundColor =
      `dr-item-${tab.id}` === activeId ? "var(--background-modifier-selected, rgba(255,255,255,0.08))" : "";
  }
}

let hiddenContent = [];
let pageIntervals = []; // live-updating timers (e.g. the memory readout)

function hidePage() {
  document.getElementById(PAGE_ID)?.remove();
  hiddenContent.forEach((c) => {
    if (c.isConnected) c.style.display = "";
  });
  hiddenContent = [];
  pageIntervals.forEach(clearInterval);
  pageIntervals = [];
  streamStatusListeners = [];
  setActiveItem(null);
}

function showPage(tab) {
  hidePage();
  const pane = findContentPane();
  if (!pane) return;

  // Hide Discord's current page so ours can sit in the same place.
  hiddenContent = Array.from(pane.children);
  hiddenContent.forEach((c) => (c.style.display = "none"));

  const overlay = document.createElement("div");
  overlay.id = PAGE_ID;
  overlay.appendChild(buildPageContent(tab));
  pane.appendChild(overlay);
  setActiveItem(`dr-item-${tab.id}`);
}

// ---------------------------------------------------------------------------
// Injecting our section into the settings sidebar
// ---------------------------------------------------------------------------

function watchNav() {
  const nav = document.querySelector('[class*="nav__"]');
  if (!nav || nav.__drWatched) return;
  nav.__drWatched = true;
  nav.addEventListener(
    "click",
    (e) => {
      const section = document.getElementById(SECTION_ID);
      if (section && section.contains(e.target)) return; // our items manage their own pages
      hidePage();
    },
    true
  );
}

function injectSettings() {
  if (document.getElementById(SECTION_ID)) return; // already injected

  const leaf = findLeavesByText("Appearance")[0];
  if (!leaf) return; // not on the settings screen
  const content = leaf.closest('[class*="itemContent_"]');
  if (!content) return;
  const sectionList = content.parentElement?.parentElement?.parentElement;
  const sectionLI = sectionList?.parentElement;
  const sublist = sectionLI?.parentElement;
  if (!sublist) return;

  const section = sectionLI.cloneNode(true);
  section.id = SECTION_ID;

  const label = section.querySelector('[class*="sectionLabel__"]');
  if (label) label.textContent = "Discord Renewed";

  const itemsUL = section.querySelector('[class*="sectionList__"]');
  const template = itemsUL.firstElementChild; // reuse a real settings item as our template
  itemsUL.innerHTML = "";

  // One sidebar item per tab, each opening its own filtered page.
  for (const tab of TABS) {
    const li = template.cloneNode(true);
    li.id = `dr-item-${tab.id}`;
    li.querySelectorAll('[class*="subnavContainer"]').forEach((el) => el.remove());
    li.querySelectorAll("svg, img").forEach((el) => el.remove());
    li.querySelectorAll("[aria-selected]").forEach((el) => el.removeAttribute("aria-selected"));
    li.querySelectorAll("*").forEach((el) => {
      Array.from(el.classList || []).forEach((c) => {
        if (/selected|active/i.test(c)) el.classList.remove(c);
      });
    });
    relabelItem(li, tab.label);

    // Prepend a small icon before the label so our items match Discord's native ones.
    const content = li.querySelector('[class*="itemContent_"]');
    if (content && tab.icon) {
      Object.assign(content.style, { display: "flex", alignItems: "center", gap: "8px" });
      const icon = document.createElement("span");
      icon.innerHTML = tab.icon;
      Object.assign(icon.style, { display: "inline-flex", flex: "0 0 auto", width: "18px", height: "18px", opacity: "0.9" });
      content.insertBefore(icon, content.firstChild);
    }

    const clickable = li.querySelector('[class*="itemContent_"]')?.parentElement || li;
    clickable.addEventListener("click", (e) => {
      e.stopPropagation();
      showPage(tab);
    });
    itemsUL.appendChild(li);
  }

  const logoutLeaf = findLeavesByText("Log Out")[0];
  const beforeNode = logoutLeaf
    ? Array.from(sublist.children).find((child) => child.contains(logoutLeaf))
    : null;
  if (beforeNode) sublist.insertBefore(section, beforeNode);
  else sublist.appendChild(section);

  watchNav();
  log("settings section injected");
}

// Discord re-renders constantly and the settings screen only exists while open,
// so we re-check on every DOM change and re-inject as needed.
const observer = new MutationObserver(() => {
  injectSettings();
  ensureDockPresent();
  syncTitlebar();
});
window.addEventListener("DOMContentLoaded", () => {
  observer.observe(document.documentElement, { childList: true, subtree: true });
  injectSettings();
  loadSavedSettings();
  log("preload ready");
});

// Pause a moving wallpaper while the window is hidden/minimized so it isn't
// decoding video no one can see; resume when it comes back into view.
document.addEventListener("visibilitychange", () => {
  const video = document.getElementById(VIDEO_ID)?.querySelector("video");
  if (!video) return;
  if (document.hidden) video.pause();
  else video.play?.().catch(() => {});
});
