# Daemonet — Operations

Runbook for provisioning, deploying and operating the Daemonet sim on the homelab.
Section A is the one-time setup (SP1 plan 4), section B the first deploy and its acceptance
checks, section C day-2 operations. Hosts: S1 `192.168.40.21` (runs the game), S2
`192.168.40.20` (shared PostgreSQL), LC2 `192.168.40.11` (nginx + Cloudflare Tunnel), LC3
`192.168.60.11` (Vault). All commands assume `ssh S1`, `ssh S2`, `ssh LC2`, `ssh LC3` work from
the workstation.

## Configuration reference (Vault document `secret/daemonet`, 9 keys)

| Key | Value | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://daemonet:<pw>@192.168.40.20:5432/daemonet` | built by `scripts/provision-secrets.sh` |
| `AUTHENTIK_ISSUER_URL` | `https://authentik.wispy-nook.casa/application/o/daemonet-bot/` | |
| `AUTHENTIK_BOT_CLIENT_ID` | client ID of the public provider `daemonet-bot` | |
| `AUTH_REQUIRED_GROUP` | `daemonet-users` | the access gate |
| `TRUST_PROXY_HOPS` | `3` | see the warning below |
| `MAX_CONNECTIONS_PER_IP` | `16` | concurrent connections allowed per client IP (sim default 16) |
| `SUBNET` | `lo` | |
| `LOG_LEVEL` | `info` | |
| `PORT` | `3000` | |

**`TRUST_PROXY_HOPS` must equal the real number of proxies in front of the sim.** The chain is
Cloudflare edge → cloudflared (LC2) → nginx (LC2) → Caddy → sim, which is 3 trusted hops. If it is
set too low (or left at the default `0`), the sim sees the proxy's address for every client, all
operators share one IP, and `MAX_CONNECTIONS_PER_IP` then locks everyone out after 16 connections.
Set too high and clients can spoof their IP through `X-Forwarded-For`. Re-check it whenever a hop is
added or removed (for example a new load balancer), then `restart sim`. Acceptance step 5 verifies
it from the logs.

The entrypoint applies **only these 9 keys** from Vault (an allowlist in `apps/sim/env-filter.mjs`).
Anything else in the document (`AUTH_DEV_BYPASS`, `NODE_ENV`, `NODE_OPTIONS`,
`NODE_TLS_REJECT_UNAUTHORIZED`, `LD_PRELOAD`, `PATH`, new keys nobody allowlisted) is dropped and its
NAME logged as `Ignored non-allowlisted key(s)`. Adding a new setting means adding it to the
allowlist, `provision-secrets.sh` and this table together. `VAULT_ADDR`/`VAULT_TOKEN`/`VAULT_PATH`
come from `.env` and are removed from the sim process's environment.

