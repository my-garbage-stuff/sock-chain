# sock-chain

Raw SOCKS5 relay tunnel. Forwards SOCKS5 connections through a remote agent.

## Architecture

```
User App --SOCKS5--> Server --[relay frames]--> Client --SOCKS5--> Client's internal proxy --> Target
```

- **Server** opens a SOCKS5 port. For each connection, it relays raw bytes to a randomly chosen client.
- **Client** runs an internal SOCKS5 proxy and connects to the server. Incoming relayed bytes are sent through the proxy to the target.

Multiple clients can connect to one server. Each user connection is randomly assigned to a connected client.

## Usage

```bash
# Server (listens on :1080 for SOCKS5 users, :2080 for clients)
sock-chain --server

# Client (connects to server, runs internal SOCKS5 proxy)
sock-chain --server-host example.com --server-port 2080

# Test the chain
curl --socks5 127.0.0.1:1080 http://httpbin.org/ip
```

With multiple clients:

```bash
# Terminal 1
sock-chain --server --port 1080 --control-port 2080

# Terminal 2 and 3
sock-chain --server-host myserver.com
sock-chain --server-host myserver.com
```

## Build

```bash
bun build src/index.ts --compile --outfile=sock-chain
```

## Configuration

Edit `src/config.ts` to change default `serverHost` and `serverPort` for client mode.
These are compiled into the binary. CLI flags (`--server-host`, `--server-port`) override them.

```ts
export const config = {
  serverHost: "my-server.com",
  serverPort: 2080,
};
```

## Options

```
--server              Server mode
--port <n>            SOCKS5 forward port (default: 1080)
--control-port <n>    Client control port (default: 2080)
--connect <host>  Server address for client mode
--help                Show this help
```

## Relay Protocol

Framed TCP over the control channel:

```
[connId:4][type:1][payloadLen:4][payload...]
```

- `FRAME_CONNECT (0x01)` — server→client: new user connection
- `FRAME_DATA    (0x02)` — bidirectional: raw TCP bytes
- `FRAME_CLOSE   (0x03)` — bidirectional: connection closed
