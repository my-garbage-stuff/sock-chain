FROM debian:stable as build

WORKDIR /app
COPY ./ ./
RUN apt update && apt install curl unzip -yq
RUN curl -fsSL https://bun.com/install | bash
RUN /root/.bun/bin/bun install --frozen-lockfile

RUN ls && /root/.bun/bin/bun build src/index.ts --outfile=/app/sock-chain --compile --target=bun-linux-x86_64

FROM debian:stable

COPY --from=build /app/sock-chain /usr/local/bin/sock-chain

ENV SOCK_CHAIN_SERVER_HOST=my-server.com
ENV SOCK_CHAIN_SERVER_PORT=2080

ENTRYPOINT ["sock-chain"]
