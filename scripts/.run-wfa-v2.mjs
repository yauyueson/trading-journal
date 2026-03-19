#!/usr/bin/env node
/**
 * WFA v2 Runner — CACHE-ONLY, MULTI-THREADED
 *
 * NO ORATS API calls. All data from:
 *   - SQLite option chain cache (46M rows, local) — each worker gets its own connection
 *   - Supabase stock_candles + orats_iv_cache (our own DB, read-only)
 *
 * Parallelism: N workers (cpu_count - 2), each with own SQLite read-only connection.
 * Main thread: TPE optimization + stats. Workers: trade evaluation.
 *
 * Usage:
 *   node scripts/.run-wfa-v2.mjs --profile swing --mode ga --trials 200
 *   node scripts/.run-wfa-v2.mjs --profile short --mode ga --trials 200
 *   node scripts/.run-wfa-v2.mjs --profile swing --mode tpe --trials 200
 *   node scripts/.run-wfa-v2.mjs --profile swing --mode grid
 */

import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load .env.local ─────────────────────────────────────
const envPath = path.resolve(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const parts = line.split('=');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const value = parts.slice(1).join('=').trim().replace(/^["']|["']$/g, '');
      if (key && !key.startsWith('#')) process.env[key] = value;
    }
  });
}

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || '';

// ── CLI args ────────────────────────────────────────────
const { values: cliArgs } = parseArgs({
  options: {
    profile: { type: 'string', default: 'swing' },
    mode: { type: 'string', default: 'tpe' },
    trials: { type: 'string', default: '200' },
    seed: { type: 'string', default: '42' },
    bootstrap: { type: 'string', default: '5000' },
    refresh: { type: 'boolean', default: false },
    'no-adx': { type: 'boolean', default: false },
  },
});

let PROFILE = cliArgs.profile;
let ROBUSTNESS_TAG = '';
const MODE = cliArgs.mode;
const N_TRIALS = parseInt(cliArgs.trials, 10);
let SEED = parseInt(cliArgs.seed, 10);
const N_BOOTSTRAP = parseInt(cliArgs.bootstrap, 10);
const REFRESH_CACHE = cliArgs.refresh;
const NO_ADX_FILTER = cliArgs['no-adx'];
const NUM_WORKERS = Math.min(os.cpus().length - 2, 8); // Cap at 8 for 24GB RAM
const CACHE_DIR = path.resolve(__dirname, '..', 'data', 'cache');

const DATA_START = '2017-01-01';
const DATA_END = '2026-03-06';
const WFA_START = '2018-01-01';
const WFA_END = '2026-02-28';
const STARTING_CAPITAL = 100000;

const ALL_TICKERS = [
  'SPY','QQQ','AMD','IWM','TSLA','AAPL','JPM','NVDA',
  'AMZN','MSFT','META','NFLX','GOOG','GS','COST',
];

// Banner printed inside main() to reflect current PROFILE

// ── Supabase REST (our own DB) ──────────────────────────
async function supabaseGet(table, query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`${table} fetch failed: ${res.status}`);
  return res.json();
}

// ── Real signal generation via engine.ts ────────────────
// Import the real precomputeSignalsDaily + SIGNAL_PRESETS for proper
// 7-component calculateTechScore direction detection & setup matching
const { precomputeSignalsDaily } = await import('../src/lib/backtest/engine.ts');
const { SIGNAL_PRESETS } = await import('../src/lib/backtest/types.ts');

const ALL_PRESET_KEYS = Object.keys(SIGNAL_PRESETS);

/**
 * Compute IV Rank from a time series of IV values (252-day lookback window).
 */
function computeIVRank(ivSeries) {
  return ivSeries.map((v, i) => {
    if (i < 252 || v == null) return null;
    const w = ivSeries.slice(i - 252, i + 1).filter(x => x != null);
    if (w.length < 100) return null;
    const mn = Math.min(...w), mx = Math.max(...w), r = mx - mn;
    return r > 0 ? (v - mn) / r * 100 : 50;
  });
}

// Default weights from tech-analysis.ts (Pine Scanner v3.2 defaults)
const DEFAULT_WEIGHTS = { w_mb: 25, w_bxs: 20, w_bxl: 15, w_ema: 12, w_mom: 8, w_adx: 12, w_vol: 8 };

/**
 * Generate signals for all presets using real calculateTechScore engine.
 *
 * Optimization: runs precomputeSignalsDaily ONCE with full weights (all 7 components),
 * then derives each preset's direction & score by re-weighting the sub-scores.
 * This is 8× faster than running the engine separately for each preset.
 *
 * The sub-scores (sc_mb, sc_bxs, sc_bxl, sc_ema, sc_mom) are direction-aware
 * components from calculateTechScore. For each preset, we zero out the weights
 * of disabled components and recompute the weighted sum to get direction.
 */
