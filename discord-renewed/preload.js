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

const log = (...args) => console.log("[DiscordRenewed]", ...args);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let settings = {}; // all saved customization values, keyed by schema id
let currentImageUrl = null; // background image (stored on disk as a file)

// ---------------------------------------------------------------------------
// Customization schema — add entries here to add options.
// ---------------------------------------------------------------------------

const SCHEMA = [
  { section: "Background", id: "background", type: "background", label: "Background image" },
  { section: "Background", id: "dim", type: "slider", label: "Background dimming", min: 0, max: 100, step: 1, def: 50, suffix: "%" },
  { section: "System", id: "memory", type: "readout", label: "Memory usage" },
  { section: "System", id: "clearCache", type: "button", label: "Free up memory now", action: "clear-cache" },
  { section: "System", id: "perfMode", type: "select", label: "Performance mode — Smooth = full GPU acceleration (default). Light = GPU off, saves ~250 MB / ~35% RAM but video, screen share and animations get clunkier. Applies after restart.", choices: ["Smooth", "Light"], def: "Smooth" },
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

function backgroundCss() {
  if (!currentImageUrl) return ""; // no wallpaper → leave Discord fully normal

  const dim = clamp(Number(val("dim")) || 0, 0, 100) / 100;
  const dimC = `rgba(0, 0, 0, ${dim})`;

  return `
    /* Paint the dimmed wallpaper on the full-window base elements. */
    html, body, [class*="appMount__"], [class*="app__"], [class*="bg__"] {
      background-image: linear-gradient(${dimC}, ${dimC}), url("${currentImageUrl}") !important;
      background-size: cover !important;
      background-position: center !important;
      background-repeat: no-repeat !important;
    }

    /* Clear opaque region fills so the wallpaper shows behind the panels.
       Content (avatars, banners, text) sits on top and stays visible. */
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

// Combine every section's CSS. Future sections (theme, fonts, custom CSS) get
// appended here.
function buildCss() {
  return backgroundCss();
}

function applyStyles() {
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
  const url = await ipcRenderer.invoke("dr:pick-background");
  if (url) {
    currentImageUrl = url;
    applyStyles();
  }
}

function removeBackgroundImage() {
  currentImageUrl = null;
  applyStyles();
  ipcRenderer.invoke("dr:remove-background");
}

// Load saved settings on startup and apply them, so nothing resets on close.
function loadSavedSettings() {
  ipcRenderer.invoke("dr:get-settings").then((s) => {
    if (!s) return;
    const { image, backgroundFile, ...values } = s;
    settings = values;
    // Migrate an older 0–1 dim value to the 0–100 slider scale.
    if (typeof settings.dim === "number" && settings.dim <= 1) {
      settings.dim = Math.round(settings.dim * 100);
    }
    // Migrate the old on/off low-memory toggle to the new performance modes.
    if (!settings.perfMode && settings.lowMemoryMode) settings.perfMode = "Light";
    if (image) currentImageUrl = image;
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

// Friendlier names for Electron's process types in the memory readout.
const PROC_LABELS = { Browser: "App core", Tab: "Discord", GPU: "Graphics", Utility: "Helpers" };

// Paint a memory-metrics object (from dr:get-metrics) into a container element.
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
  Object.assign(sub.style, { fontSize: "12px", opacity: "0.7", marginBottom: "10px" });
  sub.textContent = `across ${m.processCount} process${m.processCount === 1 ? "" : "es"}`;

  box.append(total, sub);

  const entries = Object.entries(m.byType || {}).sort((a, b) => b[1] - a[1]);
  for (const [type, mb] of entries) {
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "flex",
      justifyContent: "space-between",
      fontSize: "13px",
      padding: "2px 0",
    });
    const name = document.createElement("span");
    name.textContent = PROC_LABELS[type] || type;
    const value = document.createElement("span");
    value.textContent = `${mb} MB`;
    row.append(name, value);
    box.appendChild(row);
  }
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
    const pick = makeButton("Choose image…", "#5865F2");
    pick.addEventListener("click", pickBackground);
    const remove = makeButton("Remove background", "#4e5058");
    remove.style.marginLeft = "10px";
    remove.addEventListener("click", removeBackgroundImage);
    wrap.append(pick, remove);
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
    const refresh = () =>
      ipcRenderer.invoke("dr:get-metrics").then((m) => m && renderMetrics(box, m));
    refresh();
    pageIntervals.push(setInterval(refresh, 2000)); // stopped in hidePage()
    wrap.appendChild(box);
    return wrap;
  }

  if (ctrl.type === "button") {
    const b = makeButton(ctrl.label, ctrl.bg || "#4e5058");
    b.addEventListener("click", () => runButtonAction(ctrl.action, b));
    wrap.appendChild(b);
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
const observer = new MutationObserver(() => injectSettings());
window.addEventListener("DOMContentLoaded", () => {
  observer.observe(document.documentElement, { childList: true, subtree: true });
  injectSettings();
  loadSavedSettings();
  log("preload ready");
});
