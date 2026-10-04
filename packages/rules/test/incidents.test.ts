import { describe, expect, it } from 'vitest';
import { BESTIARY } from '../src/content/bestiary.js';
import { INCIDENT_PERIOD_MS, INCIDENT_POOL, KERNEL_DAEMONS, bossSpecies, incidentNumber, incidentPayouts, lineBase, nextIncidentStart } from '../src/content/incidents.js';
import { getSpecies } from '../src/content/species.js';
import { HOSTED_SUBNET_IDS, OPEN_SUBNET_IDS, getGateway, getSubnet } from '../src/content/subnets.js';
import { ticketBoard } from '../src/content/tickets.js';

describe('incident schedule', () => {
  it('starts on every multiple of four hours UTC', () => {
    const t = Date.parse('2026-10-01T05:30:00Z');
    expect(new Date(nextIncidentStart(t)).toISOString()).toBe('2026-10-01T08:00:00.000Z');
    expect(nextIncidentStart(Date.parse('2026-10-01T08:00:00Z'))).toBe(Date.parse('2026-10-01T08:00:00Z'));
    expect(incidentNumber(nextIncidentStart(t) + INCIDENT_PERIOD_MS) - incidentNumber(nextIncidentStart(t))).toBe(1);
  });

  it('rotates capstones as the kernel daemon; adds are the base form of its line', () => {
    expect(KERNEL_DAEMONS.length).toBeGreaterThanOrEqual(4);
    for (const id of KERNEL_DAEMONS) expect(getSpecies(id).capstone).toBe(true);
    expect(bossSpecies(0)).toBe(KERNEL_DAEMONS[0]);
    expect(bossSpecies(KERNEL_DAEMONS.length + 1)).toBe(KERNEL_DAEMONS[1]);
    expect(lineBase('pidzero')).toBe('initling');
    expect(getSpecies(lineBase('pingodeth')).stage).toBe(0);
  });

  it('every kernel daemon has a base form in its own line, and every line has exactly one', () => {
    for (const id of KERNEL_DAEMONS) {
      const base = getSpecies(lineBase(id));
      expect(base.stage).toBe(0);
      expect(base.line).toBe(getSpecies(id).line);
    }
    for (const line of new Set(BESTIARY.map((r) => r.line))) expect(BESTIARY.filter((r) => r.line === line && r.stage === 0)).toHaveLength(1);
    expect(() => lineBase('nope')).toThrow(RangeError);
  });
});

describe('incidentPayouts', () => {
  it('splits the pool by damage, drops contributors under 1% and guarantees 64 bits to the rest', () => {
    const p = incidentPayouts(new Map([['a', 6000], ['b', 3000], ['c', 950], ['d', 50]]));
    expect(p.map((x) => x.operatorId)).toEqual(['a', 'b', 'c']);
    expect(p[0]).toMatchObject({ share: 0.6, reward: 4915 });
    expect(p[1]!.reward).toBe(2457);
    expect(p[2]!.reward).toBe(778);
    expect(incidentPayouts(new Map([['a', 9900], ['b', 100]]))[1]).toMatchObject({ operatorId: 'b', reward: 81 });
    expect(incidentPayouts(new Map([['a', 9950], ['b', 105]]), 1000)[1]!.reward).toBe(64);
    expect(incidentPayouts(new Map())).toEqual([]);
  });

  it('pays whole bits and never more than the default pool (the 64-bit floor cannot bind at 1% of 8192)', () => {
    expect(Math.floor(INCIDENT_POOL * 0.01)).toBeGreaterThanOrEqual(64);
    const cases: Array<Array<[string, number]>> = [
      [['a', 1], ['b', 1], ['c', 1]],
      [['a', 7], ['b', 7], ['c', 7], ['d', 7], ['e', 7], ['f', 7], ['g', 7]],
      Array.from({ length: 16 }, (_, i): [string, number] => [`op${i}`, 1 + ((i * 7919) % 101)]),
      [['a', 99], ['b', 1]],
      [['solo', 123_456]],
    ];
    for (const c of cases) {
      const p = incidentPayouts(new Map(c));
      expect(p.length).toBeGreaterThan(0);
      for (const x of p) expect(Number.isInteger(x.reward)).toBe(true);
      expect(p.reduce((s, x) => s + x.reward, 0)).toBeLessThanOrEqual(INCIDENT_POOL);
    }
    expect(incidentPayouts(new Map([['solo', 5]]))[0]).toMatchObject({ share: 1, reward: INCIDENT_POOL });
  });

  it('is deterministic and ignores non-positive damage', () => {
    const m = new Map([['a', 10], ['b', 10], ['z', 0], ['y', -5]]);
    expect(incidentPayouts(m)).toEqual(incidentPayouts(new Map([...m].reverse())).sort((a, b) => a.operatorId.localeCompare(b.operatorId)));
    expect(incidentPayouts(m).map((x) => x.operatorId)).toEqual(['a', 'b']);
  });
});

describe('kernelspace', () => {
  it('is hosted but not an open subnet: no spawns, reachable only through the Incident gateway from backbone', () => {
    expect(OPEN_SUBNET_IDS).not.toContain('kernelspace');
    expect(HOSTED_SUBNET_IDS).toEqual([...OPEN_SUBNET_IDS, 'kernelspace']);
    const ks = getSubnet('kernelspace');
    expect(ks.regions).toEqual([]);
    expect(ks.arena).toBeDefined();
    expect(getGateway('backbone', 'backbone-kernelspace')).toMatchObject({ to: 'kernelspace', incidentOnly: true, requires: { level: 32 } });
    expect(getGateway('kernelspace', 'kernelspace-backbone')).toMatchObject({ to: 'backbone' });
  });

  it('ticket boards never deliver to kernelspace', () => {
    for (const day of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06']) {
      for (const t of ticketBoard('backbone', day)) if (t.params.kind === 'deliver') expect(t.params.to).not.toBe('kernelspace');
    }
  });

  it('kernelspace host posts no tickets (and does not throw)', () => {
    expect(ticketBoard('kernelspace', '2026-10-01')).toEqual([]);
  });

  it('backbone boards are unchanged by the new gateway (pinned)', () => {
    const delivers = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'].flatMap((d) => ticketBoard('backbone', d).filter((t) => t.params.kind === 'deliver').map((t) => (t.params as { to: string }).to));
    for (const to of delivers) expect(['dmz', 'darknet', 'cloudnet']).toContain(to);
  });
});
