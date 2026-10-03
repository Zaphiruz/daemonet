import { TYPES, type TypeId } from '@daemonet/rules';

export const SPRITE_SIZE = 16;

export interface Sprite {
  width: number;
  height: number;
  /** RGBA, row-major, SPRITE_SIZE * SPRITE_SIZE * 4 bytes. */
  data: Uint8ClampedArray;
}

export interface SpriteOptions {
  types: readonly TypeId[];
  clean?: boolean;
  signature?: number;
}

type Rgb = readonly [number, number, number];
/** [dark, mid, light] per type. */
export const PALETTES: Record<TypeId, readonly [Rgb, Rgb, Rgb]> = {
  kernel: [[40, 44, 52], [110, 118, 129], [200, 205, 212]],
  packet: [[26, 84, 122], [54, 160, 220], [170, 220, 250]],
  crypto: [[92, 40, 120], [156, 92, 200], [220, 190, 245]],
  cache: [[128, 84, 20], [232, 164, 48], [250, 220, 150]],
  thread: [[20, 100, 90], [48, 190, 170], [170, 240, 225]],
  signal: [[150, 40, 40], [230, 80, 80], [250, 180, 180]],
  socket: [[30, 70, 130], [70, 130, 220], [180, 200, 245]],
  buffer: [[100, 90, 30], [200, 180, 60], [240, 230, 160]],
  shell: [[30, 90, 40], [70, 180, 90], [180, 235, 190]],
  root: [[110, 30, 30], [200, 50, 60], [245, 160, 170]],
  null: [[24, 24, 30], [70, 70, 90], [150, 150, 175]],
  glitch: [[120, 20, 110], [230, 60, 200], [250, 170, 240]],
  proxy: [[60, 60, 100], [130, 130, 190], [210, 210, 240]],
  cloud: [[70, 100, 130], [150, 190, 220], [230, 240, 250]],
  stack: [[110, 70, 20], [200, 130, 50], [245, 205, 150]],
  heap: [[40, 90, 60], [90, 170, 110], [190, 235, 200]],
};

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Hue for signature tier k (1-15): 16 evenly spaced hues, converted to RGB at full saturation. */
export function signatureColor(tier: number): Rgb {
  const h = ((tier * 22.5) % 360) / 60;
  const x = Math.round(255 * (1 - Math.abs((h % 2) - 1)));
  const i = Math.floor(h) % 6;
  const table: Rgb[] = [[255, x, 0], [x, 255, 0], [0, 255, x], [0, x, 255], [x, 0, 255], [255, 0, x]];
  return table[i]!;
}

/**
 * Deterministic 16x16 pixel-art body for a species: a random 6-wide half (columns 2-7) over rows
 * 2-13, smoothed once (a cell survives with >= 2 live neighbours, is born with 3), mirrored across
 * the centre. Fill = the primary type's mid colour (rows 8+ use the secondary type when present),
 * body edges = dark, a few highlights = light. `clean` draws a 1-px white rim around the body;
 * `signature` >= 1 draws a glow ring one pixel further out in the tier's hue.
 *
 * Every call allocates and recomputes the whole sprite: callers memoise the result (e.g. per
 * `speciesId|types|clean|signature`, or the canvas/ImageBitmap made from it) instead of calling
 * this per frame.
 */
export function spriteFor(speciesId: string, opts: SpriteOptions): Sprite {
  const size = SPRITE_SIZE;
  const rand = lcg(fnv1a(speciesId));
  const primary = opts.types[0] ?? 'null';
  const secondary = opts.types[1] ?? primary;

  // half grid: rows 2..13, cols 2..7 (mirrored to 8..13)
  let half: boolean[][] = Array.from({ length: size }, () => Array<boolean>(8).fill(false));
  for (let y = 2; y <= 13; y++) for (let x = 2; x <= 7; x++) half[y]![x] = rand() < 0.48;
  const alive = (g: boolean[][], y: number, x: number) => (g[y]?.[x] ?? false);
  const next: boolean[][] = half.map((row) => [...row]);
  for (let y = 2; y <= 13; y++) {
    for (let x = 2; x <= 7; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dy || dx) && alive(half, y + dy, x + dx)) n++;
      // the mirror column counts as a neighbour of column 7
      if (x === 7 && alive(half, y, 7)) n++;
      next[y]![x] = half[y]![x] ? n >= 2 : n === 3;
    }
  }
  half = next;
  // guarantee a body: the centre pixels are always on
  half[7]![7] = true;
  half[8]![7] = true;

  const body: boolean[][] = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  for (let y = 0; y < size; y++) for (let x = 0; x < 8; x++) body[y]![x] = body[y]![size - 1 - x] = half[y]![x]!;

  const data = new Uint8ClampedArray(size * size * 4);
  const put = (x: number, y: number, [r, g, b]: Rgb) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  };
  const isBody = (x: number, y: number) => (body[y]?.[x] ?? false);
  const near = (x: number, y: number, d: number) => {
    for (let dy = -d; dy <= d; dy++) for (let dx = -d; dx <= d; dx++) if (isBody(x + dx, y + dy)) return true;
    return false;
  };

  // outer glow (distance 2), then rim (distance 1), then body — later layers overwrite
  if ((opts.signature ?? 0) >= 1) {
    const glow = signatureColor(opts.signature!);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isBody(x, y) && !near(x, y, 1) && near(x, y, 2)) put(x, y, glow);
  }
  if (opts.clean) {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isBody(x, y) && near(x, y, 1)) put(x, y, [255, 255, 255]);
  }
  // highlights are keyed by the mirrored column so the sprite stays symmetric
  const highlight = (x: number, y: number) => fnv1a(`${speciesId}:${Math.min(x, size - 1 - x)}:${y}`) % 100 < 15;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!isBody(x, y)) continue;
      const pal = PALETTES[y >= 8 ? secondary : primary];
      const edge = !isBody(x - 1, y) || !isBody(x + 1, y) || !isBody(x, y - 1) || !isBody(x, y + 1);
      put(x, y, edge ? pal[0] : highlight(x, y) ? pal[2] : pal[1]);
    }
  }
  return { width: size, height: size, data };
}

/** All 16 type ids, for palette previews. */
export const SPRITE_TYPES = TYPES;
