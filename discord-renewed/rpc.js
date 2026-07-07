// rpc.js — runs in the MAIN process. RAW transport for Discord Rich Presence.
//
// Approach: instead of reimplementing the Discord RPC protocol ourselves, we let
// Discord's OWN web code run its RPC server — it does the handshake, connection
// registration, application resolution and presence correctly. Discord drives
// this through the native `discord_rpc` module's transport facade (RPCIPC), which
// we can't bridge across contextBridge (it wraps Node net with server/socket
// objects). So we run the real Node IPC pipe server HERE and expose a thin relay:
// the DiscordNative shim reimplements the discord_rpc facade in the page and
// drives this transport over IPC. We move raw bytes; Discord's code parses them.
//
// Windows named pipe path uses the \\?\pipe\ namespace (same object as \\.\pipe\).

const net = require("net");

function slotPath(i) {
  return `\\\\?\\pipe\\discord-ipc-${i}`;
}

class RpcTransport {
  // `send(type, payload)` relays an event to the renderer (→ the shim facade).
  constructor(send) {
    this.send = send;
    this.server = null;
    this.conns = new Map();
    this.nextId = 1;
  }

  // Find the first ipc slot (0-9) that's free to LISTEN on. Discord calls
  // getAvailableSocket to pick a slot before creating its server; we answer with
  // a slot we can actually bind. Returns a Promise<path|null>.
  findFreeSlot() {
    return new Promise((resolve) => {
      let i = 0;
      const tryNext = () => {
        if (i > 9) return resolve(null);
        const p = slotPath(i);
        const probe = net.createServer();
        probe.once("error", () => { try { probe.close(); } catch {} ; i++; tryNext(); });
        probe.listen(p, () => probe.close(() => resolve(p)));
      };
      tryNext();
    });
  }

  // Start the real IPC server on `path` and relay connections/data to the shim.
  listen(path) {
    if (this.server) return;
    const server = net.createServer((socket) => this._onConn(socket));
    server.on("error", (e) => this.send("server-error", { message: e.message }));
    server.listen(path, () => {
      this.server = server;
      this.send("listening", { path });
    });
  }

  _onConn(socket) {
    const id = this.nextId++;
    this.conns.set(id, socket);
    socket.on("data", (chunk) => {
      // Relay raw bytes; the shim hands them to Discord's IPC parser.
      this.send("data", { id, data: chunk });
    });
    socket.on("close", () => {
      this.conns.delete(id);
      this.send("conn-close", { id });
    });
    socket.on("error", () => {});
    this.send("connection", { id });
  }

  write(id, data) {
    const s = this.conns.get(id);
    if (s) try { s.write(Buffer.from(data)); } catch {}
  }

  end(id) {
    const s = this.conns.get(id);
    if (s) try { s.end(); } catch {}
  }

  destroy(id) {
    const s = this.conns.get(id);
    if (s) try { s.destroy(); } catch {}
    this.conns.delete(id);
  }

  stop() {
    for (const s of this.conns.values()) try { s.destroy(); } catch {}
    this.conns.clear();
    if (this.server) try { this.server.close(); } catch {}
    this.server = null;
  }
}

module.exports = { RpcTransport, slotPath };
