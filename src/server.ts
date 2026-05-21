import * as net from "net";
import { serve } from "bun";
import { config } from "./config";
import {
  FRAME_CONNECT, FRAME_DATA, FRAME_CLOSE, FRAME_META,
  toBuf, wsWriteFrame, parseFrame, now,
  parseAddress, socks5Reply, socks5TargetAddr,
  SOCKS_VERSION, METHOD_NO_AUTH, CMD_CONNECT,
  ATYP_IPV4,
  REP_SUCCEEDED, REP_GENERAL_FAILURE,
} from "./utils";

interface ClientState {
  userQueues: Map<number, Buffer[]>;
}

interface ClientInfo {
  id: number;
  ip: string;
  hostname: string;
  platform: string;
  connectedAt: string;
  [key: string]: unknown;
}

export function startServer(listenPort: number, controlPort: number) {
  const clients = new Map<any, ClientState>();
  const clientInfo = new Map<any, ClientInfo>();
  const clientConns = new Map<number, any>();
  const users = new Map<number, net.Socket>();
  const userDraining = new Set<net.Socket>();
  let nextConnId = 1;
  let nextClientId = 1;

  function pickClient(): any | null {
    const pool = Array.from(clients.keys());
    if (pool.length === 0) return null;
    return pool[Math.floor(Math.random() * pool.length)]!;
  }

  function flushUser(connId: number, q: Buffer[]) {
    const user = users.get(connId);
    if (!user) return;
    while (q.length > 0) {
      if (!user.write(q[0]!)) {
        if (!userDraining.has(user)) {
          userDraining.add(user);
          user.once("drain", () => {
            userDraining.delete(user);
            flushUser(connId, q);
          });
        }
        return;
      }
      q.shift();
    }
  }

  // Control channel — WebSocket
  serve({
    port: controlPort,
    fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === "/clients") {
        const list = Array.from(clientInfo.entries()).map(([ws, info]) => ({
          ...info,
          connections: Array.from(clientConns.values()).filter(c => c === ws).length,
        }));
        return new Response(JSON.stringify(list, null, 2), {
          headers: { "Content-Type": "application/json" },
        });
      }

      const ip = server.requestIP(req)?.address || "unknown";

      if (server.upgrade(req, { data: { ip } })) return;
      const list = Array.from(clientInfo.entries()).map(([ws, info]) => ({
        ...info,
        connections: Array.from(clientConns.values()).filter(c => c === ws).length,
      }));
      return new Response(JSON.stringify(list, null, 2), {
        status: 426,
        headers: { "Content-Type": "application/json" },
      });
    },
    websocket: {
      pingInterval: config.server.pingInterval,
      open(ws) {
        const info: ClientInfo = {
          id: nextClientId++,
          ip: ws.data.ip,
          hostname: "unknown",
          platform: "unknown",
          connectedAt: new Date().toISOString(),
        };
        clientInfo.set(ws, info);
        clients.set(ws, { userQueues: new Map() });
        console.log(`[${now()}] [+] client #${info.id} ${info.ip} (${clients.size} connected)`);
      },
      message(ws, data) {
        if (typeof data === "string") return;
        const f = parseFrame(data);

        if (f.type === FRAME_DATA) {
          const user = users.get(f.connId);
          if (!user || user.destroyed) return;
          if (!user.write(f.payload)) {
            let q = clients.get(ws)?.userQueues.get(f.connId);
            if (!q) {
              q = [];
              const st = clients.get(ws);
              if (st) st.userQueues.set(f.connId, q);
            }
            q.push(f.payload);
            if (!userDraining.has(user)) {
              userDraining.add(user);
              user.once("drain", () => {
                userDraining.delete(user);
                flushUser(f.connId, q);
              });
            }
          }
        } else if (f.type === FRAME_CLOSE) {
          const user = users.get(f.connId);
          if (user) user.end();
          users.delete(f.connId);
          clientConns.delete(f.connId);
          const st = clients.get(ws);
          if (st) st.userQueues.delete(f.connId);
        } else if (f.type === FRAME_META) {
          const info = clientInfo.get(ws);
          if (info) {
            try {
              const meta = JSON.parse(f.payload.toString());
              delete meta.id;
              delete meta.ip;
              delete meta.connectedAt;
              Object.assign(info, meta);
            } catch {}
          }
        }
      },
      close(ws) {
        const info = clientInfo.get(ws);
        if (info) console.log(`[${now()}] [-] client #${info.id} ${info.ip} (${clients.size - 1} connected)`);
        else console.log(`[${now()}] [-] client (${clients.size - 1} connected)`);
        clientInfo.delete(ws);
        clients.delete(ws);
        for (const [connId, cs] of clientConns) {
          if (cs === ws) {
            const user = users.get(connId);
            if (user) user.end();
            users.delete(connId);
            clientConns.delete(connId);
          }
        }
      },
    },
  });
  console.log(`[${now()}] server control on ${controlPort}`);

  // Forward port — users connect here (SOCKS5)
  net.createServer((user) => {
    const userAddr = `${user.remoteAddress}:${user.remotePort}`;
    let buf = Buffer.alloc(0);
    let step: "handshake" | "request" | "relay" = "handshake";
    let connId = -1;
    let c: any = null;

    function onData(d: string | Buffer) {
      buf = Buffer.concat([buf, toBuf(d)]);

      if (step === "handshake") {
        if (buf.length < 3) return;
        const nmethods = buf[1]!;
        const greetingLen = 2 + nmethods;
        if (buf.length < greetingLen) return;
        if (buf[0] !== SOCKS_VERSION) { user.end(); return; }
        user.write(Buffer.from([SOCKS_VERSION, METHOD_NO_AUTH]));
        buf = buf.subarray(greetingLen);
        step = "request";
      }

      if (step === "request") {
        if (buf.length < 5) return;
        if (buf[0] !== SOCKS_VERSION || buf[1] !== CMD_CONNECT) {
          try { user.write(socks5Reply(0x07)); } catch {}
          user.end();
          return;
        }
        const atyp = buf[3]!;
        let need: number;
        if (atyp === ATYP_IPV4) need = 10;
        else need = 7 + buf[4]!;
        if (buf.length < need) return;

        user.removeListener("data", onData);

        try {
          const { addr, port: targetPort } = parseAddress(buf, 3);
          const leftover = buf.subarray(need);
          const addrPayload = socks5TargetAddr(atyp, buf, 3);

          c = pickClient();
          if (!c) {
            try { user.write(socks5Reply(REP_GENERAL_FAILURE)); } catch {}
            user.end();
            console.log(`[${now()}] no clients, rejected ${userAddr}`);
            return;
          }

          connId = nextConnId++;
          users.set(connId, user);
          clientConns.set(connId, c);
          console.log(`[${now()}] [+] conn#${connId} ${addr}:${targetPort} via ${userAddr} (${users.size} active)`);

          wsWriteFrame(c, connId, FRAME_CONNECT, addrPayload);
          try { user.write(socks5Reply(REP_SUCCEEDED)); } catch {}

          if (leftover.length > 0) {
            wsWriteFrame(c, connId, FRAME_DATA, leftover);
          }

          step = "relay";
          user.on("data", (d2: string | Buffer) => {
            wsWriteFrame(c, connId, FRAME_DATA, toBuf(d2));
          });
          user.on("close", () => {
            console.log(`[${now()}] [-] conn#${connId} closed (${users.size - 1} active)`);
            wsWriteFrame(c, connId, FRAME_CLOSE, Buffer.alloc(0));
            users.delete(connId);
            clientConns.delete(connId);
            const st = clients.get(c);
            if (st) st.userQueues.delete(connId);
          });
          user.on("error", () => {});
        } catch {
          try { user.write(socks5Reply(REP_GENERAL_FAILURE)); } catch {}
          user.end();
        }
      }
    }

    user.on("data", onData);
    user.on("error", () => {});
  }).listen(listenPort, "0.0.0.0", () => console.log(`[${now()}] server forward on ${listenPort}`));
}
