import { ARENA_SUBNET, getSubnet, INCIDENT_SUBNET, TICK_HZ, type SubnetDef } from '@daemonet/rules';
import type { GameClient } from '@daemonet/sdk';
import { signatureColor, spriteFor, SPRITE_SIZE } from '@daemonet/sprites';
import type { Controls } from '../game/controls.ts';
import { incidentStore, isIncidentLive } from '../game/incident.ts';
import { taggedName } from '../game/names.ts';
import { scale, visibleTiles, worldToScreen, type Camera } from './camera.ts';

const spriteCache = new Map<string, HTMLCanvasElement>();

/** A cached canvas per (species, types, clean, signature); `spriteFor` is pure, so it runs once per key. */
export function spriteCanvas(species: string, types: readonly string[], clean: boolean, signature: number): HTMLCanvasElement {
  const key = `${species}|${types.join('/')}|${clean ? 1 : 0}|${signature}`;
  let c = spriteCache.get(key);
  if (!c) {
    const s = spriteFor(species, { types: types as never, clean, signature });
    c = document.createElement('canvas');
    c.width = c.height = SPRITE_SIZE;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(s.data), SPRITE_SIZE, SPRITE_SIZE), 0, 0);
    spriteCache.set(key, c);
  }
  return c;
}

const subnetCache = new Map<string, { def: SubnetDef; blocked: Uint8Array }>();
export function subnetGeometry(id: string): { def: SubnetDef; blocked: Uint8Array } {
  let g = subnetCache.get(id);
  if (!g) {
    const def = getSubnet(id);
    const blocked = new Uint8Array(def.width * def.height);
    const block = (x: number, y: number) => (blocked[y * def.width + x] = 1);
    for (let x = 0; x < def.width; x++) {
      block(x, 0);
      block(x, def.height - 1);
    }
    for (let y = 0; y < def.height; y++) {
      block(0, y);
      block(def.width - 1, y);
    }
    for (const r of def.walls) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) block(x, y);
    g = { def, blocked };
    subnetCache.set(id, g);
  }
  return g;
}

export interface DrawInput {
  ctx: CanvasRenderingContext2D;
  cam: Camera;
  client: GameClient;
  controls: Controls;
  hover: { x: number; y: number } | null;
}

const COLORS = {
  floor: '#0f1620',
  wall: '#2a3442',
  region: 'rgba(80, 140, 255, 0.05)',
  host: '#ffd166',
  self: '#7dd3fc',
  other: '#a3a3a3',
  hp: '#22c55e',
  hpBack: '#3f1d1d',
  tagMine: '#f59e0b',
  tagOther: '#ef4444',
  hardened: '#f97316',
  select: '#ffffff',
  target: '#f472b6',
  path: 'rgba(125, 211, 252, 0.6)',
  link: '#a78bfa',
  gateway: '#38bdf8',
  gatewayClosed: '#525252',
  boss: '#f43f5e',
  shield: '#93c5fd',
  telegraph: 'rgba(244, 63, 94, 0.35)',
};

