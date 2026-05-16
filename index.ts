// ── Sock-Chain: raw SOCKS5 relay ──
// Server:  opens port 1080, relays raw TCP bytes to client
// Client:  starts a local SOCKS5 proxy, connects to server,
//          forwards relayed bytes through its SOCKS5 proxy
// Users:   connect to server:1080 as a SOCKS5 proxy

import * as net from "net";
import * as dns from "dns";

// ── Relay protocol ──
// Frame: [connId:4][type:1][payloadLen:4][payload...]
const FRAME_CONNECT = 0x01;
const FRAME_DATA    = 0x02;
const FRAME_CLOSE   = 0x03;
const HDR_SIZE = 9;

function toBuf(d: string | Buffer): Buffer {
  return typeof d === "string" ? Buffer.from(d) : d;
}

function frameHeader(connId: number, type: number, payloadLen: number): Buffer {
  const h = Buffer.alloc(HDR_SIZE);
  h.writeUInt32BE(connId, 0);
  h[4] = type;
  h.writeUInt32BE(payloadLen, 5);
  return h;
}

function writeFrame(sock: net.Socket, connId: number, type: number, payload: Buffer): boolean {
  return sock.write(Buffer.concat([frameHeader(connId, type, payload.length), payload]));
}

class FrameStream {
  buf = Buffer.alloc(0);

  push(data: Buffer) {
    this.buf = Buffer.concat([this.buf, data]);
    const frames: { connId: number; type: number; payload: Buffer }[] = [];
    while (this.buf.length >= HDR_SIZE) {
      const payloadLen = this.buf.readUInt32BE(5);
      const totalLen = HDR_SIZE + payloadLen;
      if (this.buf.length < totalLen) break;
      frames.push({
        connId: this.buf.readUInt32BE(0),
        type: this.buf[4]!,
        payload: this.buf.subarray(HDR_SIZE, totalLen),
      });
      this.buf = this.buf.subarray(totalLen);
    }
    return frames;
  }

  reset() { this.buf = Buffer.alloc(0); }
}

function now(): string {
  return new Date().toISOString().slice(11, 19);
}

// ── Server ──

function startServer(listenPort: number, controlPort: number) {
  let ctrl: net.Socket | null = null;
  let nextConnId = 1;
  const users = new Map<number, net.Socket>();
  const frameStream = new FrameStream();

  // Flush queued data to user socket when it drains
  function flushUser(connId: number, q: Buffer[]) {
    const user = users.get(connId);
    if (!user) return;
    while (q.length > 0) {
      if (!user.write(q[0]!)) {
        user.once("drain", () => flushUser(connId, q));
        return;
      }
      q.shift();
    }
  }

  // Control channel — client connects here
  net.createServer((s) => {
    const ctrlAddr = `${s.remoteAddress}:${s.remotePort}`;
    console.log(`[${now()}] client connected from ${ctrlAddr}`);
    ctrl = s;
    frameStream.reset();
    const userQueues = new Map<number, Buffer[]>();

    s.on("data", (d: string | Buffer) => {
      for (const f of frameStream.push(toBuf(d))) {
        if (f.type === FRAME_DATA) {
          const user = users.get(f.connId);
          if (!user || user.destroyed) continue;
          if (!user.write(f.payload)) {
            let q = userQueues.get(f.connId);
            if (!q) { q = []; userQueues.set(f.connId, q); }
            q.push(f.payload);
            user.once("drain", () => flushUser(f.connId, q));
          }
        } else if (f.type === FRAME_CLOSE) {
          const user = users.get(f.connId);
          if (user) user.end();
          users.delete(f.connId);
          userQueues.delete(f.connId);
        }
      }
    });

    s.on("close", () => {
      console.log(`[${now()}] client disconnected`);
      ctrl = null;
      users.forEach((user) => user.destroy());
      users.clear();
    });
    s.on("error", () => {});
  }).listen(controlPort, () => console.log(`[${now()}] server control on ${controlPort}`));

  // Forward port — users connect here
  net.createServer((user) => {
    const userAddr = `${user.remoteAddress}:${user.remotePort}`;
    if (!ctrl || ctrl.destroyed) { user.end(); return; }
    const c = ctrl;
    const connId = nextConnId++;
    users.set(connId, user);
    console.log(`[${now()}] [+] conn#${connId} from ${userAddr} (${users.size} active)`);

    writeFrame(c, connId, FRAME_CONNECT, Buffer.alloc(0));

    user.on("data", (d: string | Buffer) => {
      if (!writeFrame(c, connId, FRAME_DATA, toBuf(d))) {
        user.pause();
        c.once("drain", () => { if (!user.destroyed) user.resume(); });
      }
    });
    user.on("close", () => {
      console.log(`[${now()}] [-] conn#${connId} closed (${users.size} active)`);
      writeFrame(c, connId, FRAME_CLOSE, Buffer.alloc(0));
      users.delete(connId);
    });
    user.on("error", () => {});
  }).listen(listenPort, () => console.log(`[${now()}] server forward on ${listenPort}`));
}

