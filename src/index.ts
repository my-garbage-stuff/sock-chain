// ── Sock-Chain: raw SOCKS5 relay over WebSocket ──
// Server:  opens port 1080, relays SOCKS5 traffic to client via WebSocket
// Client:  connects to server via WebSocket, directly connects to targets
// Users:   connect to server:1080 as a SOCKS5 proxy

import { startServer } from "./server";
import { startClient } from "./client";
import { config } from "./config";

function usage() {
  console.log(`sock-chain — SOCKS5 relay over WebSocket

USAGE
  sock-chain [--server] [options]

MODES
  --server                Run in server mode (default: client mode)

SERVER OPTIONS
  --port <n>              Forward port (default: ${config.server.port})
  --control-port <n>      Client WebSocket port (default: ${config.server.controlPort})

CLIENT OPTIONS
  --connect <url>         Server WebSocket URL (default: ${config.client.serverAddress})

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
  const serverAddress = arg("--connect") || config.client.serverAddress;
  startClient(serverAddress);
}
