// preload.js — runs INSIDE the Discord page, before it loads.
//
// Our "safe bridge": it can touch the Discord page's DOM, but Discord's own code
// can't reach Node. Customization is reached through Discord's own settings: we
// add a "Discord Renewed" section to the settings sidebar, and our item opens a
// settings page whose controls are generated from a SCHEMA (below). Every
// control auto-saves to the persistent store and auto-applies. To add a new
// customization, add an entry to SCHEMA and (if needed) a line to buildCss().

const { ipcRenderer } = require("electron");

const STYLE_ID = "dr-styles";
const SECTION_ID = "dr-settings-section";
const ITEM_ID = "dr-settings-item";
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
let dockInterval = null;
let dockBusy = false;
let dockScrubbing = false; // true while dragging the progress bar to seek

// A round control button, shared by the settings widget and the dock.
function circleButton(glyph, title, size = 36) {
  const b = document.createElement("button");
  b.textContent = glyph;
  b.title = title;
  Object.assign(b.style, {
    width: `${size}px`,
    height: `${size}px`,
    borderRadius: "50%",
    border: "none",
    background: "rgba(255,255,255,0.1)",
    color: "#fff",
    cursor: "pointer",
    fontSize: `${Math.round(size * 0.4)}px`,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0",
    lineHeight: "1",
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
    Object.assign(dock.style, {
      boxSizing: "border-box",
      flex: "0 0 auto", // don't let the sidebar's flex layout squash it
      margin: "0 8px 8px",
      padding: "8px 10px",
      background: dockBgFor(true),
      border: "1px solid rgba(255,255,255,0.08)",
      borderRadius: "8px",
      color: "var(--text-normal, #dbdee1)",
      display: "none", // shown by updateDock when there's a track
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

  const art = document.createElement("img");
  Object.assign(art.style, { width: `${artSize}px`, height: `${artSize}px`, borderRadius: "6px", flex: "0 0 auto" });

  const info = document.createElement("div");
  Object.assign(info.style, { minWidth: "0", flex: "1 1 auto" });
  const title = document.createElement("div");
  Object.assign(title.style, {
    fontWeight: "600", fontSize: inline ? "12px" : "13px", whiteSpace: "nowrap",
    overflow: "hidden", textOverflow: "ellipsis",
  });
  const artist = document.createElement("div");
  Object.assign(artist.style, {
    fontSize: inline ? "11px" : "12px", opacity: "0.7", whiteSpace: "nowrap",
    overflow: "hidden", textOverflow: "ellipsis",
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
    fontSize: "11px", opacity: "0.6", marginTop: "3px",
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
  const prev = circleButton("⏮", "Previous", btnSize);
  const play = circleButton("▶", "Play / Pause", btnSize);
  const next = circleButton("⏭", "Next", btnSize);

  // Mode button: docked → pop out into a floating card; floating → dock back.
  const modeBtn = inline
    ? circleButton("⤢", "Pop out (drag anywhere)", btnSize)
    : circleButton("⤓", "Dock to sidebar", btnSize);
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
  if (!data || !data.connected || !data.track) {
    dock.style.display = "none";
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
  r.play.textContent = playing ? "⏸" : "▶";
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

// Insert the docked (inline) mini-player just above Discord's profile card. That
// card lives at the bottom of the left sidebar; inserting before it makes the
// channel list flex to leave room, so it reads as part of the app.
function injectInlineDock() {
  if (document.getElementById(DOCK_INLINE_ID)) return;
  const panels = document.querySelector('[class*="panels_"]');
  if (!panels || !panels.parentElement) return; // sidebar not on screen yet
  panels.parentElement.insertBefore(buildDock(true), panels);
}

// Create/remove the mini-player (in whichever mode) and its polling timer to
// match the settings. Called from applyStyles, so it re-syncs on any change.
function syncDockedPlayer() {
  const enabled = Boolean(val("dockedPlayer"));

  if (!enabled) {
    document.getElementById(DOCK_ID)?.remove();
    document.getElementById(DOCK_INLINE_ID)?.remove();
    if (dockInterval) {
      clearInterval(dockInterval);
      dockInterval = null;
    }
    return;
  }

  if ((val("dockMode") || "docked") === "floating") {
    document.getElementById(DOCK_INLINE_ID)?.remove();
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

// Combine every section's CSS. Future sections (theme, fonts, custom CSS) get
// appended here.
function buildCss() {
  return backgroundCss();
}

function applyStyles() {
  // Keep the moving-wallpaper <video> (if any) in sync with the current settings,
  // then rebuild the CSS. Every place that changes a setting calls this, so the
  // video element and dimming overlay update alongside the styles.
  syncVideoElement();
  syncDockedPlayer();
  applyDockAppearance();

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

function buildPageContent() {
  const inner = document.createElement("div");
  Object.assign(inner.style, { maxWidth: "740px", padding: "60px 40px 80px", boxSizing: "border-box" });

  const title = document.createElement("h2");
  title.textContent = "Discord Renewed";
  Object.assign(title.style, {
    margin: "0 0 24px",
    fontSize: "20px",
    fontWeight: "700",
    color: "var(--header-primary, #f2f3f5)",
  });
  inner.appendChild(title);

  // Group controls by section, in first-seen order.
  const sections = [];
  for (const ctrl of SCHEMA) {
    let group = sections.find((g) => g.name === ctrl.section);
    if (!group) {
      group = { name: ctrl.section, controls: [] };
      sections.push(group);
    }
    group.controls.push(ctrl);
  }

  for (const group of sections) {
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
  const ours = document.getElementById(ITEM_ID) || document.getElementById(SECTION_ID);
  const aside = ours
    ? ours.closest('[class*="sidebar__"]')
    : document.querySelector('[class*="sidebar__"]');
  if (!aside || !aside.parentElement) return null;
  return aside.parentElement.querySelector(':scope > [class*="content_"]');
}

function setItemActive(active) {
  const li = document.getElementById(ITEM_ID);
  if (!li) return;
  const clickable = li.querySelector('[class*="itemContent_"]')?.parentElement || li;
  clickable.style.backgroundColor = active
    ? "var(--background-modifier-selected, rgba(255,255,255,0.08))"
    : "";
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
  setItemActive(false);
}

function showPage() {
  hidePage();
  const pane = findContentPane();
  if (!pane) return;

  // Hide Discord's current page so ours can sit in the same place.
  hiddenContent = Array.from(pane.children);
  hiddenContent.forEach((c) => (c.style.display = "none"));

  const overlay = document.createElement("div");
  overlay.id = PAGE_ID;
  overlay.appendChild(buildPageContent());
  pane.appendChild(overlay);
  setItemActive(true);
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
      const ours = document.getElementById(ITEM_ID);
      if (ours && ours.contains(e.target)) return; // our item shows our page
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
  while (itemsUL.children.length > 1) itemsUL.removeChild(itemsUL.lastElementChild);

  const ourLI = itemsUL.firstElementChild;
  ourLI.id = ITEM_ID;
  ourLI.querySelectorAll('[class*="subnavContainer"]').forEach((el) => el.remove());
  ourLI.querySelectorAll("svg, img").forEach((el) => el.remove());
  ourLI.querySelectorAll("[aria-selected]").forEach((el) => el.removeAttribute("aria-selected"));
  ourLI.querySelectorAll("*").forEach((el) => {
    Array.from(el.classList || []).forEach((c) => {
      if (/selected|active/i.test(c)) el.classList.remove(c);
    });
  });
  relabelItem(ourLI, "Customize");

  const clickable = ourLI.querySelector('[class*="itemContent_"]')?.parentElement || ourLI;
  clickable.addEventListener("click", (e) => {
    e.stopPropagation();
    showPage();
  });

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
