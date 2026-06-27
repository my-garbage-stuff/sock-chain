# sock-chain

HTTP CONNECT relay over TCP. Routes HTTP CONNECT proxy requests through remote client agents.

## Architecture

```
User App --HTTP CONNECT--> Server --[relay frames]--> Client --TCP--> Target
```

- **Server** opens an HTTP CONNECT proxy port. For each user connection, it relays raw bytes to a randomly chosen client via framed TCP.
- **Client** connects to the server and forwards relayed bytes directly to the target host.

Multiple clients can connect to one server. Each user connection is randomly assigned to a connected client. Optionally target a specific client by passing a UUID (`CONNECT uuid@host:port`).

## Usage

```bash
# Server (listens on :1080 for HTTP CONNECT users)
sock-chain --server

# Client (connects to server, forwards traffic to targets)
sock-chain --connect 127.0.0.1:1080

# Test the chain
curl -x http://127.0.0.1:1080 http://httpbin.org/ip
```

With multiple clients:

```bash
# Terminal 1
sock-chain --server

# Terminal 2 and 3
sock-chain --connect wss://myserver.com
sock-chain --connect wss://myserver.com
```

## Build

```bash
bun build.ts
```

## Configuration

Edit `src/config.ts` to change defaults. CLI flags override.

## Options

```
--server              Server mode
--port <n>            Listen / connect port (default: 1080)
--connect <host:port> Server address for client mode
--help                Show this help
```

## Relay Protocol

Framed TCP over the control channel:

```
[connId:4][type:1][payloadLen:4][payload...]
```

- `FRAME_CONNECT (0x01)` — server→client: connect to target
- `FRAME_DATA    (0x02)` — bidirectional: raw TCP bytes
- `FRAME_CLOSE   (0x03)` — bidirectional: connection closed
- `FRAME_META    (0x04)` — client→server: metadata (hostname, platform, etc.)

## HTTP Endpoints

- `GET /clients` — returns JSON array of connected clients
