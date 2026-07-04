// webpack.js — runs in Discord's MAIN world (the page's own JS context), injected
// by preload.js as an inline <script>. Unlike preload.js (which lives in an
// isolated world and can't see Discord's globals), this script CAN reach
// Discord's internal module system (webpackChunkdiscord_app). It is the
// foundation for "unlock" features that need to modify Discord's own code.
//
// STEP 1 (this file, for now): capture Discord's module `require`, expose a small
// search API to find modules by shape (not by hashed IDs, which change every
// update), and self-test by finding a well-known module. NOTHING is patched yet —
// this stage is purely read-only, equivalent to poking around in devtools.
//
// It talks back to preload over window.postMessage (both worlds share the frame),
// every message tagged {source:"dr-wp"} so it never collides with Discord's own.

(function () {
  "use strict";

  const TAG = "[DiscordRenewed]"; // main.js forwards console lines containing this to the terminal
  const log = (...a) => console.log(TAG, "[wp]", ...a);
  const send = (msg) => {
    try {
      window.postMessage(Object.assign({ source: "dr-wp" }, msg), "*");
    } catch {}
  };

  if (window.__drWebpack) {
    log("already initialised, skipping");
    return;
  }

  // -------------------------------------------------------------------------
  // Capture Discord's MAIN webpack `require`.
  // Technique (from Vencord's patchWebpack): every webpack require is a function
  // that gets `require.m = moduleFactories` assigned while it's built, so a setter
  // on Function.prototype.m sees each require the instant it appears. We keep the
  // MAIN app bundle's require — identified by its "/assets/" public path (`.p`) and
  // a real module cache (`.c`) — and ignore secondary/worker runtimes (an earlier
  // chunk-push approach handed us one of those, whose cache only had ~77 modules).
  // Once captured we remove the hook.
  // -------------------------------------------------------------------------

  let wreq = null; // the main webpack require once captured
  const candidates = new Set();
  let captureTimer = null;

  function removeMHook() {
    try {
      delete Function.prototype.m;
    } catch {}
  }

  function cacheSize(fn) {
    try {
      return fn && fn.c && typeof fn.c === "object" ? Object.keys(fn.c).length : -1;
    } catch {
      return -1;
    }
  }

  function consider(fn) {
    if (wreq) return;
    candidates.add(fn);
    if (captureTimer) return;
    let tries = 0;
    captureTimer = setInterval(() => {
      tries++;
      // The main app require is the one whose module cache actually fills up
      // (thousands), vs. small secondary/worker runtimes. Pick the biggest, and
      // only once it's clearly the app (> 500 instantiated modules).
      let best = null, bestN = -1;
      for (const c of candidates) {
        const n = cacheSize(c);
        if (n > bestN) { bestN = n; best = c; }
      }
      if (best && bestN > 500) wreq = best;
      if (wreq || tries > 80) {
        clearInterval(captureTimer);
        captureTimer = null;
        log("candidates=" + candidates.size + " bestCache=" + bestN);
        candidates.clear();
        removeMHook();
        if (wreq) onRequire();
        else log("main require not found (timed out)");
      }
    }, 150);
  }

  try {
    Object.defineProperty(Function.prototype, "m", {
      configurable: true,
      set(modules) {
        // Give this function its own real `.m` so webpack keeps working normally.
        Object.defineProperty(this, "m", {
          value: modules,
          writable: true,
          configurable: true,
          enumerable: true,
        });
        consider(this);
      },
    });
  } catch (e) {
    log("Function.prototype.m hook failed:", e && e.message);
  }

  // -------------------------------------------------------------------------
  // Search API over the module cache. We search already-instantiated modules
  // (wreq.c) by the shape of their exports, so we don't depend on hashed module
  // IDs — the same resilience strategy we use for Discord's hashed CSS classes.
  // -------------------------------------------------------------------------

  function allExports() {
    const out = [];
    if (!wreq || !wreq.c) return out;
    for (const id in wreq.c) {
      const exp = wreq.c[id] && wreq.c[id].exports;
      if (exp) out.push(exp);
    }
    return out;
  }

  const hasProps = (o, props) => o && props.every((p) => o[p] !== undefined);

  function findByProps(...props) {
    for (const exp of allExports()) {
      if (hasProps(exp, props)) return exp;
      if (exp.default && hasProps(exp.default, props)) return exp.default;
    }
    return null;
  }

  function findStore(name) {
    for (const exp of allExports()) {
      const store = exp && exp.default ? exp.default : exp;
      if (store && typeof store.getName === "function") {
        try {
          if (store.getName() === name) return store;
        } catch {}
      }
    }
    return null;
  }

  function moduleCount() {
    return wreq && wreq.c ? Object.keys(wreq.c).length : 0;
  }

  const api = { get require() { return wreq; }, allExports, findByProps, findStore, moduleCount };
  window.__drWebpack = api;

  // -------------------------------------------------------------------------
  // Self-test (STEP 1 verification). Once require is captured, wait briefly for
  // modules to populate, then report the module count and whether we can find a
  // couple of well-known modules. Read the result in the terminal logs.
  // -------------------------------------------------------------------------

  function onRequire() {
    log("require captured; modules=" + moduleCount());
    // The cache keeps filling as Discord instantiates modules, so poll a few times
    // until a well-known module shows up (proves the search API works end to end).
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      const count = moduleCount();
      const userStore = findStore("UserStore") || findByProps("getCurrentUser");
      const mediaEngine = findByProps("getMediaEngine") || findByProps("setVideoBroadcast");
      if (userStore || tries >= 12) {
        clearInterval(iv);
        const status = {
          ok: Boolean(userStore),
          moduleCount: count,
          userStore: Boolean(userStore),
          mediaEngine: Boolean(mediaEngine),
        };
        log("self-test:", JSON.stringify(status));
        send({ type: "status", status });
      }
    }, 800);
  }

  // -------------------------------------------------------------------------
  // Command channel from preload (used in later steps for the stream-unlock
  // config). For STEP 1 we just acknowledge so the bridge is proven end-to-end.
  // -------------------------------------------------------------------------

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.source !== "dr-wp-cmd") return;
    if (d.type === "config") {
      log("received config (no-op in step 1):", JSON.stringify(d.config || {}));
      send({ type: "ack" });
    }
  });

  log("patcher injected; module require " + (wreq ? "captured" : "pending"));
})();