// ── Client ──

const SOCKS_VERSION = 0x05;
const METHOD_NO_AUTH = 0x00;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const REP_SUCCEEDED = 0x00;
const REP_GENERAL_FAILURE = 0x01;

function parseAddress(buf: Buffer, offset = 0) {
  const atyp = buf[offset]!;
  if (atyp === ATYP_IPV4) {
    return {
      addr: Array.from(buf.slice(offset + 1, offset + 5)).join("."),
      port: buf.readUInt16BE(offset + 5),
    };
  }
  const len = buf[offset + 1]!;
  return {
    addr: buf.slice(offset + 2, offset + 2 + len).toString(),
    port: buf.readUInt16BE(offset + 2 + len),
  };
}

function socks5Reply(rep: number): Buffer {
  const b = Buffer.alloc(10);
  b[0] = SOCKS_VERSION; b[1] = rep; b[2] = 0x00; b[3] = ATYP_IPV4;
  b.writeUInt32BE(0, 4); b.writeUInt16BE(0, 8);
  return b;
}

function startSocks5Proxy(port: number): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer((client) => {
      // Accumulate data until we have enough to parse
      // After CONNECT is handled, the listener is removed and pipe() takes over
      let buf = Buffer.alloc(0);
      let step: "handshake" | "request" = "handshake";

      function onData(chunk: string | Buffer) {
        buf = Buffer.concat([buf, toBuf(chunk)]);

        if (step === "handshake") {
          if (buf.length < 3) return;
          if (buf[0] !== SOCKS_VERSION) { client.end(); return; }
          client.write(Buffer.from([SOCKS_VERSION, METHOD_NO_AUTH]));
          buf = buf.subarray(3);
          step = "request";
        }

        if (step === "request") {
          if (buf.length < 5) return;
          if (buf[0] !== SOCKS_VERSION || buf[1] !== CMD_CONNECT) {
            client.write(socks5Reply(0x07));
            client.end();
            return;
          }
          const atyp = buf[3]!;
          let need: number;
          if (atyp === ATYP_IPV4) need = 10;
          else need = 7 + buf[4]!;
          if (buf.length < need) return;

          client.removeListener("data", onData);  // let pipe() take over

          try {
            const { addr, port } = parseAddress(buf, 3);
            const leftover = buf.subarray(need);

            dns.lookup(addr, (err, ip) => {
              if (err) {
                try { client.write(socks5Reply(REP_GENERAL_FAILURE)); } catch {}
                client.end();
                return;
              }
              const target = net.createConnection({ host: ip, port });
              target.setTimeout(15000);
              target.on("connect", () => {
                target.setTimeout(0);
                client.write(socks5Reply(REP_SUCCEEDED));
                if (leftover.length > 0) target.write(leftover);
                client.pipe(target);
                target.pipe(client);
              });
              target.on("error", () => {
                if (target.destroyed) return;
                try { client.write(socks5Reply(REP_GENERAL_FAILURE)); } catch {}
                client.end();
              });
              target.on("timeout", () => {
                target.destroy();
                try { client.write(socks5Reply(REP_GENERAL_FAILURE)); } catch {}
                client.end();
              });
            });
          } catch { client.end(); }
        }
      }

      client.on("data", onData);
      client.on("error", () => {});
    });

    server.listen(port, () => {
      const addr = server.address()!;
      const actualPort = typeof addr === "object" ? addr.port : port;
      console.log(`[${now()}] client socks5 proxy on ${actualPort}`);
      resolve(actualPort);
    });
  });
}

