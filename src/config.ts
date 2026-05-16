export const config = {
  server: {
    port: 1080,
    controlPort: 2080,
  },
  client: {
    serverHost: "127.0.0.1",
    serverPort: 2080,
    proxyPort: 0,
  },
  socks5: {
    targetTimeout: 15000,
  },
};
