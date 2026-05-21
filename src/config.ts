export const config = {
  server: {
    port: 1080,
    controlPort: 2080,
    pingInterval: 30000,
  },
  client: {
    serverAddress: "ws://127.0.0.1:2080",
    reconnectDelay: 1000,
    reconnectMaxDelay: 30000,
  },
  target: {
    timeout: 15000,
  },
};
