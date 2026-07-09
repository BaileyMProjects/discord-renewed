// webpack.js — runs in Discord's MAIN world (the page's own JS context), injected
// by preload.js as an inline <script>. Unlike preload.js (which lives in an
// isolated world and can't see Discord's globals), this script CAN reach
// Discord's internal module system (webpackChunkdiscord_app). It is the
// foundation for "unlock" features that need to modify Discord's own code.
//
// Capture Discord's module `require`, expose a search API to find modules by
// shape (not by hashed IDs, which change every Discord update), and — gated
// behind an explicit opt-in — patch the screen-share/Go Live quality ceiling
// (resolution, framerate, bitrate). The patch only runs when preload sends
// {enabled:true} (the "streamUnlock" toggle, OFF by default with an in-UI ToS
// warning); until then this file is purely read-only.
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

  // Electron can't cleanly signal "user cancelled the screen-share picker" — a
  // cancel comes back to getDisplayMedia() as AbortError "Invalid capture
  // constraints", which Discord treats as a real failure (error toast). Wrap
  // getDisplayMedia to translate that into the standard NotAllowedError that
  // Discord's web code (like any browser) already handles as a silent cancel.
  // (Electron issues #47980 / #45517.) Runs in Discord's own context before its
  // bundle, so Discord uses the wrapped version.
  try {
    const md = navigator.mediaDevices;
    if (md && typeof md.getDisplayMedia === "function" && !md.__drDisplayWrapped) {
      const orig = md.getDisplayMedia.bind(md);
      md.getDisplayMedia = function (...args) {
        return orig(...args).catch((err) => {
          if (err && err.name === "AbortError") {
            throw new DOMException("Permission denied", "NotAllowedError");
          }
          throw err;
        });
      };
      md.__drDisplayWrapped = true;
    }
  } catch {}

  // Discord's web code leaves the screen-share getDisplayMedia rejection unhandled
  // in our Electron shell (a cancel or a benign capture-constraint failure), which
  // surfaces as an error. Swallow those specific unhandled rejections so cancelling
  // the picker is silent, like it is in a real browser.
  window.addEventListener("unhandledrejection", (e) => {
    const r = e && e.reason;
    if (r && (r.name === "NotAllowedError" || r.name === "AbortError" || r.name === "OverconstrainedError")) {
      e.preventDefault();
    }
  });

  if (window.__drWebpack) {
    log("already initialised, skipping");
    return;
  }

  // -------------------------------------------------------------------------
  // FACTORY PATCHING (pre-execution source rewrites).
  //
  // Unlike the stream-unlock feature (which wraps class methods at RUNTIME on
  // already-instantiated modules), some fixes must change a module's SOURCE
  // before Discord ever runs it — because the value is a closure local behind a
  // non-configurable getter that can't be reassigned afterwards. We do this the
  // Vencord way: hook `webpackChunkdiscord_app.push` so we see every chunk's
  // module factories the instant they arrive (before webpack executes them),
  // string-replace the target factory's source, and recompile it. Discord's
  // bundle is loaded AFTER this script, so the push hook is in place in time.
  //
  // Modules are recompiled by wrapping the factory's own `id(e,t,n){...}`
  // method-shorthand source in an object literal and eval'ing it (main.js strips
  // Discord's CSP, so eval is allowed). Every step is guarded — if a patch
  // fails to match or recompile, the ORIGINAL factory is kept untouched, so a
  // future Discord build that renames things simply leaves the feature inert
  // rather than breaking the client.
  //
  // GATED to the desktop spoof only (DiscordNative present): these patches are
  // meaningless/unwanted on the normal web client.
  // -------------------------------------------------------------------------

  const SPOOF = window.DiscordNative != null; // nativebridge injects before us when the spoof is on

  // Each patch: `find` (optional substring that scopes the patch to one module —
  // omit to match purely by the edit regexes) and `edits` (list of {re, replace}
  // applied to that module's source), applied at most once.
  //
  // platform-embedded-off: force isPlatformEmbedded=false GLOBALLY (module 574381,
  // `let s=window.DiscordNative,a=null!=s,o=null!=s?s.process.platform:""` → a=!1)
  // so the media engine goes browser + no "corrupt installation" banner + the
  // spoofed client stays stable, while isDesktop (from `o`) stays true → desktop
  // UI/title bar/features intact. NOTE (2026-07-07): this does NOT make voice
  // CALLS connect under the spoof — the voice transport's web-vs-native behavior
  // is spread across ~17 media/voice modules' platform-flag reads (esp. isWindows),
  // several shared with non-voice code, so a clean voice-only patch isn't viable;
  // voice under the spoof needs a different approach (see memory). Keep the spoof
  // OFF for making calls until that's solved.
  const FACTORY_PATCHES = [
    {
      id: "platform-embedded-off",
      edits: [{
        re: /(let (\w+)=window\.DiscordNative,)(\w+)(=null!=\2,)(\w+)(=null!=\2\?\2\.process\.platform)/,
        replace: "$1$3=!1,$5$6",
      }],
      done: false,
    },
  ];

  function recompileFactory(id, src) {
    // Factory source is method-shorthand `123(e,t,n){...}`; a numeric method key
    // is valid in an object literal, so wrap + eval + pull it back out.
    const obj = (0, eval)("({" + src + "})");
    const fn = obj[id];
    if (typeof fn !== "function") throw new Error("recompiled key missing");
    return fn;
  }

  function patchModuleFactories(modules) {
    if (!SPOOF) return;
    if (FACTORY_PATCHES.every((p) => p.done)) return; // nothing left to look for
    for (const id in modules) {
      const factory = modules[id];
      if (typeof factory !== "function") continue;
      let src;
      try { src = Function.prototype.toString.call(factory); } catch { continue; }
      let patched = src;
      for (const p of FACTORY_PATCHES) {
        if (p.done) continue;
        if (p.find && !src.includes(p.find)) continue; // scope to the target module
        let changed = false;
        for (const e of p.edits) {
          const next = patched.replace(e.re, e.replace);
          if (next !== patched) { patched = next; changed = true; }
        }
        if (changed) { p.done = true; log("factory patch '" + p.id + "' applied to module " + id); }
      }
      if (patched === src) continue;
      try {
        modules[id] = recompileFactory(id, patched);
        log("factory patch applied + recompiled module " + id);
      } catch (e) {
        log("factory recompile FAILED for module " + id + ": " + (e && e.message));
      }
    }
  }

  function installFactoryPatcher() {
    if (!SPOOF || !FACTORY_PATCHES.length) return;
    let store = window.webpackChunkdiscord_app;
    const hookPush = (arr) => {
      if (!arr || arr.__drPatched) return arr;
      const origPush = arr.push.bind(arr);
      arr.push = function (chunk) {
        try { if (chunk && chunk[1]) patchModuleFactories(chunk[1]); } catch (e) { log("push-patch error: " + (e && e.message)); }
        return origPush(chunk);
      };
      arr.__drPatched = true;
      log("webpackChunkdiscord_app.push hooked for factory patching");
      return arr;
    };
    if (store) hookPush(store); // already created (shouldn't be — we run first)
    // Discord creates the chunk array after us; intercept its assignment.
    try {
      Object.defineProperty(window, "webpackChunkdiscord_app", {
        configurable: true,
        get() { return store; },
        set(v) { store = hookPush(v); },
      });
    } catch (e) {
      log("could not define webpackChunkdiscord_app hook: " + (e && e.message));
    }
  }

  installFactoryPatcher();

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
        // Eager modules (assigned directly to require.m, not via a lazy chunk
        // push) also flow through here — patch them before webpack executes them.
        try { patchModuleFactories(modules); } catch (e) { log("m-hook patch err: " + (e && e.message)); }
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
  // Self-test. Once require is captured, wait briefly for modules to populate,
  // then report the module count and whether we can find a couple of well-known
  // modules. Read the result in the terminal logs; preload also uses the "ok"
  // status to know it's safe to (re)send the stream-unlock config.
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
  // Stream-quality unlock (screen share / Go Live resolution, framerate,
  // bitrate). Gated: applyStreamUnlock() only patches anything when
  // config.enabled is true. Targets are found by CODE SIGNATURE (substring
  // match on each module factory's own source, via Function.prototype.toString)
  // rather than by module id — ids are volatile and reshuffle on every Discord
  // build, but the real (non-minified) method names on these classes
  // (setGoLiveSource, setQualityOverwrite, setGoliveQuality) are stable enough
  // to match reliably. Mapped 2026-07-04 against the live client:
  //   - the RTC connection class: setGoLiveSource(e) destructures
  //     e.quality.{resolution,frameRate} — this is what the Go Live/camera
  //     panel asks for, before Discord's own Nitro-tier UI even limits the
  //     choices, so overriding it here bypasses that limit regardless of what
  //     was selected in the UI.
  //   - the VideoQualityManager class: setQualityOverwrite(e) and
  //     setGoliveQuality(e) carry {bitrateMin,bitrateMax,capture,encode} — the
  //     actual ceiling the encoder is allowed to use.
  // If a future Discord update renames/restructures these, the matchers below
  // simply fail to find a class and the feature reports "inactive" — nothing
  // else breaks (every hook is wrapped in try/catch and never modifies
  // anything unless config.enabled is true).
  // -------------------------------------------------------------------------

  function moduleSource(id) {
    try {
      return Function.prototype.toString.call(wreq.m[id]);
    } catch {
      return "";
    }
  }

  // Instantiate module `id` and find which export (or the module itself) is a
  // class exposing `methodName` on its prototype.
  function classWithMethod(id, methodName) {
    let exp;
    try {
      exp = wreq(id);
    } catch {
      return null;
    }
    if (!exp) return null;
    if (typeof exp === "function" && exp.prototype && typeof exp.prototype[methodName] === "function") return exp;
    for (const k of Object.keys(exp)) {
      const v = exp[k];
      if (typeof v === "function" && v.prototype && typeof v.prototype[methodName] === "function") return v;
    }
    return null;
  }

  function findConnectionClass() {
    if (!wreq || !wreq.m) return null;
    for (const id in wreq.m) {
      const src = moduleSource(id);
      if (src.includes("setTransportOptions") && src.includes("setGoLiveSource") && src.includes("videoQualityManager")) {
        const cls = classWithMethod(id, "setGoLiveSource");
        if (cls) return cls;
      }
    }
    return null;
  }

  function findQualityManagerClass() {
    if (!wreq || !wreq.m) return null;
    for (const id in wreq.m) {
      const src = moduleSource(id);
      if (src.includes("setQualityOverwrite") && src.includes("setGoliveQuality")) {
        const cls = classWithMethod(id, "setQualityOverwrite");
        if (cls) return cls;
      }
    }
    return null;
  }

  let streamConfig = null; // last config received from preload: {enabled,resolution,fps,bitrateKbps}
  let streamPatches = []; // restore functions for the currently-applied patches

  function currentTargets() {
    const cfg = streamConfig || {};
    return {
      res: cfg.resolution || 2160,
      fps: cfg.fps || 60,
      bitrate: (cfg.bitrateKbps || 8000) * 1000,
    };
  }

  // Wrap cls.prototype[method], remembering how to put the original back.
  function patchMethod(cls, method, makeWrapper) {
    if (!cls || typeof cls.prototype[method] !== "function") return false;
    const orig = cls.prototype[method];
    cls.prototype[method] = makeWrapper(orig);
    streamPatches.push(() => {
      cls.prototype[method] = orig;
    });
    return true;
  }

  function unpatchStream() {
    for (const restore of streamPatches) {
      try {
        restore();
      } catch {}
    }
    streamPatches = [];
  }

  function applyStreamUnlock(config) {
    streamConfig = config;

    if (!config || !config.enabled) {
      const wasActive = streamPatches.length > 0;
      unpatchStream();
      send({ type: "stream-status", status: { active: false, reason: wasActive ? "disabled" : "off" } });
      return;
    }

    if (!wreq) {
      send({ type: "stream-status", status: { active: false, reason: "webpack not ready" } });
      return;
    }

    if (streamPatches.length > 0) {
      // Already patched this session — target values are read live via
      // currentTargets() on every call, so changing them needs no re-wrapping.
      send({ type: "stream-status", status: { active: true } });
      return;
    }

    const ConnClass = findConnectionClass();
    const VQMClass = findQualityManagerClass();
    if (!ConnClass && !VQMClass) {
      send({ type: "stream-status", status: { active: false, reason: "modules not found" } });
      return;
    }

    const patchedGoLiveSource = patchMethod(ConnClass, "setGoLiveSource", (orig) => function (e) {
      try {
        if (e && e.quality) {
          const { res, fps } = currentTargets();
          log("stream APPLIED setGoLiveSource → " + res + "p " + fps + "fps (was " + (e.quality.resolution) + "p " + (e.quality.frameRate) + "fps)");
          e = Object.assign({}, e, { quality: Object.assign({}, e.quality, { resolution: res, frameRate: fps }) });
        }
      } catch (err) {
        log("setGoLiveSource override failed:", err && err.message);
      }
      return orig.call(this, e);
    });

    const patchedQualityOverwrite = patchMethod(VQMClass, "setQualityOverwrite", (orig) => function (e) {
      try {
        const { bitrate } = currentTargets();
        e = Object.assign({}, e, { bitrateMin: Math.round(bitrate * 0.6), bitrateMax: bitrate });
      } catch (err) {
        log("setQualityOverwrite override failed:", err && err.message);
      }
      return orig.call(this, e);
    });

    const patchedGoliveQuality = patchMethod(VQMClass, "setGoliveQuality", (orig) => function (e) {
      try {
        const { res, fps, bitrate } = currentTargets();
        const width = Math.round((res * 16) / 9);
        log("stream APPLIED goLiveQuality → " + width + "x" + res + " " + fps + "fps @ " + (bitrate / 1e6).toFixed(1) + "Mbps");
        e = Object.assign({}, e, {
          bitrateMin: Math.round(bitrate * 0.6),
          bitrateMax: bitrate,
          capture: Object.assign({}, e && e.capture, { width, height: res, framerate: fps }),
          encode: Object.assign({}, e && e.encode, { width, height: res, framerate: fps }),
        });
      } catch (err) {
        log("setGoliveQuality override failed:", err && err.message);
      }
      return orig.call(this, e);
    });

    const active = patchedGoLiveSource || patchedQualityOverwrite || patchedGoliveQuality;
    const status = {
      active,
      conn: patchedGoLiveSource,
      overwrite: patchedQualityOverwrite,
      golive: patchedGoliveQuality,
    };
    log("stream unlock:", JSON.stringify(status));
    send({ type: "stream-status", status });
  }

  // -------------------------------------------------------------------------
  // Command channel from preload: the persisted stream-unlock config, sent on
  // load and whenever the user changes a setting. (Rich Presence is handled by
  // Discord's own RPC code via the discord_rpc transport facade in the shim.)
  // -------------------------------------------------------------------------

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d) return;
    if (d.source === "dr-wp-cmd" && d.type === "config") {
      applyStreamUnlock(d.config);
    }
  });

  log("patcher injected; module require " + (wreq ? "captured" : "pending"));
})();