function generateSignals(candles, ivData, ticker) {
  const ivLookup = new Map();
  if (ivData) for (const row of ivData) ivLookup.set(row.date, row.iv30d);
  const ivRankSeries = computeIVRank(candles.map(c => ivLookup.get(c.date) ?? null));
  const dateToIdx = new Map(candles.map((c, i) => [c.date, i]));

  // Run engine once with full weights (all 7 components active)
  const fullSignals = precomputeSignalsDaily(candles, {}, ivData);

  const presets = {};
  for (const key of ALL_PRESET_KEYS) presets[key] = [];

  for (const sig of fullSignals) {
    // Quality gates: match v1 behavior (ADX gate can be disabled via --no-adx)
    if (!NO_ADX_FILTER && (!isFinite(sig.adx) || sig.adx < 15)) continue;
    if (!isFinite(sig.rvol) || sig.rvol < 0.5) continue;

    const candleIdx = dateToIdx.get(sig.date);
    const ivRank = candleIdx != null ? ivRankSeries[candleIdx] : null;

    // For the 'full' preset, use the original signal directly
    if (sig.type !== 'NEUTRAL') {
      presets.full.push({
        ticker, date: sig.date, direction: sig.type,
        score: sig.score, ivRank: ivRank != null ? Math.round(ivRank) : undefined,
        dirConfidence: sig.dirConfidence,
      });
    }

    // For other presets, re-derive direction from sub-scores with preset weights
    if (!sig.subScores) continue;
    const { sc_mb, sc_bxs, sc_bxl, sc_ema, sc_mom } = sig.subScores;

    for (const presetKey of ALL_PRESET_KEYS) {
      if (presetKey === 'full') continue;
      const presetWeights = SIGNAL_PRESETS[presetKey];

      // Compute weighted sum using preset's active components
      // A zeroed weight in SIGNAL_PRESETS means that component is disabled
      const w_mb  = presetWeights.w_mb  ?? DEFAULT_WEIGHTS.w_mb;
      const w_bxs = presetWeights.w_bxs ?? DEFAULT_WEIGHTS.w_bxs;
      const w_bxl = presetWeights.w_bxl ?? DEFAULT_WEIGHTS.w_bxl;
      const w_ema = presetWeights.w_ema ?? DEFAULT_WEIGHTS.w_ema;
      const w_mom = presetWeights.w_mom ?? DEFAULT_WEIGHTS.w_mom;
      // ADX and RVOL sub-scores aren't in subScores — they boost existing direction
      // For adx/vol presets, use ADX/RVOL as directional signals via the regime
      const w_adx = presetWeights.w_adx ?? DEFAULT_WEIGHTS.w_adx;
      const w_vol = presetWeights.w_vol ?? DEFAULT_WEIGHTS.w_vol;

      const weightedSum = sc_mb * w_mb + sc_bxs * w_bxs + sc_bxl * w_bxl
                        + sc_ema * w_ema + sc_mom * w_mom;
      const totalWeight = w_mb + w_bxs + w_bxl + w_ema + w_mom + w_adx + w_vol;

      if (totalWeight === 0) continue;

      // Direction: positive weighted sum = CALL, negative = PUT
      // ADX/RVOL don't have directional sub-scores, so for adx/vol presets
      // we fall back to the full signal's direction if directional components are zero
      let direction;
      const directionalWeight = w_mb + w_bxs + w_bxl + w_ema + w_mom;
      if (directionalWeight > 0) {
        if (weightedSum > 0) direction = 'CALL';
        else if (weightedSum < 0) direction = 'PUT';
        else continue; // NEUTRAL
      } else {
        // Pure ADX/RVOL preset — use full signal direction
        if (sig.type === 'NEUTRAL') continue;
        direction = sig.type;
      }

      // Score: normalize to 0-100 scale based on active weight proportion
      const rawScore = Math.abs(weightedSum) / directionalWeight * 100;
      const score = Math.min(100, Math.max(0, Math.round(50 + rawScore / 2)));

      presets[presetKey].push({
        ticker, date: sig.date, direction,
        score, ivRank: ivRank != null ? Math.round(ivRank) : undefined,
        dirConfidence: sig.dirConfidence,
      });
    }
  }
  return presets;
}

// ── Worker Pool ─────────────────────────────────────────
class WorkerPool {
  constructor(workerPath, numWorkers, workerData) {
    this.workers = [];
    this.idle = [];
    this.pending = [];
    this.readyCount = 0;
    this.readyResolve = null;

    for (let i = 0; i < numWorkers; i++) {
      const w = new Worker(workerPath, { workerData });
      w.on('message', (msg) => this._onMessage(i, msg));
      w.on('error', (err) => console.error(`Worker ${i} error:`, err));
      this.workers.push(w);
    }
  }

  waitReady() {
    return new Promise(resolve => {
      this.readyResolve = resolve;
    });
  }

  _onMessage(workerIdx, msg) {
    if (msg.type === 'ready') {
      this.readyCount++;
      if (this.readyCount === this.workers.length && this.readyResolve) {
        this.readyResolve();
      }
      this.idle.push(workerIdx);
      this._dispatch();
      return;
    }

    if (msg.type === 'result') {
      const { taskId, trades } = msg;
      if (this.callbacks && this.callbacks[taskId]) {
        this.callbacks[taskId](trades);
        delete this.callbacks[taskId];
      }
      this.idle.push(workerIdx);
      this._dispatch();
    }
  }

  /** Submit evaluation: just send config + date range (signals already in worker via workerData) */
  submit(taskId, presetKey, dateStart, dateEnd, config, maxDate) {
    return new Promise(resolve => {
      if (!this.callbacks) this.callbacks = {};
      this.callbacks[taskId] = resolve;
      this.pending.push({ taskId, presetKey, dateStart, dateEnd, config, maxDate });
      this._dispatch();
    });
  }

  _dispatch() {
    while (this.idle.length > 0 && this.pending.length > 0) {
      const workerIdx = this.idle.shift();
      const task = this.pending.shift();
      this.workers[workerIdx].postMessage({
        type: 'eval',
        taskId: task.taskId,
        presetKey: task.presetKey,
        dateStart: task.dateStart,
        dateEnd: task.dateEnd,
        config: task.config,
        maxDate: task.maxDate,
      });
    }
  }

  shutdown() {
    for (const w of this.workers) w.postMessage({ type: 'exit' });
  }
}

