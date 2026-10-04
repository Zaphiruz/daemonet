import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  SESSION_COOKIE_SECURE: z.enum(['true', 'false']).default('true'),
  FRONTEND_ORIGIN: z.url(),
  AUTHENTIK_WEB_ISSUER_URL: z.url().optional(),
  AUTHENTIK_CLIENT_ID: z.string().min(1).optional(),
  AUTHENTIK_CLIENT_SECRET: z.string().min(1).optional(),
  AUTHENTIK_REDIRECT_URI: z.url().optional(),
  /** The bot provider `daemonet-bot` (the sim's keys): bots' bearer tokens on /api (SP5). Both unset = bearer tokens off. */
  AUTHENTIK_ISSUER_URL: z.url().optional(),
  AUTHENTIK_BOT_CLIENT_ID: z.string().min(1).optional(),
  AUTH_REQUIRED_GROUP: z.string().min(1).default('daemonet-users'),
  AUTH_ADMIN_GROUP: z.string().min(1).default('daemonet-admins'),
  AUTH_DEV_BYPASS: z.enum(['true', 'false']).default('false'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** The sim ⇄ api bus (SP4 §4); unset → an in-process bus (admin chat actions then never reach the sim). */
  REDIS_URL: z.string().min(1).optional(),
});

export interface ApiConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  sessionSecret: string;
  cookieSecure: boolean;
  frontendOrigin: string;
  oidc: { issuer: string; clientId: string; clientSecret: string; redirectUri: string } | null;
  /** Bearer tokens from the bot provider (issuer + public client id = accepted audience); null = only `dev:` tokens (dev bypass). */
  botOidc: { issuer: string; clientId: string } | null;
  requiredGroup: string;
  adminGroup: string;
  devBypass: boolean;
  trustProxyHops: number;
  logLevel: string;
  redisUrl: string | undefined;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  const e = Env.parse(env);
  const devBypass = e.AUTH_DEV_BYPASS === 'true';
  if (devBypass && e.NODE_ENV === 'production') throw new Error('AUTH_DEV_BYPASS must not be enabled in production');
  const oidc =
    e.AUTHENTIK_WEB_ISSUER_URL && e.AUTHENTIK_CLIENT_ID && e.AUTHENTIK_CLIENT_SECRET && e.AUTHENTIK_REDIRECT_URI
      ? { issuer: e.AUTHENTIK_WEB_ISSUER_URL, clientId: e.AUTHENTIK_CLIENT_ID, clientSecret: e.AUTHENTIK_CLIENT_SECRET, redirectUri: e.AUTHENTIK_REDIRECT_URI }
      : null;
  const botOidc = e.AUTHENTIK_ISSUER_URL && e.AUTHENTIK_BOT_CLIENT_ID ? { issuer: e.AUTHENTIK_ISSUER_URL, clientId: e.AUTHENTIK_BOT_CLIENT_ID } : null;
  if (!oidc && !devBypass) throw new Error('set the AUTHENTIK_* variables (or AUTH_DEV_BYPASS=true outside production)');
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    sessionSecret: e.SESSION_SECRET,
    cookieSecure: e.SESSION_COOKIE_SECURE === 'true',
    frontendOrigin: new URL(e.FRONTEND_ORIGIN).origin,
    oidc,
    botOidc,
    requiredGroup: e.AUTH_REQUIRED_GROUP,
    adminGroup: e.AUTH_ADMIN_GROUP,
    devBypass,
    trustProxyHops: e.TRUST_PROXY_HOPS,
    logLevel: e.LOG_LEVEL,
    redisUrl: e.REDIS_URL,
  };
}
