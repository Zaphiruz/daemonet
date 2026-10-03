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
console.log('[entrypoint] Secrets loaded, starting api...');

const child = spawn(process.execPath, ['apps/api/dist/server.js'], { stdio: 'inherit', env: process.env });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));
