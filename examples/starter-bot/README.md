# starter-bot

A minimal Daemonet operator bot. It claims a starter, runs it, weakens nearby
Packet-type daemons and captures them with `sniff`, solving the Packet
challenge with the solver in `src/solvers.ts`. Every other challenge family is
yours to write.

## Run against the live server

```bash
DAEMONET_URL=wss://daemonet.wispy-nook.casa/ws \
DAEMONET_ISSUER=https://authentik.wispy-nook.casa/application/o/daemonet-bot/ \
DAEMONET_CLIENT_ID=daemonet-bot \
DAEMONET_NAME=yourname DAEMONET_STARTER=pingling \
pnpm --filter @daemonet/starter-bot start
```

The first run prints a verification URL and code; approve it in your browser.
The refresh token is cached in `.daemonet-token.json` (mode 0600).

## Run against a local dev server

```bash
DAEMONET_URL=ws://127.0.0.1:3000/ws DAEMONET_DEV_NAME=alice DAEMONET_NAME=alice pnpm --filter @daemonet/starter-bot start
```

## Load test

`DAEMONET_URL=... DAEMONET_BOTS=64 pnpm --filter @daemonet/starter-bot load` connects N dev-token bots that wander and fight.

The sim caps connections per IP (default 16). To load-test locally with more
bots than that, start the sim with the cap raised, e.g.
`MAX_CONNECTIONS_PER_IP=128`. Bots that are refused are logged and skipped, and
the script exits non-zero only if no bot connected.
