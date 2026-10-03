import { TICK_MS } from '@daemonet/rules';

const MAX_CATCH_UP = 4;

/**
 * Fixed-timestep loop, drift-corrected against performance.now().
 * If the process falls more than MAX_CATCH_UP ticks behind it skips ahead instead of spiralling.
 * Returns a stop function.
 */
export function startLoop(tick: () => void, intervalMs: number = TICK_MS): () => void {
  let next = performance.now() + intervalMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const run = () => {
    if (stopped) return;
    let ran = 0;
    while (performance.now() >= next && ran < MAX_CATCH_UP) {
      tick();
      next += intervalMs;
      ran++;
    }
    if (performance.now() >= next) next = performance.now() + intervalMs;
    timer = setTimeout(run, Math.max(0, next - performance.now()));
  };
  timer = setTimeout(run, intervalMs);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
