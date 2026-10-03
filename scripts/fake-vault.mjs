// Local stand-in for Vault so the production image can be booted on a workstation (plan 4 task 1).
// Serves the same document shape as secret/data/daemonet; AUTH_DEV_BYPASS is present on purpose
// to prove the entrypoint ignores protected keys.
import { createServer } from 'node:http';
const secrets = {
  DATABASE_URL: 'postgresql://daemonet:daemonet@host.docker.internal:5432/daemonet_test',
  AUTH_DEV_BYPASS: 'true',            // protected: must be ignored by the entrypoint
  AUTHENTIK_ISSUER_URL: 'https://authentik.wispy-nook.casa/application/o/daemonet-bot/',
  AUTHENTIK_BOT_CLIENT_ID: 'daemonet-bot',
  TRUST_PROXY_HOPS: '3', MAX_CONNECTIONS_PER_IP: '16', SUBNET: 'lo', LOG_LEVEL: 'info', PORT: '3000',
  // apps/api (web login); each app's allowlist drops the other's keys.
  SESSION_SECRET: 'local-session-secret-local-session-secret', SESSION_COOKIE_SECURE: 'false', FRONTEND_ORIGIN: 'http://127.0.0.1:3010',
  AUTHENTIK_WEB_ISSUER_URL: 'https://authentik.wispy-nook.casa/application/o/daemonet/', AUTHENTIK_CLIENT_ID: 'daemonet', AUTHENTIK_CLIENT_SECRET: 'not-a-real-secret', AUTHENTIK_REDIRECT_URI: 'http://127.0.0.1:3010/api/auth/callback', AUTH_ADMIN_GROUP: 'daemonet-admins',
};
createServer((req, res) => {
  if (req.url === '/v1/secret/data/daemonet' && req.headers['x-vault-token'] === 'tok') {
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: { data: secrets } })); return;
  }
  res.writeHead(403).end();
}).listen(8200, () => console.log('fake vault up'));
