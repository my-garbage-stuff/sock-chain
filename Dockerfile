FROM oven/bun:1 AS build

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src/ ./src/
RUN bun build src/index.ts --outfile=/app/sock-chain --compile --target=bun-linux-x86_64

FROM gcr.io/distroless/cc-debian12

COPY --from=build /app/sock-chain /usr/local/bin/sock-chain

ENV SOCK_CHAIN_SERVER_HOST=my-server.com
ENV SOCK_CHAIN_SERVER_PORT=2080

ENTRYPOINT ["sock-chain"]
