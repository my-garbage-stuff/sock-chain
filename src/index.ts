// Sock-Chain: HTTP CONNECT relay over TCP.
// Server mode: opens an HTTP CONNECT proxy port.
// Client mode: connects to server, relays traffic to TCP targets.

import { startServer } from "./server";
import { startClient } from "./client";
import { config } from "./config";

function usage() {
  console.log(`sock-chain — HTTP CONNECT relay over TCP

USAGE
  sock-chain [--server] [options]

MODES
  --server                Run in server mode (default: client mode)

OPTIONS
  --port <n>              Listen / connect port (default: ${config.server.port})
  --connect <host:port>   Server address for client mode (default: ${config.client.serverAddress})

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
  startServer(parseInt(arg("--port") || String(config.server.port)));
} else {
  startClient(arg("--connect") || config.client.serverAddress);
}
