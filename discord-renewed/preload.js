// preload.js — runs INSIDE the Discord page, before it loads.
//
// This is our "safe bridge": it can touch the Discord page's DOM, but Discord's
// own code can't reach Node. Our customization is reached through Discord's own
// settings (BetterDiscord-style): we add a "Discord Renewed" section at the
// bottom of the settings sidebar, and clicking our item opens a real settings
// PAGE in the content pane — same look and feel as Discord's own pages.

const { ipcRenderer } = require("electron");

const STYLE_ID = "dr-background-style";
const SECTION_ID = "dr-settings-section";
const ITEM_ID = "dr-settings-item";
const PAGE_ID = "dr-settings-page";

const log = (...args) => console.log("[DiscordRenewed]", ...args);

// ---------------------------------------------------------------------------
// Applying the background
// ---------------------------------------------------------------------------

// Current background state (session-only for now; persistence comes later).
let currentImageUrl = null;
let dimOpacity = 0.5; // 0 = image fully visible, 1 = fully dark. Default: readable.

function setBackgroundImage(imageUrl) {
  currentImageUrl = imageUrl;
  renderBackground();
}

function setDimOpacity(value) {
  dimOpacity = Math.min(1, Math.max(0, value));
  renderBackground();
}

function removeBackground() {
  currentImageUrl = null;
  renderBackground();
}

function renderBackground() {
  let style = document.getElementById(STYLE_ID);

  if (!currentImageUrl) {
    style?.remove();
    return;
  }
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }

  // A dark layer over the image (the "dimming") keeps text readable.
  const dim = `rgba(0, 0, 0, ${dimOpacity})`;

  style.textContent = `
    /* Override Discord's surface-colour variables so panels that use them go
       see-through automatically (covers both old and new theme tokens). */
    :root, .theme-dark, .theme-darker, .theme-midnight, .theme-light {
      --background-primary: transparent !important;
      --background-secondary: transparent !important;
      --background-secondary-alt: transparent !important;
      --background-tertiary: transparent !important;
      --background-base-low: transparent !important;
      --background-base-lower: transparent !important;
      --background-base-lowest: transparent !important;
      --bg-overlay-app-frame: transparent !important;
      --bg-base-primary: transparent !important;
      --bg-base-secondary: transparent !important;
      --bg-base-tertiary: transparent !important;
      --background-floating: transparent !important;
      --background-surface-high: transparent !important;
      --background-surface-higher: transparent !important;
      --background-surface-highest: transparent !important;
      --profile-body-background-color: transparent !important;
    }

    /* Paint the dimmed image on the root elements. */
    html, body, #app-mount {
      background-image: linear-gradient(${dim}, ${dim}), url("${currentImageUrl}") !important;
      background-size: cover !important;
      background-position: center !important;
      background-repeat: no-repeat !important;
      background-attachment: fixed !important;
    }

    /* Transparent-ize the main layout layers by class as a backstop. */
    [class*="baseLayer"],
    [class*="app_"],
    [class*="base_"],
    [class*="content_"],
    [class*="container_"],
    [class*="sidebar_"],
    [class*="chat_"],
    [class*="chatContent_"],
    [class*="bg_"],
    [class*="appAsidePanelWrapper"] {
      background-color: transparent !important;
    }
  `;
}

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

// Deepest elements whose trimmed text is exactly `text`.
function findLeavesByText(text) {
  return Array.from(document.querySelectorAll("div,button,a,span,h1,h2")).filter(
    (el) =>
      (el.textContent || "").trim() === text &&
      !Array.from(el.children).some((c) => (c.textContent || "").trim() === text)
  );
}

// Replace the first text label inside an item with `newText`.
function relabelItem(root, newText) {
  const content = root.querySelector('[class*="itemContent_"]') || root;
  const leaf = Array.from(content.querySelectorAll("*")).find(
    (el) => el.childElementCount === 0 && (el.textContent || "").trim().length > 0
  );
  if (leaf) leaf.textContent = newText;
  else content.textContent = newText;
}

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

// ---------------------------------------------------------------------------
// Our settings PAGE (rendered into Discord's settings content pane)
// ---------------------------------------------------------------------------

// The content pane is the sibling of the settings sidebar inside the settings
// container (…sidebar__409aa and …content_e9e3ed share a parent). Anchor on our
// own item so we get the settings sidebar specifically, not some other sidebar.
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

// Discord's content nodes we hid while our page is shown (so we can restore).
let hiddenContent = [];

function hidePage() {
  document.getElementById(PAGE_ID)?.remove();
  hiddenContent.forEach((c) => {
    if (c.isConnected) c.style.display = "";
  });
  hiddenContent = [];
  setItemActive(false);
}

