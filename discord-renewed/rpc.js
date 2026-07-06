// rpc.js — runs in the MAIN process. Implements Discord's local Rich Presence
// IPC server (the thing games/apps connect to via discord-rpc / the Game SDK to
// show "Playing X" with details). The real desktop client runs this; our spoofed
// client loads Discord's WEB bundle, which tries to stand the server up through
// the native discord_rpc module — impractical to bridge (it wraps Node net/http
// with server/socket objects that don't survive contextBridge). So we run our own
// server here (arRPC-style) and hand received activities to the renderer, which
// injects them into Discord via our webpack access.
//
// Protocol (Discord IPC): a Windows named pipe \\.\pipe\discord-ipc-<0-9>. Each
// message is an 8-byte little-endian header (opcode uint32, length uint32)
// followed by a UTF-8 JSON payload. Opcodes: 0 HANDSHAKE, 1 FRAME, 2 CLOSE,
// 3 PING, 4 PONG. A client sends HANDSHAKE {v:1, client_id}; we reply with a
// DISPATCH/READY frame; then it sends FRAME {cmd:"SET_ACTIVITY", nonce, args:
// {pid, activity}} which we ack and forward.

const net = require("net");
const { EventEmitter } = require("events");

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

// Windows named-pipe path for a given IPC slot.
function pipePath(i) {
  return `\\\\.\\pipe\\discord-ipc-${i}`;
}

// Encode one IPC message (opcode + JSON payload) into a framed Buffer.
function encode(op, payload) {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(8);
  header.writeInt32LE(op, 0);
  header.writeInt32LE(json.length, 4);
  return Buffer.concat([header, json]);
}

// A connected RPC client. Buffers incoming bytes and emits complete frames.
class RpcConnection extends EventEmitter {
  constructor(socket, server) {
    super();
    this.socket = socket;
    this.server = server;
    this.buffer = Buffer.alloc(0);
    this.clientId = null;
    this.handshaken = false;

    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("close", () => this.emit("close"));
    socket.on("error", () => {}); // ignore; close will follow
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // Drain as many complete frames as we have.
    while (this.buffer.length >= 8) {
      const op = this.buffer.readInt32LE(0);
      const len = this.buffer.readInt32LE(4);
      if (this.buffer.length < 8 + len) break; // wait for the rest
      const payloadBuf = this.buffer.subarray(8, 8 + len);
      this.buffer = this.buffer.subarray(8 + len);
      let payload = null;
      try {
        payload = JSON.parse(payloadBuf.toString("utf8"));
      } catch {
        this.close();
        return;
      }
      this._handleFrame(op, payload);
    }
  }

  _handleFrame(op, payload) {
    if (op === OP_HANDSHAKE) {
      this.clientId = payload && (payload.client_id || payload.clientId);
      this.handshaken = true;
      // Minimal READY dispatch so the client considers itself connected.
      this.send(OP_FRAME, {
        cmd: "DISPATCH",
        evt: "READY",
        data: {
          v: 1,
          config: { cdn_host: "cdn.discordapp.com", api_endpoint: "//discord.com/api", environment: "production" },
          user: this.server.selfUser || { id: "0", username: "user", discriminator: "0", avatar: null },
        },
      });
      this.emit("handshake", this.clientId);
      return;
    }
    if (op === OP_PING) {
      this.send(OP_PONG, payload);
      return;
    }
    if (op === OP_CLOSE) {
      this.close();
      return;
    }
    if (op === OP_FRAME) {
      const cmd = payload && payload.cmd;
      if (cmd === "SET_ACTIVITY") {
        const args = payload.args || {};
        this.server.emit("activity", {
          clientId: this.clientId,
          pid: args.pid,
          activity: args.activity || null,
          socketId: this.id,
        });
        // Ack the command (echo the activity back as the response data).
        this.send(OP_FRAME, { cmd: "SET_ACTIVITY", evt: null, nonce: payload.nonce, data: args.activity || null });
      } else if (payload && payload.nonce) {
        // Unknown/unsupported command — ack so the client isn't left hanging.
        this.send(OP_FRAME, { cmd, evt: null, nonce: payload.nonce, data: null });
      }
    }
  }

  send(op, payload) {
    try {
      this.socket.write(encode(op, payload));
    } catch {}
  }

  close() {
    try {
      this.socket.end();
    } catch {}
  }
}

// The RPC server: binds the first free discord-ipc pipe and tracks connections.
// Emits "activity" ({clientId, pid, activity}) when a client sets its presence,
// and "activity-clear" when a client disconnects (so we can drop its presence).
class RpcServer extends EventEmitter {
  constructor() {
    super();
    this.servers = [];
    this.connections = new Map();
    this.nextId = 1;
    this.selfUser = null;
  }

  // Try to bind ipc slots 0..9 (like the real client; multiple can coexist).
  start() {
    for (let i = 0; i <= 9; i++) this._bind(i);
  }

  _bind(i) {
    const server = net.createServer((socket) => this._onConnection(socket));
    server.on("error", () => {
      // Slot taken (e.g. the real Discord client is running) — that's fine.
      try { server.close(); } catch {}
    });
    try {
      server.listen(pipePath(i), () => {
        console.log("[DiscordRenewed][rpc] listening on discord-ipc-" + i);
      });
      this.servers.push(server);
    } catch {}
  }

  _onConnection(socket) {
    const conn = new RpcConnection(socket, this);
    conn.id = this.nextId++;
    this.connections.set(conn.id, conn);
    conn.on("close", () => {
      this.connections.delete(conn.id);
      this.emit("activity-clear", { socketId: conn.id });
    });
  }

  stop() {
    for (const s of this.servers) {
      try { s.close(); } catch {}
    }
    this.servers = [];
  }
}

module.exports = { RpcServer };
