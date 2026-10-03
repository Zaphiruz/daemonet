import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@daemonet/db';

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
export const randomToken = (): string => randomBytes(32).toString('base64url');

export interface SessionRecord {
  operatorId: string;
  groups: string[];
  expiresAt: Date;
  /** Current `Operator.isAdmin`: the source of truth for admin rights (kept up to date at login). */
  isAdmin: boolean;
}

export interface SessionStore {
  create(operatorId: string, groups: string[]): Promise<string>;
  get(token: string): Promise<SessionRecord | null>;
  touch(token: string): Promise<void>;
  destroy(token: string): Promise<void>;
}

/** A session is never valid longer than this after creation, however often its sliding expiry was extended. */
export const SESSION_ABSOLUTE_MS = 30 * 24 * 3600 * 1000;

/** Sessions live in PostgreSQL; only the SHA-256 of the cookie value is stored. */
export function createSessionStore(prisma: PrismaClient, ttlSeconds: number): SessionStore {
  const expiry = () => new Date(Date.now() + ttlSeconds * 1000);
  return {
    async create(operatorId, groups) {
      const token = randomToken();
      await prisma.session.create({ data: { tokenHash: hashToken(token), operatorId, groups, expiresAt: expiry() } });
      return token;
    },
    async get(token) {
      const row = await prisma.session.findUnique({ where: { tokenHash: hashToken(token) }, include: { operator: { select: { isAdmin: true } } } });
      if (!row) return null;
      if (row.expiresAt.getTime() <= Date.now() || row.createdAt.getTime() + SESSION_ABSOLUTE_MS <= Date.now()) {
        await prisma.session.deleteMany({ where: { tokenHash: row.tokenHash } });
        return null;
      }
      return { operatorId: row.operatorId, groups: row.groups, expiresAt: row.expiresAt, isAdmin: row.operator.isAdmin };
    },
    async touch(token) {
      await prisma.session.updateMany({ where: { tokenHash: hashToken(token) }, data: { expiresAt: expiry(), lastSeenAt: new Date() } });
    },
    async destroy(token) {
      await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
    },
  };
}
