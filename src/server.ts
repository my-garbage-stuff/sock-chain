import * as net from "net";
import { FRAME_CONNECT, FRAME_DATA, FRAME_CLOSE, toBuf, writeFrame, FrameStream, now } from "./utils";

interface ClientState {
  socket: net.Socket;
  frameStream: FrameStream;
  userQueues: Map<number, Buffer[]>;
}

export function startServer(listenPort: number, controlPort: number) {
  const clients = new Map<net.Socket, ClientState>();
  const clientConns = new Map<number, net.Socket>();  // connId → client socket
  const users = new Map<number, net.Socket>();          // connId → user socket
  let nextConnId = 1;

  function pickClient(): net.Socket | null {
    const pool = Array.from(clients.keys());
    if (pool.length === 0) return null;
    return pool[Math.floor(Math.random() * pool.length)]!;
  }

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

  // Control channel — clients connect here
  net.createServer((s) => {
    const ctrlAddr = `${s.remoteAddress}:${s.remotePort}`;
    const st: ClientState = { socket: s, frameStream: new FrameStream(), userQueues: new Map() };
    clients.set(s, st);
    console.log(`[${now()}] [+] client ${ctrlAddr} (${clients.size} connected)`);

    s.on("data", (d: string | Buffer) => {
      for (const f of st.frameStream.push(toBuf(d))) {
        if (f.type === FRAME_DATA) {
          const user = users.get(f.connId);
          if (!user || user.destroyed) continue;
          if (!user.write(f.payload)) {
            let q = st.userQueues.get(f.connId);
            if (!q) { q = []; st.userQueues.set(f.connId, q); }
            q.push(f.payload);
            user.once("drain", () => flushUser(f.connId, q));
          }
        } else if (f.type === FRAME_CLOSE) {
          const user = users.get(f.connId);
          if (user) user.end();
          users.delete(f.connId);
          clientConns.delete(f.connId);
          st.userQueues.delete(f.connId);
        }
      }
    });

    s.on("close", () => {
      console.log(`[${now()}] [-] client ${ctrlAddr} (${clients.size - 1} connected)`);
      clients.delete(s);
      // Kill all user connections that were routed through this client
      for (const [connId, cs] of clientConns) {
        if (cs === s) {
          const user = users.get(connId);
          if (user) user.end();
          users.delete(connId);
          clientConns.delete(connId);
        }
      }
    });
    s.on("error", () => {});
  }).listen(controlPort, () => console.log(`[${now()}] server control on ${controlPort}`));

  // Forward port — users connect here
  net.createServer((user) => {
    const userAddr = `${user.remoteAddress}:${user.remotePort}`;
    const c = pickClient();
    if (!c) { user.end(); console.log(`[${now()}] no clients, rejected ${userAddr}`); return; }

    const connId = nextConnId++;
    users.set(connId, user);
    clientConns.set(connId, c);
    console.log(`[${now()}] [+] conn#${connId} from ${userAddr} (${users.size} active)`);

    writeFrame(c, connId, FRAME_CONNECT, Buffer.alloc(0));

    user.on("data", (d: string | Buffer) => {
      if (!writeFrame(c, connId, FRAME_DATA, toBuf(d))) {
        user.pause();
        c.once("drain", () => { if (!user.destroyed) user.resume(); });
      }
    });
    user.on("close", () => {
      console.log(`[${now()}] [-] conn#${connId} closed (${users.size - 1} active)`);
      writeFrame(c, connId, FRAME_CLOSE, Buffer.alloc(0));
      users.delete(connId);
      clientConns.delete(connId);
      const st = clients.get(c);
      if (st) st.userQueues.delete(connId);
    });
    user.on("error", () => {});
  }).listen(listenPort, () => console.log(`[${now()}] server forward on ${listenPort}`));
}
