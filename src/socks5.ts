import * as net from "net";
import * as dns from "dns";
import {
  SOCKS_VERSION, METHOD_NO_AUTH, CMD_CONNECT, ATYP_IPV4,
  REP_SUCCEEDED, REP_GENERAL_FAILURE,
  toBuf, now, parseAddress, socks5Reply,
} from "./utils";
import { config } from "./config";

export function startSocks5Proxy(port: number): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer((client) => {
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

          client.removeListener("data", onData);

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
              target.setTimeout(config.socks5.targetTimeout);
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

    server.listen(port, "0.0.0.0", () => {
      const addr = server.address()!;
      const actualPort = typeof addr === "object" ? addr.port : port;
      console.log(`[${now()}] client socks5 proxy on ${actualPort}`);
      resolve(actualPort);
    });
  });
}