function startClient(serverHost: string, serverPort: number, proxyPort: number) {
  const proxyConns = new Map<number, net.Socket>();
  const pending = new Map<number, Buffer[]>();
  const frameStream = new FrameStream();

  const ctrl = net.createConnection({ host: serverHost, port: serverPort }, () =>
    console.log(`[${now()}] client connected to ${serverHost}:${serverPort}`));

  ctrl.on("data", (d: string | Buffer) => {
    for (const f of frameStream.push(toBuf(d))) {
      if (f.type === FRAME_CONNECT) {
        const proxy = net.createConnection({ host: "127.0.0.1", port: proxyPort }, () => {
          const buf = pending.get(f.connId);
          if (buf) {
            for (const chunk of buf) proxy.write(chunk);
            pending.delete(f.connId);
          }
          proxy.on("data", (pd: string | Buffer) => {
            const data = toBuf(pd);
            if (!writeFrame(ctrl, f.connId, FRAME_DATA, data)) {
              proxy.pause();
              ctrl.once("drain", () => { if (!proxy.destroyed) proxy.resume(); });
            }
          });
          proxy.on("close", () => {
            writeFrame(ctrl, f.connId, FRAME_CLOSE, Buffer.alloc(0));
            proxyConns.delete(f.connId);
          });
          proxy.on("error", () => {});
        });
        proxy.on("error", (e: Error) => {
          console.log(`[${now()}] proxy#${f.connId}: ${e.message}`);
          pending.delete(f.connId);
          proxyConns.delete(f.connId);
        });
        proxyConns.set(f.connId, proxy);
      } else if (f.type === FRAME_DATA) {
        const proxy = proxyConns.get(f.connId);
        if (proxy && !proxy.destroyed && proxy.readyState === "open") {
          if (!proxy.write(f.payload)) {
            const proxy2 = proxy;
            let q = pending.get(f.connId);
            if (!q) { q = []; pending.set(f.connId, q); }
            q.push(f.payload);
            proxy2.once("drain", () => {
              const q2 = pending.get(f.connId);
              if (!q2) return;
              while (q2.length > 0) {
                if (!proxy2.write(q2[0]!)) { proxy2.once("drain", () => {}); return; }
                q2.shift();
              }
              pending.delete(f.connId);
            });
          }
        } else {
          let q = pending.get(f.connId);
          if (!q) { q = []; pending.set(f.connId, q); }
          q.push(f.payload);
        }
      } else if (f.type === FRAME_CLOSE) {
        const proxy = proxyConns.get(f.connId);
        if (proxy) proxy.end();
        proxyConns.delete(f.connId);
        pending.delete(f.connId);
      }
    }
  });

  ctrl.on("close", () => {
    console.log(`[${now()}] client disconnected from server`);
    proxyConns.forEach((p) => p.destroy());
    proxyConns.clear();
    pending.clear();
  });
  ctrl.on("error", (e: Error) => console.error(`[${now()}] client error:`, e.message));
}

// ── CLI ──

const args = process.argv.slice(2);
const isServer = args.includes("--server");

const listenPort = (() => {
  const i = args.indexOf("--port");
  return i >= 0 ? parseInt(args[i + 1]!) : 1080;
})();

if (isServer) {
  const controlPort = (() => {
    const i = args.indexOf("--control-port");
    return i >= 0 ? parseInt(args[i + 1]!) : 2080;
  })();
  startServer(listenPort, controlPort);
} else {
  const serverHost = (() => {
    const i = args.indexOf("--server-host");
    return i >= 0 ? args[i + 1]! : "127.0.0.1";
  })();
  const serverPort = (() => {
    const i = args.indexOf("--server-port");
    return i >= 0 ? parseInt(args[i + 1]!) : 2080;
  })();
  const proxyPort = (() => {
    const i = args.indexOf("--proxy-port");
    return i >= 0 ? parseInt(args[i + 1]!) : 0;
  })();
  startSocks5Proxy(proxyPort).then((actualProxyPort) => {
    startClient(serverHost, serverPort, actualProxyPort);
  });
}
