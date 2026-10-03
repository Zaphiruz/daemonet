export const TILE = 16;

export interface Camera {
  /** World position at the centre of the screen. */
  cx: number;
  cy: number;
  zoom: number;
  width: number;
  height: number;
}

export const scale = (cam: Camera): number => TILE * cam.zoom;

export function worldToScreen(cam: Camera, x: number, y: number): { sx: number; sy: number } {
  const s = scale(cam);
  return { sx: (x - cam.cx) * s + cam.width / 2, sy: (y - cam.cy) * s + cam.height / 2 };
}

export function screenToWorld(cam: Camera, sx: number, sy: number): { x: number; y: number } {
  const s = scale(cam);
  return { x: (sx - cam.width / 2) / s + cam.cx, y: (sy - cam.height / 2) / s + cam.cy };
}

/** Inclusive tile range visible on screen, clamped to the map. */
export function visibleTiles(cam: Camera, mapW: number, mapH: number): { x0: number; y0: number; x1: number; y1: number } {
  const tl = screenToWorld(cam, 0, 0);
  const br = screenToWorld(cam, cam.width, cam.height);
  return {
    x0: Math.max(0, Math.floor(tl.x)),
    y0: Math.max(0, Math.floor(tl.y)),
    x1: Math.min(mapW - 1, Math.ceil(br.x)),
    y1: Math.min(mapH - 1, Math.ceil(br.y)),
  };
}
