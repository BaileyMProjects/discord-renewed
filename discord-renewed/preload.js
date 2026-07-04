// preload.js — runs INSIDE the Discord page, before it loads.
//
// Our "safe bridge": it can touch the Discord page's DOM, but Discord's own code
// can't reach Node. Customization is reached through Discord's own settings: we
// add a "Discord Renewed" section to the settings sidebar, and our item opens a
// settings page whose controls are generated from a SCHEMA (below). Every
// control auto-saves to the persistent store and auto-applies. To add a new
// customization, add an entry to SCHEMA and (if needed) a line to buildCss().

const { ipcRenderer } = require("electron");

// Inject our MAIN-WORLD patcher (webpack.js) into Discord's page context. Our
// preload lives in an isolated world and can't see Discord's internal module
// system, so the patcher has to run as a page <script>. We do this at the very top
// of preload (document-start) so its webpack hook is in place before Discord's
// bundle loads. Discord's CSP is stripped in main.js, so the inline script runs.
// NOTE: this preload is sandboxed, so it can't require("fs") — the main process
// reads the patcher source and hands it over synchronously via sendSync.
(function injectMainWorldPatcher() {
  let code;
  try {
    code = ipcRenderer.sendSync("dr:get-patcher-source");
  } catch (e) {
    return console.log("[DiscordRenewed] patcher source failed:", e && e.message);
  }
  if (!code) return console.log("[DiscordRenewed] patcher source empty");

  const run = () => {
    const root = document.documentElement || document.head || document.body;
    if (!root) return false; // <html> not created yet — try again when it is
    try {
      const script = document.createElement("script");
      script.textContent = code;
      root.appendChild(script);
      script.remove(); // its code has already executed; keep the DOM tidy
    } catch (e) {
      console.log("[DiscordRenewed] patcher inject error:", e && e.message);
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
})();

// Bridge for messages coming back from the main-world patcher (webpack.js).
let webpackStatus = null; // last { ok, moduleCount, ... } reported by the patcher
window.addEventListener("message", (e) => {
  const d = e.data;
  if (!d || d.source !== "dr-wp") return;
  if (d.type === "status") {
    webpackStatus = d.status;
    console.log("[DiscordRenewed] webpack status:", JSON.stringify(d.status));
  }
});

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
  { section: "Spotify", id: "spotify", type: "spotify", label: "Spotify" },
  { section: "Spotify", id: "dockedPlayer", type: "toggle", label: "Show a Spotify mini-player docked above your profile (pop it out with ⤢ to drag it anywhere)", def: false },
  { section: "Spotify", id: "tabColor", type: "color", label: "Mini-player background colour", def: "", defColor: "#1e1f22" },
  { section: "Spotify", id: "tabLineColor", type: "color", label: "Progress bar colour", def: "", defColor: "#1DB954" },
  { section: "Spotify", id: "tabImage", type: "tabImage", label: "Mini-player background image" },
  { section: "Spotify", id: "tabDim", type: "slider", label: "Mini-player image dimming", min: 0, max: 100, step: 1, def: 0, suffix: "%" },
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
  // Don't overwrite the bar/elapsed while the user is dragging it to seek.
  if (!dockScrubbing) {
    const pct = data.durationMs ? Math.min(100, (data.progressMs / data.durationMs) * 100) : 0;
    r.barFill.style.width = `${pct}%`;
    r.elapsed.textContent = msToClock(data.progressMs);
  }
  const playing = Boolean(data.playing);
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
  controls.append(inbox, help, divider, min, max, close);

  bar.append(navWrap, title, controls);
  document.documentElement.appendChild(bar);
}

// Reserve the title-bar strip so Discord's root sits below it, and hide Discord's
// own (web) title bar — it has no window controls and would duplicate ours.
function titlebarCss() {
  return `
    #app-mount { position: absolute !important; inset: ${TITLEBAR_H}px 0 0 0 !important; }
    [class*="bar_"]:has(> [class*="title_"]) { display: none !important; }
  `;
}

// Combine every section's CSS. Future sections (theme, fonts, custom CSS) get
// appended here.
function buildCss() {
  return backgroundCss() + titlebarCss();
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
      opt.textContent = choice;
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
