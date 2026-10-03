#!/usr/bin/env bash
# Writes the only two values the containers get from disk. Run on S1 in /opt/daemonet.
set -euo pipefail
cd "$(dirname "$0")"
umask 077
printf 'VAULT_ADDR=https://vault.wispy-nook.casa\nVAULT_TOKEN=%s\n' "$(cat vault-token)" > .env
echo ".env written"