// ── Main ────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();

  console.log(`\n╔═══════════════════════════════════════════════════════╗`);
  console.log(`║  WFA v2 — Walk-Forward Analysis (CACHE-ONLY, ${NUM_WORKERS} workers) ║`);
  console.log(`╚═══════════════════════════════════════════════════════╝\n`);
  console.log(`Profile:    ${PROFILE}`);
  console.log(`Mode:       ${MODE}`);
  console.log(`Trials:     ${N_TRIALS}`);
  console.log(`Workers:    ${NUM_WORKERS}`);
  console.log(`Tickers:    ${ALL_TICKERS.length}`);
  console.log(`ADX filter: ${NO_ADX_FILTER ? 'DISABLED' : 'enabled (ADX ≥ 15)'}`);
  console.log(`Date range: ${WFA_START} → ${WFA_END}`);
  console.log();

  // 1. Load candle + IV data (local cache → Supabase fallback)
  const candleCachePath = path.join(CACHE_DIR, 'stock-candles.json');
  const ivCachePath = path.join(CACHE_DIR, 'orats-iv.json');
  const candleData = new Map();

  const hasCachedCandles = !REFRESH_CACHE && fs.existsSync(candleCachePath);
  const hasCachedIV = !REFRESH_CACHE && fs.existsSync(ivCachePath);

  if (hasCachedCandles && hasCachedIV) {
    console.log('Loading from local cache...');
    const cachedCandles = JSON.parse(fs.readFileSync(candleCachePath, 'utf8'));
    const cachedIV = JSON.parse(fs.readFileSync(ivCachePath, 'utf8'));
    for (const ticker of ALL_TICKERS) {
      const candles = (cachedCandles[ticker] || []).map(r => ({
        ...r, timestamp: new Date(r.date + 'T00:00:00Z').getTime(),
      }));
      candleData.set(ticker, { candles, ivData: cachedIV[ticker] || [] });
      process.stdout.write(`  ${ticker}: ${candles.length} candles, ${(cachedIV[ticker]||[]).length} IV rows (cached)\n`);
    }
  } else {
    console.log(`${REFRESH_CACHE ? 'Refreshing' : 'Downloading'} from Supabase (will cache locally)...`);
    const candleCache = {};
    const ivCache = {};
    await Promise.all(ALL_TICKERS.map(async (ticker) => {
      const [candles, ivData] = await Promise.all([
        supabaseGet('stock_candles',
          `select=date,open,high,low,close,volume&ticker=eq.${ticker}&timeframe=eq.1D&date=gte.${DATA_START}&date=lte.${DATA_END}&order=date.asc&limit=5000`,
        ).then(rows => rows.map(r => ({ date: r.date, open:+r.open, high:+r.high, low:+r.low, close:+r.close, volume:+r.volume }))),
        supabaseGet('orats_iv_cache',
          `select=date,iv30d,iv60d,hv20d,hv30d,hv60d&ticker=eq.${ticker}&date=gte.${DATA_START}&date=lte.${DATA_END}&order=date.asc&limit=5000`,
        ),
      ]);
      candleCache[ticker] = candles;
      ivCache[ticker] = ivData;
      const withTs = candles.map(r => ({ ...r, timestamp: new Date(r.date + 'T00:00:00Z').getTime() }));
      candleData.set(ticker, { candles: withTs, ivData });
      process.stdout.write(`  ${ticker}: ${candles.length} candles, ${ivData.length} IV rows\n`);
    }));
    // Save cache
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(candleCachePath, JSON.stringify(candleCache));
    fs.writeFileSync(ivCachePath, JSON.stringify(ivCache));
    console.log(`  Cached to ${CACHE_DIR}/`);
  }

  // 2. Build trading dates
  const allDatesSet = new Set();
  for (const [, data] of candleData) for (const c of data.candles) allDatesSet.add(c.date);
  const allTradingDates = [...allDatesSet].sort();
  console.log(`Trading dates: ${allTradingDates.length}`);

  // 3. Generate signals using real calculateTechScore engine
  console.log('Precomputing signals (real engine)...');
  const signalsByPreset = {};
  for (const key of ALL_PRESET_KEYS) signalsByPreset[key] = [];
  for (const ticker of ALL_TICKERS) {
    const { candles, ivData } = candleData.get(ticker);
    const t1 = Date.now();
    const presets = generateSignals(candles, ivData, ticker);
    for (const key of ALL_PRESET_KEYS) if (presets[key]) signalsByPreset[key].push(...presets[key]);
    process.stdout.write(`  ${ticker}: signals in ${((Date.now()-t1)/1000).toFixed(1)}s\n`);
  }
  for (const key of ALL_PRESET_KEYS) signalsByPreset[key].sort((a, b) => a.date.localeCompare(b.date));
  console.log(`Signal counts: ${ALL_PRESET_KEYS.map(k => `${k}:${signalsByPreset[k].length}`).join('  ')}`);

  // 3b. Build ORATS enrichment lookups (VRP, contango, slope from Supabase IV + SQLite cores)
  console.log('Building ORATS enrichment lookups...');
  const enrichmentLookup = new Map(); // key: "ticker|date" → { vrp, contango, slope, smvVol }

  // From Supabase: compute VRP and contango from iv30d, iv60d, hv30d
  for (const ticker of ALL_TICKERS) {
    const { ivData } = candleData.get(ticker);
    for (const row of ivData) {
      const iv30 = row.iv30d ?? 0;
      const iv60 = row.iv60d ?? 0;
      const rv30 = row.hv30d ?? 0;
      const vrp = (iv30 * iv30) - (rv30 * rv30);  // IV² - RV² variance risk premium
      const contango = iv30 > 0 ? (iv60 / iv30) - 1 : 0;
      enrichmentLookup.set(`${ticker}|${row.date}`, { vrp, contango, slope: undefined, smvVol: undefined });
    }
  }

  // Try SQLite orats_cores_cache for slope/smvVol (if available)
  let coresEnriched = 0;
  try {
    const Database = (await import('better-sqlite3')).default;
    const dbPath = path.resolve(__dirname, '..', 'data', 'option-chains.sqlite');
    if (fs.existsSync(dbPath)) {
      const coresDb = new Database(dbPath, { readonly: true });
      const coresStmt = coresDb.prepare(
        'SELECT ticker, trade_date, slope, smv_vol FROM orats_cores_cache WHERE ticker = ? AND trade_date >= ? AND trade_date <= ? ORDER BY trade_date'
      );
      for (const ticker of ALL_TICKERS) {
        const rows = coresStmt.all(ticker, DATA_START, DATA_END);
        for (const row of rows) {
          const key = `${row.ticker}|${row.trade_date}`;
          const existing = enrichmentLookup.get(key);
          if (existing) {
            existing.slope = row.slope ?? undefined;
            existing.smvVol = row.smv_vol ?? undefined;
            coresEnriched++;
          } else {
            enrichmentLookup.set(key, { vrp: undefined, contango: undefined, slope: row.slope ?? undefined, smvVol: row.smv_vol ?? undefined });
          }
        }
      }
      coresDb.close();
    }
  } catch (e) {
    console.log(`  SQLite cores cache not available (${e.message}) — slope/smvVol filters disabled`);
  }
  console.log(`  Enrichment entries: ${enrichmentLookup.size}, SQLite cores: ${coresEnriched}`);

  // 3c. Enrich signals with ORATS data
  let enriched = 0;
  for (const key of ALL_PRESET_KEYS) {
    for (const sig of signalsByPreset[key]) {
      const enrichment = enrichmentLookup.get(`${sig.ticker}|${sig.date}`);
      if (enrichment) {
        if (enrichment.vrp !== undefined) sig.vrp = enrichment.vrp;
        if (enrichment.contango !== undefined) sig.contango = enrichment.contango;
        if (enrichment.slope !== undefined) sig.slope = enrichment.slope;
        if (enrichment.smvVol !== undefined) sig.smvVol = enrichment.smvVol;
        enriched++;
      }
    }
  }
  console.log(`  Enriched ${enriched} signals with ORATS data`);

  // 4. VIX proxy
  const spyIV = candleData.get('SPY')?.ivData || [];
  // iv30d is already in VIX-like units (e.g., 10.09 = 10.09%)
  const vixData = spyIV.map(row => ({ date: row.date, close: row.iv30d || 15 }));

  // 5. Spawn worker pool
  const dbPath = path.resolve(__dirname, '..', 'data', 'option-chains.sqlite');
  const workerPath = path.resolve(__dirname, '.wfa-v2-eval-worker.mjs');
  console.log(`\nSpawning ${NUM_WORKERS} workers...`);
  const pool = new WorkerPool(workerPath, NUM_WORKERS, { dbPath, allTradingDates, signalsByPreset });
  await pool.waitReady();
  console.log(`All ${NUM_WORKERS} workers ready (signals shared via workerData).\n`);

  try {
  // 6. Import v2 modules
  const { buildWFAWindows } = await import('../src/lib/backtest/wfa-options.ts');
  const { buildParameterSpace, runTPE, generateGrid, paramsToSimConfig } = await import('../src/lib/backtest/wfa-v2-optimizer.ts');
  const { computeOptionAnalytics } = await import('../src/lib/backtest/option-sim.ts');
  const { computeDSR, computePBO, blockBootstrap, permutationTest, benjaminiHochberg, computeParameterStability } = await import('../src/lib/backtest/wfa-v2-stats.ts');
  const { buildRegimeLookup, computeRegimeMetrics } = await import('../src/lib/backtest/wfa-v2-regime.ts');
  const { computeCompositeRanking } = await import('../src/lib/backtest/wfa-v2-ranking.ts');
  const { PROFILE_BOUNDS } = await import('../src/lib/backtest/wfa-v2-types.ts');

  // 7. Build WFA windows
  const allDates = allTradingDates.filter(d => d >= WFA_START && d <= WFA_END);
  const holdoutBoundaryIdx = Math.max(0, allDates.length - 252); // 1 year holdout
  const holdoutStart = allDates[holdoutBoundaryIdx];
  const wfaEndDate = allDates[holdoutBoundaryIdx - 1];

  const windowDefs = buildWFAWindows(allDates, {
    trainWindowDays: 504, forwardStepDays: 126, purgeGapDays: 65, mode: 'rolling',
    startDate: WFA_START, endDate: wfaEndDate,
  });
  console.log(`Built ${windowDefs.length} windows, holdout starts ${holdoutStart}\n`);

  // 8. Parallel trial evaluator
  let taskCounter = 0;

  async function evaluateAllWindowsParallel(simConfig, params) {
    const presetKey = simConfig.signalWeightPreset ?? 'ema';
    const maxPerTicker = params.maxPerTicker ?? 5;
    const maxPositions = params.maxPositions ?? 10;

    // Dispatch ALL train+OOS evals at once (2 per window) for maximum worker utilization
    const trainPromises = [];
    const oosPromises = [];
    for (const w of windowDefs) {
      trainPromises.push(pool.submit(`t${taskCounter++}`, presetKey, w.trainStart, w.trainEnd, simConfig, w.trainEnd));
      oosPromises.push(pool.submit(`t${taskCounter++}`, presetKey, w.oosStart, w.oosEnd, simConfig, WFA_END));
    }
    const [trainResults, oosResults] = await Promise.all([
      Promise.all(trainPromises),
      Promise.all(oosPromises),
    ]);

    // Process results
    const windows = windowDefs.map((w, i) => {
      const trainAnalytics = computeOptionAnalytics(trainResults[i]);

      // Apply portfolio constraints to OOS trades
      const oosTrades = [];
      const openPositions = [];
      const sortedOos = [...oosResults[i]].sort((a, b) => a.entryDate.localeCompare(b.entryDate));
      for (const trade of sortedOos) {
        for (let j = openPositions.length - 1; j >= 0; j--) {
          if (openPositions[j].exitDate <= trade.entryDate) openPositions.splice(j, 1);
        }
        if (openPositions.length >= maxPositions) continue;
        const tickerCount = openPositions.filter(t => t.ticker === trade.ticker).length;
        if (tickerCount >= maxPerTicker) continue;
        oosTrades.push(trade);
        openPositions.push(trade);
      }

      const oosAnalytics = computeOptionAnalytics(oosTrades);
      return {
        windowIndex: i, trainStart: w.trainStart, trainEnd: w.trainEnd,
        oosStart: w.oosStart, oosEnd: w.oosEnd, bestConfig: simConfig,
        bestTrainSharpe: trainAnalytics.sharpe, trainTradeCount: trainResults[i].length,
        oosTrades, oosSharpe: oosAnalytics.sharpe, oosWinRate: oosAnalytics.winRate,
        oosMaxDD: oosAnalytics.maxDrawdown, oosTradeCount: oosTrades.length,
      };
    });

    const allOOSTrades = windows.flatMap(w => w.oosTrades);
    const oosAll = computeOptionAnalytics(allOOSTrades);
    const avgTrainSharpe = windows.reduce((s, w) => s + w.bestTrainSharpe, 0) / windows.length;

    return {
      windows, oosTrades: allOOSTrades,
      oosSharpe: oosAll.sharpe, oosWinRate: oosAll.winRate, oosMaxDD: oosAll.maxDrawdown,
      oosTotalPnl: allOOSTrades.reduce((s, t) => s + t.pnl, 0),
      avgTrainSharpe, wfEfficiency: avgTrainSharpe > 0 ? oosAll.sharpe / avgTrainSharpe : 0,
    };
  }

  // 9. Deliberate grid definitions (round values, meaningful spacing)
  const SWING_GRID = {
    signalWeightPreset: ['ema', 'mom', 'em', 'full', 'vol'],
    creditShortDelta:   [0.20, 0.25, 0.30, 0.35, 0.40],
    creditSpreadWidth:  [5, 10, 15, 20],
    creditProfitTarget: [0.30, 0.35, 0.40, 0.45, 0.50],
    minIVRank:          [0, 10, 20, 30, 40, 50],
    creditTimeStopDTE:  [5, 7, 10],
    maxPositions:       [5, 10],
    maxPerTicker:       [3, 5],
    dirConfTier:        ['any', 'medium+', 'high'],
  };
  const SHORT_GRID = {
    signalWeightPreset: ['ema', 'mom', 'em', 'full', 'vol'],
    creditShortDelta:   [0.25, 0.30, 0.35, 0.40, 0.45, 0.50],
    creditSpreadWidth:  [1, 5, 10],
    creditProfitTarget: [0.30, 0.35, 0.40, 0.45, 0.50],
    minIVRank:          [0, 10, 20, 30, 40, 50],
    creditTimeStopDTE:  [1, 3],
    maxPositions:       [5, 10],
    maxPerTicker:       [3, 5],
    dirConfTier:        ['any', 'medium+', 'high'],
  };
  const GRID = PROFILE === 'short' ? SHORT_GRID : SWING_GRID;

  // Fixed params (not swept)
  const FIXED = {
    creditStopLossMultiple: 100,   // No stop loss (locked)
    monitoringIntervalDays: 1,     // Daily monitoring (locked)
    vrpFilter: 0,                  // Disabled
    contangoFilter: 0,             // Disabled
    slopeFilter: 0,                // Disabled
    maxIVSkew: 0.20,               // Disabled (high threshold)
    useSmvVol: false,
  };

  // Helper: sample a random individual from the grid
  function sampleGridIndividual(rng) {
    const params = { ...FIXED };
    for (const [key, values] of Object.entries(GRID)) {
      params[key] = values[Math.floor(rng() * values.length)];
    }
    return params;
  }

  // Helper: crossover two parents (uniform crossover on grid values)
  function crossover(p1, p2, rng) {
    const child = { ...FIXED };
    for (const key of Object.keys(GRID)) {
      child[key] = rng() < 0.5 ? p1[key] : p2[key];
    }
    return child;
  }

  // Helper: mutate one random gene to a different grid value
  function mutate(individual, rng, mutationRate = 0.15) {
    const result = { ...individual };
    for (const [key, values] of Object.entries(GRID)) {
      if (rng() < mutationRate) {
        result[key] = values[Math.floor(rng() * values.length)];
      }
    }
    return result;
  }

  // Helper: tournament selection (pick best of k random)
  function tournamentSelect(population, fitnesses, rng, k = 3) {
    let bestIdx = Math.floor(rng() * population.length);
    for (let i = 1; i < k; i++) {
      const idx = Math.floor(rng() * population.length);
      if (fitnesses[idx] > fitnesses[bestIdx]) bestIdx = idx;
    }
    return population[bestIdx];
  }

  const totalGridSize = Object.values(GRID).reduce((s, v) => s * v.length, 1);
  console.log(`Grid: ${Object.entries(GRID).map(([k,v]) => `${k}(${v.length})`).join(' × ')} = ${totalGridSize.toLocaleString()} combos`);
  console.log(`${'═'.repeat(55)}`);
  console.log(`Starting ${MODE} optimization (${N_TRIALS} evals, ${NUM_WORKERS} workers)...`);
  console.log(`${'═'.repeat(55)}\n`);

  const trialResults = [];
  let trialCounter = 0;

  // Dedup cache: avoid re-evaluating identical grid configs
  const evalCache = new Map();
  function configKey(params) {
    return Object.keys(GRID).map(k => params[k]).join('|');
  }

  const evaluateTrial = async (params) => {
    const key = configKey(params);
    if (evalCache.has(key)) {
      const cached = evalCache.get(key);
      trialResults.push({ trialId: trialCounter++, params, ...cached });
      return cached._fitness;
    }
    const simConfig = paramsToSimConfig(params, PROFILE);
    const trialId = trialCounter++;
    const result = await evaluateAllWindowsParallel(simConfig, params);
    // Fitness: Sharpe × √WFE × min(1, trades/500) × 1/(1 + maxDD/10)
    const wfeFactor = result.wfEfficiency > 0 ? Math.sqrt(result.wfEfficiency) : 0.5;
    const tradePenalty = Math.min(1, result.oosTrades.length / 500);
    const ddPenalty = 1 / (1 + result.oosMaxDD / 10);
    const fitness = result.oosSharpe * wfeFactor * tradePenalty * ddPenalty;
    result._fitness = fitness;
    evalCache.set(key, result);
    trialResults.push({ trialId, params, ...result });
    return fitness;
  };

  // Seeded RNG
  let _seed = SEED;
  const rng = () => { _seed = (_seed * 1664525 + 1013904223) & 0x7fffffff; return _seed / 0x7fffffff; };

  if (MODE === 'ga') {
    // ── Genetic Algorithm on deliberate grid ──────────────
    const POP_SIZE = Math.min(N_TRIALS, 50);  // population size
    const N_GENS = Math.max(1, Math.floor(N_TRIALS / POP_SIZE));
    const ELITE_COUNT = Math.max(2, Math.floor(POP_SIZE * 0.1));
    const MUTATION_RATE = 0.15;

    console.log(`GA: pop=${POP_SIZE}, gens=${N_GENS}, elite=${ELITE_COUNT}, mutation=${MUTATION_RATE}`);

    // Gen 0: random population from grid
    let population = [];
    for (let i = 0; i < POP_SIZE; i++) population.push(sampleGridIndividual(rng));

    let bestEverObj = -Infinity;
    let bestEverParams = null;

    for (let gen = 0; gen < N_GENS; gen++) {
      // Evaluate population in parallel batches
      const fitnesses = [];
      for (let b = 0; b < population.length; b += NUM_WORKERS) {
        const batch = population.slice(b, b + NUM_WORKERS);
        const results = await Promise.all(batch.map(p => evaluateTrial(p)));
        fitnesses.push(...results);
      }

      // Track best
      const genBestIdx = fitnesses.indexOf(Math.max(...fitnesses));
      const genBestObj = fitnesses[genBestIdx];
      if (genBestObj > bestEverObj) {
        bestEverObj = genBestObj;
        bestEverParams = { ...population[genBestIdx] };
      }

      const avgFit = fitnesses.reduce((s, f) => s + f, 0) / fitnesses.length;
      console.log(`  Gen ${gen+1}/${N_GENS}: best=${genBestObj.toFixed(3)}, avg=${avgFit.toFixed(3)}, allTimeBest=${bestEverObj.toFixed(3)}`);

      if (gen === N_GENS - 1) break; // last gen, skip breeding

      // Sort by fitness, keep elite
      const ranked = population.map((p, i) => ({ p, f: fitnesses[i] })).sort((a, b) => b.f - a.f);
      const nextPop = ranked.slice(0, ELITE_COUNT).map(r => r.p);

      // Breed rest via tournament + crossover + mutation
      while (nextPop.length < POP_SIZE) {
        const parent1 = tournamentSelect(population, fitnesses, rng);
        const parent2 = tournamentSelect(population, fitnesses, rng);
        let child = crossover(parent1, parent2, rng);
        child = mutate(child, rng, MUTATION_RATE);
        nextPop.push(child);
      }
      population = nextPop;
    }
  } else if (MODE === 'tpe') {
    // ── TPE on deliberate grid (snap to nearest grid value) ──
    const space = buildParameterSpace(PROFILE);
    const batchSize = NUM_WORKERS;
    const allTrialParams = [];
    const trialObjectives = [];
    const nStartup = Math.min(30, N_TRIALS);

    console.log(`Phase 1: ${nStartup} random startup trials (grid-snapped)...`);
    for (let b = 0; b < nStartup; b += batchSize) {
      const batchEnd = Math.min(b + batchSize, nStartup);
      const batchParams = [];
      for (let i = b; i < batchEnd; i++) batchParams.push(sampleGridIndividual(rng));
      const batchResults = await Promise.all(batchParams.map(p => evaluateTrial(p)));
      for (let i = 0; i < batchParams.length; i++) {
        allTrialParams.push(batchParams[i]);
        trialObjectives.push(batchResults[i]);
      }
      console.log(`  Batch ${Math.ceil((b+1)/batchSize)}/${Math.ceil(nStartup/batchSize)} done, best: ${Math.max(...trialObjectives).toFixed(3)}`);
    }

    console.log(`Phase 2: ${N_TRIALS - nStartup} TPE-guided trials (grid-snapped)...`);
    for (let i = nStartup; i < N_TRIALS; i++) {
      const sorted = allTrialParams.map((p, idx) => ({ p, obj: trialObjectives[idx] })).sort((a, b) => b.obj - a.obj);
      const splitIdx = Math.max(1, Math.ceil(sorted.length * 0.25));
      const base = sorted[Math.floor(rng() * splitIdx)].p;
      // Mutate from good individual, snapping to grid
      const params = mutate(base, rng, 0.20);
      const obj = await evaluateTrial(params);
      allTrialParams.push(params);
      trialObjectives.push(obj);
      if ((i + 1) % 20 === 0 || i === N_TRIALS - 1) {
        console.log(`  Trial ${i+1}/${N_TRIALS}, best: ${Math.max(...trialObjectives).toFixed(3)}`);
      }
    }
  } else {
    // ── Full grid sweep ──────────────────────────────────
    const gridCombos = generateGrid(GRID, PROFILE);
    console.log(`Full grid: ${gridCombos.length} combinations`);
    for (let b = 0; b < gridCombos.length; b += NUM_WORKERS) {
      const batch = gridCombos.slice(b, b + NUM_WORKERS);
      await Promise.all(batch.map(p => evaluateTrial(p)));
      if ((b + NUM_WORKERS) % 100 < NUM_WORKERS || b + NUM_WORKERS >= gridCombos.length) {
        console.log(`  ${Math.min(b + NUM_WORKERS, gridCombos.length)}/${gridCombos.length}`);
      }
    }
  }

  // 10. Sort results by fitness function
  function computeFitness(r) {
    const wfe = r.wfEfficiency > 0 ? Math.sqrt(r.wfEfficiency) : 0.5;
    const tradePenalty = Math.min(1, r.oosTrades.length / 500);
    const ddPenalty = 1 / (1 + r.oosMaxDD / 10);
    return r.oosSharpe * wfe * tradePenalty * ddPenalty;
  }
  trialResults.sort((a, b) => computeFitness(b) - computeFitness(a));
  const bestTrial = trialResults[0];

  console.log(`\nBest: Sharpe=${bestTrial.oosSharpe.toFixed(2)}, WR=${bestTrial.oosWinRate.toFixed(1)}%, DD=${bestTrial.oosMaxDD.toFixed(1)}%, WFE=${bestTrial.wfEfficiency.toFixed(3)}, trades=${bestTrial.oosTrades.length}`);

  // 11. Statistical validation
  console.log('\nRunning statistical validation...');
  const oosReturns = bestTrial.oosTrades.map(t => t.pnlPct);
  const perWindowReturns = bestTrial.windows.map(w => w.oosTrades.map(t => t.pnlPct));
  const dsr = computeDSR(bestTrial.oosSharpe, trialResults.length, oosReturns);
  const pbo = computePBO(perWindowReturns, 16, 5000);
  const bootstrap = blockBootstrap(bestTrial.oosTrades, N_BOOTSTRAP, 5, STARTING_CAPITAL);
  const permResult = permutationTest(bestTrial.oosTrades, 10000, STARTING_CAPITAL);
  const paramStability = computeParameterStability(bestTrial.windows, ['creditShortDelta','creditSpreadWidth','creditProfitTarget','creditStopLossMultiple','creditTimeStopDTE','minIVRank']);
  const stability = Math.max(0, 1 - (paramStability.reduce((s, p) => s + p.cv, 0) / Math.max(1, paramStability.length)));

  // 12. Holdout
  console.log('Running holdout...');
  const bestConfig = paramsToSimConfig(bestTrial.params, PROFILE);
  const holdoutTaskId = `holdout_${taskCounter++}`;
  const allHoldoutTrades = await pool.submit(holdoutTaskId, bestConfig.signalWeightPreset ?? 'ema', holdoutStart, WFA_END, bestConfig, WFA_END);
  // Apply portfolio constraints
  const holdoutTrades = [];
  const holdoutOpen = [];
  const maxPT = bestTrial.params.maxPerTicker ?? 5;
  const maxP = bestTrial.params.maxPositions ?? 10;
  for (const trade of allHoldoutTrades.sort((a, b) => a.entryDate.localeCompare(b.entryDate))) {
    for (let j = holdoutOpen.length - 1; j >= 0; j--) { if (holdoutOpen[j].exitDate <= trade.entryDate) holdoutOpen.splice(j, 1); }
    if (holdoutOpen.length >= maxP) continue;
    if (holdoutOpen.filter(t => t.ticker === trade.ticker).length >= maxPT) continue;
    holdoutTrades.push(trade); holdoutOpen.push(trade);
  }
  const holdoutAnalytics = computeOptionAnalytics(holdoutTrades);

  // 13. Regime analysis
  const vixLookup = buildRegimeLookup(vixData);
  const regimes = computeRegimeMetrics(bestTrial.oosTrades, vixLookup, STARTING_CAPITAL);

  // 14. Ranking
  const top20DSR = trialResults.slice(0, 20).map(t => {
    const r = t.oosTrades.map(tr => tr.pnlPct);
    return { configId: `trial_${t.trialId}`, pValue: 1 - computeDSR(t.oosSharpe, trialResults.length, r).dsr };
  });
  const bhCorrected = benjaminiHochberg(top20DSR);
  const evalResults = trialResults.slice(0, 50).map(t => {
    const r = t.oosTrades.map(tr => tr.pnlPct);
    return { configId: `trial_${t.trialId}`, params: t.params, sharpe: t.oosSharpe, maxDD: t.oosMaxDD, wfe: t.wfEfficiency, stability, dsr: computeDSR(t.oosSharpe, trialResults.length, r).dsr, winRate: t.oosWinRate, totalPnl: t.oosTotalPnl, tradeCount: t.oosTrades.length };
  });
  const ranking = computeCompositeRanking(evalResults);

  // 15. Print results
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  WFA v2 RESULTS — ${PROFILE.toUpperCase()} PROFILE`);
  console.log(`${'═'.repeat(60)}\n`);
  console.log(`OOS: Sharpe=${bestTrial.oosSharpe.toFixed(3)}, WR=${bestTrial.oosWinRate.toFixed(1)}%, DD=${bestTrial.oosMaxDD.toFixed(2)}%, PnL=$${bestTrial.oosTotalPnl.toFixed(0)}, WFE=${bestTrial.wfEfficiency.toFixed(3)}, trades=${bestTrial.oosTrades.length}`);
  const holdoutDegradation = bestTrial.oosSharpe > 0 ? holdoutAnalytics.sharpe / bestTrial.oosSharpe : 0;
  const holdoutFlag = holdoutDegradation < 0.50 ? ' ⚠ DEGRADATION > 50%' : '';
  console.log(`Holdout: Sharpe=${holdoutAnalytics.sharpe.toFixed(3)}, WR=${holdoutAnalytics.winRate.toFixed(1)}%, DD=${holdoutAnalytics.maxDrawdown.toFixed(2)}%, trades=${holdoutTrades.length}, degradation=${holdoutDegradation.toFixed(2)}${holdoutFlag}`);
  console.log(`\nStatistics:`);
  console.log(`  DSR: ${dsr.dsr.toFixed(3)} (expected max SR: ${dsr.expectedMaxSR.toFixed(2)} from ${dsr.nTrials} trials)${dsr.dsr < 0.5 ? ' ⚠ LOW' : ''}`);
  console.log(`  PBO: ${pbo.pbo.toFixed(3)} (${pbo.nCombinations} CSCV combinations)${pbo.pbo > 0.5 ? ' ⚠ HIGH' : ''}`);
  console.log(`  Bootstrap Sharpe CI: [${bootstrap.sharpe.ci5.toFixed(2)}, ${bootstrap.sharpe.ci95.toFixed(2)}]${bootstrap.sharpe.ci5 <= 0 ? ' ⚠ CROSSES ZERO' : ''}`);
  console.log(`  Permutation p-value: ${permResult.pValue.toFixed(4)}${permResult.pValue >= 0.05 ? ' ⚠ NOT SIGNIFICANT' : ''}`);
  console.log(`\nStability:  ${paramStability.map(p => `${p.paramName}=${p.mean.toFixed(3)}(CV${p.cv.toFixed(2)})${p.isStable?'✓':'⚠'}`).join('  ')}`);
  console.log(`\nRegimes:  ${regimes.map(r => `${r.regime}:${r.tradeCount}t/${r.sharpe.toFixed(1)}SR/${r.winRate.toFixed(0)}%WR`).join('  ')}`);
  console.log(`\nBest Config: delta=${bestConfig.creditShortDelta.toFixed(3)}, width=$${bestConfig.creditSpreadWidth.toFixed(1)}, DTE=[${bestConfig.creditDTERange}], TP=${(bestConfig.creditProfitTarget*100).toFixed(0)}%, SL=${bestConfig.creditStopLossMultiple >= 50 ? 'None' : bestConfig.creditStopLossMultiple+'x'}, IVRank≥${bestConfig.minIVRank.toFixed(0)}, signal=${bestConfig.signalWeightPreset}`);
  if (bestConfig.vrpFilter) console.log(`  VRP≥${bestConfig.vrpFilter.toFixed(3)}, Contango≥${(bestConfig.contangoFilter||0).toFixed(3)}, Slope≥${(bestConfig.slopeFilter||0).toFixed(2)}`);
  console.log(`\nTop 5:`);
  for (const r of ranking.slice(0, 5)) console.log(`  ${r.configId}: composite=${r.compositeScore.toFixed(3)}, SR=${r.sharpe.toFixed(2)}, DD=${r.maxDD.toFixed(1)}%, WFE=${r.wfe.toFixed(2)} ${r.isParetoOptimal?'★':''}`);
  const paretoConfigs = ranking.filter(r => r.isParetoOptimal);
  console.log(`\nPareto: ${paretoConfigs.length} non-dominated configs`);

  // v1 comparison table (v1 baseline: ema iv30plus std30 mpt5 → OOS Sharpe 2.14, WR 88%, DD 4.9%)
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  v2 vs v1 COMPARISON`);
  console.log(`${'─'.repeat(60)}`);
  console.log(`${'Metric'.padEnd(20)} ${'v1 (baseline)'.padEnd(15)} ${'v2 (best)'.padEnd(15)} Delta`);
  console.log(`${'─'.repeat(60)}`);
  const v1 = { sharpe: 1.275, wr: 89.52, dd: 4.64, trades: 5556, pnl: 613248 };
  const v2s = { sharpe: bestTrial.oosSharpe, wr: bestTrial.oosWinRate, dd: bestTrial.oosMaxDD, trades: bestTrial.oosTrades.length, pnl: bestTrial.oosTotalPnl };
  console.log(`${'Sharpe'.padEnd(20)} ${v1.sharpe.toFixed(3).padEnd(15)} ${v2s.sharpe.toFixed(3).padEnd(15)} ${(v2s.sharpe - v1.sharpe > 0 ? '+' : '') + (v2s.sharpe - v1.sharpe).toFixed(3)}`);
  console.log(`${'Win Rate %'.padEnd(20)} ${v1.wr.toFixed(1).padEnd(15)} ${v2s.wr.toFixed(1).padEnd(15)} ${(v2s.wr - v1.wr > 0 ? '+' : '') + (v2s.wr - v1.wr).toFixed(1)}`);
  console.log(`${'Max DD %'.padEnd(20)} ${v1.dd.toFixed(2).padEnd(15)} ${v2s.dd.toFixed(2).padEnd(15)} ${(v2s.dd - v1.dd > 0 ? '+' : '') + (v2s.dd - v1.dd).toFixed(2)}`);
  console.log(`${'Trade Count'.padEnd(20)} ${String(v1.trades).padEnd(15)} ${String(v2s.trades).padEnd(15)} ${(v2s.trades - v1.trades > 0 ? '+' : '') + (v2s.trades - v1.trades)}`);
  console.log(`${'Total PnL $'.padEnd(20)} ${v1.pnl.toFixed(0).padEnd(15)} ${v2s.pnl.toFixed(0).padEnd(15)} ${(v2s.pnl - v1.pnl > 0 ? '+' : '') + (v2s.pnl - v1.pnl).toFixed(0)}`);
  console.log(`${'─'.repeat(60)}`);

  // Build equity curve from OOS trades
  const sortedOosTrades = [...bestTrial.oosTrades].sort((a, b) => a.exitDate.localeCompare(b.exitDate));
  const equityCurve = [];
  let equity = STARTING_CAPITAL;
  for (const trade of sortedOosTrades) {
    equity += trade.pnl;
    equityCurve.push({ date: trade.exitDate, equity: Math.round(equity * 100) / 100 });
  }

  // Save
  const result = {
    oos: {
      windows: bestTrial.windows.map(w => ({ ...w, oosTrades: w.oosTrades.length })),
      allTrades: bestTrial.oosTrades,
      sharpe: bestTrial.oosSharpe, winRate: bestTrial.oosWinRate,
      maxDD: bestTrial.oosMaxDD, totalPnl: bestTrial.oosTotalPnl,
      wfEfficiency: bestTrial.wfEfficiency,
      equityCurve,
    },
    holdout: {
      sharpe: holdoutAnalytics.sharpe, winRate: holdoutAnalytics.winRate,
      maxDD: holdoutAnalytics.maxDrawdown,
      totalPnl: holdoutTrades.reduce((s, t) => s + t.pnl, 0),
      tradeCount: holdoutTrades.length,
      degradation: holdoutDegradation,
    },
    stats: { dsr, pbo, bootstrap, permutationPValue: permResult.pValue, paramStability },
    regimes, bestConfig,
    ranking: ranking.slice(0, 20),
    paretoFrontier: paretoConfigs,
    dteProfile: PROFILE,
    v1Comparison: { v1, v2: v2s },
    totalEvaluations: trialResults.length, elapsedMs: Date.now() - t0,
  };
  const adxTag = NO_ADX_FILTER ? '-noadx' : '';
  const outPath = path.resolve(__dirname, '..', 'data', `wfa-v2-results-${PROFILE}${ROBUSTNESS_TAG}${adxTag}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\nSaved: ${outPath}`);
  console.log(`Total time: ${((Date.now()-t0)/1000).toFixed(1)}s (${trialResults.length} evaluations, ${NUM_WORKERS} workers)\n`);
  } finally {
    pool.shutdown();
  }
}

