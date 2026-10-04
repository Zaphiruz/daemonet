import { OPEN_SUBNET_IDS, getSubnet } from '@daemonet/rules';
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
  /** Comma-separated subnet ids this process hosts (default: every open subnet). */
  SUBNETS: z.string().default(OPEN_SUBNET_IDS.join(',')),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** redis://daemonet:<pw>@host:6379/4 — unset: in-process bus (single sim process, no api moderation push). */
  REDIS_URL: z.string().min(1).optional(),
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
  /** Hosted subnet ids; the first is the default world (new operators, unhosted subnets). */
  subnets: string[];
  logLevel: string;
  /** Shared Redis for the sim ⇄ api bus; undefined = in-process bus. */
  redisUrl: string | undefined;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const e = Env.parse(env);
  const devBypass = e.AUTH_DEV_BYPASS === 'true';
  if (devBypass && e.NODE_ENV === 'production') throw new Error('AUTH_DEV_BYPASS must not be enabled in production');
  const subnets = e.SUBNETS.split(',').map((s) => s.trim()).filter(Boolean);
  if (subnets.length === 0) throw new Error('SUBNETS must name at least one subnet');
  if (new Set(subnets).size !== subnets.length) throw new Error('SUBNETS must not repeat a subnet');
  for (const id of subnets) getSubnet(id); // throws on an unknown id
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
    subnets,
    logLevel: e.LOG_LEVEL,
    redisUrl: e.REDIS_URL,
  };
}
