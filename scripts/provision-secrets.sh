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
# Safe to re-run, but the KV write is a full replace (any later `vault kv patch` changes are lost; re-apply them); an existing app token is reused, not duplicated.
set -euo pipefail

say() { printf '%s\n' "$*" >&2; }
ask_secret() { local v; read -r -s -p "$1: " v; echo >&2; printf '%s' "$v"; }
ask() { local v; read -r -p "$1: " v; printf '%s' "$v"; }

[ -f apps/sim/package.json ] || { say "Run from the repo root."; exit 1; }

say "== Things only you have (input is hidden) =="
VAULT_ROOT_TOKEN=$(ask_secret "Vault root token (1Password)")
BOT_CLIENT_ID=$(ask "Authentik client ID of the public provider 'daemonet-bot'")
WEB_CLIENT_ID=$(ask "Authentik client ID of the confidential provider 'daemonet' (web login)")
WEB_CLIENT_SECRET=$(ask_secret "Authentik client secret of 'daemonet'")
[ -n "$VAULT_ROOT_TOKEN" ] && [ -n "$BOT_CLIENT_ID" ] && [ -n "$WEB_CLIENT_ID" ] && [ -n "$WEB_CLIENT_SECRET" ]   || { say "Vault token, both client IDs and the web client secret are required."; exit 1; }

say "== Reading the DB password from S2 =="
DB_PW=$(ssh -o BatchMode=yes S2 'cat /root/.daemonet-db-pw')
[ -n "$DB_PW" ] || { say "Missing /root/.daemonet-db-pw on S2 (OPERATIONS step 3)."; exit 1; }

say "== Building the secret document =="
PY=$(command -v python3 || command -v py || command -v python || true)
[ -n "$PY" ] || { say "Python is required (python3, py or python)."; exit 1; }
[ "$(basename "$PY" .exe)" = py ] && PY="$PY -3"
# Generated in memory, never printed. A re-run replaces it, which signs every web session out.
SESSION_SECRET=$($PY -c 'import secrets; print(secrets.token_hex(32))')
export DB_PW BOT_CLIENT_ID WEB_CLIENT_ID WEB_CLIENT_SECRET SESSION_SECRET
KV_JSON=$($PY - <<'PY'
import json, os
d = {
  # The sim runs on S1 and reaches the shared PostgreSQL on S2 over the VLAN 40 LAN (OPERATIONS step 3).
  "DATABASE_URL": f"postgresql://daemonet:{os.environ['DB_PW']}@192.168.40.20:5432/daemonet",
  "AUTHENTIK_ISSUER_URL": "https://authentik.wispy-nook.casa/application/o/daemonet-bot/",
  "AUTHENTIK_BOT_CLIENT_ID": os.environ["BOT_CLIENT_ID"],
  "AUTH_REQUIRED_GROUP": "daemonet-users",
  # Number of proxies between the client and the sim: cloudflared -> nginx (both LC2) -> Caddy.
  # Caddy trusts only LC2. MUST equal the real chain length: too low and every client shares one IP
  # (the per-IP cap then locks everyone out); too high and clients can spoof their IP.
  # Change it whenever the chain changes.
  "TRUST_PROXY_HOPS": "3",
  # Per-client-IP concurrent connection cap (sim default is 16).
  "MAX_CONNECTIONS_PER_IP": "16",
  "SUBNET": "lo",
  "LOG_LEVEL": "info",
  "PORT": "3000",
  # apps/api (web login). The sim's entrypoint drops these (and the api drops the bot/sim-only keys);
  # each app's allowlist logs only the NAMES it ignored.
  "SESSION_SECRET": os.environ["SESSION_SECRET"],
  "SESSION_COOKIE_SECURE": "true",
  "FRONTEND_ORIGIN": "https://daemonet.wispy-nook.casa",
  # Issuer of the web provider (slug daemonet); the api no longer reads AUTHENTIK_ISSUER_URL (that is the bot issuer, used by the sim).
  "AUTHENTIK_WEB_ISSUER_URL": "https://authentik.wispy-nook.casa/application/o/daemonet/",
  "AUTHENTIK_CLIENT_ID": os.environ["WEB_CLIENT_ID"],
  "AUTHENTIK_CLIENT_SECRET": os.environ["WEB_CLIENT_SECRET"],
  "AUTHENTIK_REDIRECT_URI": "https://daemonet.wispy-nook.casa/api/auth/callback",
  "AUTH_ADMIN_GROUP": "daemonet-admins",
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
# The token is piped to curl on stdin (-H @-), never put on a command line. No custom CA: vault.wispy-nook.casa
# resolves via Cloudflare, whose public edge certificate chains to the system trust store.
ssh -o BatchMode=yes S1 '
  code=$(printf "X-Vault-Token: %s\n" "$(cat /root/.daemonet-vault-token)" \
    | curl -s -o /dev/null -w "%{http_code}" -H @- https://vault.wispy-nook.casa/v1/secret/data/daemonet)
  echo "GET secret/data/daemonet with the app token -> HTTP $code (want 200)" >&2'

unset VAULT_ROOT_TOKEN DB_PW KV_JSON APP_TOKEN WEB_CLIENT_SECRET SESSION_SECRET
say "Done. Next: OPERATIONS step 6 (move the token into /opt/daemonet, write .env)."
