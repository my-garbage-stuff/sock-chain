// server.js - minimal SOCKS5 proxy (CONNECT only, no auth)
// Note: tested on Node-like environment; Bun's net API is compatible.

import net from "net";

const SOCKS_VERSION = 0x05;
const METHOD_NO_AUTH = 0x00;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const REP_SUCCEEDED = 0x00;
const REP_GENERAL_FAILURE = 0x01;

function parseAddress(buffer, offset = 0) {
  const atyp = buffer[offset];
  if (atyp === ATYP_IPV4) {
    return {
      addr: Array.from(buffer.slice(offset + 1, offset + 5)).join("."),
      port: buffer.readUInt16BE(offset + 5),
      readBytes: 1 + 4 + 2,
    };
  } else if (atyp === ATYP_DOMAIN) {
    const len = buffer[offset + 1];
    const addr = buffer.slice(offset + 2, offset + 2 + len).toString();
    const port = buffer.readUInt16BE(offset + 2 + len);
    return { addr, port, readBytes: 1 + 1 + len + 2 };
  } else {
    throw new Error("ATYP not supported");
  }
}

const server = net.createServer((client) => {
  client.once("data", (chunk) => {
    // handshake
    if (chunk[0] !== SOCKS_VERSION) return client.end();
    // reply: version, no auth
    client.write(Buffer.from([SOCKS_VERSION, METHOD_NO_AUTH]));

    client.once("data", async (req) => {
      try {
        if (req[0] !== SOCKS_VERSION) return client.end();
        const cmd = req[1];
        if (cmd !== CMD_CONNECT) {
          client.write(Buffer.from([SOCKS_VERSION, 0x07, 0x00, ATYP_IPV4, 0,0,0,0,0,0])); // command not supported
          return client.end();
        }
        const { addr, port } = parseAddress(req, 3);
        const remote = net.createConnection({ host: addr, port }, () => {
          // success reply: VER, REP, RSV, ATYP, BND.ADDR, BND.PORT
          const resp = Buffer.alloc(10);
          resp[0] = SOCKS_VERSION;
          resp[1] = REP_SUCCEEDED;
          resp[2] = 0x00;
          resp[3] = ATYP_IPV4;
          // bind addr 0.0.0.0 and port 0
          resp.writeUInt32BE(0, 4);
          resp.writeUInt16BE(0, 8);
          client.write(resp);
          // pipe data both ways
          client.pipe(remote);
          remote.pipe(client);
        });
        remote.on("error", () => {
          client.write(Buffer.from([SOCKS_VERSION, REP_GENERAL_FAILURE, 0x00, ATYP_IPV4, 0,0,0,0,0,0]));
          client.end();
        });
      } catch (e) {
        client.end();
      }
    });
  });

  client.on("error", () => client.destroy());
});

const PORT = 1080;
server.listen(PORT, () => {
  console.log(`SOCKS5 proxy listening on ${PORT}`);
});