async function run() {
  if (PROFILE === 'all') {
    // Full analysis: swing → short → swing robustness (seed=43)
    const originalSeed = SEED;

    PROFILE = 'swing';
    SEED = originalSeed;
    await main();

    PROFILE = 'short';
    SEED = originalSeed;
    await main();

    // Robustness check: re-run swing with different seed
    PROFILE = 'swing';
    SEED = 43;
    ROBUSTNESS_TAG = '-seed43';
    console.log('\n' + '█'.repeat(60));
    console.log('  ROBUSTNESS CHECK — Swing with seed=43');
    console.log('█'.repeat(60));
    await main();
    ROBUSTNESS_TAG = '';

    // Print cross-run comparison
    try {
      const s1 = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', 'wfa-v2-results-swing.json'), 'utf8'));
      const s2 = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', 'wfa-v2-results-swing-seed43.json'), 'utf8'));
      const sh = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', 'wfa-v2-results-short.json'), 'utf8'));
      console.log('\n' + '═'.repeat(60));
      console.log('  FULL ANALYSIS SUMMARY');
      console.log('═'.repeat(60));
      console.log(`${'Profile'.padEnd(18)} ${'Sharpe'.padEnd(8)} ${'WR%'.padEnd(7)} ${'DD%'.padEnd(7)} ${'Trades'.padEnd(8)} ${'WFE'.padEnd(7)} ${'Holdout SR'.padEnd(10)} ${'Signal'}`);
      console.log('─'.repeat(75));
      for (const [label, d] of [['Swing (seed=42)', s1], ['Swing (seed=43)', s2], ['Short', sh]]) {
        console.log(
          label.padEnd(18) +
          d.oos.sharpe.toFixed(2).padEnd(8) +
          d.oos.winRate.toFixed(1).padEnd(7) +
          d.oos.maxDD.toFixed(1).padEnd(7) +
          String(d.oos.allTrades.length).padEnd(8) +
          d.oos.wfEfficiency.toFixed(2).padEnd(7) +
          d.holdout.sharpe.toFixed(2).padEnd(10) +
          (d.bestConfig.signalWeightPreset || '?')
        );
      }
      console.log('─'.repeat(75));
      // Robustness: check if same signal preset + similar params
      const same = s1.bestConfig.signalWeightPreset === s2.bestConfig.signalWeightPreset;
      const sharpeDiff = Math.abs(s1.oos.sharpe - s2.oos.sharpe);
      console.log(`\nRobustness: signal match=${same ? 'YES' : 'NO'}, Sharpe diff=${sharpeDiff.toFixed(3)} ${sharpeDiff < 0.3 ? '✓ STABLE' : '⚠ UNSTABLE'}`);
    } catch (e) { /* files may not exist */ }

  } else if (PROFILE === 'both') {
    for (const p of ['swing', 'short']) {
      PROFILE = p;
      await main();
    }
  } else {
    await main();
  }
}

run().catch(err => { console.error('FATAL:', err); process.exit(1); });
