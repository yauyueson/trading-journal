/**
 * Phase 0.c.10 — seeded GBM path generator.
 *
 * Zero-drift geometric Brownian motion. Used by tests/bsm-zero-ev.test.ts
 * to stress the BSM payoff path: the process has no true drift, so any
 * systematic profit/loss in aggregated trades implies a math bug.
 *
 * The RNG is a Mulberry32 (32-bit state, good enough for stress testing;
 * not for cryptography). Same seed → same path, always.
 */

/** Mulberry32 — small, fast, deterministic PRNG. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller: two uniforms → one standard normal sample. */
function sampleNormal(rng: () => number): number {
  // Guard against u1=0 (log(0) = -Inf).
  let u1 = rng();
  while (u1 === 0) u1 = rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export interface GBMPath {
  dates: string[];     // trading-day calendar (skips weekends)
  prices: number[];    // S_t for each date
}

/**
 * Generate a zero-drift GBM path.
 *
 * S_{t+1} = S_t · exp((-0.5·σ²)·Δt + σ·√Δt·Z)
 *
 * Note the -0.5·σ² Itô correction: without it, E[S_t] would drift upward
 * at rate 0.5·σ², biasing every test. With it, E[S_t] = S_0 for all t.
 *
 * @param opts.startPrice  initial price (default 100)
 * @param opts.days        number of daily steps (trading days)
 * @param opts.sigma       annualized volatility (0.20 = 20%)
 * @param opts.seed        RNG seed
 * @param opts.startDate   first date (YYYY-MM-DD, default "2020-01-02")
 */
export function generateGBMPath(opts: {
  startPrice?: number;
  days: number;
  sigma: number;
  seed: number;
  startDate?: string;
}): GBMPath {
  const S0 = opts.startPrice ?? 100;
  const σ = opts.sigma;
  const rng = makeRng(opts.seed);
  const dt = 1 / 252;            // Actual/252 trading-day convention
  const drift = -0.5 * σ * σ * dt;
  const diffusion = σ * Math.sqrt(dt);

  const prices: number[] = [S0];
  for (let i = 1; i < opts.days; i++) {
    const z = sampleNormal(rng);
    const logStep = drift + diffusion * z;
    prices.push(prices[i - 1] * Math.exp(logStep));
  }

  const dates = buildTradingDates(opts.startDate ?? '2020-01-02', opts.days);
  return { dates, prices };
}

/**
 * Build a sequence of trading-day date strings, skipping weekends.
 * No holiday calendar — this is synthetic data, a 252-day year is the
 * convention.
 */
function buildTradingDates(startStr: string, count: number): string[] {
  const out: string[] = [];
  const d = new Date(`${startStr}T00:00:00Z`);
  while (out.length < count) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) {
      out.push(d.toISOString().slice(0, 10));
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
