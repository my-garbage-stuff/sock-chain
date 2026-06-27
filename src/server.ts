// Server: accepts HTTP CONNECT users and routes traffic to connected clients via framed TCP.

import { listen } from "bun";
import { config } from "./config";
import {
  FRAME_CONNECT, FRAME_DATA, FRAME_CLOSE, FRAME_META,
  CLIENT_MAGIC,
  bunWriteFrame, FrameStream, now, randomUUID,
  tryParseConnect, makeConnectResponse, encodeTargetAddr,
} from "./utils";

interface ClientState {
  userQueues: Map<number, Buffer[]>;
  fs: FrameStream;
  hostname: string;
  platform: string;
  ip: string;
  connectedAt: string;
  id: number;
  uuid: string;
}

interface UserState {
  sock: any;
  connId: number;
  client: any;
}

function makeClientsJS(clients: Map<any, ClientState>, clientConns: Map<number, any>): string {
  const list = Array.from(clients.entries()).map(([sock, info]) => ({
    id: info.id,
    uuid: info.uuid,
    ip: info.ip,
    hostname: info.hostname,
    platform: info.platform,
    connectedAt: info.connectedAt,
    connections: Array.from(clientConns.values()).filter(c => c === sock).length,
  }));
  return JSON.stringify(list);
}

export function startServer(listenPort: number) {
  const clients = new Map<any, ClientState>();
  const clientConns = new Map<number, any>();
  const users = new Map<number, UserState>();
  let nextConnId = 1;
  let nextClientId = 1;

  function pickClient(uuid?: string): any | null {
    const pool = Array.from(clients.keys());
    if (pool.length === 0) return null;
    if (uuid) {
      return pool.find(c => clients.get(c)!.uuid === uuid) || null;
    }
    return pool[Math.floor(Math.random() * pool.length)]!;
  }

  function closeConnection(connId: number) {
    const user = users.get(connId);
    if (user) {
      try { user.sock.end(); } catch {}
      const st = clients.get(user.client);
      if (st) st.userQueues.delete(connId);
    }
    users.delete(connId);
    clientConns.delete(connId);
  }

  console.log(`[${now()}] server listening on ${listenPort}`);

  listen({
    hostname: "0.0.0.0",
    port: listenPort,
    socket: {
      open(sock) {
        sock.data = { role: null as string | null, buf: Buffer.alloc(0) };
      },
      data(sock, data) {
        const d: any = sock.data;

        if (d.role === "client") {
          const st = clients.get(sock);
          if (!st) return;
          const frames = st.fs.push(data);
          for (const f of frames) {
            if (f.type === FRAME_DATA) {
              const user = users.get(f.connId);
              if (!user) continue;
              try { user.sock.write(f.payload); } catch {}
            } else if (f.type === FRAME_CLOSE) {
              closeConnection(f.connId);
            } else if (f.type === FRAME_META) {
              try {
                const meta = JSON.parse(f.payload.toString());
                st.hostname = meta.hostname ?? st.hostname;
                st.platform = meta.platform ?? st.platform;
              } catch {}
            }
          }
        } else if (d.role === "user") {
          const user = users.get(d.connId);
          if (!user || !user.client) return;
          bunWriteFrame(user.client, d.connId, FRAME_DATA, data);
        } else {
          // Determine role from first data
          if (data.length >= 4 && data.subarray(0, 4).equals(CLIENT_MAGIC)) {
            const fs = new FrameStream();
            let clientIp = "";
            try { clientIp = (sock.remoteAddress || "").replace("::ffff:", ""); } catch {}
            const info: ClientState = {
              id: nextClientId++,
              uuid: randomUUID(),
              ip: clientIp,
              hostname: "unknown",
              platform: "unknown",
              connectedAt: new Date().toISOString(),
              userQueues: new Map(),
              fs,
            };
            d.role = "client";
            clients.set(sock, info);
            console.log(`[${now()}] [+] client #${info.id} ${info.uuid.slice(0, 8)} ${clientIp} (${clients.size} connected)`);
            const leftover = data.subarray(4);
            if (leftover.length > 0) {
              const frames = fs.push(leftover);
              for (const f of frames) {
                if (f.type === FRAME_META) {
                  try {
                    const meta = JSON.parse(f.payload.toString());
                    info.hostname = meta.hostname ?? info.hostname;
                    info.platform = meta.platform ?? info.platform;
                  } catch {}
                }
              }
            }
          } else {
            d.buf = Buffer.concat([d.buf, data]);
            if (d.buf.length >= 4 && d.buf.subarray(0, 4).toString() === "GET ") {
              const eom = d.buf.indexOf(Buffer.from("\r\n\r\n"));
              if (eom !== -1) {
                const reqLine = d.buf.subarray(0, d.buf.indexOf(Buffer.from("\r\n"))).toString();
                if (reqLine === "GET /clients HTTP/1.1" || reqLine === "GET /clients HTTP/1.0") {
                  const json = makeClientsJS(clients, clientConns);
                  const body = Buffer.from(json);
                  const resp = Buffer.concat([
                    Buffer.from("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n"),
                    body,
                  ]);
                  try { sock.write(resp); } catch {}
                }
                sock.end();
                return;
              }
              if (d.buf.length > 65536) sock.end();
              return;
            }

            // HTTP CONNECT
            const parsed = tryParseConnect(d.buf);
            if (!parsed) {
              if (d.buf.length > 65536) sock.end();
              return;
            }
            const { host, port, uuid } = parsed;

            const c = pickClient(uuid);
            if (!c) {
              try { sock.write(Buffer.from("HTTP/1.1 503 Service Unavailable\r\n\r\n")); } catch {}
              sock.end();
              console.log(`[${now()}] no clients, rejected ${host}:${port}`);
              return;
            }

            const connId = nextConnId++;
            d.role = "user";
            d.connId = connId;

            const addrPayload = encodeTargetAddr(host, port);
            bunWriteFrame(c, connId, FRAME_CONNECT, addrPayload);
            try { sock.write(makeConnectResponse()); } catch {}

            const eoh = d.buf.indexOf(Buffer.from("\r\n\r\n"));
            const leftover = eoh !== -1 ? d.buf.subarray(eoh + 4) : Buffer.alloc(0);

            const userState: UserState = {
              sock,
              connId,
              client: c,
            };
            users.set(connId, userState);
            clientConns.set(connId, c);
            const usedUUID = clients.get(c)?.uuid ?? "?";
            console.log(`[${now()}] [+] conn#${connId} ${host}:${port} \u2192 ${usedUUID.slice(0, 8)} (${users.size} active)`);

            if (leftover.length > 0) {
              bunWriteFrame(c, connId, FRAME_DATA, leftover);
            }
          }
        }
      },
      close(sock) {
        const d: any = sock.data;
        if (d?.role === "client") {
          const info = clients.get(sock);
          if (info) console.log(`[${now()}] [-] client #${info.id} (${clients.size - 1} connected)`);
          else console.log(`[${now()}] [-] client (${clients.size - 1} connected)`);
          clients.delete(sock);
          for (const [connId, cs] of clientConns) {
            if (cs === sock) closeConnection(connId);
          }
        } else if (d?.role === "user") {
          const user = users.get(d.connId);
          if (user) {
            bunWriteFrame(user.client, d.connId, FRAME_CLOSE, Buffer.alloc(0));
            users.delete(d.connId);
            clientConns.delete(d.connId);
            const st = clients.get(user.client);
            if (st) st.userQueues.delete(d.connId);
          }
        }
      },
      error(_sock, _err) {},
    },
  });
}
