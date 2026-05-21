export const config = {
  server: {
    port: 1080,
    controlPort: 2080,
  },
  client: {
    serverAddress: "ws://127.0.0.1:2080",
  },
  target: {
    timeout: 15000,
  },
};
