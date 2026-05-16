import * as net from "net";
import {
  FRAME_CONNECT, FRAME_DATA, FRAME_CLOSE,
  toBuf, writeFrame, FrameStream, now,
} from "./utils";

export function startClient(serverHost: string, serverPort: number, proxyPort: number) {
  const proxyConns = new Map<number, net.Socket>();
  const pending = new Map<number, Buffer[]>();
  const frameStream = new FrameStream();
  const ctrlDraining = new Set<net.Socket>();
  const proxyDraining = new Set<net.Socket>();

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
              if (!ctrlDraining.has(ctrl)) {
                ctrlDraining.add(ctrl);
                ctrl.once("drain", () => {
                  ctrlDraining.delete(ctrl);
                  if (!proxy.destroyed) proxy.resume();
                });
              }
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
            let q = pending.get(f.connId);
            if (!q) { q = []; pending.set(f.connId, q); }
            q.push(f.payload);
            if (!proxyDraining.has(proxy)) {
              proxyDraining.add(proxy);
              const flush = () => {
                const q2 = pending.get(f.connId);
                if (!q2) { proxyDraining.delete(proxy); return; }
                while (q2.length > 0) {
                  if (!proxy.write(q2[0]!)) {
                    proxy.once("drain", flush);
                    return;
                  }
                  q2.shift();
                }
                pending.delete(f.connId);
                proxyDraining.delete(proxy);
              };
              proxy.once("drain", flush);
            }
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