function showPage() {
  hidePage();
  const pane = findContentPane();
  if (!pane) return;

  // Hide Discord's current page (instead of covering it) so our page can be
  // transparent and match the rest of the now-see-through settings.
  hiddenContent = Array.from(pane.children);
  hiddenContent.forEach((c) => (c.style.display = "none"));

  const overlay = document.createElement("div");
  overlay.id = PAGE_ID;

  const inner = document.createElement("div");
  Object.assign(inner.style, {
    maxWidth: "740px",
    padding: "60px 40px 80px",
    boxSizing: "border-box",
  });

  const title = document.createElement("h2");
  title.textContent = "Background";
  Object.assign(title.style, {
    margin: "0 0 8px",
    fontSize: "20px",
    fontWeight: "700",
    color: "var(--header-primary, #f2f3f5)",
  });

  const desc = document.createElement("p");
  desc.textContent = "Set a custom background image for Discord Renewed.";
  Object.assign(desc.style, {
    margin: "0 0 24px",
    fontSize: "14px",
    color: "var(--text-normal, #dbdee1)",
  });

  const pickBtn = makeButton("Choose image…", "#5865F2");
  pickBtn.addEventListener("click", async () => {
    const imageUrl = await ipcRenderer.invoke("dr:pick-background");
    if (imageUrl) setBackgroundImage(imageUrl);
  });

  const resetBtn = makeButton("Remove background", "#4e5058");
  resetBtn.style.marginLeft = "10px";
  resetBtn.addEventListener("click", removeBackground);

  // --- Dimming slider -------------------------------------------------------
  const sliderWrap = document.createElement("div");
  sliderWrap.style.marginTop = "32px";

  const sliderLabel = document.createElement("label");
  Object.assign(sliderLabel.style, {
    display: "block",
    marginBottom: "8px",
    fontSize: "12px",
    fontWeight: "700",
    letterSpacing: "0.02em",
    textTransform: "uppercase",
    color: "var(--header-secondary, #b5bac1)",
  });
  const pct = () => `${Math.round(dimOpacity * 100)}%`;
  sliderLabel.textContent = `Background dimming — ${pct()}`;

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "100";
  slider.value = String(Math.round(dimOpacity * 100));
  slider.style.width = "320px";
  slider.style.maxWidth = "100%";
  slider.addEventListener("input", () => {
    setDimOpacity(Number(slider.value) / 100);
    sliderLabel.textContent = `Background dimming — ${pct()}`;
  });

  const sliderHint = document.createElement("p");
  sliderHint.textContent = "Higher dimming makes text easier to read over the image.";
  Object.assign(sliderHint.style, {
    margin: "8px 0 0",
    fontSize: "12px",
    color: "var(--text-muted, #949ba4)",
  });

  sliderWrap.append(sliderLabel, slider, sliderHint);

  inner.append(title, desc, pickBtn, resetBtn, sliderWrap);
  overlay.appendChild(inner);
  pane.appendChild(overlay);
  setItemActive(true);
}

// ---------------------------------------------------------------------------
// Injecting our section into the settings sidebar
// ---------------------------------------------------------------------------

// When any sidebar item OTHER than ours is clicked, close our page (Discord is
// navigating to one of its own pages).
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

  // Walk the known sidebar structure up from the "Appearance" label.
  const leaf = findLeavesByText("Appearance")[0];
  if (!leaf) return; // not on the settings screen
  const content = leaf.closest('[class*="itemContent_"]');
  if (!content) return;
  const sectionList = content.parentElement?.parentElement?.parentElement; // …sectionList
  const sectionLI = sectionList?.parentElement; // …section
  const sublist = sectionLI?.parentElement; // …sublist (all sections)
  if (!sublist) return;

  // Clone a whole section so we inherit Discord's exact label + item styling.
  const section = sectionLI.cloneNode(true);
  section.id = SECTION_ID;

  const label = section.querySelector('[class*="sectionLabel__"]');
  if (label) label.textContent = "Discord Renewed";

  // Keep only the first item as our template; remove the rest.
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
  relabelItem(ourLI, "Background");

  const clickable = ourLI.querySelector('[class*="itemContent_"]')?.parentElement || ourLI;
  clickable.addEventListener("click", (e) => {
    e.stopPropagation();
    showPage();
  });

  // Insert our section just ABOVE the "Log Out" entry (keep it last-ish but
  // before logout), falling back to the end of the list.
  const logoutLeaf = findLeavesByText("Log Out")[0];
  const beforeNode = logoutLeaf
    ? Array.from(sublist.children).find((child) => child.contains(logoutLeaf))
    : null;
  if (beforeNode) sublist.insertBefore(section, beforeNode);
  else sublist.appendChild(section);

  watchNav();
  log("settings section injected" + (beforeNode ? " above Log Out" : " at bottom"));
}

// Discord re-renders constantly and the settings screen only exists while open,
// so we re-check on every DOM change and re-inject as needed.
const observer = new MutationObserver(() => injectSettings());
window.addEventListener("DOMContentLoaded", () => {
  observer.observe(document.documentElement, { childList: true, subtree: true });
  injectSettings();
  log("preload ready");
});