export function drawWorld({ ctx, cam, client, controls, hover }: DrawInput): void {
  const s = scale(cam);
  const { def, blocked } = subnetGeometry(client.subnet);
  ctx.fillStyle = COLORS.floor;
  ctx.fillRect(0, 0, cam.width, cam.height);

  const v = visibleTiles(cam, def.width, def.height);
  ctx.fillStyle = COLORS.region;
  for (const r of def.regions) {
    const p = worldToScreen(cam, r.rect.x, r.rect.y);
    ctx.fillRect(p.sx, p.sy, r.rect.w * s, r.rect.h * s);
  }
  ctx.fillStyle = COLORS.wall;
  for (let y = v.y0; y <= v.y1; y++) {
    for (let x = v.x0; x <= v.x1; x++) {
      if (blocked[y * def.width + x]) {
        const p = worldToScreen(cam, x, y);
        ctx.fillRect(p.sx, p.sy, s, s);
      }
    }
  }
  // the sandbox has no host services: nothing to mark
  if (def.id !== ARENA_SUBNET) {
    const host = worldToScreen(cam, def.host.x, def.host.y);
    ctx.strokeStyle = COLORS.host;
    ctx.lineWidth = 2;
    ctx.strokeRect(host.sx - s, host.sy - s, 2 * s, 2 * s);
    ctx.fillStyle = COLORS.host;
    ctx.font = `${Math.max(10, s * 0.6)}px ui-monospace`;
    ctx.fillText('host', host.sx - s, host.sy - s - 4);
  }
  // the Incident-only gateway is closed unless an Incident is live (the same rule as the banner and the gateway card)
  const incidentLive = isIncidentLive(incidentStore.get().current, Date.now());
  for (const g of def.gateways) {
    const p = worldToScreen(cam, g.at.x, g.at.y);
    const closed = g.incidentOnly === true && !incidentLive;
    ctx.strokeStyle = closed ? COLORS.gatewayClosed : COLORS.gateway;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.sx, p.sy, s, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = closed ? COLORS.gatewayClosed : COLORS.gateway;
    ctx.fillText(`→ ${g.to}${g.requires.level ? ` L${g.requires.level}` : ''}${closed ? ' · closed' : ''}`, p.sx + s + 2, p.sy + 4);
  }

  // blasts that land in two seconds (kernelspace only; the store drops them once they have landed)
  if (client.subnet === INCIDENT_SUBNET) {
    ctx.fillStyle = COLORS.telegraph;
    for (const t of incidentStore.get().telegraphs) {
      const c = worldToScreen(cam, t.x, t.y);
      ctx.beginPath();
      ctx.arc(c.sx, c.sy, t.radius * s, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const me = client.self;
  const capture = me.capture;
  for (const e of client.entities.values()) {
    const p = worldToScreen(cam, e.x, e.y);
    if (e.kind === 'operator') {
      ctx.fillStyle = e.id === client.operatorId ? COLORS.self : COLORS.other;
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, s * 0.35, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#e5e7eb';
      ctx.fillText(taggedName(e.tag, e.name), p.sx + s * 0.4, p.sy - s * 0.4);
      continue;
    }
    const sprite = spriteCanvas(e.species, e.types, e.clean, e.signature);
    const size = s;
    if (e.signature > 0) {
      const [r, g, b] = signatureColor(e.signature);
      ctx.strokeStyle = `rgba(${r},${g},${b},0.9)`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, size * 0.8, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.drawImage(sprite, p.sx - size / 2, p.sy - size / 2, size, size);
    if (e.boss) {
      // the kernel daemon: a ring of 1.4 tiles whose bright arc is its remaining HP (blue while its shield holds)
      ctx.strokeStyle = e.shielded ? COLORS.shield : COLORS.boss;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, s * 1.4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, s * 1.4, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * Math.max(0, e.hp)) / Math.max(1, e.maxHp));
      ctx.stroke();
      ctx.fillStyle = e.shielded ? COLORS.shield : COLORS.boss;
      ctx.fillText(e.shielded ? 'KERNEL DAEMON · shielded' : 'KERNEL DAEMON', p.sx - s * 1.4, p.sy - s * 1.4 - 4);
    }
    if (e.hardened) {
      ctx.strokeStyle = COLORS.hardened;
      ctx.lineWidth = 1;
      ctx.strokeRect(p.sx - size / 2, p.sy - size / 2, size, size);
    }
    // HP bar
    const w = size;
    ctx.fillStyle = COLORS.hpBack;
    ctx.fillRect(p.sx - w / 2, p.sy + size / 2 + 1, w, 3);
    ctx.fillStyle = COLORS.hp;
    ctx.fillRect(p.sx - w / 2, p.sy + size / 2 + 1, (w * e.hp) / Math.max(1, e.maxHp), 3);
    if (e.taggedBy) {
      ctx.fillStyle = e.taggedBy === client.operatorId ? COLORS.tagMine : COLORS.tagOther;
      ctx.fillText('⚑', p.sx + size / 2, p.sy - size / 2);
    }
    if (e.statuses.length) {
      ctx.fillStyle = '#c4b5fd';
      ctx.fillText(e.statuses.map((st) => st[0]!.toUpperCase()).join(''), p.sx - size / 2, p.sy - size / 2 - 2);
    }
    if (e.id === controls.targetId) {
      ctx.strokeStyle = COLORS.target;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, size * 0.65, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (e.id === controls.actor) {
      ctx.strokeStyle = COLORS.select;
      ctx.lineWidth = 1;
      ctx.strokeRect(p.sx - size / 2 - 2, p.sy - size / 2 - 2, size + 4, size + 4);
    }
    if (capture && capture.targetId === e.id) {
      const mine = worldToScreen(cam, me.x, me.y);
      ctx.strokeStyle = COLORS.link;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(mine.sx, mine.sy);
      ctx.lineTo(p.sx, p.sy);
      ctx.stroke();
      ctx.setLineDash([]);
      const left = Math.max(0, capture.deadlineTick - client.tick);
      ctx.fillStyle = COLORS.link;
      ctx.fillText(`${(left / TICK_HZ).toFixed(1)}s`, p.sx + size / 2, p.sy + size / 2 + 12);
    }
  }
  if (hover) {
    const p = worldToScreen(cam, Math.floor(hover.x), Math.floor(hover.y));
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(p.sx, p.sy, s, s);
  }
}
