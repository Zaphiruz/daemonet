import { SPECIES } from '@daemonet/rules';
import { describe, expect, it } from 'vitest';
import { PALETTES, SPRITE_SIZE, signatureColor, spriteFor, type Sprite } from '../src/index.js';

const px = (s: Sprite, x: number, y: number) => Array.from(s.data.slice((y * SPRITE_SIZE + x) * 4, (y * SPRITE_SIZE + x) * 4 + 4));
const opaque = (s: Sprite) => {
  let n = 0;
  for (let i = 3; i < s.data.length; i += 4) if (s.data[i] === 255) n++;
  return n;
};

describe('spriteFor', () => {
  it('is deterministic and 16x16 RGBA', () => {
    const a = spriteFor('pingling', { types: ['packet'] });
    const b = spriteFor('pingling', { types: ['packet'] });
    expect(a.data).toEqual(b.data);
    expect(a.data.length).toBe(16 * 16 * 4);
    expect(spriteFor('hashling', { types: ['crypto'] }).data).not.toEqual(a.data);
  });

  it('is left-right symmetric with a non-trivial body', () => {
    for (const sp of SPECIES) {
      const s = spriteFor(sp.id, { types: sp.types });
      for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) expect(px(s, x, y)).toEqual(px(s, 15 - x, y));
      expect(opaque(s)).toBeGreaterThan(20);
      expect(opaque(s)).toBeLessThan(200);
    }
  });

  it('uses only the primary palette (and the secondary on the lower half) for body pixels', () => {
    const s = spriteFor('pingling', { types: ['packet', 'glitch'] });
    const allowed = new Set([...PALETTES.packet, ...PALETTES.glitch].map((c) => c.join(',')));
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const [r, g, b, a] = px(s, x, y);
      if (a === 255) expect(allowed.has(`${r},${g},${b}`)).toBe(true);
    }
  });

  it('adds a white rim for clean images and a coloured glow for signatures', () => {
    const plain = spriteFor('nullpup', { types: ['null'] });
    const clean = spriteFor('nullpup', { types: ['null'], clean: true });
    const shiny = spriteFor('nullpup', { types: ['null'], clean: true, signature: 3 });
    expect(opaque(clean)).toBeGreaterThan(opaque(plain));
    expect(opaque(shiny)).toBeGreaterThan(opaque(clean));
    const white = (s: Sprite) => Array.from({ length: 256 }, (_, i) => px(s, i % 16, Math.floor(i / 16))).filter((p) => p.join(',') === '255,255,255,255').length;
    expect(white(clean)).toBeGreaterThan(0);
    expect(white(plain)).toBe(0);
    const glow = signatureColor(3).join(',');
    const glowPixels = Array.from({ length: 256 }, (_, i) => px(shiny, i % 16, Math.floor(i / 16))).filter((p) => p.slice(0, 3).join(',') === glow).length;
    expect(glowPixels).toBeGreaterThan(0);
  });

  it('spaces signature hues around the wheel', () => {
    const hues = new Set(Array.from({ length: 15 }, (_, i) => signatureColor(i + 1).join(',')));
    expect(hues.size).toBe(15);
  });
});
