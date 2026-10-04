import type { Bus } from '@daemonet/bus';
import type { PrismaClient } from '@daemonet/db';
import { INCIDENT_PERIOD_MS, INCIDENT_WINDOW_MS, bossSpecies, incidentNumber, nextIncidentStart } from '@daemonet/rules';
import type { FastifyInstance } from 'fastify';
import { conflict, notFound } from '../errors.js';
import { publishSafely } from '../publish.js';

/** The history shows names, damage share and reward only (SP4 spec §8): never an operator id or a payout flag. */
export interface PublicParticipant {
  name: string | null;
  damage: number;
  share: number;
  reward: number;
  you: boolean;
}

interface StoredParticipant {
  operatorId: string;
  name: string | null;
  damage: number;
  share: number;
  reward: number;
}

/** Reads the stored participants defensively (the column is Json): anything malformed is skipped. */
function storedParticipants(raw: unknown): StoredParticipant[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((p: unknown) => {
    const x = p as Record<string, unknown> | null;
    if (!x || typeof x.operatorId !== 'string') return [];
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    return [{ operatorId: x.operatorId, name: typeof x.name === 'string' ? x.name : null, damage: num(x.damage), share: num(x.share), reward: num(x.reward) }];
  });
}

interface IncidentRow {
  id: string;
  n: number;
  species: string;
  openedAt: Date;
  endsAt: Date;
  closedAt: Date | null;
  outcome: string;
  participants: unknown;
}

/** Incident schedule and history (SP4 spec §8); admins can start one now. */
export function registerIncidentRoutes(app: FastifyInstance, prisma: PrismaClient, bus: Bus): void {
  const auth = { preHandler: app.requireAuth };

  /** One public view per row: operators' current names (a rename shows up in old history), `you` marks the caller. */
  async function present(rows: IncidentRow[], me: string) {
    const parsed = rows.map((r) => storedParticipants(r.participants));
    const ids = [...new Set(parsed.flatMap((ps) => ps.map((p) => p.operatorId)))];
    const names = new Map((ids.length ? await prisma.operator.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : []).map((o) => [o.id, o.name]));
    return rows.map((r, i) => ({
      id: r.id,
      n: r.n,
      species: r.species,
      openedAt: r.openedAt,
      endsAt: r.endsAt,
      closedAt: r.closedAt,
      outcome: r.outcome,
      participants: parsed[i]!.map((p): PublicParticipant => ({ name: names.get(p.operatorId) ?? p.name, damage: p.damage, share: p.share, reward: p.reward, you: p.operatorId === me })),
    }));
  }

  app.get('/api/incidents', auth, async (req) => {
    const now = Date.now();
    const rows = await prisma.incident.findMany({ orderBy: { openedAt: 'desc' }, take: 16 });
    const recent = await present(rows, req.operator!.id);
    const current = recent.find((r) => r.outcome === 'OPEN' && r.endsAt.getTime() > now) ?? null;
    const start = nextIncidentStart(now);
    return {
      next: { at: new Date(start).toISOString(), species: bossSpecies(incidentNumber(start)), periodMs: INCIDENT_PERIOD_MS, windowMs: INCIDENT_WINDOW_MS },
      current: current ? { id: current.id, n: current.n, species: current.species, openedAt: current.openedAt, endsAt: current.endsAt } : null,
      recent,
    };
  });

  app.get<{ Params: { id: string } }>('/api/incidents/:id', auth, async (req) => {
    const row = await prisma.incident.findUnique({ where: { id: req.params.id } });
    if (!row) throw notFound('no such incident');
    return (await present([row], req.operator!.id))[0]!;
  });

  app.post('/api/admin/incidents/start', { preHandler: [app.requireAuth, app.requireAdmin] }, async (req) => {
    // the sim refuses a second start too (and this check is only a courtesy to the admin), so the row read need not be locked
    const running = await prisma.incident.findFirst({ where: { outcome: 'OPEN', endsAt: { gt: new Date() } }, select: { id: true } });
    if (running) throw conflict('an Incident is already running');
    publishSafely(bus, req.log, 'admin', { kind: 'incident:start', origin: 'api' });
    return { ok: true };
  });
}
