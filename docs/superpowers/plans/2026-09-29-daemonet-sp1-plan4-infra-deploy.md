# Daemonet SP1 · Plan 4 — Infrastructure and Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Tasks 2–7 change the homelab (S1, S2, LC2, LC3, Authentik, Cloudflare). Each step that changes a host or a service is user-confirmed: show the command, get a yes, run it, show the output.**

**Goal:** Ship the SP1 sim to production on S1 behind `daemonet.wispy-nook.casa`, following the homelab conventions (Vault-fed containers, Caddy in front, nginx + Cloudflare Tunnel on LC2, self-hosted runner deploys gated on green CI), and pass the SP1 acceptance checks with a real Authentik device-flow login.

**Architecture:** Two containers from `docker-compose.prod.yml` on S1 — `sim` (Node 24, boots through `entrypoint.mjs` which loads its environment from Vault) and `frontend` (Caddy: placeholder page, `/ws*` → `sim:3000`, trusts only LC2 as proxy). The sim reaches the shared PostgreSQL on S2 over the VLAN 40 LAN through a Docker-published port that a `DOCKER-USER` rule restricts to S1. Deploys run on the `s1-daemonet` runner after a green CI on `main`: checkout the CI SHA → build → `prisma migrate deploy` → `up -d` → `/ws/ready`.

**Tech Stack:** Docker Compose, Caddy 2, nginx, cloudflared, HashiCorp Vault, Authentik OIDC (public client + device authorization grant), GitHub Actions self-hosted runner.

**Prerequisites:** Plans 1–3 merged and green in CI. Physical access to power S1 on. Vault unsealed (root token in 1Password). Authentik admin.

**Specs:** SP1 spec §8, §10, §11 (acceptance); game design §4.3, §4.4, §5.

## Global Constraints

- Everything from Plans 1–3.
- Production containers run as `node`, get only `VAULT_ADDR` + `VAULT_TOKEN` from disk, and the entrypoint refuses Vault overrides of `NODE_ENV`, `AUTH_DEV_BYPASS`, `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `TZ`, `PATH`.
- Ports bind to LAN addresses only (`192.168.40.21:3010` on S1; `192.168.40.20:5432` on S2), never `0.0.0.0`.
- Cloudflare Tunnel public hostname uses port **443** (a previous deploy lost time to `433`).
- The repo is private; the deploy key is read-only; the runner runs as `runner`, not root.
- Secrets never appear in chat, logs, command lines or files on the workstation: use `scripts/provision-secrets.sh` (hidden prompts, ssh stdin).
- Redis is **not** published or used by SP1 (the spec's "readiness check" mention is superseded); revisit when a sub-project needs it.
- No player-facing text links to GitHub.

## File map

```
apps/sim/Dockerfile, apps/sim/entrypoint.mjs, apps/sim/env-filter.mjs
apps/frontend/Dockerfile, apps/frontend/Caddyfile, apps/frontend/public/index.html
docker-compose.prod.yml, fetch-secrets.sh, .dockerignore
.github/workflows/deploy.yml, .github/workflows/ci.yml (paths-ignore)
scripts/provision-secrets.sh, scripts/fake-vault.mjs
OPERATIONS.md
```

---

### Task 1: Deployable images, compose, workflows and runbook (repo only)

**Files:**
- Create: `apps/sim/Dockerfile`, `apps/sim/entrypoint.mjs`, `apps/sim/env-filter.mjs`, `apps/frontend/Dockerfile`, `apps/frontend/Caddyfile`, `apps/frontend/public/index.html`, `docker-compose.prod.yml`, `fetch-secrets.sh`, `.dockerignore`, `.github/workflows/deploy.yml`, `scripts/provision-secrets.sh`, `scripts/fake-vault.mjs`, `OPERATIONS.md`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- `sim` image: `CMD node apps/sim/entrypoint.mjs`; env `VAULT_ADDR`, `VAULT_TOKEN`, optional `VAULT_PATH` (default `secret/data/daemonet`); listens on 3000; `HEALTHCHECK` on `/ws/ready`; migrations via `cd packages/db && node_modules/.bin/prisma migrate deploy` with `--entrypoint ""`.
- `frontend` image: Caddy on 80; `/ws*` → `sim:3000`; everything else static from `/srv`.
- Vault document `secret/daemonet`: `DATABASE_URL`, `AUTHENTIK_ISSUER_URL`, `AUTHENTIK_BOT_CLIENT_ID`, `AUTH_REQUIRED_GROUP`, `TRUST_PROXY_HOPS`, `SUBNET`, `LOG_LEVEL`, `PORT` (8 keys).

- [ ] **Step 1: Create the files**

`apps/sim/Dockerfile`:

```dockerfile
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages/rules/package.json packages/rules/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/sdk/package.json packages/sdk/
COPY apps/sim/package.json apps/sim/
COPY examples/starter-bot/package.json examples/starter-bot/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY packages/rules packages/rules
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY packages/sdk packages/sdk
COPY apps/sim apps/sim
RUN pnpm --filter @daemonet/db generate && pnpm exec tsc -b

