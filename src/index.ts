// ── Sock-Chain: raw SOCKS5 relay ──
// Server:  opens port 1080, relays raw TCP bytes to client
// Client:  starts a local SOCKS5 proxy, connects to server,
//          forwards relayed bytes through its SOCKS5 proxy
// Users:   connect to server:1080 as a SOCKS5 proxy

import { startServer } from "./server";
import { startClient } from "./client";
import { startSocks5Proxy } from "./socks5";
import { config } from "./config";

function usage() {
  console.log(`sock-chain — raw SOCKS5 relay

USAGE
  sock-chain [--server] [options]

MODES
  --server                Run in server mode (default: client mode)

SERVER OPTIONS
  --port <n>              Forward port (default: ${config.server.port})
  --control-port <n>      Client control port (default: ${config.server.controlPort})

CLIENT OPTIONS
  --server-host <host>    Server address (default: ${config.client.serverHost})
  --server-port <n>       Server control port (default: ${config.client.serverPort})
  --proxy-port <n>        Local SOCKS5 proxy port (default: ${config.client.proxyPort})

CONFIG
  Edit src/config.ts to change all defaults. CLI flags override.
`);
  process.exit(0);
}

function arg(s: string): string | undefined {
  const i = process.argv.indexOf(s);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) usage();

const isServer = process.argv.includes("--server");

if (isServer) {
  const listenPort = parseInt(arg("--port") || String(config.server.port));
  const controlPort = parseInt(arg("--control-port") || String(config.server.controlPort));
  startServer(listenPort, controlPort);
} else {
  const serverHost = arg("--server-host") || config.client.serverHost;
  const serverPort = parseInt(arg("--server-port") || String(config.client.serverPort));
  const proxyPort = parseInt(arg("--proxy-port") || String(config.client.proxyPort));
  startSocks5Proxy(proxyPort).then((actualProxyPort) => {
    startClient(serverHost, serverPort, actualProxyPort);
  });
}
