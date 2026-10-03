import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  AUTHENTIK_ISSUER_URL: z.url().optional(),
  AUTHENTIK_BOT_CLIENT_ID: z.string().min(1).optional(),
  AUTH_REQUIRED_GROUP: z.string().min(1).default('daemonet-users'),
  AUTH_DEV_BYPASS: z.enum(['true', 'false']).default('false'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  MAX_CONNECTIONS_PER_IP: z.coerce.number().int().positive().default(16),
  SUBNET: z.string().default('lo'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  oidc: { issuer: string; clientId: string } | null;
  requiredGroup: string;
  devBypass: boolean;
  trustProxyHops: number;
  maxConnectionsPerIp: number;
  subnet: string;
  logLevel: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const e = Env.parse(env);
  const devBypass = e.AUTH_DEV_BYPASS === 'true';
  if (devBypass && e.NODE_ENV === 'production') throw new Error('AUTH_DEV_BYPASS must not be enabled in production');
  const oidc = e.AUTHENTIK_ISSUER_URL && e.AUTHENTIK_BOT_CLIENT_ID ? { issuer: e.AUTHENTIK_ISSUER_URL, clientId: e.AUTHENTIK_BOT_CLIENT_ID } : null;
  if (!oidc && !devBypass) throw new Error('set AUTHENTIK_ISSUER_URL and AUTHENTIK_BOT_CLIENT_ID (or AUTH_DEV_BYPASS=true outside production)');
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    oidc,
    requiredGroup: e.AUTH_REQUIRED_GROUP,
    devBypass,
    trustProxyHops: e.TRUST_PROXY_HOPS,
    maxConnectionsPerIp: e.MAX_CONNECTIONS_PER_IP,
    subnet: e.SUBNET,
    logLevel: e.LOG_LEVEL,
  };
}
