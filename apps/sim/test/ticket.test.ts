import { createHash } from 'node:crypto';
import { createPrisma } from '@daemonet/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthError, combineVerifiers } from '../src/runtime/auth.js';
import { createTicketVerifier } from '../src/runtime/ticket.js';

const url = process.env.DATABASE_URL;
const prisma = url ? createPrisma(url) : null;
const hash = (v: string) => createHash('sha256').update(v).digest('hex');

describe.skipIf(!url)('ticket verifier (needs DATABASE_URL)', () => {
  afterAll(async () => prisma?.$disconnect());
  beforeEach(async () => {
    await prisma!.$executeRawUnsafe('TRUNCATE "WsTicket", "Operator" CASCADE');
  });

  async function mint(value: string, ttlMs = 60_000) {
    const op = await prisma!.operator.upsert({ where: { sub: 'user-t' }, update: {}, create: { sub: 'user-t', x: 1, y: 1 } });
    await prisma!.wsTicket.create({ data: { tokenHash: hash(value), operatorId: op.id, expiresAt: new Date(Date.now() + ttlMs) } });
  }

  it('accepts a fresh ticket exactly once', async () => {
    await mint('abc');
    const verify = createTicketVerifier(prisma!, 'daemonet-users');
    expect(await verify('ticket:abc')).toEqual({ sub: 'user-t', groups: ['daemonet-users'] });
    await expect(verify('ticket:abc')).rejects.toBeInstanceOf(AuthError);
    expect(await prisma!.wsTicket.count()).toBe(0);
  });

  it('lets only one of many concurrent uses of a ticket succeed', async () => {
    await mint('race');
    const verify = createTicketVerifier(prisma!, 'daemonet-users');
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => verify('ticket:race')));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(AuthError);
  });

  it('rejects expired and unknown tickets, and routes the ticket: prefix', async () => {
    await mint('old', -1000);
    const verify = combineVerifiers(null, null, createTicketVerifier(prisma!, 'daemonet-users'));
    await expect(verify('ticket:old')).rejects.toThrow(/expired/);
    expect(await prisma!.wsTicket.count()).toBe(0);
    await expect(verify('ticket:nope')).rejects.toBeInstanceOf(AuthError);
    await expect(verify('ticket:')).rejects.toThrow(/empty/);
    await expect(combineVerifiers(null, null)('ticket:x')).rejects.toThrow(/not configured/);
  });
});