FROM node:24-alpine AS runtime
RUN apk add --no-cache openssl tzdata
WORKDIR /repo
ENV NODE_ENV=production
# Owned by `node`: the Prisma CLI needs a writable engines directory, and `prisma migrate deploy`
# runs from this image during deploys.
COPY --from=build --chown=node:node /repo/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/package.json ./
COPY --from=build --chown=node:node /repo/packages/rules/package.json packages/rules/
COPY --from=build --chown=node:node /repo/packages/rules/dist packages/rules/dist
COPY --from=build --chown=node:node /repo/packages/rules/node_modules packages/rules/node_modules
COPY --from=build --chown=node:node /repo/packages/shared/package.json packages/shared/
COPY --from=build --chown=node:node /repo/packages/shared/dist packages/shared/dist
COPY --from=build --chown=node:node /repo/packages/shared/node_modules packages/shared/node_modules
COPY --from=build --chown=node:node /repo/packages/db/package.json /repo/packages/db/prisma.config.ts packages/db/
COPY --from=build --chown=node:node /repo/packages/db/dist packages/db/dist
COPY --from=build --chown=node:node /repo/packages/db/prisma packages/db/prisma
COPY --from=build --chown=node:node /repo/packages/db/node_modules packages/db/node_modules
COPY --from=build --chown=node:node /repo/apps/sim/package.json apps/sim/
COPY --from=build --chown=node:node /repo/apps/sim/dist apps/sim/dist
COPY --from=build --chown=node:node /repo/apps/sim/node_modules apps/sim/node_modules
COPY --chown=node:node apps/sim/entrypoint.mjs apps/sim/env-filter.mjs apps/sim/
USER node
EXPOSE 3000
# Liveness only: /ws/ready probes PostgreSQL and is what the deploy workflow checks.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/ws/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/sim/entrypoint.mjs"]
```

`apps/sim/env-filter.mjs`:

```js
/**
 * Environment keys that Vault secrets must never be able to set.
 *
 * `NODE_ENV` / `AUTH_DEV_BYPASS` decide whether the auth dev bypass is legal;
 * the `NODE_*` and `PATH` keys can change what code the process loads.
 */
export const PROTECTED_ENV_KEYS = Object.freeze(['NODE_ENV', 'AUTH_DEV_BYPASS', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'TZ', 'PATH']);

/** Split a Vault secret bag into values that may be applied and the key NAMES (never values) that were ignored. */
export function filterSecrets(secrets) {
  const applied = {};
  const ignored = [];
  for (const [key, value] of Object.entries(secrets ?? {})) {
    if (PROTECTED_ENV_KEYS.includes(key)) ignored.push(key);
    else applied[key] = value;
  }
  return { applied, ignored };
}
```

`apps/sim/entrypoint.mjs`:

```js
import { spawn } from 'node:child_process';
import { filterSecrets } from './env-filter.mjs';

