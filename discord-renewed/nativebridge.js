// nativebridge.js — runs in Discord's MAIN world (injected as a <script> by
// preload.js, before Discord's own bundle loads).
//
// PURPOSE: Discord's web app renders a REDUCED feature set unless it detects the
// native desktop client, which it does by checking for a global `DiscordNative`
// object (the real desktop app's preload exposes it). By defining our own
// `window.DiscordNative` here — backed by Electron via our IPC bridge — we make
// Discord's own code believe it's running in the desktop client, so it renders
// and enables the full desktop experience (Keybinds/push-to-talk, Game Activity,
// advanced Voice settings, native title bar, etc.).
//
// PHASE 0 (validation spike): this is a MINIMAL, mostly-stub implementation whose
// job is to (a) let Discord boot without crashing and (b) prove that desktop-only
// UI actually appears once DiscordNative exists. Every property Discord accesses
// that we haven't explicitly implemented is LOGGED (via the [DiscordRenewed]
// console→terminal forwarder) and safely auto-stubbed, turning the huge native
// API surface into a finite, observable to-do list we fill in over later phases.
//
// The real desktop DiscordNative has these 29 top-level members (Discord
// 1.0.9244, read from its core.asar mainScreenPreload.js): isRenderer,
// setUncaughtExceptionHandler, nativeModules, process, os, app, clipboard, ipc,
// gpuSettings, window, powerMonitor, spellCheck, crashReporter, desktopCapture,
// fileManager, clips, processUtils, powerSaveBlocker, http, accessibility,
// features, settings, userDataCache, thumbar, safeStorage, hardware, riotGames,
// webAuthn, gcEvents. We stub the shape of all of them so feature-detection that
// probes for a member's existence succeeds.

