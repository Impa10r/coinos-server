FROM oven/bun:1.2

ARG NODE_ENV=production

# curl: Bun's fetch doesn't correctly honor a SOCKS5 proxy agent (open Bun
# bug, oven-sh/bun#15499) — lib/esplora.ts shells out to curl for its
# optional Tor-routed onion mirror instead.
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock /home/bun/app/
COPY patches /home/bun/app/patches

RUN NODE_ENV=development bun i

CMD ["bun", "run", "start"]
