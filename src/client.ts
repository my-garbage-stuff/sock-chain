import * as net from "net";
import * as os from "os";
import {
  FRAME_CONNECT, FRAME_DATA, FRAME_CLOSE, FRAME_META,
  toBuf, wsWriteFrame, parseFrame, now, parseAddress,
} from "./utils";
import { config } from "./config";

export function startClient(serverAddress: string) {
  const targets = new Map<number, net.Socket>();
  const pending = new Map<number, Buffer[]>();
  const targetDraining = new Set<net.Socket>();
  let closing = false;
  let retryDelay = config.client.reconnectDelay;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function cleanup() {
    targets.forEach((t) => t.destroy());
    targets.clear();
    pending.clear();
  }

  function connect() {
    closing = false;
    const ws = new WebSocket(serverAddress);
    ws.binaryType = "nodebuffer";

    ws.onopen = () => {
      console.log(`[${now()}] client connected to ${serverAddress}`);
      retryDelay = config.client.reconnectDelay;
      const cpus = os.cpus();
      const userInfo = os.userInfo();
      const meta = JSON.stringify({
        hostname: os.hostname(),
        platform: os.platform(),
        type: os.type(),
        release: os.release(),
        arch: os.arch(),
        machine: os.machine(),
        user: userInfo,
        uptime: os.uptime(),
        totalmem: (os.totalmem() / (1024 ** 3)).toFixed(1) + " GB",
        cpus: cpus.length,
        cpuModel: cpus[0]?.model || "",
        cpuSpeed: cpus[0]?.speed || 0,
        pid: process.pid,
        runtime: process.version,
      });
      wsWriteFrame(ws, 0, FRAME_META, Buffer.from(meta));
    };

    ws.onmessage = (event) => {
      const data = event.data;
      if (typeof data === "string") return;
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const f = parseFrame(buf);

      if (f.type === FRAME_CONNECT) {
        const { addr, port } = parseAddress(f.payload, 0);
        const target = net.createConnection({ host: addr, port }, () => {
          target.setTimeout(0);
          const q = pending.get(f.connId);
          if (q) {
            for (const chunk of q) target.write(chunk);
            pending.delete(f.connId);
          }
          target.on("data", (pd: string | Buffer) => {
            wsWriteFrame(ws, f.connId, FRAME_DATA, toBuf(pd));
          });
          target.on("close", () => {
            wsWriteFrame(ws, f.connId, FRAME_CLOSE, Buffer.alloc(0));
            targets.delete(f.connId);
          });
          target.on("error", () => {});
        });
        target.on("error", (e: Error) => {
          console.log(`[${now()}] target#${f.connId} ${addr}:${port}: ${e.message}`);
          pending.delete(f.connId);
          targets.delete(f.connId);
          wsWriteFrame(ws, f.connId, FRAME_CLOSE, Buffer.alloc(0));
        });
        targets.set(f.connId, target);
      } else if (f.type === FRAME_DATA) {
        const target = targets.get(f.connId);
        if (target && !target.destroyed && target.readyState === "open") {
          if (!target.write(f.payload)) {
            let q = pending.get(f.connId);
            if (!q) { q = []; pending.set(f.connId, q); }
            q.push(f.payload);
            if (!targetDraining.has(target)) {
              targetDraining.add(target);
              const flush = () => {
                const q2 = pending.get(f.connId);
                if (!q2) { targetDraining.delete(target); return; }
                while (q2.length > 0) {
                  if (!target.write(q2[0]!)) {
                    target.once("drain", flush);
                    return;
                  }
                  q2.shift();
                }
                pending.delete(f.connId);
                targetDraining.delete(target);
              };
              target.once("drain", flush);
            }
          }
        } else {
          let q = pending.get(f.connId);
          if (!q) { q = []; pending.set(f.connId, q); }
          q.push(f.payload);
        }
      } else if (f.type === FRAME_CLOSE) {
        const target = targets.get(f.connId);
        if (target) target.end();
        targets.delete(f.connId);
        pending.delete(f.connId);
      }
    };

    ws.onclose = () => {
      console.log(`[${now()}] client disconnected from server`);
      cleanup();
      if (!closing) {
        console.log(`[${now()}] reconnecting in ${retryDelay}ms`);
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, config.client.reconnectMaxDelay);
      }
    };

    ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  connect();
}
