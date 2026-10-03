import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { filterSecrets } from './env-filter.mjs';

const { VAULT_ADDR, VAULT_TOKEN, VAULT_PATH = 'secret/data/daemonet' } = process.env;
if (!VAULT_ADDR || !VAULT_TOKEN) {
  console.error('[entrypoint] VAULT_ADDR and VAULT_TOKEN must be set');
  process.exit(1);
}
console.log('[entrypoint] Fetching secrets from Vault...');
let res;
try {
  res = await fetch(`${VAULT_ADDR}/v1/${VAULT_PATH}`, {
    headers: { 'X-Vault-Token': VAULT_TOKEN },
    signal: AbortSignal.timeout(10_000),
  });
} catch (err) {
  console.error(`[entrypoint] Vault request failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
if (!res.ok) {
  console.error(`[entrypoint] Vault responded ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const { data: { data: secrets } } = await res.json();
const { applied, ignored } = filterSecrets(secrets);
if (ignored.length) console.warn(`[entrypoint] Ignored non-allowlisted key(s) from Vault: ${ignored.join(', ')}`);

// The api never needs the Vault credentials: do not leak them into its environment.
const childEnv = { ...process.env, ...applied };
delete childEnv.VAULT_TOKEN;
delete childEnv.VAULT_ADDR;
delete childEnv.VAULT_PATH;
console.log('[entrypoint] Secrets loaded, starting api...');

// SIGTERM/SIGINT are forwarded so the api shuts down cleanly: it closes its HTTP server (in-flight
// requests finish) and disconnects Prisma. The container's stop_grace_period must outlast that.
const child = spawn(process.execPath, ['apps/api/dist/server.js'], { stdio: 'inherit', env: childEnv });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => {
  if (code !== null) process.exit(code);
  // Killed by a signal: SIGTERM is the normal stop; anything else (OOM SIGKILL, SIGSEGV) is a failure.
  process.exit(signal === 'SIGTERM' ? 0 : 128 + (constants.signals[signal] ?? 1));
});
