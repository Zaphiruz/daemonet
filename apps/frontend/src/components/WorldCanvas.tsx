import { getMove } from '@daemonet/rules';
import { useEffect, useRef } from 'react';
import { getControls, setControls, useControls } from '../game/controls.ts';
import { useGame } from '../game/connection.ts';
import { log } from '../game/log.ts';
import { screenToWorld, type Camera } from '../render/camera.ts';
import { drawWorld } from '../render/draw.ts';

/** Sends a manual command and logs any rejection. */
export function run(promise: Promise<unknown>, label: string): void {
  promise.catch((err: Error) => log.push('reject', `${label}: ${err.message}`));
}

export function WorldCanvas() {
  const client = useGame();
  const controls = useControls();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hover = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !client) return;
    const ctx = canvas.getContext('2d')!;
    let frame = 0;
    const loop = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.floor(rect.width * dpr) || canvas.height !== Math.floor(rect.height * dpr)) {
        canvas.width = Math.floor(rect.width * dpr);
        canvas.height = Math.floor(rect.height * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
      if (client.self && client.subnet) {
        const c = getControls();
        const cam: Camera = { cx: client.self.x, cy: client.self.y, zoom: c.zoom, width: rect.width, height: rect.height };
        drawWorld({ ctx, cam, client, controls: c, hover: hover.current });
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [client]);

  if (!client) return null;

  const camera = (): Camera | null => {
    const canvas = canvasRef.current;
    if (!canvas || !client.self) return null;
    const rect = canvas.getBoundingClientRect();
    return { cx: client.self.x, cy: client.self.y, zoom: controls.zoom, width: rect.width, height: rect.height };
  };

  const onClick = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    const cam = camera();
    if (!cam) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    const w = screenToWorld(cam, ev.clientX - rect.left, ev.clientY - rect.top);
    // click on a daemon selects it as the target; otherwise move the selected actor
    let hit: string | null = null;
    for (const e of client.entities.values()) if (e.kind === 'daemon' && Math.hypot(e.x - w.x, e.y - w.y) < 0.6) hit = e.id;
    if (hit) {
      const e = client.entities.get(hit)!;
      if (e.kind === 'daemon' && e.owner === client.operatorId) setControls({ actor: hit });
      else setControls({ targetId: hit });
      return;
    }
    if (client.role !== 'controller') return;
    const actor = controls.actor;
    const dest = { x: Math.floor(w.x) + 0.5, y: Math.floor(w.y) + 0.5 };
    if (actor === 'self') run(client.operator.moveTo(dest.x, dest.y), 'moveTo');
    else run(client.daemons.get(actor).moveTo(dest.x, dest.y), 'moveTo');
  };

  const onKey = (ev: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (client.role !== 'controller') return;
    const c = getControls();
    const running = client.self.running;
    if (ev.key === 'Tab') {
      ev.preventDefault();
      const order = ['self', ...running];
      const i = order.indexOf(c.actor);
      setControls({ actor: order[(i + 1) % order.length] ?? 'self' });
      return;
    }
    if (ev.key === 'Escape') return setControls({ targetId: null, actor: 'self' });
    if (ev.key === 'c' && c.targetId) return run(client.operator.capture(c.targetId, c.tool), 'capture');
    if (ev.key === 'r') {
      const first = client.self.ram.find((d) => !d.crashed && !running.includes(d.id));
      if (c.actor !== 'self') return run(client.operator.recall(c.actor), 'recall');
      if (first) return run(client.operator.run(first.id), 'run');
      return;
    }
    if (/^[1-4]$/.test(ev.key) && c.actor !== 'self') {
      const d = client.daemons.get(c.actor);
      const move = d.ram?.moves[Number(ev.key) - 1];
      if (!move) return;
      const target = c.targetId ? client.entities.get(c.targetId) : undefined;
      const shape = getMove(move).shape.kind;
      if (shape === 'single') {
        if (target) run(d.use(move, { id: target.id, x: target.x, y: target.y }), move);
      } else if (target) run(d.use(move, { x: target.x, y: target.y }), move);
      else if (hover.current) run(d.use(move, { x: hover.current.x, y: hover.current.y }), move);
    }
  };

  return (
    <canvas
      ref={canvasRef}
      tabIndex={0}
      data-testid="world"
      className="h-full w-full bg-neutral-950 outline-none"
      onClick={onClick}
      onKeyDown={onKey}
      onMouseMove={(ev) => {
        const cam = camera();
        if (!cam) return;
        const rect = ev.currentTarget.getBoundingClientRect();
        hover.current = screenToWorld(cam, ev.clientX - rect.left, ev.clientY - rect.top);
      }}
      onMouseLeave={() => (hover.current = null)}
    />
  );
}