(function installDiscordNative() {
  "use strict";
  if (window.DiscordNative) return; // already installed (double-inject guard)

  var TAG = "[DiscordRenewed][native]";
  function log() {
    try {
      console.log.apply(console, [TAG].concat([].slice.call(arguments)));
    } catch (e) {}
  }


  // Log each unique accessed-but-unimplemented path only once, so the terminal
  // shows a clean checklist of what Discord actually calls rather than a flood.
  var seen = Object.create(null);
  function logOnce(path) {
    if (seen[path]) return;
    seen[path] = true;
    log("unimplemented:", path);
  }


  // A deep auto-stub: any property access returns another auto-stub (so long
  // chains like DiscordNative.x.y.z never throw), and calling it returns
  // undefined. Used as the FALLBACK for anything we haven't explicitly typed.
  function autoStub(path) {
    var fn = function () {
      logOnce(path + "()");
      return undefined;
    };
    return new Proxy(fn, {
      get: function (target, prop) {
        if (prop === Symbol.toPrimitive) return function () { return ""; };
        if (typeof prop === "symbol") return undefined;
        if (prop === "then") return undefined; // don't masquerade as a thenable
        return autoStub(path + "." + String(prop));
      },
      apply: function () {
        logOnce(path + "()");
        return undefined;
      },
    });
  }

  // A tiny event emitter matching the shape discord_rpc's facades spread in
  // (on/once/addListener/removeListener/removeAllListeners/emit).
  function makeEmitter() {
    var listeners = Object.create(null);
    var e = {
      on: function (n, fn) { (listeners[n] = listeners[n] || []).push(fn); return e; },
      addListener: function (n, fn) { return e.on(n, fn); },
      once: function (n, fn) { var g = function () { e.removeListener(n, g); fn.apply(null, arguments); }; return e.on(n, g); },
      removeListener: function (n, fn) { if (listeners[n]) listeners[n] = listeners[n].filter(function (x) { return x !== fn; }); return e; },
      removeAllListeners: function (n) { if (n) delete listeners[n]; else listeners = Object.create(null); return e; },
      emit: function (n) { var a = [].slice.call(arguments, 1); (listeners[n] || []).slice().forEach(function (fn) { try { fn.apply(null, a); } catch (err) {} }); return true; },
    };
    return e;
  }

  // ---- discord_rpc transport facade -----------------------------------------
  // Reimplements the discord_rpc module's transport interface (RPCIPC net server
  // + sockets) in the page, backed by a REAL Node IPC pipe server in the main
  // process (rpc.js) over the dr-rpc-evt/dr-rpc-cmd relay. Discord's OWN RPC code
  // then runs the protocol (handshake, connection/app registration, presence) —
  // which is what makes Rich Presence actually display, unlike a hand-rolled
  // LOCAL_ACTIVITY_UPDATE. Built lazily and cached.
  var rpcConnHandler = null; // Discord's onConnection callback for the IPC server
  var rpcSockets = Object.create(null); // conn id -> socket facade
  var rpcServerEmitter = null; // the IPC server's own emitter (for 'error')
  var rpcListenCb = null; // pending server.listen callback
  var rpcSlotResolvers = Object.create(null);
  var rpcSlotReqId = 1;

  function rpcCmd(obj) {
    try { window.postMessage(Object.assign({ source: "dr-rpc-cmd" }, obj), "*"); } catch (e) {}
  }

  function makeRpcSocket(id) {
    var em = makeEmitter();
    var handshake = false;
    var buf = new Uint8Array(0); // internal read buffer for read(len) (pull mode)
    function recv(data) {
      var u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
      var merged = new Uint8Array(buf.length + u8.length);
      merged.set(buf); merged.set(u8, buf.length); buf = merged;
      // Emit an ArrayBuffer chunk (Discord's web IPC reader works in ArrayBuffers,
      // not Node Buffers), and also leave it buffered for read().
      em.emit("data", u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
    }
    var sock = {
      setHandshakeComplete: function (b) { handshake = b; },
      getHandshakeComplete: function () { return handshake; },
      write: function (data) { rpcCmd({ cmd: "write", id: id, data: new Uint8Array(data.buffer || data) }); },
      end: function (data) { if (data) rpcCmd({ cmd: "write", id: id, data: new Uint8Array(data.buffer || data) }); rpcCmd({ cmd: "end", id: id }); },
      read: function (len) {
        if (len == null) len = buf.length;
        if (len === 0 || buf.length < len) return null;
        var out = buf.slice(0, len); buf = buf.slice(len);
        return out.buffer;
      },
      destroy: function () { rpcCmd({ cmd: "destroy", id: id }); em.removeAllListeners(); },
      __recv: recv,
    };
    // Spread emitter methods onto the socket (matches recastNetSocket's ...emitter).
    for (var k in em) sock[k] = em[k];
    sock.__emit = em.emit;
    return sock;
  }

  function makeRpcServer() {
    var em = makeEmitter();
    rpcServerEmitter = em;
    var server = {
      listening: function () { return true; },
      address: function () { return { port: 0 }; },
      listen: function (socketPath, onListening) {
        rpcListenCb = onListening || null;
        rpcCmd({ cmd: "listen", path: socketPath });
      },
    };
    for (var k in em) server[k] = em[k];
    return server;
  }

  // Events relayed from the main-process transport (rpc.js).
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d.source !== "dr-rpc-evt") return;
    if (d.type === "connection") {
      var sock = makeRpcSocket(d.id);
      rpcSockets[d.id] = sock;
      if (rpcConnHandler) { try { rpcConnHandler(sock); } catch (err) {} }
    } else if (d.type === "data") {
      var s = rpcSockets[d.id]; if (s) s.__recv(d.data);
    } else if (d.type === "conn-close") {
      var s2 = rpcSockets[d.id]; if (s2) { try { s2.__emit("close"); } catch (err) {} delete rpcSockets[d.id]; }
    } else if (d.type === "listening") {
      if (rpcListenCb) { var cb = rpcListenCb; rpcListenCb = null; try { cb(); } catch (err) {} }
    } else if (d.type === "server-error") {
      if (rpcServerEmitter) rpcServerEmitter.emit("error", new Error(d.message || "rpc error"));
    } else if (d.type === "slot") {
      var r = rpcSlotResolvers[d.reqId]; if (r) { r(d.path); delete rpcSlotResolvers[d.reqId]; }
    }
  });

  var discordRpcModule = null;
  function buildDiscordRpc() {
    if (discordRpcModule) return discordRpcModule;
    discordRpcModule = {
      RPCIPC: {
        // Discord calls this to pick a free ipc slot; we answer with one the main
        // process can actually bind (ignoring the client-probe testFn — we bind,
        // not connect).
        getAvailableSocket: function () {
          var reqId = rpcSlotReqId++;
          return new Promise(function (resolve, reject) {
            rpcSlotResolvers[reqId] = function (path) { path ? resolve(path) : reject(new Error("no free ipc slot")); };
            rpcCmd({ cmd: "find-slot", reqId: reqId });
          });
        },
        net: {
          createServer: function (onConnection) {
            rpcConnHandler = onConnection;
            return makeRpcServer();
          },
        },
      },
      // WebSocket transport (port 6463): safe no-op stub for now — the IPC pipe is
      // what games use. Lets Discord's WS setup complete without a real server.
      RPCWebSocket: {
        ws: { Server: function () { return makeEmitter(); } },
        http: {
          createServer: function () {
            var em = makeEmitter();
            var srv = {
              address: function () { return { port: 6463 }; },
              listening: function () { return false; },
              listen: function (_port, _host, cb) { if (typeof cb === "function") cb(); },
              instanceId: 1,
            };
            for (var k in em) srv[k] = em[k];
            return srv;
          },
        },
      },
    };
    return discordRpcModule;
  }

  // Wrap an explicitly-implemented object so that KNOWN members pass through as
  // written, but any UNKNOWN member access is logged and falls back to autoStub.
  // This is what makes the shim self-documenting during development.
  function typed(name, impl) {
    return new Proxy(impl, {
      get: function (target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop === "symbol") return undefined;
        return autoStub(name + "." + String(prop));
      },
    });
  }

  // A no-op event emitter shape (many DiscordNative sub-objects expose on/off/
  // addListener/removeListener). Returns itself for chaining.
  function emitterMethods() {
    return {
      on: function () {},
      off: function () {},
      addListener: function () {},
      removeListener: function () {},
      removeAllListeners: function () {},
    };
  }

  // --- Bridge to our preload/main process ------------------------------------
  // The main world can't do IPC directly; we postMessage to the preload (which
  // relays to main.js) using a dedicated source tag. Phase 0 mostly no-ops, but
  // the scaffold is here so later phases can wire real behavior without
  // restructuring. Fire-and-forget only for now.
  function nativeSend(type, payload) {
    try {
      window.postMessage({ source: "dr-native-cmd", type: type, payload: payload }, "*");
    } catch (e) {}
  }

  // --- Boot-critical concrete values -----------------------------------------
  // These are read synchronously and switched on by Discord early in boot, so
  // they must be REAL values (not stubs). Hardcoded for this machine in Phase 0;
  // Phase 1 sources them from main.js over IPC.
  var PLATFORM = "win32";
  var ARCH = "x64";
  var RELEASE_CHANNEL = "stable";
  var APP_VERSION = "1.0.9244"; // mirrors the installed desktop client

  // NB: `process` and `os` expose their members as VALUE properties (strings/
  // numbers), NOT methods — Discord reads e.g. `DiscordNative.os.release` and
  // calls `.split` on it directly. Implementing `release` as a function made
  // fast-connect/sentry throw "split is not a function" and truncated the bundle
  // load. Keep these as plain values.
  var processShim = typed("process", {
    platform: PLATFORM,
    arch: ARCH,
    // Discord reads a handful of env flags; empty object is safe (missing keys
    // are undefined, which its `?.` reads guard against).
    env: {},
    pid: 0,
  });

  var osShim = typed("os", {
    release: "10.0.26200",
    arch: ARCH,
    appArch: ARCH,
    platform: PLATFORM,
  });

  // Full `app` surface (method set read from Discord 1.0.9244's preload). Several
  // of these are read at boot and their results are string-parsed (e.g. .split on
  // the version/build), so they MUST return real strings, not stubs — returning
  // undefined here breaks Discord's bundle load (only ~519 of ~6600 modules load).
  var BUILD_NUMBER = "9244"; // matches the installed desktop build (1.0.9244)
  var appShim = typed("app", {
    getReleaseChannel: function () { return RELEASE_CHANNEL; },
    getVersion: function () { return APP_VERSION; },
    getBuildNumber: function () { return BUILD_NUMBER; },
    getAppArch: function () { return ARCH; },
    getModuleVersions: function () { return {}; },
    getPath: function () { return ""; },
    setBadgeCount: function (n) { nativeSend("setBadgeCount", n); },
    dock: typed("app.dock", { setBadge: function () {}, bounce: function () { return 0; } }),
    relaunch: function () { nativeSend("relaunch"); },
    getDefaultDoubleClickAction: function () { return "maximize"; },
    pauseFrameEvictor: function () {},
    unpauseFrameEvictor: function () {},
    // Returns a PROMISE — Discord awaits this during i18n boot (calls .then on
    // it). Returning a bare array here left the locale promise rejected and the
    // React app never mounted (blank window).
    getPreferredSystemLanguages: function () { return Promise.resolve(["en-US"]); },
    getOpenOnStart: function () { return false; },
    registerUserInteractionHandler: function () {},
    supportsFeature: function () { return false; },
  });

  var windowShim = typed(
    "window",
    Object.assign(
      {
        USE_OSX_NATIVE_TRAFFIC_LIGHTS: false,
        setDevtoolsCallbacks: function () {},
        setZoomFactor: function (z) { nativeSend("setZoomFactor", z); },
        minimize: function () { nativeSend("win", "minimize"); },
        maximize: function () { nativeSend("win", "maximize"); },
        restore: function () { nativeSend("win", "restore"); },
        close: function () { nativeSend("win", "close"); },
        focus: function () { nativeSend("win", "focus"); },
        blur: function () {},
        fullscreen: function () {},
        flashFrame: function () {},
        setProgressBar: function () {},
        setAlwaysOnTop: function () {},
        isAlwaysOnTop: function () { return false; },
        isMaximized: function () { return false; },
        isFullscreen: function () { return false; },
        setMinimumSize: function () {},
        setMaximumSize: function () {},
      },
      emitterMethods()
    )
  );

  var powerMonitorShim = typed(
    "powerMonitor",
    Object.assign(
      {
        // Idle time in ms; 0 = "active" (safe default until wired to Electron
        // powerMonitor.getSystemIdleTime in a later phase).
        getSystemIdleTimeMs: function () { return 0; },
        getSystemIdleTime: function () { return 0; },
      },
      emitterMethods()
    )
  );

  // Feature flags. Returning false for unknown features is the safe default
  // (Discord treats unsupported features as absent). If discovery shows a
  // feature must be on for parity, we'll flip specific ones in a later phase.
  var featuresShim = typed("features", {
    supports: function () { return false; },
    declareSupported: function () {},
    getSupported: function () { return {}; },
  });

  // Desktop settings store. Discord reads a few keys early; return the provided
  // default so nothing breaks. Backed by our persistent store in a later phase.
  var settingsShim = typed("settings", {
    get: function (key, fallback) { return fallback; },
    set: function () {},
    getAll: function () { return {}; },
  });

  // Native modules (discord_voice/discord_krisp/discord_overlay2/etc). Phase 4
  // will load Discord's REAL prebuilt .node addons here; for the spike we report
  // them absent (returning autoStub) so voice/overlay UI renders but the native
  // paths are inert rather than crashing.
  // Native modules (discord_voice/discord_krisp/discord_overlay2/discord_erlpack/
  // etc). Phase 0 returns an autoStub for every one — enough for Discord's FULL
  // desktop bundle to load and initialize, but the native paths are inert.
  //
  // IMPORTANT (learned in the Phase 0 spike): Discord's desktop connection path
  // genuinely REQUIRES real native modules — it uses erlpack (ETF) for the
  // gateway and does NOT fall back to JSON when the module is absent, and it does
  // NOT wrap requireModule in try/catch (throwing here breaks the bundle load).
  // So a stub lets the bundle load but the gateway can't connect (fast-connect
  // throws on erlpack.pack(...).buffer). Real rendering therefore depends on the
  // Phase 4 native-module bridge (confirmed: Discord's real .node addons load
  // under our Electron 43). Until then this whole shim is gated OFF by default.
  // Safe main-world stubs for native modules we don't (yet) bridge as real
  // addons, covering the methods Discord calls during boot with correct return
  // types (Promises where it awaits). Unknown methods fall back to autoStub.
  var MODULE_STUBS = {
    discord_utils: {
      getGPUDriverVersions: function () { return Promise.resolve({}); },
      getDiscordMemoryUsage: function () { return 0; },
      getDiscordMemoryUsageElectronRenderer: function () { return 0; },
      isSystemDarkMode: function () { return true; },
      getDiscordIsElevated: function () { return false; },
      isHardwareAcceleratedGPUSchedulingEnabled: function () { return false; },
      nativePermssionHasAuthorization: function () { return true; },
      shouldDisplayNotifications: function () { return true; },
      setGameCandidateOverrides: function () {},
    },
    discord_media: {
      getSystemAnalyticsBlob: function () { return Promise.resolve({}); },
      getMemoryUsageBlob: function () { return Promise.resolve({}); },
      getGpuStats: function () { return Promise.resolve({}); },
    },
  };

  // Native modules we report as UNAVAILABLE (requireModule → null) so Discord
  // takes its non-native fallback. discord_zstd: fall back to zlib-stream gateway
  // compression (bridging the real native streaming decompressor crashed the
  // renderer). Returning null — NOT a stub — is what makes Discord pick the
  // fallback rather than assume the module works.
  var NULL_MODULES = { discord_zstd: 1 };

  var nativeModulesShim = typed("nativeModules", {
    requireModule: function (name) {
      // Rich Presence: return our transport facade so Discord runs its own RPC.
      if (name === "discord_rpc") {
        logOnce("nativeModules.requireModule(discord_rpc) -> transport facade");
        return buildDiscordRpc();
      }
      if (NULL_MODULES[name]) {
        logOnce("nativeModules.requireModule(" + name + ") -> null (fallback)");
        return null;
      }
      // Prefer a REAL native module bridged from the preload (see
      // native-modules.js + setupNativeModuleBridge in preload.js). erlpack must
      // be real for the gateway to connect; others fall back to autoStub until
      // they're bridged in later phases.
      var bridge = window.__drNativeBridge;
      if (bridge && bridge.availableModules && bridge.availableModules.indexOf(name) !== -1) {
        var real = bridge.requireModule(name);
        if (real) {
          logOnce("nativeModules.requireModule(" + name + ") -> real");
          // Wrap so bridged (real) methods pass through, but any method we didn't
          // bridge falls back to a safe auto-stub instead of throwing "not a
          // function" — Discord calls methods beyond the curated allowlist.
          return typed("nativeModules[" + name + "]", real);
        }
      }
      if (MODULE_STUBS[name]) {
        logOnce("nativeModules.requireModule(" + name + ") -> jsstub");
        return typed("nativeModules[" + name + "]", MODULE_STUBS[name]);
      }
      logOnce("nativeModules.requireModule(" + name + ") -> stub");
      return autoStub("nativeModules[" + name + "]");
    },
    ensureModule: function () { return Promise.resolve(); },
    canBootstrapNewUpdater: false,
    globalPaths: [],
  });

  // Screen/window capture. Our main.js already brokers getDisplayMedia via
  // setDisplayMediaRequestHandler, so Discord's standard web path handles real
  // capture; this returns an empty source list (Discord falls back gracefully).
  var desktopCaptureShim = typed("desktopCapture", {
    getDesktopCaptureSources: function () { return Promise.resolve([]); },
  });

  // Pure path helpers Discord's fileManager exposes — safe to implement in JS.
  var fileManagerShim = typed("fileManager", {
    extname: function (p) { var m = /(\.[^.\/\\]+)$/.exec(p || ""); return m ? m[1] : ""; },
    basename: function (p) { return String(p || "").split(/[\\\/]/).pop(); },
    dirname: function (p) { var a = String(p || "").split(/[\\\/]/); a.pop(); return a.join("/"); },
    join: function () { return [].slice.call(arguments).join("/"); },
    getModulePath: function () { return ""; },
    readLogFiles: function () { return Promise.resolve([]); },
  });

  var ipcShim = typed(
    "ipc",
    Object.assign(
      {
        send: function () {},
        invoke: function () { return Promise.resolve(); },
      },
      emitterMethods()
    )
  );

  var spellCheckShim = typed(
    "spellCheck",
    Object.assign(
      {
        getAvailableLanguages: function () { return Promise.resolve([]); },
        getAvailableDictionaries: function () { return Promise.resolve([]); },
        setLanguages: function () {},
        setLocale: function () { return Promise.resolve(); },
        replaceMisspelling: function () {},
      },
      emitterMethods()
    )
  );

  var processUtilsShim = typed("processUtils", {
    getCurrentCPUUsagePercent: function () { return 0; },
    getCPUCoreCount: function () { return (navigator && navigator.hardwareConcurrency) || 4; },
    getProcessUptime: function () { return 0; },
    getMemoryInfo: function () { return Promise.resolve({}); },
    getUsedHeapSize: function () { return 0; },
    getSystemInfo: function () { return {}; },
    getMainArgvSync: function () { return []; },
    // Returns a PROMISE — Sentry init awaits the last-crash info; undefined broke it.
    getLastCrash: function () { return Promise.resolve(null); },
    purgeMemory: function () {},
    flushDNSCache: function () {},
    flushCookies: function () {},
    flushStorageData: function () {},
    setCrashInterceptCallback: function () {},
    setMemoryInformation: function () {},
  });

  // The full DiscordNative object. Members we haven't concretely implemented get
  // an autoStub (via `typed`) so their mere existence satisfies feature probes
  // and any calls are logged rather than throwing.
  var DiscordNative = typed("DiscordNative", {
    isRenderer: true,
    setUncaughtExceptionHandler: function () {},
    nativeModules: nativeModulesShim,
    process: processShim,
    os: osShim,
    app: appShim,
    clipboard: typed("clipboard", {
      copy: function () {},
      cut: function () {},
      paste: function () { return ""; },
      read: function () { return ""; },
      copyImage: function () {},
    }),
    ipc: ipcShim,
    gpuSettings: typed("gpuSettings", {
      getEnableHardwareAcceleration: function () { return true; },
      setEnableHardwareAcceleration: function () {},
    }),
    window: windowShim,
    powerMonitor: powerMonitorShim,
    spellCheck: spellCheckShim,
    crashReporter: typed("crashReporter", {
      updateCrashReporter: function () {},
      getGpuCrashReports: function () { return []; },
    }),
    desktopCapture: desktopCaptureShim,
    fileManager: fileManagerShim,
    clips: typed("clips", {}),
    processUtils: processUtilsShim,
    powerSaveBlocker: typed("powerSaveBlocker", {
      blockDisplaySleep: function () { return 0; },
      cleanupDisplaySleep: function () {},
    }),
    http: typed("http", {
      makeChunkedRequest: function () { return Promise.resolve(); },
    }),
    accessibility: typed(
      "accessibility",
      Object.assign({ isAccessibilitySupportEnabled: function () { return false; } }, emitterMethods())
    ),
    features: featuresShim,
    settings: settingsShim,
    userDataCache: typed("userDataCache", {
      getCached: function () { return Promise.resolve(null); },
      cacheUserData: function () {},
    }),
    thumbar: typed("thumbar", { setThumbarButtons: function () { return Promise.resolve(); } }),
    safeStorage: typed("safeStorage", {
      isEncryptionAvailable: function () { return false; },
      encryptString: function () { return ""; },
      decryptString: function () { return ""; },
    }),
    hardware: typed("hardware", {}),
    riotGames: typed("riotGames", {}),
    webAuthn: typed("webAuthn", {}),
    gcEvents: typed("gcEvents", emitterMethods()),
  });

  window.DiscordNative = DiscordNative;
  log("DiscordNative shim installed (Phase 0 spike)");
})();
