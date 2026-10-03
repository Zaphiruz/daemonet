import { createHash } from 'node:crypto';
import type { PrismaClient } from '@daemonet/db';
import { AuthError, type Claims, type TokenVerifier } from './auth.js';

const hash = (v: string) => createHash('sha256').update(v).digest('hex');

/**
 * Browser sockets authenticate with a single-use ticket minted by the API (`ticket:<value>`).
 * Consumption is a single `deleteMany` keyed by the hash: only the caller whose DELETE removes the row
 * (count 1) wins, so two concurrent uses of one ticket cannot both succeed. Expired rows are deleted too
 * and rejected. Group membership was checked by the API at login, so the ticket implies the required group.
 */
export function createTicketVerifier(prisma: PrismaClient, requiredGroup: string): TokenVerifier {
  return async (token): Promise<Claims> => {
    const value = token.slice('ticket:'.length);
    if (!value) throw new AuthError('empty ticket');
    const tokenHash = hash(value);
    const found = await prisma.wsTicket.findUnique({ where: { tokenHash }, include: { operator: { select: { sub: true } } } });
    if (!found) throw new AuthError('invalid or expired ticket');
    const { count } = await prisma.wsTicket.deleteMany({ where: { tokenHash } });
    if (count !== 1 || found.expiresAt.getTime() <= Date.now()) throw new AuthError('invalid or expired ticket');
    return { sub: found.operator.sub, groups: [requiredGroup] };
  };
}
