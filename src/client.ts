// Client: connects to server and relays framed traffic to local TCP targets.

import * as net from "net";
import * as os from "os";
import {
  FRAME_CONNECT, FRAME_DATA, FRAME_CLOSE, FRAME_META,
  CLIENT_MAGIC,
  toBuf, tcpWriteFrame, FrameStream, now, parseAddress,
} from "./utils";
import { config } from "./config";

export function startClient(serverAddress: string) {
  const targets = new Map<number, net.Socket>();
  const pending = new Map<number, Buffer[]>();
  let closing = false;
  let retryDelay = config.client.reconnectDelay;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function cleanup() {
    targets.forEach((t) => t.destroy());
    targets.clear();
    pending.clear();
  }

  // Write data to target socket, queueing on backpressure
  function writeWithBackpressure(connId: number, data: Buffer, target: net.Socket) {
    const q = pending.get(connId);
    if (q) {
      q.push(data);
    } else if (!target.write(data)) {
      const q2 = [data];
      pending.set(connId, q2);
      const drain = () => {
        const qq = pending.get(connId);
        if (!qq) return;
        while (qq.length > 0) {
          if (!target.write(qq[0]!)) {
            target.once("drain", drain);
            return;
          }
          qq.shift();
        }
        pending.delete(connId);
      };
      target.once("drain", drain);
    }
  }

  function connect() {
    closing = false;

    const [host, portStr] = serverAddress.includes("://")
      ? serverAddress.split("://")[1]!.split(":")
      : serverAddress.split(":");
    const port = parseInt(portStr || String(config.server.port));
    const address = host || "127.0.0.1";

    const sock = net.createConnection({ host: address, port }, () => {
      console.log(`[${now()}] client connected to ${address}:${port}`);
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
      sock.write(CLIENT_MAGIC);
      tcpWriteFrame(sock, 0, FRAME_META, Buffer.from(meta));
    });

    const fs = new FrameStream();

    sock.on("data", (data: Buffer) => {
      const frames = fs.push(data);
      for (const f of frames) {
        if (f.type === FRAME_CONNECT) {
          const { addr, port: targetPort } = parseAddress(f.payload, 0);
          const target = net.createConnection({ host: addr, port: targetPort }, () => {
            target.setTimeout(0);
            const q = pending.get(f.connId);
            if (q) {
              for (const chunk of q) target.write(chunk);
              pending.delete(f.connId);
            }
            target.on("data", (pd: Buffer) => {
              tcpWriteFrame(sock, f.connId, FRAME_DATA, toBuf(pd));
            });
            target.on("close", () => {
              tcpWriteFrame(sock, f.connId, FRAME_CLOSE, Buffer.alloc(0));
              targets.delete(f.connId);
            });
            target.on("error", () => {});
          });
          target.on("error", (e: Error) => {
            console.log(`[${now()}] target#${f.connId} ${addr}:${targetPort}: ${e.message}`);
            pending.delete(f.connId);
            targets.delete(f.connId);
            tcpWriteFrame(sock, f.connId, FRAME_CLOSE, Buffer.alloc(0));
          });
          targets.set(f.connId, target);
        } else if (f.type === FRAME_DATA) {
          const target = targets.get(f.connId);
          if (target && !target.destroyed && target.readyState === "open") {
            writeWithBackpressure(f.connId, f.payload, target);
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
      }
    });

    sock.on("close", () => {
      console.log(`[${now()}] client disconnected from server`);
      cleanup();
      if (!closing) {
        console.log(`[${now()}] reconnecting in ${retryDelay}ms`);
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, config.client.reconnectMaxDelay);
      }
    });

    sock.on("error", () => {});
  }

  connect();
}
