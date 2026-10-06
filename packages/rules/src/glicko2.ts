import { deepFreeze } from './freeze.js';

/**
 * Glicko-2 (Glickman, "Example of the Glicko-2 system", 2012). Ratings are kept on the familiar scale
 * (1500 / RD 350); the maths runs on the internal scale (μ, φ). The Arena rates after every match, so a
 * rating period is usually a single game. Pure and deterministic: no clocks, no randomness.
 */
export interface Glicko {
  rating: number;
  rd: number;
  vol: number;
}

export const GLICKO_START: Readonly<Glicko> = deepFreeze<Glicko>({ rating: 1500, rd: 350, vol: 0.06 });
export const GLICKO_TAU = 0.5;
export const GLICKO_MAX_RD = 350;

const SCALE = 173.7178;
const EPSILON = 0.000001;
/** The Illinois iteration converges in well under 20 steps for any sane input; this only bounds degenerate ones. */
const MAX_ITERATIONS = 100;

const g = (phi: number): number => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const expected = (mu: number, muJ: number, phiJ: number): number => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

/** New volatility σ′ (step 5 of the paper; the Illinois variant of regula falsi). */
function volatility(phi: number, v: number, delta: number, vol: number, tau: number): number {
  const a = Math.log(vol * vol);
  const f = (x: number): number => {
    const ex = Math.exp(x);
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * (phi * phi + v + ex) ** 2) - (x - a) / (tau * tau);
  };
  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (k < MAX_ITERATIONS && f(a - k * tau) < 0) k++;
    B = a - k * tau;
  }
  let fA = f(A);
  let fB = f(B);
  for (let i = 0; i < MAX_ITERATIONS && Math.abs(B - A) > EPSILON && fB !== fA; i++) {
    const C = A + ((A - B) * fA) / (fB - fA);
    if (!Number.isFinite(C)) break;
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA /= 2;
    }
    B = C;
    fB = fC;
  }
  return Math.exp(A / 2);
}

/** One rating period: `player` after the given games (score 1 win, 0.5 draw, 0 loss). No games = RD decay only. */
export function rateGames(
  player: Readonly<Glicko>,
  games: ReadonlyArray<{ opponent: Pick<Glicko, 'rating' | 'rd'>; score: number }>,
  tau = GLICKO_TAU,
): Glicko {
  if (games.length === 0) return decayRd(player, 1);
  const mu = (player.rating - 1500) / SCALE;
  const phi = player.rd / SCALE;
  let vInv = 0;
  let sum = 0;
  for (const { opponent, score } of games) {
    const muJ = (opponent.rating - 1500) / SCALE;
    const phiJ = opponent.rd / SCALE;
    const e = expected(mu, muJ, phiJ);
    vInv += g(phiJ) ** 2 * e * (1 - e);
    sum += g(phiJ) * (score - e);
  }
  // a saturated expectation (E rounds to 0 or 1: a gap of thousands of points) carries no information: v would be ∞
  if (!(vInv > 0) || !Number.isFinite(1 / vInv)) return decayRd(player, 1);
  const v = 1 / vInv;
  const vol = volatility(phi, v, v * sum, player.vol, tau);
  const phiStar = Math.sqrt(phi * phi + vol * vol);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * sum;
  const out = { rating: muNew * SCALE + 1500, rd: Math.min(GLICKO_MAX_RD, phiNew * SCALE), vol };
  // never hand a NaN / ∞ to the ladder (Postgres stores and sorts it): fall back to the no-game update
  return Number.isFinite(out.rating) && Number.isFinite(out.rd) && Number.isFinite(out.vol) ? out : decayRd(player, 1);
}

/** A single game. */
export function rate(player: Readonly<Glicko>, opponent: Pick<Glicko, 'rating' | 'rd'>, score: number, tau = GLICKO_TAU): Glicko {
  return rateGames(player, [{ opponent, score }], tau);
}

/** `periods` rating periods without a game: the rating stays, the deviation grows with the volatility (capped at 350). */
export function decayRd(player: Readonly<Glicko>, periods: number): Glicko {
  let phi = player.rd / SCALE;
  for (let i = 0; i < periods; i++) phi = Math.sqrt(phi * phi + player.vol * player.vol);
  return { ...player, rd: Math.min(GLICKO_MAX_RD, phi * SCALE) };
}