**Stopping the sim:** the container receives SIGTERM, which the entrypoint forwards to the sim's
`gracefulShutdown` (stop accepting connections, kick clients with `server shutting down`, flush and
checkpoint the world, close the server and store). `docker-compose.prod.yml` sets
`stop_grace_period: 30s`; never lower it below 10 s (Docker's default) or the checkpoint can be cut
off by SIGKILL. When stopping by hand use `docker compose stop sim` or `docker stop -t 30 …`, not
`docker kill`.

## A. Provision (one-time)

- [ ] **Step 1: S1 is up and baselined**

Power S1 on. Then:

```bash
ssh S1 'hostname; ip -4 addr show enp4s0 | grep inet; docker version --format "{{.Server.Version}}"; \
  id runner; ls -l /usr/local/share/ca-certificates/cloudflare-origin-ca.crt; df -h / | tail -1'
```

Expect `192.168.40.21`, a Docker version, the `runner` user (in the `docker` group), the CA cert and free disk. Then check S1 can reach Vault. Since 2026-04-20 `vault.wispy-nook.casa` resolves through Cloudflare's public DNS and tunnel, so S1 sees Cloudflare's edge certificate, which its system CA bundle already trusts (do not pass `--cacert`; it would replace the trust store and fail):

```bash
ssh S1 'getent hosts vault.wispy-nook.casa; curl -s -o /dev/null -w "%{http_code}\n" https://vault.wispy-nook.casa/v1/sys/health'
```

Expect an IP and an HTTP status (200, 429 or 473 for a healthy Vault), not a curl error. If anything is missing, S1 was provisioned like S2 on 2026-04-20 (`D:\docs\MikroTik\CLAUDE.md`, "S1"); redo the missing piece the same way.

- [ ] **Step 2: GitHub deploy key and self-hosted runner (S1)**

```bash
ssh S1 'sudo install -d -m 700 -o runner -g runner /home/runner/.ssh && \
  sudo -u runner ssh-keygen -t ed25519 -N "" -f /home/runner/.ssh/daemonet-deploy -C daemonet-deploy && \
  printf "Host github.com-daemonet\n  HostName github.com\n  User git\n  IdentityFile ~/.ssh/daemonet-deploy\n  IdentitiesOnly yes\n  StrictHostKeyChecking accept-new\n" | sudo -u runner tee -a /home/runner/.ssh/config >/dev/null && \
  sudo -u runner chmod 600 /home/runner/.ssh/config && \
  sudo -u runner sh -c "ssh-keyscan github.com >> /home/runner/.ssh/known_hosts" && \
  cat /home/runner/.ssh/daemonet-deploy.pub'
```

Add the printed public key as a **read-only deploy key** on `Zaphiruz/daemonet` (Settings → Deploy keys). Store the private key in Vault too (LC3): `ssh S1 'sudo cat /home/runner/.ssh/daemonet-deploy' | ssh LC3 'export VAULT_ADDR=http://127.0.0.1:8200; read -r VAULT_TOKEN ...'` — use the "piping a secret from one host into Vault" recipe in the homelab doc, path `deploy-keys/daemonet`, field `private_key`.

**Before registering the runner (do this first).** Merging this work to `main` automatically queues a Deploy run (CI succeeds, then `deploy.yml` fires), and a queued run starts the moment a runner labelled `daemonet` comes online, before Vault, the database and `.env` exist. So:

1. Configure the GitHub `production` environment now (Step 2b; it may already exist, auto-created by that queued run) with **deployment branches = `main`**.
2. List and cancel any queued or waiting Deploy run: `gh run list --workflow deploy.yml --repo Zaphiruz/daemonet`, then `gh run cancel <id> --repo Zaphiruz/daemonet` for each.
3. Only then run `./config.sh` below. The first deploy is started deliberately at Step 8.
4. After the runner is registered and the `production` environment is configured, set the repository variable `DAEMONET_DEPLOY_ENABLED` to `true` (GitHub → Settings → Secrets and variables → Actions → Variables, or `gh variable set DAEMONET_DEPLOY_ENABLED --body true --repo Zaphiruz/daemonet`); until then deploys are skipped.

Clone and register the runner (GitHub: Settings → Actions → Runners → New self-hosted runner → Linux x64 gives a fresh token):

```bash
ssh S1 'sudo mkdir -p /opt/daemonet /opt/actions-runner-daemonet && sudo chown runner:runner /opt/daemonet /opt/actions-runner-daemonet && \
  sudo -u runner git clone git@github.com-daemonet:Zaphiruz/daemonet.git /opt/daemonet'
ssh S1 'cd /opt/actions-runner-daemonet && sudo -u runner bash -c "curl -sSL -o r.tgz https://github.com/actions/runner/releases/download/v2.337.0/actions-runner-linux-x64-2.337.0.tar.gz && tar xzf r.tgz && rm r.tgz && \
  ./config.sh --url https://github.com/Zaphiruz/daemonet --token <TOKEN> --name s1-daemonet --labels daemonet --unattended" && sudo ./svc.sh install runner && sudo ./svc.sh start'
```

Verify: the runner shows **Idle** with label `daemonet` on GitHub.

- [ ] **Step 2b: GitHub environment `production` (you, in the GitHub UI)**

`deploy.yml` runs in the environment `production`. Create it: repository Settings → Environments → New environment → `production`, then **Deployment branches and tags → Selected branches and tags → add `main` only**. Optionally add yourself as a required reviewer so every deploy waits for an approval click. Without the branch restriction a manual `workflow_dispatch` from another branch could be pointed at the self-hosted runner (the workflow also refuses non-`main` dispatches itself, but the environment rule is the enforced one).

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

Note: `docker compose up -d postgresql` recreates the shared PostgreSQL container, so every app that uses it (Plantry, Third Eye, Mealie, ...) loses its database connection for a few seconds. Do it at a quiet time.

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

Expect `kv written: 9 keys` and `GET secret/data/daemonet with the app token -> HTTP 200`. Confirm `TRUST_PROXY_HOPS` matches the proxy chain (see the configuration reference above) before the first deploy.

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
2. **Persistence across a restart:** `ssh S1 'cd /opt/daemonet && docker compose -f docker-compose.prod.yml restart -t 30 sim'`; rerun the bot; the log line `connected as …` is followed by no `claimed` line (starter already claimed) and the captured daemon is in RAM (`game.self.ram` — the bot prints `captured` only for new ones; check with `psql`: `ssh S2 'docker exec shared-infra-postgresql-1 psql -U daemonet -d daemonet -c "select species, location, slot from \"Daemon\""'`). Also confirm the restart was graceful: check it from the log, not from exit codes: `docker compose -f docker-compose.prod.yml logs --tail 100 sim` shows `shutting down`, then the shutdown lines, then `daemonet sim started` for the new process.
3. **Tag protection with a second operator:** a second Authentik user in `daemonet-users` runs the bot at the same time; its log shows `capture failed`/no capture of the first bot's tagged target, and no `E_STATE` other than tag conflicts.
4. **Group gate:** remove a user from `daemonet-users`, restart their bot → `E_AUTH` (`authentication failed`; the real reason, `not in daemonet-users`, is in the sim log). Add them back.
5. **Real client IPs and no PII:** `ssh S1 'cd /opt/daemonet && docker compose -f docker-compose.prod.yml logs --tail 50 sim | grep "operator connected"'` shows your public IP in `ip` and a `sub`, never a name or email. If `ip` is the LC2/Caddy/Docker address instead of your public IP, `TRUST_PROXY_HOPS` is wrong: fix it in Vault (`vault kv patch secret/daemonet TRUST_PROXY_HOPS=<n>`) and restart before going further, otherwise the per-IP connection cap applies to everyone together.
6. **Existing apps unaffected:** open Plantry, Third Eye and Mealie; all load.
7. **Load (staging sim with its own throwaway database; never production data):** the load test needs `AUTH_DEV_BYPASS`, which production refuses, so it runs a **separate staging container** that does not use Vault and is never pointed at the `daemonet` database. Rule: a sim with dev bypass on must only ever see a throwaway database.

   ```bash
   # 1. Throwaway database + env file (password piped S2 -> S1, never on a command line; env file in tmpfs).
   ssh S2 'docker exec shared-infra-postgresql-1 psql -U postgres -c "CREATE DATABASE daemonet_staging OWNER daemonet TEMPLATE template0;"'
   ssh S2 'cat /root/.daemonet-db-pw' | ssh S1 'umask 077; read -r PW; printf "DATABASE_URL=postgresql://daemonet:%s@192.168.40.20:5432/daemonet_staging\nAUTH_DEV_BYPASS=true\nNODE_ENV=development\nMAX_CONNECTIONS_PER_IP=128\nSUBNET=lo\nLOG_LEVEL=info\n" "$PW" > /dev/shm/daemonet-staging.env'
   # 2. Migrate it and start the staging sim, bound to S1 loopback only (reach it through an SSH tunnel).
   H="--rm --env-file /dev/shm/daemonet-staging.env --entrypoint '' --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true"
   ssh S1 "docker run $H daemonet-sim:latest sh -c 'cd packages/db && node_modules/.bin/prisma migrate deploy' && \
     docker run -d $H -p 127.0.0.1:3011:3000 --name daemonet-staging daemonet-sim:latest node apps/sim/dist/runtime/main.js"
   ```

   (Plain `docker run` on the image built by the last deploy, not `compose run`: the compose service would also inject the Vault `.env`. `--entrypoint ''` skips the Vault entrypoint on purpose; the sim gets only the staging env file. `MAX_CONNECTIONS_PER_IP=128` is set for this container only: all 64 bots share your tunnel's one IP. Production's cap is untouched.) From the workstation: `ssh -L 3011:127.0.0.1:3011 S1`, then `DAEMONET_URL=ws://127.0.0.1:3011/ws DAEMONET_BOTS=64 pnpm --filter @daemonet/starter-bot load` for 5 minutes. The `tick stats` log lines must show `p99` under 32 ms. Never publish port 3011 on the LAN address. Clean up afterwards (the staging sim runs detached; `docker stop daemonet-staging` stops it and, because of `--rm`, removes it):

   ```bash
   ssh S1 'docker stop daemonet-staging'
   ssh S2 'docker exec shared-infra-postgresql-1 psql -U postgres -c "DROP DATABASE daemonet_staging;"'
   ssh S1 'rm -f /dev/shm/daemonet-staging.env'
   ```

- [ ] **Step 10: Record it in the homelab doc**

Add to `D:\docs\MikroTik\CLAUDE.md`: S1 now hosts Daemonet (compose at `/opt/daemonet`, port 3010 LAN-bound, runner `s1-daemonet`, Vault `secret/daemonet`, Authentik slug `daemonet-bot` public client + device flow, DB `daemonet`); shared PostgreSQL is published on `192.168.40.20:5432` restricted to S1 by `DOCKER-USER`; the nginx `websocket-upgrade.conf` map on LC2; the S2 port table gains `3010 Daemonet (on S1)`.

## C. Day-2 operations

- **Logs:** `ssh S1 'cd /opt/daemonet && docker compose -f docker-compose.prod.yml logs -f sim'` (pino JSON; `tick stats` every 64 s).
- **Restart:** `… restart sim` — Compose sends SIGTERM and waits up to `stop_grace_period` (30 s) for the graceful shutdown to checkpoint the world. Connected bots are kicked with `server shutting down`, reconnect and resume on their own; the world reloads from the last checkpoint (≤ 32 s of movement lost, never a daemon).
- **Change a secret:** `vault kv patch secret/daemonet KEY=value` on LC3, then `… restart sim`. This includes `TRUST_PROXY_HOPS` and `MAX_CONNECTIONS_PER_IP`.
- **Rotate the Vault token:** it is periodic (30 d, renewed weekly by LC3's timer); to replace it, rerun `scripts/provision-secrets.sh` (reuses the existing token unless removed from `/opt/vault/app-tokens`), then `fetch-secrets.sh` and restart. Rerunning the script **rewrites the whole Vault document** (`kv put`), so re-apply any later `vault kv patch` changes (for example a tuned `TRUST_PROXY_HOPS`) afterwards.
- **Migrations:** run by `deploy.yml` before `up -d`; manual: the "Run migrations" step's command in `.github/workflows/deploy.yml`. The migrate container runs under the production hardening (`read_only`, tmpfs `/tmp`, all capabilities dropped, `no-new-privileges`); `prisma migrate deploy` was verified to apply pending migrations under exactly those flags against a throwaway database. Fallback if a future Prisma upgrade needs a writable path (first try a tmpfs for it, set through an environment variable): run the migration once by hand without `--read-only`, with `DATABASE_URL` exported from Vault as in the workflow step: `docker run --rm -e DATABASE_URL --entrypoint "" daemonet-sim:latest sh -c 'cd packages/db && node_modules/.bin/prisma migrate deploy'`; then deploy.
- **Backups:** the `daemonet` database is included in S2's nightly `pg_dumpall` automatically.
- **Disk:** `docker image prune -f` runs after each deploy; check `df -h /` on S1 occasionally.
- **Wipe the world (dev only):** stop the sim, `psql -U daemonet -d daemonet -c 'TRUNCATE "Daemon","Operator","SubnetSeed","AppliedAction" CASCADE'`, start the sim. Operators re-claim starters.

### Troubleshooting

- **`Vault responded 503` in the sim log at start:** Vault is sealed (LC3 rebooted). Unseal it, then `restart sim`.
- **`/ws/ready` returns 503 (and the deploy health check fails):** the database is unreachable. Check that S2's PostgreSQL is up and that the `DOCKER-USER` rule on S2 still allows S1 (`ssh S2 'sudo iptables -S DOCKER-USER'`, and the Step 3 verification lines).
- **Clients get HTTP 429 on connect:** the per-IP connection cap. Either one client really opened more than `MAX_CONNECTIONS_PER_IP` connections, or `TRUST_PROXY_HOPS` is wrong and everyone shares the proxy's IP (see the warning in the configuration reference and acceptance step 5).