const { VAULT_ADDR, VAULT_TOKEN, VAULT_PATH = 'secret/data/daemonet' } = process.env;
if (!VAULT_ADDR || !VAULT_TOKEN) {
  console.error('[entrypoint] VAULT_ADDR and VAULT_TOKEN must be set');
  process.exit(1);
}
console.log('[entrypoint] Fetching secrets from Vault...');
const res = await fetch(`${VAULT_ADDR}/v1/${VAULT_PATH}`, { headers: { 'X-Vault-Token': VAULT_TOKEN } });
if (!res.ok) {
  console.error(`[entrypoint] Vault responded ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const { data: { data: secrets } } = await res.json();
const { applied, ignored } = filterSecrets(secrets);
if (ignored.length) console.warn(`[entrypoint] Ignored protected key(s) from Vault: ${ignored.join(', ')}`);
Object.assign(process.env, applied);
console.log('[entrypoint] Secrets loaded, starting sim...');

const child = spawn(process.execPath, ['apps/sim/dist/runtime/main.js'], { stdio: 'inherit', env: process.env });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));
```

`apps/frontend/Dockerfile`:

```dockerfile
# SP1: a placeholder page plus the /ws proxy. SP2 replaces /srv with the built web client.
FROM caddy:2-alpine
COPY apps/frontend/Caddyfile /etc/caddy/Caddyfile
COPY apps/frontend/public /srv
EXPOSE 80
```

`apps/frontend/Caddyfile`:

```
# Caddy drops an incoming X-Forwarded-For unless the peer is a trusted proxy. Trust ONLY LC2
# (static 192.168.40.11): any other host on the VLAN that reaches this port directly has its
# X-Forwarded-For discarded, so client IPs cannot be spoofed.
# Chain: Cloudflare edge -> cloudflared (LC2, 127.0.0.1) -> nginx (LC2) -> Caddy -> sim,
# which is why the sim runs with TRUST_PROXY_HOPS=3.
{
  servers {
    trusted_proxies static 192.168.40.11/32
  }
}

:80 {
  encode gzip zstd

  # The game protocol and its readiness probe. WebSocket upgrades pass through reverse_proxy as-is.
  handle /ws* {
    reverse_proxy sim:3000
  }

  handle {
    root * /srv
    header {
      X-Content-Type-Options "nosniff"
      Referrer-Policy "strict-origin-when-cross-origin"
      X-Frame-Options "DENY"
      Cache-Control "no-cache"
    }
    file_server
  }
}
```

`apps/frontend/public/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Daemonet</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0f14; color: #d6e2f0; font: 16px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
      main { max-width: 32rem; padding: 2rem; }
      h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
      code { background: #17202b; padding: 0.1rem 0.35rem; border-radius: 0.25rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>Daemonet</h1>
      <p>The network is up. Operators connect with the SDK at <code>wss://daemonet.wispy-nook.casa/ws</code>.</p>
      <p>The web client arrives in a later release.</p>
    </main>
  </body>
</html>
```

`docker-compose.prod.yml`:

```yaml
x-logging: &default-logging
  driver: json-file
  options: { max-size: "10m", max-file: "3" }

services:
  sim:
    build: { context: ., dockerfile: apps/sim/Dockerfile }
    image: daemonet-sim:latest
    restart: unless-stopped
    env_file: .env            # VAULT_ADDR + VAULT_TOKEN only; everything else comes from Vault at start
    environment:
      TZ: UTC
      NODE_EXTRA_CA_CERTS: /etc/ssl/extra/cloudflare-ca.crt
    volumes:
      - /usr/local/share/ca-certificates/cloudflare-origin-ca.crt:/etc/ssl/extra/cloudflare-ca.crt:ro
    # S1 is otherwise idle, but keep the 16 Hz loop from starving the box during builds.
    cpus: 1.5
    mem_limit: 1g
    logging: *default-logging

  frontend:
    build: { context: ., dockerfile: apps/frontend/Dockerfile }
    image: daemonet-frontend:latest
    restart: unless-stopped
    depends_on:
      sim:
        condition: service_healthy
    ports: ["192.168.40.21:3010:80"]   # LAN address only; nginx on LC2 is the only intended client
    logging: *default-logging
```

`fetch-secrets.sh` (then `chmod +x fetch-secrets.sh`):

```bash
#!/usr/bin/env bash
# Writes the only two values the containers get from disk. Run on S1 in /opt/daemonet.
set -euo pipefail
cd "$(dirname "$0")"
umask 077
printf 'VAULT_ADDR=https://vault.wispy-nook.casa\nVAULT_TOKEN=%s\n' "$(cat vault-token)" > .env
echo ".env written"
```

`.dockerignore`:

```
node_modules
**/node_modules
**/dist
**/*.tsbuildinfo
.git
docs
.env
**/.daemonet-token.json
packages/db/src/generated
```

`.github/workflows/deploy.yml`:

```yaml
name: Deploy
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
    branches: [main]
  workflow_dispatch: {}

# Nothing here talks to the GitHub API; the runner only needs the checkout it already has on disk.
permissions: {}

concurrency: { group: deploy, cancel-in-progress: false }

jobs:
  deploy:
    # workflow_run fires for CI runs from forks and any branch; without these guards a green CI run
    # on a fork's pull_request would deploy that fork's code.
    if: >-
      ${{ github.event_name == 'workflow_dispatch' ||
          (github.event.workflow_run.conclusion == 'success' &&
           github.event.workflow_run.event == 'push' &&
           github.event.workflow_run.head_branch == 'main' &&
           github.event.workflow_run.head_repository.full_name == github.repository) }}
    runs-on: [self-hosted, daemonet]
    defaults: { run: { working-directory: /opt/daemonet } }
    steps:
      - name: Check out the exact commit CI validated
        run: |
          set -euo pipefail
          git fetch origin
          git checkout --detach "${{ github.event.workflow_run.head_sha || github.sha }}"

      - name: Build images
        run: |
          set -e
          for i in 1 2 3; do
            if docker compose -f docker-compose.prod.yml build sim frontend; then exit 0; fi
            echo "Attempt $i failed, retrying..."; sleep 10
          done
          echo "Build failed after 3 attempts."; exit 1

      - name: Run migrations (before the new code starts)
        run: |
          set -euo pipefail
          source .env
          DB_URL=$(curl -sf -H "X-Vault-Token: $VAULT_TOKEN" "$VAULT_ADDR/v1/secret/data/daemonet" \
            | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['data']['DATABASE_URL'])")
          docker compose -f docker-compose.prod.yml run --rm --no-deps -e DATABASE_URL="$DB_URL" --entrypoint "" sim \
            sh -c 'cd packages/db && node_modules/.bin/prisma migrate deploy'

      - name: Deploy
        run: docker compose -f docker-compose.prod.yml up -d

      - name: Health check
        run: |
          for i in $(seq 1 20); do
            if curl -sf http://192.168.40.21:3010/ws/ready; then echo healthy; exit 0; fi
            sleep 3
          done
          docker compose -f docker-compose.prod.yml logs --tail 80 sim; exit 1

      - name: Prune dangling images (S1 has a 64 GB disk)
        run: docker image prune -f
```

Replace `.github/workflows/ci.yml` with (adds `paths-ignore` so docs-only pushes neither test nor deploy):

```yaml
name: CI
on:
  # Docs-only changes do not run CI, and because Deploy is triggered by a green CI run on main,
  # they do not redeploy production either.
  push:
    branches: [main]
    paths-ignore: ["**.md", "docs/**"]
  pull_request:
    paths-ignore: ["**.md", "docs/**"]
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17-alpine
        env:
          POSTGRES_USER: daemonet
          POSTGRES_PASSWORD: daemonet
          POSTGRES_DB: daemonet_test
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U daemonet"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    env:
      DATABASE_URL: postgresql://daemonet:daemonet@127.0.0.1:5432/daemonet_test
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm db:migrate
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
```

`scripts/provision-secrets.sh` (then `chmod +x`):

```bash
#!/usr/bin/env bash
# One-time: put every Daemonet secret into Vault (LC3) and deliver the app's Vault token to S1.
# Run this yourself, from the repo root, in Git Bash:   bash scripts/provision-secrets.sh
#
# Nothing secret is printed, written to this machine's disk, or put on a command line:
#   - you type the Vault root token (hidden input)
#   - the DB password is read from the root-only file on S2 (OPERATIONS step 3)
#   - everything travels over ssh stdin into `vault kv put`; the periodic app token travels
#     LC3 -> here (in a variable) -> S1:/root/.daemonet-vault-token (mode 600)
#
# Prerequisites: `ssh S2`, `ssh S1` and `ssh LC3` work; Vault is unsealed; OPERATIONS steps 3 and 4 are done.
# Safe to re-run: the KV write is a full replace; an existing app token is reused, not duplicated.
set -euo pipefail

say() { printf '%s\n' "$*" >&2; }
ask_secret() { local v; read -r -s -p "$1: " v; echo >&2; printf '%s' "$v"; }
ask() { local v; read -r -p "$1: " v; printf '%s' "$v"; }

[ -f apps/sim/package.json ] || { say "Run from the repo root."; exit 1; }

say "== Things only you have (input is hidden) =="
VAULT_ROOT_TOKEN=$(ask_secret "Vault root token (1Password)")
BOT_CLIENT_ID=$(ask "Authentik client ID of the public provider 'daemonet-bot'")
[ -n "$VAULT_ROOT_TOKEN" ] && [ -n "$BOT_CLIENT_ID" ] || { say "Vault token and client ID are required."; exit 1; }

say "== Reading the DB password from S2 =="
DB_PW=$(ssh -o BatchMode=yes S2 'cat /root/.daemonet-db-pw')
[ -n "$DB_PW" ] || { say "Missing /root/.daemonet-db-pw on S2 (OPERATIONS step 3)."; exit 1; }

say "== Building the secret document =="
export DB_PW BOT_CLIENT_ID
KV_JSON=$(python - <<'PY'
import json, os
d = {
  # The sim runs on S1 and reaches the shared PostgreSQL on S2 over the VLAN 40 LAN (OPERATIONS step 3).
  "DATABASE_URL": f"postgresql://daemonet:{os.environ['DB_PW']}@192.168.40.20:5432/daemonet",
  "AUTHENTIK_ISSUER_URL": "https://authentik.wispy-nook.casa/application/o/daemonet-bot/",
  "AUTHENTIK_BOT_CLIENT_ID": os.environ["BOT_CLIENT_ID"],
  "AUTH_REQUIRED_GROUP": "daemonet-users",
  "TRUST_PROXY_HOPS": "3",   # cloudflared -> nginx (both LC2) -> Caddy; Caddy trusts only LC2. Change if the chain changes.
  "SUBNET": "lo",
  "LOG_LEVEL": "info",
  "PORT": "3000",
}
print(json.dumps(d))
PY
)

say "== Writing policy + secrets to Vault on LC3, creating the periodic app token =="
# stdin to LC3: line 1 = root token, line 2 = the JSON document. stdout from LC3 = ONLY the app token.
APP_TOKEN=$(printf '%s\n%s\n' "$VAULT_ROOT_TOKEN" "$KV_JSON" | ssh -o BatchMode=yes LC3 '
  set -euo pipefail
  export VAULT_ADDR=http://127.0.0.1:8200
  read -r VAULT_TOKEN; export VAULT_TOKEN
  umask 077; tmp=$(mktemp -p /dev/shm daemonet.XXXXXX); trap "rm -f $tmp" EXIT
  cat > "$tmp"
  vault token lookup >/dev/null || { echo "Vault rejected the root token" >&2; exit 1; }
  printf "path \"secret/data/daemonet\" { capabilities = [\"read\"] }\n" | vault policy write daemonet - >&2
  vault kv put secret/daemonet @"$tmp" >/dev/null && echo "kv written: $(python3 -c "import json,sys;print(len(json.load(open(sys.argv[1]))))" "$tmp") keys" >&2
  if ! grep -q "^daemonet " /opt/vault/app-tokens 2>/dev/null; then
    bash /opt/vault/add-app-token.sh daemonet daemonet >&2
  else
    echo "app token for daemonet already exists - reusing it" >&2
  fi
  grep "^daemonet " /opt/vault/app-tokens | tail -1 | cut -d" " -f2
')
[ -n "$APP_TOKEN" ] || { say "No app token came back from LC3."; exit 1; }

say "== Delivering the app token to S1:/root/.daemonet-vault-token (mode 600) =="
printf '%s' "$APP_TOKEN" | ssh -o BatchMode=yes S1 'umask 077; cat > /root/.daemonet-vault-token; echo "written: $(stat -c "%a %U %s bytes" /root/.daemonet-vault-token)" >&2'

say "== Verifying the app token can read the secret (from S1, through the same URL the container uses) =="
ssh -o BatchMode=yes S1 '
  code=$(curl -s -o /dev/null -w "%{http_code}" --cacert /usr/local/share/ca-certificates/cloudflare-origin-ca.crt \
    -H "X-Vault-Token: $(cat /root/.daemonet-vault-token)" https://vault.wispy-nook.casa/v1/secret/data/daemonet)
  echo "GET secret/data/daemonet with the app token -> HTTP $code (want 200)" >&2'

unset VAULT_ROOT_TOKEN DB_PW KV_JSON APP_TOKEN
say "Done. Next: OPERATIONS step 6 (move the token into /opt/daemonet, write .env)."
```

`scripts/fake-vault.mjs`:

```js
// Local stand-in for Vault so the production image can be booted on a workstation (plan 4 task 1).
// Serves the same document shape as secret/data/daemonet; AUTH_DEV_BYPASS is present on purpose
// to prove the entrypoint ignores protected keys.
import { createServer } from 'node:http';
const secrets = {
  DATABASE_URL: 'postgresql://daemonet:daemonet@host.docker.internal:5432/daemonet_test',
  AUTH_DEV_BYPASS: 'true',            // protected: must be ignored by the entrypoint
  AUTHENTIK_ISSUER_URL: 'https://authentik.wispy-nook.casa/application/o/daemonet-bot/',
  AUTHENTIK_BOT_CLIENT_ID: 'daemonet-bot',
  TRUST_PROXY_HOPS: '3', SUBNET: 'lo', LOG_LEVEL: 'info', PORT: '3000',
};
createServer((req, res) => {
  if (req.url === '/v1/secret/data/daemonet' && req.headers['x-vault-token'] === 'tok') {
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: { data: secrets } })); return;
  }
  res.writeHead(403).end();
}).listen(8200, () => console.log('fake vault up'));
```

`OPERATIONS.md`:

````markdown
# Daemonet — Operations

Runbook for provisioning, deploying and operating the Daemonet sim on the homelab.
Section A is the one-time setup (SP1 plan 4), section B the first deploy and its acceptance
checks, section C day-2 operations. Hosts: S1 `192.168.40.21` (runs the game), S2
`192.168.40.20` (shared PostgreSQL), LC2 `192.168.40.11` (nginx + Cloudflare Tunnel), LC3
`192.168.60.11` (Vault). All commands assume `ssh S1`, `ssh S2`, `ssh LC2`, `ssh LC3` work from
the workstation.

## A. Provision (one-time)

- [ ] **Step 1: S1 is up and baselined**

Power S1 on. Then:

```bash
ssh S1 'hostname; ip -4 addr show enp4s0 | grep inet; docker version --format "{{.Server.Version}}"; \
  id runner; ls -l /usr/local/share/ca-certificates/cloudflare-origin-ca.crt; df -h / | tail -1'
```

Expect `192.168.40.21`, a Docker version, the `runner` user (in the `docker` group), the CA cert and free disk. If anything is missing, S1 was provisioned like S2 on 2026-04-20 (`D:\docs\MikroTik\CLAUDE.md`, "S1"); redo the missing piece the same way.

- [ ] **Step 2: GitHub deploy key and self-hosted runner (S1)**

```bash
ssh S1 'sudo -u runner ssh-keygen -t ed25519 -N "" -f /home/runner/.ssh/daemonet-deploy -C daemonet-deploy && \
  printf "Host github.com-daemonet\n  HostName github.com\n  User git\n  IdentityFile ~/.ssh/daemonet-deploy\n  IdentitiesOnly yes\n" | sudo -u runner tee -a /home/runner/.ssh/config >/dev/null && \
  cat /home/runner/.ssh/daemonet-deploy.pub'
```

Add the printed public key as a **read-only deploy key** on `Zaphiruz/daemonet` (Settings → Deploy keys). Store the private key in Vault too (LC3): `ssh S1 'sudo cat /home/runner/.ssh/daemonet-deploy' | ssh LC3 'export VAULT_ADDR=http://127.0.0.1:8200; read -r VAULT_TOKEN ...'` — use the "piping a secret from one host into Vault" recipe in the homelab doc, path `deploy-keys/daemonet`, field `private_key`.

Clone and register the runner (GitHub: Settings → Actions → Runners → New self-hosted runner → Linux x64 gives a fresh token):

```bash
ssh S1 'sudo mkdir -p /opt/daemonet /opt/actions-runner-daemonet && sudo chown runner:runner /opt/daemonet /opt/actions-runner-daemonet && \
  sudo -u runner git clone git@github.com-daemonet:Zaphiruz/daemonet.git /opt/daemonet'
ssh S1 'cd /opt/actions-runner-daemonet && sudo -u runner bash -c "curl -sSL -o r.tgz https://github.com/actions/runner/releases/download/v2.337.0/actions-runner-linux-x64-2.337.0.tar.gz && tar xzf r.tgz && rm r.tgz && \
  ./config.sh --url https://github.com/Zaphiruz/daemonet --token <TOKEN> --name s1-daemonet --labels daemonet --unattended" && sudo ./svc.sh install runner && sudo ./svc.sh start'
```

Verify: the runner shows **Idle** with label `daemonet` on GitHub.

- [ ] **Step 3: PostgreSQL user + database, reachable from S1 (S2)**

```bash
ssh S2 'umask 077; openssl rand -hex 24 > /root/.daemonet-db-pw; PW=$(cat /root/.daemonet-db-pw); \
  docker exec shared-infra-postgresql-1 psql -U postgres -c "CREATE USER daemonet WITH PASSWORD '"'"'$PW'"'"';" && \
  docker exec shared-infra-postgresql-1 psql -U postgres -c "CREATE DATABASE daemonet OWNER daemonet TEMPLATE template0;" && \
  docker exec shared-infra-postgresql-1 psql -U postgres -d daemonet -c "GRANT ALL PRIVILEGES ON SCHEMA public TO daemonet; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO daemonet; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO daemonet;"'
```

Publish PostgreSQL on S2's LAN address **only**, then restrict it to S1 with a `DOCKER-USER` rule (Docker-published ports bypass host firewalls otherwise):

```bash
ssh S2 'cd /opt/shared-infra && sudo cp docker-compose.yml docker-compose.yml.bak-$(date +%F) && \
  sudo python3 - <<EOF
import re
p="docker-compose.yml"; s=open(p).read()
if "192.168.40.20:5432:5432" not in s:
    s=s.replace("    volumes:\n      - rift-trader_pgdata:/var/lib/postgresql/data", "    ports: [\"192.168.40.20:5432:5432\"]   # LAN only; DOCKER-USER limits it to S1\n    volumes:\n      - rift-trader_pgdata:/var/lib/postgresql/data",1)
    open(p,"w").write(s)
EOF
  sudo docker compose up -d postgresql && \
  sudo iptables -C DOCKER-USER -i end0 -p tcp -m conntrack --ctorigdstport 5432 --ctdir ORIGINAL ! -s 192.168.40.21 -j DROP 2>/dev/null || \
  sudo iptables -I DOCKER-USER -i end0 -p tcp -m conntrack --ctorigdstport 5432 --ctdir ORIGINAL ! -s 192.168.40.21 -j DROP && \
  (dpkg -s iptables-persistent >/dev/null 2>&1 || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent) && sudo netfilter-persistent save'
```

Verify (all three lines must hold):

```bash
ssh S1 'docker run --rm postgres:17-alpine pg_isready -h 192.168.40.20 -p 5432 -U daemonet'      # accepting connections
ssh LC2 'timeout 3 bash -c "</dev/tcp/192.168.40.20/5432" && echo REACHABLE || echo blocked'       # blocked
ssh S2 'docker exec shared-infra-postgresql-1 psql -U postgres -c "\l" | grep -c "^ [a-z]"'          # the other apps still list
```

Redis is **not** published: the SP1 sim does not use it. Publish it the same way (with an ACL user) when a later sub-project needs it.

- [ ] **Step 4: Authentik — public client with the device flow**

In `https://authentik.wispy-nook.casa` (admin):

1. **Providers → Create → OAuth2/OpenID Provider**: name `daemonet-bot`, authorization flow `default-provider-authorization-implicit-consent`, **Client type: Public**, redirect URIs: none needed (the device flow has no redirect; if the form insists, add `https://daemonet.wispy-nook.casa/`), signing key: the `authentik Self-signed Certificate`, scopes: `openid`, `profile`, `email`, `offline_access` **and the custom `groups` scope mapping** (Customisation → Property Mappings, the one BookStack uses). Access token validity `minutes=5`, refresh token validity `days=30`. Note the **Client ID**.
2. **Applications → Create**: name `Daemonet`, slug `daemonet-bot`, provider `daemonet-bot`.
3. **Directory → Groups**: create `daemonet-users` and `daemonet-admins`; add yourself to both. **Bind** `daemonet-users` to the application (Applications → Daemonet → Policy/Group/User Bindings → Bind existing group) — this is the access gate.
4. **System → Brands → the default brand → Device code flow**: set `default-provider-authorization-implicit-consent` if empty (the device flow is disabled on the brand until this is set).

Verify the device endpoint answers:

```bash
curl -s -X POST https://authentik.wispy-nook.casa/application/o/device/ -d client_id=<CLIENT_ID> -d scope="openid profile groups offline_access"
```

Expect JSON with `device_code`, `user_code`, `verification_uri`.

- [ ] **Step 5: Vault**

From the repo root on the workstation (prompts for the root token and the client ID; nothing is printed):

```bash
bash scripts/provision-secrets.sh
```

Expect `kv written: 8 keys` and `GET secret/data/daemonet with the app token -> HTTP 200`.

- [ ] **Step 6: Token + .env on S1**

```bash
ssh S1 'sudo mv /root/.daemonet-vault-token /opt/daemonet/vault-token && sudo chown runner:runner /opt/daemonet/vault-token && sudo chmod 400 /opt/daemonet/vault-token && \
  cd /opt/daemonet && sudo -u runner bash fetch-secrets.sh && sudo -u runner ls -l .env vault-token'
```

`.env` holds only `VAULT_ADDR` and `VAULT_TOKEN`.

- [ ] **Step 7: nginx (LC2) + Cloudflare Tunnel**

nginx needs a `map` for WebSocket upgrades (none exists on LC2 yet) and a server block:

```bash
ssh LC2 'sudo cp /etc/nginx/sites-enabled/wispy-nook.casa /root/wispy-nook.casa.bak-$(date +%F-%H%M) && \
  printf "map \$http_upgrade \$connection_upgrade {\n    default upgrade;\n    \"\"      close;\n}\n" | sudo tee /etc/nginx/conf.d/websocket-upgrade.conf >/dev/null && \
  sudo tee -a /etc/nginx/sites-enabled/wispy-nook.casa >/dev/null <<EOF

server {
    listen 443 ssl;
    server_name daemonet.wispy-nook.casa;
    ssl_certificate     /etc/nginx/certs/cloudflare-origin.pem;
    ssl_certificate_key /etc/nginx/certs/cloudflare-origin.key;
    location / {
        proxy_pass http://192.168.40.21:3010;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF
  sudo nginx -t && sudo systemctl reload nginx'
```

Cloudflare dashboard → Zero Trust → Tunnels → the LC2 tunnel → Public Hostname → add `daemonet.wispy-nook.casa` → `https://localhost:443`, **port 443 (not 433)**, TLS → Origin Server Name `daemonet.wispy-nook.casa`.

## B. First deploy and acceptance

- [ ] **Step 8: Deploy**

Push `main` (CI must be green), or trigger manually: `gh workflow run deploy.yml --repo Zaphiruz/daemonet`. Watch: `gh run watch --repo Zaphiruz/daemonet --exit-status`. Then:

```bash
curl -s https://daemonet.wispy-nook.casa/ws/ready          # ok
curl -s -o /dev/null -w "%{http_code}\n" https://daemonet.wispy-nook.casa/   # 200
ssh S1 'cd /opt/daemonet && docker compose -f docker-compose.prod.yml ps'
```

- [ ] **Step 9: Acceptance — every line must be checked**

1. **Device-flow bot from the PC captures a daemon:**
   `DAEMONET_URL=wss://daemonet.wispy-nook.casa/ws DAEMONET_ISSUER=https://authentik.wispy-nook.casa/application/o/daemonet-bot/ DAEMONET_CLIENT_ID=<CLIENT_ID> DAEMONET_NAME=<you> pnpm --filter @daemonet/starter-bot start` → approve the printed code in the browser → `claimed pingling` → within a few minutes `captured pingling!`.
2. **Persistence across a restart:** `ssh S1 'cd /opt/daemonet && docker compose -f docker-compose.prod.yml restart sim'`; rerun the bot; the log line `connected as …` is followed by no `claimed` line (starter already claimed) and the captured daemon is in RAM (`game.self.ram` — the bot prints `captured` only for new ones; check with `psql`: `ssh S2 'docker exec shared-infra-postgresql-1 psql -U daemonet -d daemonet -c "select species, location, slot from \"Daemon\""'`).
3. **Tag protection with a second operator:** a second Authentik user in `daemonet-users` runs the bot at the same time; its log shows `capture failed`/no capture of the first bot's tagged target, and no `E_STATE` other than tag conflicts.
4. **Group gate:** remove a user from `daemonet-users`, restart their bot → `E_AUTH: not in daemonet-users`. Add them back.
5. **Real client IPs and no PII:** `ssh S1 'cd /opt/daemonet && docker compose -f docker-compose.prod.yml logs --tail 50 sim | grep "operator connected"'` shows your public IP in `ip` and a `sub`, never a name or email.
6. **Existing apps unaffected:** open Plantry, Third Eye and Mealie; all load.
7. **Load:** `DAEMONET_URL=wss://daemonet.wispy-nook.casa/ws DAEMONET_BOTS=64 pnpm --filter @daemonet/starter-bot load` for 5 minutes (requires `AUTH_DEV_BYPASS`, which production refuses — so run this step against a **staging** start instead: `ssh S1 'cd /opt/daemonet && docker compose -f docker-compose.prod.yml run --rm --no-deps -p 192.168.40.21:3011:3000 -e VAULT_PATH=secret/data/daemonet -e AUTH_DEV_BYPASS=true -e NODE_ENV=development sim'` and point the bots at `ws://192.168.40.21:3011/ws` from a VLAN 40 host, or through an SSH tunnel: `ssh -L 3011:192.168.40.21:3011 S1`). The `tick stats` log lines must show `p99` under 32 ms. Afterwards remove the load operators: `ssh S2 'docker exec shared-infra-postgresql-1 psql -U daemonet -d daemonet -c "DELETE FROM \"Daemon\" WHERE \"operatorId\" IN (SELECT id FROM \"Operator\" WHERE sub LIKE '"'"'dev-%'"'"'); DELETE FROM \"Operator\" WHERE sub LIKE '"'"'dev-%'"'"';"'`.

- [ ] **Step 10: Record it in the homelab doc**

Add to `D:\docs\MikroTik\CLAUDE.md`: S1 now hosts Daemonet (compose at `/opt/daemonet`, port 3010 LAN-bound, runner `s1-daemonet`, Vault `secret/daemonet`, Authentik slug `daemonet-bot` public client + device flow, DB `daemonet`); shared PostgreSQL is published on `192.168.40.20:5432` restricted to S1 by `DOCKER-USER`; the nginx `websocket-upgrade.conf` map on LC2; the S2 port table gains `3010 Daemonet (on S1)`.

## C. Day-2 operations

- **Logs:** `ssh S1 'cd /opt/daemonet && docker compose -f docker-compose.prod.yml logs -f sim'` (pino JSON; `tick stats` every 64 s).
- **Restart:** `… restart sim` — connected bots reconnect and resume on their own; the world reloads from the last checkpoint (≤ 32 s of movement lost, never a daemon).
- **Change a secret:** `vault kv patch secret/daemonet KEY=value` on LC3, then `… restart sim`.
- **Rotate the Vault token:** it is periodic (30 d, renewed weekly by LC3's timer); to replace it, rerun `scripts/provision-secrets.sh` (reuses the existing token unless removed from `/opt/vault/app-tokens`), then `fetch-secrets.sh` and restart.
- **Migrations:** run by `deploy.yml` before `up -d`; manual: the "Run migrations" step's command in `.github/workflows/deploy.yml`.
- **Backups:** the `daemonet` database is included in S2's nightly `pg_dumpall` automatically.
- **Disk:** `docker image prune -f` runs after each deploy; check `df -h /` on S1 occasionally.
- **Wipe the world (dev only):** stop the sim, `psql -U daemonet -d daemonet -c 'TRUNCATE "Daemon","Operator","SubnetSeed","AppliedAction" CASCADE'`, start the sim. Operators re-claim starters.
````

- [ ] **Step 2: Build both images locally**

```bash
docker build -f apps/sim/Dockerfile -t daemonet-sim:local .
docker build -f apps/frontend/Dockerfile -t daemonet-frontend:local .
```

Expected: both builds succeed (the sim build runs `prisma generate` and `tsc -b` inside the image).

- [ ] **Step 3: Boot the production image through a fake Vault**

With the local test database from Plan 3 running (`daemonet_test` on `127.0.0.1:5432`):

```bash
docker network create daemonet-local
docker run -d --name fake-vault --network daemonet-local node:24-alpine node --input-type=module -e "$(cat scripts/fake-vault.mjs)"
docker run --rm --network daemonet-local --add-host=host.docker.internal:host-gateway \
  -e DATABASE_URL='postgresql://daemonet:daemonet@host.docker.internal:5432/daemonet_test' \
  --entrypoint "" daemonet-sim:local sh -c 'cd packages/db && node_modules/.bin/prisma migrate deploy'
docker run -d --name sim-local --network daemonet-local --network-alias sim --add-host=host.docker.internal:host-gateway \
  -e VAULT_ADDR=http://fake-vault:8200 -e VAULT_TOKEN=tok daemonet-sim:local
docker run -d --name frontend-local --network daemonet-local -p 127.0.0.1:3010:80 daemonet-frontend:local
sleep 8
docker logs sim-local
curl -s http://127.0.0.1:3010/ws/ready; echo
docker inspect --format 'health={{.State.Health.Status}} user={{.Config.User}}' sim-local
```

Expected: the sim logs `Ignored protected key(s) from Vault: AUTH_DEV_BYPASS`, then `daemonet sim started` with `devBypass: false`; `/ws/ready` through Caddy returns `ok`; `health=healthy user=node`. (On Git Bash set `MSYS_NO_PATHCONV=1` first so the `-e "$(cat …)"` argument is not mangled.)

- [ ] **Step 4: Confirm production auth is enforced through Caddy**

```bash
node -e "
const ws = new WebSocket('ws://127.0.0.1:3010/ws');
ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', seq: 1, d: { token: 'dev:x' } }));
ws.onmessage = (e) => { console.log(String(e.data)); ws.close(); };
ws.onclose = (e) => { console.log('closed', e.code); process.exit(0); };
setTimeout(() => process.exit(1), 5000);
"
docker rm -f sim-local frontend-local fake-vault; docker network rm daemonet-local
```

Expected: `{"t":"err",…"code":"E_AUTH","message":"dev tokens are disabled"}` then `closed 4401`.

- [ ] **Step 5: Validate compose and commit**

```bash
printf 'VAULT_ADDR=x\nVAULT_TOKEN=y\n' > .env && docker compose -f docker-compose.prod.yml config --quiet && rm .env
git add -A
git commit -m "chore: production images, compose, deploy workflow and runbook"
git push origin main
gh run watch --repo Zaphiruz/daemonet --exit-status
```

Expected: `config` prints nothing; CI green. (`Deploy` will fire after CI and fail until the runner exists — that is expected until Task 2.)

---

### Task 2: S1 baseline, deploy key and runner

**Files:** none in the repo. Follows `OPERATIONS.md` steps 1–2.

- [ ] **Step 1: Power S1 on and verify the baseline** — run the `ssh S1 '…'` check from OPERATIONS step 1. Expected: `192.168.40.21`, Docker, `runner` in `docker`, the CA cert, free disk. Fix anything missing the way S2 was provisioned.

- [ ] **Step 2: Deploy key** — generate it as `runner`, add it read-only on `Zaphiruz/daemonet`, store the private key in Vault at `deploy-keys/daemonet` (homelab recipe), and clone to `/opt/daemonet` as `runner`. Expected: `sudo -u runner git -C /opt/daemonet log --oneline -1` prints the latest commit.

- [ ] **Step 3: Runner** — register `s1-daemonet` with label `daemonet` (runner v2.337.0 like Third Eye's), install and start the service as `runner`. Expected: GitHub shows the runner **Idle** with label `daemonet`; `ssh S1 'systemctl is-active actions.runner.Zaphiruz-daemonet.s1-daemonet'` prints `active`.

- [ ] **Step 4: Commit nothing; note the runner name in OPERATIONS.md only if it differs from `s1-daemonet`.**

---

### Task 3: PostgreSQL user, database and LAN access (S2)

**Files:** none in the repo. Follows `OPERATIONS.md` step 3.

- [ ] **Step 1: Create the user and database** (password generated into `/root/.daemonet-db-pw` on S2, `TEMPLATE template0`). Expected: `docker exec shared-infra-postgresql-1 psql -U postgres -c "\l"` lists `daemonet` owned by `daemonet`.

- [ ] **Step 2: Publish PostgreSQL on `192.168.40.20:5432` and add the `DOCKER-USER` rule** (interface `end0`, allow only `192.168.40.21`), persist with `netfilter-persistent save`. Expected: `docker compose ps` shows `192.168.40.20:5432->5432/tcp`; `iptables -S DOCKER-USER` shows the DROP rule.

- [ ] **Step 3: Verify from three places** — S1 `pg_isready` → `accepting connections`; LC2 TCP probe → `blocked`; S2 `psql \l` → all existing databases still listed and the other apps still work (open Plantry).

---

### Task 4: Authentik public client with the device flow

**Files:** none. Follows `OPERATIONS.md` step 4.

- [ ] **Step 1: Provider `daemonet-bot`** — OAuth2/OpenID, **Public** client, implicit-consent authorization flow, scopes `openid profile email offline_access` + the `groups` scope mapping, self-signed signing key, access token 5 min, refresh token 30 d. Record the Client ID (not secret — public clients have none).

- [ ] **Step 2: Application `Daemonet` (slug `daemonet-bot`)**, groups `daemonet-users` (bound to the application) and `daemonet-admins`, add yourself to both.

- [ ] **Step 3: Brand → Device code flow** set to the implicit-consent authorization flow.

- [ ] **Step 4: Verify** — the `curl … /application/o/device/` call returns `device_code`, `user_code`, `verification_uri`. If it returns an error about the flow, the brand setting (Step 3) is missing.

---

### Task 5: Vault secrets and the app token

**Files:** none. Follows `OPERATIONS.md` steps 5–6.

- [ ] **Step 1: Run `bash scripts/provision-secrets.sh`** from the repo root (prompts: Vault root token, Client ID). Expected: `kv written: 8 keys`, the app token is created or reused, `GET secret/data/daemonet with the app token -> HTTP 200`.

- [ ] **Step 2: Move the token into `/opt/daemonet/vault-token` (400, owner `runner`) and write `.env`** with `fetch-secrets.sh`. Expected: `.env` contains exactly two lines (`VAULT_ADDR`, `VAULT_TOKEN`).

---

### Task 6: nginx on LC2 and the Cloudflare Tunnel hostname

**Files:** none. Follows `OPERATIONS.md` step 7.

- [ ] **Step 1: Add the WebSocket upgrade map** (`/etc/nginx/conf.d/websocket-upgrade.conf`) and the `daemonet.wispy-nook.casa` server block (backup the site file first). Expected: `nginx -t` OK, reload succeeds, the other hostnames still respond (`curl -sI https://plantry.wispy-nook.casa | head -1` → 200).

- [ ] **Step 2: Cloudflare Tunnel public hostname** `daemonet.wispy-nook.casa` → `https://localhost:443` (port **443**), Origin Server Name `daemonet.wispy-nook.casa`.

- [ ] **Step 3: Verify** — `curl -s -o /dev/null -w "%{http_code}\n" https://daemonet.wispy-nook.casa/` returns `502` (nothing is deployed yet; a Cloudflare 502 page means the tunnel and nginx route exist) rather than a DNS or 1016 error.

---

### Task 7: First deploy and acceptance

**Files:** none. Follows `OPERATIONS.md` steps 8–9.

- [ ] **Step 1: Deploy** — `gh workflow run deploy.yml --repo Zaphiruz/daemonet` then `gh run watch --repo Zaphiruz/daemonet --exit-status`. Expected: build (up to 3 tries), migrations `All migrations have been successfully applied`, `up -d`, `healthy`, prune.

- [ ] **Step 2: Public checks** — `curl https://daemonet.wispy-nook.casa/ws/ready` → `ok`; the placeholder page returns 200.

- [ ] **Step 3: Acceptance (OPERATIONS step 9, all seven items)** — device-flow bot captures a daemon; persistence across `restart sim`; a second `daemonet-users` account cannot capture the first bot's tagged target; a user removed from `daemonet-users` gets `E_AUTH` on reconnect; sim logs show real client IPs and only `sub`s; existing apps unaffected; 64-bot load against a dev-bypass staging start keeps `p99` under 32 ms, then the `dev-%` operators are deleted.

Expected: every item checked; any failure is fixed in code (new commit → CI → deploy) or config before moving on.

---

### Task 8: Record and close out

**Files:**
- Modify: `D:\docs\MikroTik\CLAUDE.md` (homelab doc — outside this repo), `docs/superpowers/specs/2026-09-27-daemonet-sp1-core-sim-design.md`

- [ ] **Step 1: Homelab doc** — add the Daemonet entries listed in OPERATIONS step 10 (S1 hosts Daemonet on 3010; shared PostgreSQL published on `192.168.40.20:5432` restricted to S1; the nginx upgrade map; Authentik `daemonet-bot` public client + device flow; Vault `secret/daemonet`; runner `s1-daemonet`; the port table).

- [ ] **Step 2: SP1 spec** — in §10, replace "Redis is provisioned now…" with "Redis is not provisioned or used in SP1", and mark §11 acceptance items as verified with the date.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: SP1 deployed to S1; runbook and spec updates"
git push origin main
```

Expected: CI is skipped for the docs-only push (paths-ignore), so no redeploy. SP1 is done; SP2 (web client + API) is next.
