/**
 * DTE5 TP/SL Walk-Forward Analysis Study
 *
 * Comprehensive evaluation of TP, SL, trailing lock, and phased TP
 * for the DTE5 bull put + bear call credit spread strategy.
 *
 * Baseline: hold-to-expiry (profitTarget=1.0, SL=off, deltaStop=off)
 * Validated at Sharpe ~1.18, CAGR 38.8%, WR 80%, MaxDD 25.6%.
 *
 * Usage:
 *   npx tsx scripts/wfa-dte5-tp-sl-study.ts [--phase 1|2|3|all]
 *   npx tsx scripts/wfa-dte5-tp-sl-study.ts --phase 1 --baseline-only
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import { Worker } from 'node:worker_threads';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, '../.env') });
dotenvConfig({ path: path.resolve(__dirname, '../.env.local'), override: true });

import type { BacktestCandle } from '../src/lib/backtest/types';
import { SIGNAL_PRESETS, DEFAULT_DYNAMIC_SLIPPAGE } from '../src/lib/backtest/types';
import { precomputeSignals } from '../src/lib/backtest/engine';
import { initDB, closeDB } from '../src/lib/backtest/chain-cache';
import {
  DEFAULT_CREDIT_CONFIG,
  computeOptionAnalytics,
  type EntrySignal, type SimConfig, type OptionTrade,
} from '../src/lib/backtest/option-sim';
import { computeIVRankMinMax } from '../src/lib/backtest/iv-rank';
import {
  buildWFAWindows,
  computePortfolioDailyMetrics,
  type PortfolioExecutionConfig,
} from '../src/lib/backtest/wfa-options';
import type { PhasedTPConfig } from './wfa-dte5-tp-sl-worker';

// ── Config Constants ─────────────────────────────────────

const SUPABASE_URL = () => process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_KEY = () => process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

const DTE5_PARAMS = {
  dataStart: '2017-01-01',
  startDate: '2018-01-01',
  endDate: '2026-02-28',
  trainWindowDays: 252,
  forwardStepDays: 126,
  purgeGapDays: 10,
  mode: 'rolling' as const,
  maxPositions: 1,
  maxPerTicker: 1,
  startingCapital: 10_000,
  holdoutCount: 2,
};

// DTE5 ticker configs from data/strategy-config.json
const DTE5_TICKER_CONFIGS = {
  QQQ: {
    bull: { delta: 0.30, longDelta: 0.20, ema: 34 },
    bear: { delta: 0.40, longDelta: 0.30, proximity: { ema: 21, tolerance: 0.01 } },
  },
  SPY: {
    bull: { delta: 0.30, longDelta: 0.20, ema: 34 },
    bear: { delta: 0.40, longDelta: 0.30, proximity: { ema: 21, tolerance: 0.05 } },
  },
  IWM: {
    bull: { delta: 0.30, longDelta: 0.20, ema: 34 },
    bear: { delta: 0.15, longDelta: 0.05, proximity: { ema: 21, tolerance: 0.03 } },
  },
} as const;

const DTE5_TICKERS = Object.keys(DTE5_TICKER_CONFIGS);

// ── Supabase Helper ──────────────────────────────────────

async function supabaseGet(table: string, query: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL()}/rest/v1/${table}?${query}`, {
    headers: { apikey: SUPABASE_KEY(), Authorization: `Bearer ${SUPABASE_KEY()}` },
  });
  if (!res.ok) throw new Error(`${table} fetch failed: ${res.status}`);
  return res.json();
}

// ── EMA Computation ──────────────────────────────────────

function computeEMASeries(closes: number[], period: number): number[] {
  const ema = new Array(closes.length).fill(0);
  if (closes.length < period) return ema;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  ema[period - 1] = sum / period;
  const k = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) {
    ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

// ── Data Loading ─────────────────────────────────────────

interface RegimeData {
  vrp?: number;
  contango?: number;
  vrpPct?: number;
  contangoPct?: number;
  slope?: number;
}

interface TickerData {
  ticker: string;
  candles: BacktestCandle[];
  ivRanks: (number | null)[];
  dateToIdx: Map<string, number>;
  ema21: number[];
  ema34: number[];
  ema55: number[];
  emas: Map<number, number[]>; // period → full EMA series (8, 13, 21, 34, 55)
  regimeByDate: Map<string, RegimeData>;
}

function computeRollingPercentile(values: (number | undefined)[], window = 252): (number | undefined)[] {
  return values.map((v, i) => {
    if (v == null || !Number.isFinite(v)) return undefined;
    const start = Math.max(0, i - window);
    const w = values.slice(start, i + 1).filter((x): x is number => x != null && Number.isFinite(x));
    if (w.length < 60) return undefined;
    const le = w.filter(x => x <= v).length;
    return (le / w.length) * 100;
  });
}

async function fetchTickerData(ticker: string): Promise<TickerData> {
  const rows = await supabaseGet('stock_candles',
    `select=date,open,high,low,close,volume&ticker=eq.${ticker}&timeframe=eq.1D&date=gte.${DTE5_PARAMS.dataStart}&date=lte.${DTE5_PARAMS.endDate}&order=date.asc&limit=10000`);
  const candles: BacktestCandle[] = rows.map((r: any) => ({
    date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume ?? 0,
  }));

  // Fetch ORATS IV data — expanded to include iv60d, hv20d for contango/VRP
  // Note: ORATS /hist/cores has clsHv5d,10d,20d,60d but NOT clsHv30d.
  // hv30d column in orats_iv_cache is always NULL. Use hv20d for VRP instead.
  const ivRows = await supabaseGet('orats_iv_cache',
    `select=date,iv30d,iv60d,hv20d&ticker=eq.${ticker}&date=gte.${DTE5_PARAMS.dataStart}&date=lte.${DTE5_PARAMS.endDate}&order=date.asc&limit=5000`);
  const ivByDate = new Map<string, { iv30: number | null; iv60: number | null; hv20: number | null }>();
  for (const r of ivRows) {
    ivByDate.set(r.date, { iv30: r.iv30d, iv60: r.iv60d ?? null, hv20: r.hv20d ?? null });
  }
  const ivSeries = candles.map(c => ivByDate.get(c.date)?.iv30 ?? null);
  const ivRanks = computeIVRankMinMax(ivSeries);
  const dateToIdx = new Map(candles.map((c, i) => [c.date, i]));

  const closes = candles.map(c => c.close);
  const emaPeriods = [8, 13, 21, 34, 55];
  const emas = new Map<number, number[]>();
  for (const p of emaPeriods) emas.set(p, computeEMASeries(closes, p));
  const ema21 = emas.get(21)!;
  const ema34 = emas.get(34)!;
  const ema55 = emas.get(55)!;

  // Compute contango and VRP per date
  // VRP = IV30² - HV20² (using hv20d since ORATS doesn't provide hv30d)
  const contangoSeries: (number | undefined)[] = [];
  const vrpSeries: (number | undefined)[] = [];
  for (const c of candles) {
    const iv = ivByDate.get(c.date);
    if (iv && iv.iv30 != null && Number.isFinite(iv.iv30) && iv.iv30 > 0) {
      const contango = iv.iv60 != null && Number.isFinite(iv.iv60) ? (iv.iv60 / iv.iv30) - 1 : undefined;
      const vrp = iv.hv20 != null && Number.isFinite(iv.hv20) ? (iv.iv30 * iv.iv30) - (iv.hv20 * iv.hv20) : undefined;
      contangoSeries.push(contango);
      vrpSeries.push(vrp);
    } else {
      contangoSeries.push(undefined);
      vrpSeries.push(undefined);
    }
  }

  // Compute rolling percentiles (252-day window, min 60 values)
  const contangoPctSeries = computeRollingPercentile(contangoSeries);
  const vrpPctSeries = computeRollingPercentile(vrpSeries);

  // Build regime map
  const regimeByDate = new Map<string, RegimeData>();
  for (let i = 0; i < candles.length; i++) {
    regimeByDate.set(candles[i].date, {
      contango: contangoSeries[i],
      vrp: vrpSeries[i],
      contangoPct: contangoPctSeries[i],
      vrpPct: vrpPctSeries[i],
    });
  }

  return { ticker, candles, ivRanks, dateToIdx, ema21, ema34, ema55, emas, regimeByDate };
}

// ── DTE5 Signal Generation ───────────────────────────────

function generateDTE5Signals(tickerDataMap: Map<string, TickerData>, bullOnly = false): EntrySignal[] {
  const signals: EntrySignal[] = [];

  for (const [ticker, td] of tickerDataMap) {
    const config = DTE5_TICKER_CONFIGS[ticker as keyof typeof DTE5_TICKER_CONFIGS];
    if (!config) continue;

    for (let i = 55; i < td.candles.length; i++) {
      const c = td.candles[i];
      if (c.date < DTE5_PARAMS.startDate || c.date > DTE5_PARAMS.endDate) continue;

      const close = c.close;
      const e21 = td.ema21[i];
      const e34 = td.ema34[i];
      const e55 = td.ema55[i];

      // Bull signal: close > EMA34
      if ('bull' in config && close > e34 && e34 > 0) {
        const regime = td.regimeByDate.get(c.date);
        const bullCfg = config.bull;
        signals.push({
          ticker, date: c.date, direction: 'CALL', score: 50,
          ivRank: td.ivRanks[i] ?? undefined,
          vrp: regime?.vrp,
          contango: regime?.contango,
          vrpPct: regime?.vrpPct,
          contangoPct: regime?.contangoPct,
          slope: regime?.slope,
          configuredDelta: bullCfg.delta,
          configuredLongDelta: bullCfg.longDelta,
        });
      }

      // Bear signal: triple EMA alignment + proximity to EMA21
      if (!bullOnly && 'bear' in config && e21 > 0 && e21 < e34 && e34 < e55) {
        const proxConfig = config.bear.proximity;
        if (close < e21) {
          const proxDist = Math.abs(close - e21) / e21;
          if (proxDist <= proxConfig.tolerance) {
            const regime = td.regimeByDate.get(c.date);
            const bearCfg = config.bear;
            signals.push({
              ticker, date: c.date, direction: 'PUT', score: 50,
              ivRank: td.ivRanks[i] ?? undefined,
              vrp: regime?.vrp,
              contango: regime?.contango,
              vrpPct: regime?.vrpPct,
              contangoPct: regime?.contangoPct,
              slope: regime?.slope,
              configuredDelta: bearCfg.delta,
              configuredLongDelta: bearCfg.longDelta,
            });
          }
        }
      }
    }
  }

  signals.sort((a, b) => a.date.localeCompare(b.date));
  return signals;
}

// ── SL Config Definitions ────────────────────────────────

interface ConfigDef {
  label: string;
  mechanism: string;
  params: Record<string, number>;
  apply: (base: SimConfig) => SimConfig;
  phasedConfig?: PhasedTPConfig;
}

function buildPhase1Configs(): ConfigDef[] {
  const configs: ConfigDef[] = [];

  // Baseline
  configs.push({
    label: 'baseline',
    mechanism: 'baseline',
    params: {},
    apply: (base) => ({ ...base, creditProfitTarget: 1.0, creditStopLossMultiple: 100 }),
  });

  // Phase 1A: TP Sweep
  for (const tp of [0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90]) {
    configs.push({
      label: `tp${(tp * 100).toFixed(0)}`,
      mechanism: 'profit_target',
      params: { creditProfitTarget: tp },
      apply: (base) => ({ ...base, creditProfitTarget: tp, creditStopLossMultiple: 100 }),
    });
  }

  // Phase 1B: Credit Multiple SL
  for (const mult of [1.5, 2.0, 2.5, 3.0, 5.0]) {
    configs.push({
      label: `sl${mult}x`,
      mechanism: 'credit_multiple',
      params: { creditStopLossMultiple: mult },
      apply: (base) => ({ ...base, creditProfitTarget: 1.0, creditStopLossMultiple: mult }),
    });
  }

  // Phase 1B: Max Loss %
  for (const pct of [0.25, 0.50, 0.75]) {
    configs.push({
      label: `ml${(pct * 100).toFixed(0)}`,
      mechanism: 'max_loss_pct',
      params: { creditMaxLossStopPct: pct },
      apply: (base) => ({ ...base, creditProfitTarget: 1.0, creditStopLossMultiple: 100, creditMaxLossStopPct: pct }),
    });
  }

  // Phase 1B: Delta Stop
  for (const ds of [0.50, 0.55, 0.60, 0.65, 0.70, 0.80]) {
    configs.push({
      label: `ds${(ds * 100).toFixed(0)}`,
      mechanism: 'delta_stop',
      params: { creditDeltaStop: ds },
      apply: (base) => ({ ...base, creditProfitTarget: 1.0, creditStopLossMultiple: 100, creditDeltaStop: ds }),
    });
  }

  // Phase 1C: Trailing Lock
  for (const [act, floor] of [[0.50, 0.25], [0.50, 0.50], [0.75, 0.25], [0.75, 0.50]] as [number, number][]) {
    configs.push({
      label: `tl${(act * 100).toFixed(0)}-${(floor * 100).toFixed(0)}`,
      mechanism: 'trailing_lock',
      params: { trailingActivatePct: act, trailingFloorPct: floor },
      apply: (base) => ({ ...base, creditProfitTarget: 1.0, creditStopLossMultiple: 100, trailingActivatePct: act, trailingFloorPct: floor }),
    });
  }

  // Phase 1D: NO_CHAIN fix — suppress forced exits (hold to expiry via intrinsic)
  configs.push({
    label: 'nochain_fix',
    mechanism: 'nochain_fix',
    params: { missingChainExitAfterDays: 999 },
    apply: (base) => ({ ...base, creditProfitTarget: 1.0, creditStopLossMultiple: 100, missingChainExitAfterDays: 999 }),
  });

  // Phase 1E: First-day-only SL — check SL only on day 1 after entry (morning-after defense)
  for (const mult of [1.5, 2.0, 2.5, 3.0]) {
    configs.push({
      label: `d1sl${mult}x`,
      mechanism: 'first_day_sl',
      params: { creditStopLossMultiple: mult, slActiveDays: 1 },
      apply: (base) => ({ ...base, creditProfitTarget: 1.0, creditStopLossMultiple: mult, slActiveDays: 1 } as any),
    });
  }

  // Phase 1F: Combos — NO_CHAIN fix + best SL configs
  configs.push({
    label: 'nc+sl2.5x',
    mechanism: 'combo_nochain_sl',
    params: { creditStopLossMultiple: 2.5, missingChainExitAfterDays: 999 },
    apply: (base) => ({ ...base, creditProfitTarget: 1.0, creditStopLossMultiple: 2.5, missingChainExitAfterDays: 999 }),
  });
  configs.push({
    label: 'nc+ml50',
    mechanism: 'combo_nochain_ml',
    params: { creditMaxLossStopPct: 0.50, missingChainExitAfterDays: 999 },
    apply: (base) => ({ ...base, creditProfitTarget: 1.0, creditStopLossMultiple: 100, creditMaxLossStopPct: 0.50, missingChainExitAfterDays: 999 }),
  });
  configs.push({
    label: 'nc+d1sl2.5',
    mechanism: 'combo_nochain_d1sl',
    params: { creditStopLossMultiple: 2.5, missingChainExitAfterDays: 999, slActiveDays: 1 },
    apply: (base) => ({ ...base, creditProfitTarget: 1.0, creditStopLossMultiple: 2.5, missingChainExitAfterDays: 999, slActiveDays: 1 } as any),
  });

  return configs;
}

// ── Phase 2A: Holdout Diagnostic & Multi-Mechanism Combos (8 configs) ──

function buildPhase2AConfigs(): ConfigDef[] {
  const configs: ConfigDef[] = [];
  const NC = 999; // missingChainExitAfterDays — suppress NO_CHAIN exits

  // 1. Tighter SL around champion
  configs.push({
    label: 'nc+sl2.0x',
    mechanism: 'combo_nc_sl',
    params: { creditStopLossMultiple: 2.0, missingChainExitAfterDays: NC },
    apply: (base) => ({ ...base, creditProfitTarget: 1.0, creditStopLossMultiple: 2.0, missingChainExitAfterDays: NC }),
  });

  // 2. Wider SL
  configs.push({
    label: 'nc+sl3.0x',
    mechanism: 'combo_nc_sl',
    params: { creditStopLossMultiple: 3.0, missingChainExitAfterDays: NC },
    apply: (base) => ({ ...base, creditProfitTarget: 1.0, creditStopLossMultiple: 3.0, missingChainExitAfterDays: NC }),
  });

  // 3. Champion + time stop at DTE=1
  configs.push({
    label: 'nc+sl2.5x+ts1',
    mechanism: 'combo_nc_sl_ts',
    params: { creditStopLossMultiple: 2.5, creditTimeStopDTE: 1, missingChainExitAfterDays: NC },
    apply: (base) => ({ ...base, creditProfitTarget: 1.0, creditStopLossMultiple: 2.5, creditTimeStopDTE: 1, missingChainExitAfterDays: NC }),
  });

  // 4. Champion + delta stop 0.70
  configs.push({
    label: 'nc+sl2.5x+ds70',
    mechanism: 'combo_nc_sl_ds',
    params: { creditStopLossMultiple: 2.5, creditDeltaStop: 0.70, missingChainExitAfterDays: NC },
    apply: (base) => ({ ...base, creditProfitTarget: 1.0, creditStopLossMultiple: 2.5, creditDeltaStop: 0.70, missingChainExitAfterDays: NC }),
  });

  // 5. Champion + delta stop 0.80
  configs.push({
    label: 'nc+sl2.5x+ds80',
    mechanism: 'combo_nc_sl_ds',
    params: { creditStopLossMultiple: 2.5, creditDeltaStop: 0.80, missingChainExitAfterDays: NC },
    apply: (base) => ({ ...base, creditProfitTarget: 1.0, creditStopLossMultiple: 2.5, creditDeltaStop: 0.80, missingChainExitAfterDays: NC }),
  });

  // 6. Dual: max loss 50% AND credit multiple 2.5x
  configs.push({
    label: 'nc+ml50+sl2.5x',
    mechanism: 'combo_nc_ml_sl',
    params: { creditStopLossMultiple: 2.5, creditMaxLossStopPct: 0.50, missingChainExitAfterDays: NC },
    apply: (base) => ({ ...base, creditProfitTarget: 1.0, creditStopLossMultiple: 2.5, creditMaxLossStopPct: 0.50, missingChainExitAfterDays: NC }),
  });

  // 7. Champion + trailing lock 50/50
  configs.push({
    label: 'nc+sl2.5x+tl50-50',
    mechanism: 'combo_nc_sl_tl',
    params: { creditStopLossMultiple: 2.5, trailingActivatePct: 0.50, trailingFloorPct: 0.50, missingChainExitAfterDays: NC },
    apply: (base) => ({ ...base, creditProfitTarget: 1.0, creditStopLossMultiple: 2.5, trailingActivatePct: 0.50, trailingFloorPct: 0.50, missingChainExitAfterDays: NC }),
  });

  // 8. Champion + trailing lock 50/25
  configs.push({
    label: 'nc+sl2.5x+tl50-25',
    mechanism: 'combo_nc_sl_tl',
    params: { creditStopLossMultiple: 2.5, trailingActivatePct: 0.50, trailingFloorPct: 0.25, missingChainExitAfterDays: NC },
    apply: (base) => ({ ...base, creditProfitTarget: 1.0, creditStopLossMultiple: 2.5, trailingActivatePct: 0.50, trailingFloorPct: 0.25, missingChainExitAfterDays: NC }),
  });

  return configs;
}

// ── Phase 2B: SL Parameter Refinement (12 configs) ──

function buildPhase2BConfigs(): ConfigDef[] {
  const configs: ConfigDef[] = [];
  const NC = 999;

  // Fine credit multiple sweep around 2.5x (0.1x steps)
  for (const mult of [2.1, 2.2, 2.3, 2.4, 2.6]) {
    configs.push({
      label: `nc+sl${mult}x`,
      mechanism: 'nc_credit_fine',
      params: { creditStopLossMultiple: mult, missingChainExitAfterDays: NC },
      apply: (base) => ({ ...base, creditProfitTarget: 1.0, creditStopLossMultiple: mult, missingChainExitAfterDays: NC }),
    });
  }

  // SL active for first 2, 3, 5 monitoring days
  for (const days of [2, 3, 5]) {
    configs.push({
      label: `nc+slAct${days}d_sl2.5x`,
      mechanism: 'nc_sl_active_days',
      params: { creditStopLossMultiple: 2.5, slActiveDays: days, missingChainExitAfterDays: NC },
      apply: (base) => ({ ...base, creditProfitTarget: 1.0, creditStopLossMultiple: 2.5, missingChainExitAfterDays: NC, slActiveDays: days } as any),
    });
  }

  // Fine max loss % sweep around 50%
  for (const pct of [0.40, 0.60]) {
    configs.push({
      label: `nc+ml${(pct * 100).toFixed(0)}`,
      mechanism: 'nc_max_loss_fine',
      params: { creditMaxLossStopPct: pct, missingChainExitAfterDays: NC },
      apply: (base) => ({ ...base, creditProfitTarget: 1.0, creditStopLossMultiple: 100, creditMaxLossStopPct: pct, missingChainExitAfterDays: NC }),
    });
  }

  // Delta stop refinements
  for (const ds of [0.75, 0.85]) {
    configs.push({
      label: `nc+ds${(ds * 100).toFixed(0)}`,
      mechanism: 'nc_delta_stop',
      params: { creditDeltaStop: ds, missingChainExitAfterDays: NC },
      apply: (base) => ({ ...base, creditProfitTarget: 1.0, creditStopLossMultiple: 100, creditDeltaStop: ds, missingChainExitAfterDays: NC }),
    });
  }

  return configs;
}

// ── Phase 3R: Phased TP Re-run with nc+ Fix (12 configs) ──

function buildPhase3RConfigs(): ConfigDef[] {
  const configs: ConfigDef[] = [];
  const NC = 999;

  // Reduced grid: TP1 x TP2 x afterSL
  const grid: [number, number, number, string][] = [
    // TP1=0.50, TP2 sweep, no SL
    [0.50, 0.60, -1, 'none'], [0.50, 0.70, -1, 'none'], [0.50, 0.80, -1, 'none'],
    // TP1=0.50, TP2 sweep, breakeven
    [0.50, 0.60, 0, 'be'], [0.50, 0.70, 0, 'be'], [0.50, 0.80, 0, 'be'],
    // TP1=0.30, TP2 sweep, no SL
    [0.30, 0.50, -1, 'none'], [0.30, 0.60, -1, 'none'], [0.30, 0.70, -1, 'none'],
    // TP1=0.30, TP2 sweep, lock25
    [0.30, 0.50, 0.25, 'lock25'], [0.30, 0.60, 0.25, 'lock25'], [0.30, 0.70, 0.25, 'lock25'],
  ];

  for (const [tp1, tp2, afterSL, slLabel] of grid) {
    configs.push({
      label: `nc+ph${(tp1 * 100).toFixed(0)}-${(tp2 * 100).toFixed(0)}_${slLabel}`,
      mechanism: 'nc_phased_tp',
      params: { tp1, tp2, afterTP1SL: afterSL, missingChainExitAfterDays: NC },
      apply: (base) => ({ ...base, creditProfitTarget: tp1, creditStopLossMultiple: 100, missingChainExitAfterDays: NC }),
      phasedConfig: { tp1, tp2, afterTP1SL: afterSL },
    });
  }

  return configs;
}

// ── Phase 4: Entry-Level Regime Filters (18 configs) ──

function buildPhase4Configs(): ConfigDef[] {
  const configs: ConfigDef[] = [];
  const NC = 999;
  // All configs build on the champion: nc+sl2.5x+tl50-50
  const championBase = (base: SimConfig) => ({
    ...base,
    creditProfitTarget: 1.0,
    creditStopLossMultiple: 2.5,
    trailingActivatePct: 0.50,
    trailingFloorPct: 0.50,
    missingChainExitAfterDays: NC,
  });

  // Group A: Hard entry filters — contango percentile
  for (const pct of [25, 40, 50]) {
    configs.push({
      label: `champ+cPct${pct}`,
      mechanism: 'regime_contango_pct',
      params: { contangoPctFilter: pct },
      apply: (base) => ({ ...championBase(base), contangoPctFilter: pct }),
    });
  }

  // Group A: Hard entry filters — VRP percentile
  for (const pct of [25, 40, 50]) {
    configs.push({
      label: `champ+vrpPct${pct}`,
      mechanism: 'regime_vrp_pct',
      params: { vrpPctFilter: pct },
      apply: (base) => ({ ...championBase(base), vrpPctFilter: pct }),
    });
  }

  // Group A: Hard entry filters — raw contango threshold
  for (const c of [0.02, 0.04]) {
    configs.push({
      label: `champ+c${(c * 100).toFixed(0)}`,
      mechanism: 'regime_contango_raw',
      params: { contangoFilter: c },
      apply: (base) => ({ ...championBase(base), contangoFilter: c }),
    });
  }

  // Group A: Hard entry filters — raw VRP threshold
  for (const v of [0.005, 0.010]) {
    configs.push({
      label: `champ+vrp${(v * 1000).toFixed(0)}`,
      mechanism: 'regime_vrp_raw',
      params: { vrpFilter: v },
      apply: (base) => ({ ...championBase(base), vrpFilter: v }),
    });
  }

  // Group B: Position sizing by contango bucket (not hard filter)
  // These use contango sizing fields — worker needs to support them
  // For now, test as hard filters with different thresholds

  // Group C: IV Rank filter
  for (const ivr of [30, 50]) {
    configs.push({
      label: `champ+ivRank${ivr}`,
      mechanism: 'regime_ivrank',
      params: { minIVRank: ivr },
      apply: (base) => ({ ...championBase(base), minIVRank: ivr }),
    });
  }

  // Group D: Combined filters — contango + VRP percentile
  for (const pct of [25, 40]) {
    configs.push({
      label: `champ+cPct${pct}+vrpPct${pct}`,
      mechanism: 'regime_combined',
      params: { contangoPctFilter: pct, vrpPctFilter: pct },
      apply: (base) => ({ ...championBase(base), contangoPctFilter: pct, vrpPctFilter: pct }),
    });
  }

  return configs;
}

// ── Phase 5: Trailing Lock Fine-Tune + Time Stop + EMA Exit (12 configs) ──

function buildPhase5Configs(): ConfigDef[] {
  const configs: ConfigDef[] = [];
  const NC = 999;

  // Trailing lock fine-tune around the winning 50/50 combo
  // Explore: different activation/floor ratios with the SL 2.5x champion
  for (const [act, floor] of [
    [0.30, 0.30], [0.40, 0.40], [0.60, 0.50], [0.60, 0.60],
    [0.40, 0.25], [0.70, 0.50],
  ] as [number, number][]) {
    configs.push({
      label: `nc+sl2.5x+tl${(act * 100).toFixed(0)}-${(floor * 100).toFixed(0)}`,
      mechanism: 'nc_sl_tl_fine',
      params: { creditStopLossMultiple: 2.5, trailingActivatePct: act, trailingFloorPct: floor, missingChainExitAfterDays: NC },
      apply: (base) => ({
        ...base, creditProfitTarget: 1.0, creditStopLossMultiple: 2.5,
        trailingActivatePct: act, trailingFloorPct: floor, missingChainExitAfterDays: NC,
      }),
    });
  }

  // Time stop variants on champion+TL combo
  for (const ts of [1, 2]) {
    configs.push({
      label: `nc+sl2.5x+tl50-50+ts${ts}`,
      mechanism: 'nc_sl_tl_ts',
      params: { creditStopLossMultiple: 2.5, trailingActivatePct: 0.50, trailingFloorPct: 0.50, creditTimeStopDTE: ts, missingChainExitAfterDays: NC },
      apply: (base) => ({
        ...base, creditProfitTarget: 1.0, creditStopLossMultiple: 2.5,
        trailingActivatePct: 0.50, trailingFloorPct: 0.50, creditTimeStopDTE: ts, missingChainExitAfterDays: NC,
      }),
    });
  }

  // Delta stop on top of trailing lock winner
  for (const ds of [0.70, 0.80]) {
    configs.push({
      label: `nc+sl2.5x+tl50-50+ds${(ds * 100).toFixed(0)}`,
      mechanism: 'nc_sl_tl_ds',
      params: { creditStopLossMultiple: 2.5, trailingActivatePct: 0.50, trailingFloorPct: 0.50, creditDeltaStop: ds, missingChainExitAfterDays: NC },
      apply: (base) => ({
        ...base, creditProfitTarget: 1.0, creditStopLossMultiple: 2.5,
        trailingActivatePct: 0.50, trailingFloorPct: 0.50, creditDeltaStop: ds, missingChainExitAfterDays: NC,
      }),
    });
  }

  return configs;
}

// ── Phase 7: Multi-Ticker/Direction Validation (12 configs: 6 combos × champion + baseline) ──

function buildPhase7Configs(): ConfigDef[] {
  const configs: ConfigDef[] = [];
  const NC = 999;

  const championApply = (base: SimConfig): SimConfig => ({
    ...base,
    creditProfitTarget: 1.0,
    creditStopLossMultiple: 2.5,
    trailingActivatePct: 0.50,
    trailingFloorPct: 0.50,
    missingChainExitAfterDays: NC,
  });

  const baselineApply = (base: SimConfig): SimConfig => ({
    ...base,
    creditProfitTarget: 1.0,
    creditStopLossMultiple: 100,
    missingChainExitAfterDays: NC,
  });

  // Champion + baseline for the current ticker/direction (filtered by CLI)
  configs.push({
    label: 'champion',
    mechanism: 'champion',
    params: { creditStopLossMultiple: 2.5, trailingActivatePct: 0.50, trailingFloorPct: 0.50 },
    apply: championApply,
  });

  configs.push({
    label: 'baseline_nc',
    mechanism: 'baseline_nc',
    params: { missingChainExitAfterDays: NC },
    apply: baselineApply,
  });

  return configs;
}

// ── Phase 8: EMA Gate & Stack Sweep ──────────────────────

interface EMAGate {
  label: string;
  direction: 'bull' | 'bear';
  stack: number[];  // EMAs in order — bull: close > ema[0] > ema[1] > ...; bear: close < ema[0] < ema[1] < ...
  proximityPct?: number;  // bear only: close must be within N% of ema[0]
}

const BULL_GATES: EMAGate[] = [
  { label: 'no_gate', direction: 'bull', stack: [] },
  { label: 'ema13', direction: 'bull', stack: [13] },
  { label: 'ema21', direction: 'bull', stack: [21] },
  { label: 'ema34', direction: 'bull', stack: [34] },
  { label: 'ema55', direction: 'bull', stack: [55] },
  { label: 'stack_8>21', direction: 'bull', stack: [8, 21] },
  { label: 'stack_21>34', direction: 'bull', stack: [21, 34] },
  { label: 'stack_8>21>34', direction: 'bull', stack: [8, 21, 34] },
  { label: 'stack_21>34>55', direction: 'bull', stack: [21, 34, 55] },
  { label: 'stack_8>21>34>55', direction: 'bull', stack: [8, 21, 34, 55] },
];

const BEAR_PROX: Record<string, number> = { QQQ: 0.01, SPY: 0.05, IWM: 0.03 };

const BEAR_GATES: EMAGate[] = [
  { label: 'bear_ema21', direction: 'bear', stack: [21] },
  { label: 'bear_ema34', direction: 'bear', stack: [34] },
  { label: 'bear_ema55', direction: 'bear', stack: [55] },
  { label: 'bear_21<34', direction: 'bear', stack: [21, 34] },
  { label: 'bear_34<55', direction: 'bear', stack: [34, 55] },
  { label: 'bear_21<34<55', direction: 'bear', stack: [21, 34, 55] },
  { label: 'bear_21<34<55_prox', direction: 'bear', stack: [21, 34, 55], proximityPct: -1 }, // -1 = use per-ticker
  { label: 'bear_8<21<34<55', direction: 'bear', stack: [8, 21, 34, 55] },
];

function generateSignalsForGate(
  td: TickerData,
  gate: EMAGate,
  ticker: string,
): EntrySignal[] {
  const signals: EntrySignal[] = [];
  const tickerCfg = DTE5_TICKER_CONFIGS[ticker as keyof typeof DTE5_TICKER_CONFIGS];
  const minIdx = 55; // need at least 55 bars for longest EMA

  for (let i = minIdx; i < td.candles.length; i++) {
    const c = td.candles[i];
    if (c.date < DTE5_PARAMS.startDate || c.date > DTE5_PARAMS.endDate) continue;
    const close = c.close;

    if (gate.direction === 'bull') {
      // Bull: close > ema[stack[0]] > ema[stack[1]] > ...
      const bullCfg = 'bull' in tickerCfg ? tickerCfg.bull : null;
      if (!bullCfg) continue;

      let pass = true;
      if (gate.stack.length === 0) {
        pass = true; // no_gate — every day
      } else {
        // close > first EMA
        const firstEma = td.emas.get(gate.stack[0]);
        if (!firstEma || firstEma[i] <= 0 || close <= firstEma[i]) { pass = false; }
        // Each EMA > next EMA
        if (pass) {
          for (let s = 0; s < gate.stack.length - 1; s++) {
            const emaA = td.emas.get(gate.stack[s])!;
            const emaB = td.emas.get(gate.stack[s + 1])!;
            if (emaA[i] <= emaB[i]) { pass = false; break; }
          }
        }
      }

      if (pass) {
        const regime = td.regimeByDate.get(c.date);
        signals.push({
          ticker, date: c.date, direction: 'CALL', score: 50,
          ivRank: td.ivRanks[i] ?? undefined,
          vrp: regime?.vrp, contango: regime?.contango,
          vrpPct: regime?.vrpPct, contangoPct: regime?.contangoPct,
          configuredDelta: bullCfg.delta,
          configuredLongDelta: bullCfg.longDelta,
        });
      }
    } else {
      // Bear: close < ema[stack[0]] < ema[stack[1]] < ...
      const bearCfg = 'bear' in tickerCfg ? tickerCfg.bear : null;
      if (!bearCfg) continue;

      let pass = true;
      const firstEma = td.emas.get(gate.stack[0]);
      if (!firstEma || firstEma[i] <= 0 || close >= firstEma[i]) { pass = false; }
      // Each EMA < next EMA (downtrend alignment)
      if (pass) {
        for (let s = 0; s < gate.stack.length - 1; s++) {
          const emaA = td.emas.get(gate.stack[s])!;
          const emaB = td.emas.get(gate.stack[s + 1])!;
          if (emaA[i] >= emaB[i]) { pass = false; break; }
        }
      }
      // Proximity check
      if (pass && gate.proximityPct != null) {
        const proxPct = gate.proximityPct === -1 ? (BEAR_PROX[ticker] ?? 0.03) : gate.proximityPct;
        const proxEmaVal = firstEma![i];
        const proxDist = Math.abs(close - proxEmaVal) / proxEmaVal;
        if (proxDist > proxPct) pass = false;
      }

      if (pass) {
        const regime = td.regimeByDate.get(c.date);
        signals.push({
          ticker, date: c.date, direction: 'PUT', score: 50,
          ivRank: td.ivRanks[i] ?? undefined,
          vrp: regime?.vrp, contango: regime?.contango,
          vrpPct: regime?.vrpPct, contangoPct: regime?.contangoPct,
          configuredDelta: bearCfg.delta,
          configuredLongDelta: bearCfg.longDelta,
        });
      }
    }
  }

  return signals;
}

function buildPhase3Configs(): ConfigDef[] {
  const configs: ConfigDef[] = [];
  const tp1Values = [0.25, 0.30, 0.50];
  const tp2Values = [0.50, 0.60, 0.70];
  const afterSLValues: [number, string][] = [[-1, 'none'], [0, 'be'], [0.25, 'lock25']];

  for (const tp1 of tp1Values) {
    for (const tp2 of tp2Values) {
      if (tp2 <= tp1) continue;
      for (const [afterSL, slLabel] of afterSLValues) {
        configs.push({
          label: `ph${(tp1 * 100).toFixed(0)}-${(tp2 * 100).toFixed(0)}_${slLabel}`,
          mechanism: 'phased_tp',
          params: { tp1, tp2, afterTP1SL: afterSL },
          apply: (base) => ({ ...base, creditProfitTarget: tp1, creditStopLossMultiple: 100 }),
          phasedConfig: { tp1, tp2, afterTP1SL: afterSL },
        });
      }
    }
  }
  return configs;
}

// ── Overfitting Grade ────────────────────────────────────

interface WindowEvalResult {
  windowIdx: number;
  trainSharpe: number;
  oosSharpe: number;
  oosWR: number;
  oosMaxDD: number;
  oosTradeCount: number;
}

function computeGrade(
  windowResults: WindowEvalResult[],
  minTrades: number,
  aggregateOOSSharpe: number,
): { grade: string; passCount: number; checks: boolean[] } {
  if (windowResults.length === 0) {
    return { grade: 'F', passCount: 0, checks: [false, false, false, false, false, false] };
  }
  const avgISS = windowResults.reduce((s, w) => s + w.trainSharpe, 0) / windowResults.length;
  const avgOOSS = windowResults.reduce((s, w) => s + w.oosSharpe, 0) / windowResults.length;
  const oosStdDev = Math.sqrt(
    windowResults.reduce((s, w) => s + (w.oosSharpe - avgOOSS) ** 2, 0) / windowResults.length,
  );
  const totalTrades = windowResults.reduce((s, w) => s + w.oosTradeCount, 0);
  const allPositive = windowResults.every(w => w.oosTradeCount > 0 && w.oosSharpe > 0);

  const checks = [
    avgISS > 0 && avgOOSS / avgISS >= 0.40,
    oosStdDev < 1.0,
    allPositive,
    totalTrades >= minTrades,
    avgISS < 5,
    aggregateOOSSharpe > 0.5,
  ];

  const passCount = checks.filter(Boolean).length;
  const grade = passCount === 6 ? 'A' : passCount === 5 ? 'B' : passCount === 4 ? 'C' : passCount >= 3 ? 'D' : 'F';
  return { grade, passCount, checks };
}

// ── Result Types ─────────────────────────────────────────

// ── Portfolio Growth Simulation ──────────────────────────

const RISK_PCT_PER_TRADE = 0.10;
const CONTRACT_CAP = 50;

interface PortfolioGrowthResult {
  startEquity: number;
  finalEquity: number;
  totalReturn: number;   // (final - start) / start
  cagr: number;          // annualized
  maxDD: number;         // peak-to-trough %
  minEquity: number;
  totalTrades: number;
  avgContracts: number;
  calendarDays: number;
}

function simulatePortfolioGrowth(trades: OptionTrade[], startingCapital: number): PortfolioGrowthResult {
  if (trades.length === 0) {
    return { startEquity: startingCapital, finalEquity: startingCapital, totalReturn: 0, cagr: 0, maxDD: 0, minEquity: startingCapital, totalTrades: 0, avgContracts: 0, calendarDays: 0 };
  }

  // Sort by entry date (trades are sequential with maxPositions=1)
  const sorted = [...trades].sort((a, b) => a.entryDate.localeCompare(b.entryDate));

  let equity = startingCapital;
  let peak = startingCapital;
  let maxDD = 0;
  let minEquity = startingCapital;
  let totalContracts = 0;

  for (const trade of sorted) {
    // Position sizing: risk 10% of current equity, capped at 50 contracts
    const riskBudget = equity * RISK_PCT_PER_TRADE;
    const maxLossPerContract = (trade.maxLoss ?? trade.spreadWidth ?? 10) * 100;
    const contracts = maxLossPerContract > 0
      ? Math.min(CONTRACT_CAP, Math.max(1, Math.floor(riskBudget / maxLossPerContract)))
      : 1;
    totalContracts += contracts;

    // Scale P&L by contracts (trade.pnl is per-contract P&L in $)
    const scaledPnl = trade.pnl * contracts;
    equity += scaledPnl;

    peak = Math.max(peak, equity);
    if (peak > 0) maxDD = Math.max(maxDD, (peak - equity) / peak);
    minEquity = Math.min(minEquity, equity);
  }

  const firstDate = new Date(sorted[0].entryDate);
  const lastDate = new Date(sorted[sorted.length - 1].exitDate);
  const calendarDays = Math.max(1, (lastDate.getTime() - firstDate.getTime()) / 86400000);
  const years = calendarDays / 365.25;
  const totalReturn = (equity - startingCapital) / startingCapital;
  const cagr = years > 0 ? (Math.pow(equity / startingCapital, 1 / years) - 1) : 0;

  return {
    startEquity: startingCapital,
    finalEquity: equity,
    totalReturn,
    cagr,
    maxDD,
    minEquity,
    totalTrades: sorted.length,
    avgContracts: totalContracts / sorted.length,
    calendarDays,
  };
}

interface DetailedMetrics {
  totalTrades: number;
  winners: number;
  losers: number;
  winRate: number;
  totalPnl: number;
  avgPnlPct: number;
  profitFactor: number;
  sharpe: number;
  maxDrawdown: number;
  avgHoldDays: number;
  avgEntryDelta: number;
  avgEntryDTE: number;
  avgCapitalPerTrade: number;
  totalCapitalDeployed: number;
  returnOnCapital: number;
  avgWinPnl: number;
  avgLossPnl: number;
  expectancy: number;
  byExit: Record<string, number>;
}

interface StudyResult {
  configLabel: string;
  mechanism: string;
  params: Record<string, number>;
  isSharpe: number;
  oosSharpe: number;
  holdoutSharpe: number;
  oosWinRate: number;
  oosMaxDD: number;
  oosTotalPnl: number;
  holdoutTotalPnl: number;
  wfEfficiency: number;
  grade: string;
  tradeCount: number;
  holdoutTradeCount: number;
  exitTypeBreakdown: Record<string, number>;
  windowDetails: WindowEvalResult[];
  oosDetailed: DetailedMetrics;
  holdoutDetailed: DetailedMetrics;
  oosGrowth: PortfolioGrowthResult;
  holdoutGrowth: PortfolioGrowthResult;
  // Optional per-config audit payload (2026-04-21). Populated on runs
  // that should be re-checkable against the autoresearch Phase 1/2
  // gate suite — daily returns feed N_eff / Mertens SE / bootstrap CI
  // / stat-consistency; per-trade data feeds sanity-edge. Old study
  // outputs predate these fields and won't carry them; the recheck
  // script treats their absence as "cannot check" rather than a
  // failure.
  oosDailyReturns?: number[];
  holdoutDailyReturns?: number[];
  oosTrades?: OptionTrade[];
  holdoutTrades?: OptionTrade[];
}

function buildDetailedMetrics(trades: OptionTrade[]): DetailedMetrics {
  const analytics = computeOptionAnalytics(trades);
  const winners = trades.filter(t => t.pnl > 0);
  const losers = trades.filter(t => t.pnl <= 0);
  const avgWinPnl = winners.length > 0 ? winners.reduce((s, t) => s + t.pnl, 0) / winners.length : 0;
  const avgLossPnl = losers.length > 0 ? losers.reduce((s, t) => s + t.pnl, 0) / losers.length : 0;
  const wr = trades.length > 0 ? winners.length / trades.length : 0;
  const expectancy = avgWinPnl * wr + avgLossPnl * (1 - wr);
  return {
    totalTrades: analytics.totalTrades,
    winners: analytics.winners,
    losers: analytics.losers,
    winRate: analytics.winRate,
    totalPnl: analytics.totalPnl,
    avgPnlPct: analytics.avgPnlPct,
    profitFactor: analytics.profitFactor,
    sharpe: analytics.sharpe,
    maxDrawdown: analytics.maxDrawdown,
    avgHoldDays: analytics.avgHoldDays,
    avgEntryDelta: analytics.avgEntryDelta,
    avgEntryDTE: analytics.avgEntryDTE,
    avgCapitalPerTrade: analytics.avgCapitalPerTrade,
    totalCapitalDeployed: analytics.totalCapitalDeployed,
    returnOnCapital: analytics.returnOnCapital,
    avgWinPnl,
    avgLossPnl,
    expectancy,
    byExit: analytics.byExit,
  };
}

// ── Worker Pool ──────────────────────────────────────────

let _workerBundleCached = false;
const _workerBundlePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.wfa-dte5-tp-sl-worker.mjs');

async function runConfigsViaWorkers(
  configs: ConfigDef[],
  signals: EntrySignal[],
  allTradingDates: string[],
  selectionWindows: Array<{ trainStart: string; trainEnd: string; oosStart: string; oosEnd: string }>,
  holdoutWindows: Array<{ trainStart: string; trainEnd: string; oosStart: string; oosEnd: string }>,
  maxWorkers?: number,
): Promise<StudyResult[]> {
  const numWorkers = Math.max(1, Math.min(maxWorkers ?? (os.cpus().length - 2), configs.length));
  if (numWorkers > 2) console.log(`\n  Spawning ${numWorkers} workers for ${configs.length} configs...`);

  const workerSrc = path.resolve(__dirname, 'wfa-dte5-tp-sl-worker.ts');
  const workerBundle = _workerBundlePath;
  if (!_workerBundleCached) {
    execSync(
      `npx esbuild ${workerSrc} --bundle --platform=node --format=esm --outfile=${workerBundle} --external:better-sqlite3 --packages=external`,
      { cwd: path.resolve(__dirname, '..'), stdio: 'pipe' },
    );
    _workerBundleCached = true;
  }

  const executionConfig: PortfolioExecutionConfig = {
    maxPositions: DTE5_PARAMS.maxPositions,
    maxPerTicker: DTE5_PARAMS.maxPerTicker,
    startingCapital: DTE5_PARAMS.startingCapital,
  };

  const workerInitData = {
    signals,
    allTradingDates,
    executionConfig,
    startingCapital: DTE5_PARAMS.startingCapital,
  };

  const workers = await Promise.all(
    Array.from({ length: numWorkers }, () =>
      new Promise<Worker>((resolve, reject) => {
        const w = new Worker(workerBundle, { workerData: workerInitData });
        w.once('message', (msg) => {
          if (msg?.type === 'ready') resolve(w);
          else reject(new Error('Worker failed to initialize'));
        });
        w.once('error', reject);
      }),
    ),
  );
  console.log(`  ${numWorkers} workers ready.`);

  // Build base SimConfig for DTE5
  const baseConfig: SimConfig = {
    ...DEFAULT_CREDIT_CONFIG,
    creditShortDelta: 0.30,
    creditSpreadWidth: 10,
    creditDTERange: [2, 7] as [number, number],
    creditProfitTarget: 1.0,
    creditStopLossMultiple: 100,
    creditTimeStopDTE: 0,
    minIVRank: 0,
    fillMode: 'mid',
    slippage: { ...DEFAULT_DYNAMIC_SLIPPAGE, enabled: false },
  };

  // Dispatch work items
  const workItems = configs.map((def, idx) => ({
    type: 'eval' as const,
    id: idx,
    configLabel: def.label,
    mechanism: def.mechanism,
    simConfig: def.apply(baseConfig),
    phasedConfig: def.phasedConfig,
    selectionWindows,
    holdoutWindows,
  }));

  interface WorkerResult {
    id: number;
    configLabel: string;
    mechanism: string;
    selectionResults: WindowEvalResult[];
    allOOSTrades: OptionTrade[];
    holdoutTrades: OptionTrade[];
    error?: string;
  }

  const workerResults: WorkerResult[] = new Array(workItems.length);
  let nextIdx = 0;
  let completed = 0;

  await new Promise<void>((resolve, reject) => {
    const onMessage = (worker: Worker) => (msg: any) => {
      if (!msg || msg.type !== 'result') return;
      workerResults[msg.id] = msg;
      completed++;
      process.stdout.write(`\r  Evaluating: ${completed}/${workItems.length} configs...`);

      if (completed === workItems.length) {
        process.stdout.write('\n');
        resolve();
        return;
      }
      const next = workItems[nextIdx++];
      if (next) worker.postMessage(next);
    };

    for (const worker of workers) {
      worker.on('message', onMessage(worker));
      worker.on('error', reject);
    }
    for (const worker of workers) {
      const next = workItems[nextIdx++];
      if (!next) break;
      worker.postMessage(next);
    }
  });

  // Terminate workers
  for (const w of workers) w.postMessage({ type: 'exit' });
  await new Promise(r => setTimeout(r, 100));
  await Promise.all(workers.map(w => w.terminate()));

  // Process results
  const selectionStart = selectionWindows[0]?.oosStart ?? DTE5_PARAMS.startDate;
  const selectionEnd = selectionWindows[selectionWindows.length - 1]?.oosEnd ?? DTE5_PARAMS.endDate;
  const holdoutStart = holdoutWindows[0]?.oosStart ?? DTE5_PARAMS.startDate;
  const holdoutEnd = holdoutWindows[holdoutWindows.length - 1]?.oosEnd ?? DTE5_PARAMS.endDate;

  const results: StudyResult[] = [];
  for (let ci = 0; ci < configs.length; ci++) {
    const def = configs[ci];
    const wr = workerResults[ci];
    if (!wr || wr.error) {
      console.error(`  ERROR: ${def.label}: ${wr?.error ?? 'no result'}`);
      continue;
    }

    const allOOSTrades = wr.allOOSTrades;
    const oosMetrics = computePortfolioDailyMetrics(
      allOOSTrades, allTradingDates, selectionStart, selectionEnd, DTE5_PARAMS.startingCapital,
    );
    const oosAnalytics = computeOptionAnalytics(allOOSTrades);
    const avgTrainSharpe = wr.selectionResults.length > 0
      ? wr.selectionResults.reduce((s, w) => s + w.trainSharpe, 0) / wr.selectionResults.length : 0;
    const wfEfficiency = avgTrainSharpe >= 0.1 ? oosMetrics.sharpe / avgTrainSharpe : 0;

    const holdoutMetrics = computePortfolioDailyMetrics(
      wr.holdoutTrades, allTradingDates, holdoutStart, holdoutEnd, DTE5_PARAMS.startingCapital,
    );

    const { grade } = computeGrade(
      wr.selectionResults,
      150, // min total OOS trades
      oosMetrics.sharpe,
    );

    const exitTypeBreakdown: Record<string, number> = {};
    for (const t of allOOSTrades) {
      exitTypeBreakdown[t.exitType] = (exitTypeBreakdown[t.exitType] ?? 0) + 1;
    }

    const oosDetailed = buildDetailedMetrics(allOOSTrades);
    const holdoutDetailed = buildDetailedMetrics(wr.holdoutTrades);
    const oosGrowth = simulatePortfolioGrowth(allOOSTrades, DTE5_PARAMS.startingCapital);
    const holdoutGrowth = simulatePortfolioGrowth(wr.holdoutTrades, DTE5_PARAMS.startingCapital);

    results.push({
      configLabel: def.label,
      mechanism: def.mechanism,
      params: def.params,
      isSharpe: avgTrainSharpe,
      oosSharpe: oosMetrics.sharpe,
      holdoutSharpe: holdoutMetrics.sharpe,
      oosWinRate: oosAnalytics.winRate,
      oosMaxDD: oosMetrics.maxDrawdownPct,
      oosTotalPnl: allOOSTrades.reduce((s, t) => s + t.pnl, 0),
      holdoutTotalPnl: wr.holdoutTrades.reduce((s, t) => s + t.pnl, 0),
      wfEfficiency,
      grade,
      tradeCount: allOOSTrades.length,
      holdoutTradeCount: wr.holdoutTrades.length,
      exitTypeBreakdown,
      windowDetails: wr.selectionResults,
      oosDetailed,
      holdoutDetailed,
      oosGrowth,
      holdoutGrowth,
      // Phase-1/2-gate audit payload. See StudyResult comment.
      oosDailyReturns: oosMetrics.dailyReturns,
      holdoutDailyReturns: holdoutMetrics.dailyReturns,
      oosTrades: allOOSTrades,
      holdoutTrades: wr.holdoutTrades,
    });
  }

  return results;
}

// ── Report Generation ────────────────────────────────────

function fmtPct(v: number, d = 1): string { return v.toFixed(d) + '%'; }
function fmtPnl(v: number): string { return v >= 0 ? `+$${(v / 1000).toFixed(1)}k` : `-$${(Math.abs(v) / 1000).toFixed(1)}k`; }

function printResults(results: StudyResult[], phaseLabel: string) {
  console.log(`\n${'═'.repeat(130)}`);
  console.log(`  DTE5 TP/SL STUDY — ${phaseLabel}`);
  console.log(`${'═'.repeat(130)}`);

  console.log('\n  ' +
    'Label'.padEnd(18) + 'Mechanism'.padEnd(16) +
    'IS'.padStart(8) + 'OOS'.padStart(8) + 'Hold'.padStart(8) +
    'WR%'.padStart(8) + 'MaxDD'.padStart(8) + 'Trades'.padStart(8) +
    'WFE'.padStart(8) + 'Grade'.padStart(7) +
    'PnL'.padStart(10) + 'vs Base'.padStart(9));
  console.log('  ' + '─'.repeat(126));

  const baseline = results.find(r => r.mechanism === 'baseline');
  const sorted = [...results].sort((a, b) => b.oosSharpe - a.oosSharpe);

  for (const r of sorted) {
    const isBaseline = r.mechanism === 'baseline';
    const delta = baseline ? (r.oosSharpe - baseline.oosSharpe).toFixed(2) : '—';
    const marker = isBaseline ? ' ◄' : '';
    console.log(
      '  ' + r.configLabel.padEnd(18) +
      r.mechanism.padEnd(16) +
      r.isSharpe.toFixed(2).padStart(8) +
      r.oosSharpe.toFixed(2).padStart(8) +
      r.holdoutSharpe.toFixed(2).padStart(8) +
      fmtPct(r.oosWinRate).padStart(8) +
      fmtPct(r.oosMaxDD).padStart(8) +
      String(r.tradeCount).padStart(8) +
      r.wfEfficiency.toFixed(2).padStart(8) +
      ('  ' + r.grade).padStart(7) +
      fmtPnl(r.oosTotalPnl).padStart(10) +
      (isBaseline ? '     —' : delta.padStart(9)) +
      marker,
    );
  }

  // Exit type breakdown for baseline vs best non-baseline
  const bestNonBaseline = sorted.find(r => r.mechanism !== 'baseline');
  if (baseline && bestNonBaseline) {
    console.log(`\n  EXIT TYPE COMPARISON`);
    console.log(`  ${'─'.repeat(80)}`);
    for (const [label, result] of [['Baseline', baseline], ['Best', bestNonBaseline]] as const) {
      console.log(`  ${label} (${result.configLabel}):`);
      for (const [et, count] of Object.entries(result.exitTypeBreakdown).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${et.padEnd(20)} ${String(count).padStart(4)} (${fmtPct(count / result.tradeCount * 100)})`);
      }
    }
  }

  // Per-mechanism best
  const mechanisms = [...new Set(results.map(r => r.mechanism))];
  console.log(`\n  PER-MECHANISM BEST`);
  console.log(`  ${'─'.repeat(100)}`);
  for (const mech of mechanisms) {
    const mechResults = results.filter(r => r.mechanism === mech);
    const best = mechResults.reduce((a, b) => a.oosSharpe > b.oosSharpe ? a : b);
    const delta = baseline ? ` (${(best.oosSharpe - baseline.oosSharpe) >= 0 ? '+' : ''}${(best.oosSharpe - baseline.oosSharpe).toFixed(2)} vs base)` : '';
    console.log(
      `  ${mech.padEnd(18)} ${best.configLabel.padEnd(18)} OOS ${best.oosSharpe.toFixed(2)} | Hold ${best.holdoutSharpe.toFixed(2)} | ` +
      `WR ${fmtPct(best.oosWinRate)} | Grade ${best.grade}${delta}`,
    );
  }

  // Detailed metrics table
  console.log(`\n${'═'.repeat(160)}`);
  console.log(`  DETAILED PERFORMANCE METRICS (OOS Period)`);
  console.log(`${'═'.repeat(160)}`);
  const hdr = '  ' +
    'Label'.padEnd(18) +
    'Trades'.padStart(7) + 'W'.padStart(5) + 'L'.padStart(5) +
    'WR%'.padStart(7) +
    'Total PnL'.padStart(11) +
    'Avg%'.padStart(8) +
    'PF'.padStart(7) +
    'Sharpe'.padStart(8) +
    'MaxDD%'.padStart(8) +
    'AvgWin$'.padStart(9) +
    'AvgLoss$'.padStart(10) +
    'Expect$'.padStart(9) +
    'AvgDelta'.padStart(9) +
    'AvgDTE'.padStart(7) +
    'AvgDays'.padStart(8) +
    'ROC%'.padStart(8);
  console.log(hdr);
  console.log('  ' + '─'.repeat(156));
  for (const r of sorted) {
    const d = r.oosDetailed;
    const marker = r.mechanism === 'baseline' ? ' ◄' : '';
    console.log('  ' +
      r.configLabel.padEnd(18) +
      String(d.totalTrades).padStart(7) +
      String(d.winners).padStart(5) +
      String(d.losers).padStart(5) +
      fmtPct(d.winRate).padStart(7) +
      (`${d.totalPnl >= 0 ? '+' : ''}$${Math.abs(d.totalPnl).toFixed(0)}`).padStart(11) +
      fmtPct(d.avgPnlPct).padStart(8) +
      d.profitFactor.toFixed(2).padStart(7) +
      d.sharpe.toFixed(2).padStart(8) +
      fmtPct(d.maxDrawdown * 100).padStart(8) +
      (`$${d.avgWinPnl.toFixed(0)}`).padStart(9) +
      (`-$${Math.abs(d.avgLossPnl).toFixed(0)}`).padStart(10) +
      (`$${d.expectancy.toFixed(0)}`).padStart(9) +
      d.avgEntryDelta.toFixed(2).padStart(9) +
      d.avgEntryDTE.toFixed(1).padStart(7) +
      d.avgHoldDays.toFixed(1).padStart(8) +
      fmtPct(d.returnOnCapital).padStart(8) +
      marker,
    );
  }

  // Holdout detailed
  console.log(`\n${'═'.repeat(160)}`);
  console.log(`  DETAILED PERFORMANCE METRICS (Holdout Period)`);
  console.log(`${'═'.repeat(160)}`);
  console.log(hdr);
  console.log('  ' + '─'.repeat(156));
  for (const r of sorted) {
    const d = r.holdoutDetailed;
    if (d.totalTrades === 0) {
      console.log('  ' + r.configLabel.padEnd(18) + '(no trades)');
      continue;
    }
    const marker = r.mechanism === 'baseline' ? ' ◄' : '';
    console.log('  ' +
      r.configLabel.padEnd(18) +
      String(d.totalTrades).padStart(7) +
      String(d.winners).padStart(5) +
      String(d.losers).padStart(5) +
      fmtPct(d.winRate).padStart(7) +
      (`${d.totalPnl >= 0 ? '+' : ''}$${Math.abs(d.totalPnl).toFixed(0)}`).padStart(11) +
      fmtPct(d.avgPnlPct).padStart(8) +
      d.profitFactor.toFixed(2).padStart(7) +
      d.sharpe.toFixed(2).padStart(8) +
      fmtPct(d.maxDrawdown * 100).padStart(8) +
      (`$${d.avgWinPnl.toFixed(0)}`).padStart(9) +
      (`-$${Math.abs(d.avgLossPnl).toFixed(0)}`).padStart(10) +
      (`$${d.expectancy.toFixed(0)}`).padStart(9) +
      d.avgEntryDelta.toFixed(2).padStart(9) +
      d.avgEntryDTE.toFixed(1).padStart(7) +
      d.avgHoldDays.toFixed(1).padStart(8) +
      fmtPct(d.returnOnCapital).padStart(8) +
      marker,
    );
  }

  // Portfolio Growth table
  function fmtDollar(v: number): string {
    if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
    if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(1)}k`;
    return `$${v.toFixed(0)}`;
  }

  console.log(`\n${'═'.repeat(160)}`);
  console.log(`  PORTFOLIO GROWTH SIMULATION (OOS — $10K start, 10% risk/trade, 50-contract cap)`);
  console.log(`${'═'.repeat(160)}`);
  const gHdr = '  ' +
    'Label'.padEnd(18) +
    'Final$'.padStart(12) +
    'Return'.padStart(9) +
    'CAGR'.padStart(8) +
    'MaxDD'.padStart(8) +
    'MinEq'.padStart(10) +
    'AvgCts'.padStart(8) +
    'Trades'.padStart(8) +
    '  │' +
    'Flat PnL'.padStart(11) +
    'Flat ROC%'.padStart(10);
  console.log(gHdr);
  console.log('  ' + '─'.repeat(118));
  for (const r of sorted) {
    const g = r.oosGrowth;
    const marker = r.mechanism === 'baseline' ? ' ◄' : '';
    console.log('  ' +
      r.configLabel.padEnd(18) +
      fmtDollar(g.finalEquity).padStart(12) +
      fmtPct(g.totalReturn * 100).padStart(9) +
      fmtPct(g.cagr * 100).padStart(8) +
      fmtPct(g.maxDD * 100).padStart(8) +
      fmtDollar(g.minEquity).padStart(10) +
      g.avgContracts.toFixed(1).padStart(8) +
      String(g.totalTrades).padStart(8) +
      '  │' +
      fmtPnl(r.oosTotalPnl).padStart(11) +
      fmtPct(r.oosDetailed.returnOnCapital).padStart(10) +
      marker,
    );
  }

  console.log(`\n${'═'.repeat(160)}`);
  console.log(`  PORTFOLIO GROWTH SIMULATION (Holdout — $10K start, 10% risk/trade, 50-contract cap)`);
  console.log(`${'═'.repeat(160)}`);
  console.log(gHdr);
  console.log('  ' + '─'.repeat(118));
  for (const r of sorted) {
    const g = r.holdoutGrowth;
    if (g.totalTrades === 0) {
      console.log('  ' + r.configLabel.padEnd(18) + '(no trades)');
      continue;
    }
    const marker = r.mechanism === 'baseline' ? ' ◄' : '';
    console.log('  ' +
      r.configLabel.padEnd(18) +
      fmtDollar(g.finalEquity).padStart(12) +
      fmtPct(g.totalReturn * 100).padStart(9) +
      fmtPct(g.cagr * 100).padStart(8) +
      fmtPct(g.maxDD * 100).padStart(8) +
      fmtDollar(g.minEquity).padStart(10) +
      g.avgContracts.toFixed(1).padStart(8) +
      String(g.totalTrades).padStart(8) +
      '  │' +
      fmtPnl(r.holdoutTotalPnl).padStart(11) +
      fmtPct(r.holdoutDetailed.returnOnCapital).padStart(10) +
      marker,
    );
  }
}

function generateMarkdownReport(phase1Results: StudyResult[], phase3Results: StudyResult[]): string {
  const lines: string[] = [];
  lines.push('# DTE5 TP/SL Walk-Forward Analysis Study');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString().split('T')[0]}`);
  lines.push('');
  lines.push('## Study Design');
  lines.push('');
  lines.push(`- **Strategy**: DTE5 Bull Put (QQQ) + Bear Call (QQQ/SPY/IWM)`);
  lines.push(`- **Baseline**: Hold-to-expiry (TP=1.0, SL=off)`);
  lines.push(`- **Config**: sp30/20, DTE [2,7], EMA34 gate, maxPos=1`);
  lines.push(`- **WFA**: ${DTE5_PARAMS.trainWindowDays}d train / ${DTE5_PARAMS.forwardStepDays}d test, purge ${DTE5_PARAMS.purgeGapDays}d, ${DTE5_PARAMS.holdoutCount} holdout`);
  lines.push(`- **Capital**: $${DTE5_PARAMS.startingCapital.toLocaleString()}`);
  lines.push('');

  // Phase 1 table
  if (phase1Results.length > 0) {
    const baseline = phase1Results.find(r => r.mechanism === 'baseline');

    lines.push('## Phase 1: Isolated Mechanism Results');
    lines.push('');
    lines.push('| Label | Mechanism | IS | OOS | Holdout | WR% | MaxDD | Trades | WFE | Grade | vs Base |');
    lines.push('|-------|-----------|-----|-----|---------|-----|-------|--------|-----|-------|---------|');

    const sorted = [...phase1Results].sort((a, b) => b.oosSharpe - a.oosSharpe);
    for (const r of sorted) {
      const delta = baseline ? `${(r.oosSharpe - baseline.oosSharpe) >= 0 ? '+' : ''}${(r.oosSharpe - baseline.oosSharpe).toFixed(2)}` : '—';
      const marker = r.mechanism === 'baseline' ? ' **◄**' : '';
      lines.push(`| ${r.configLabel}${marker} | ${r.mechanism} | ${r.isSharpe.toFixed(2)} | ${r.oosSharpe.toFixed(2)} | ${r.holdoutSharpe.toFixed(2)} | ${fmtPct(r.oosWinRate)} | ${fmtPct(r.oosMaxDD)} | ${r.tradeCount} | ${r.wfEfficiency.toFixed(2)} | ${r.grade} | ${delta} |`);
    }
    lines.push('');

    // Sub-tables by mechanism
    for (const mech of ['profit_target', 'credit_multiple', 'delta_stop', 'max_loss_pct', 'trailing_lock']) {
      const mechResults = phase1Results.filter(r => r.mechanism === mech);
      if (mechResults.length === 0) continue;
      lines.push(`### ${mech.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}`);
      lines.push('');
      const best = mechResults.reduce((a, b) => a.oosSharpe > b.oosSharpe ? a : b);
      const delta = baseline ? ` (${(best.oosSharpe - baseline.oosSharpe) >= 0 ? '+' : ''}${(best.oosSharpe - baseline.oosSharpe).toFixed(2)} vs baseline)` : '';
      lines.push(`**Best**: \`${best.configLabel}\` — OOS ${best.oosSharpe.toFixed(2)}, Holdout ${best.holdoutSharpe.toFixed(2)}${delta}`);
      lines.push('');
    }
  }

  // Phase 3 table
  if (phase3Results.length > 0) {
    lines.push('## Phase 3: Phased TP Results');
    lines.push('');
    lines.push('| Label | TP1 | TP2 | After SL | OOS | Holdout | WR% | Trades | Grade |');
    lines.push('|-------|-----|-----|----------|-----|---------|-----|--------|-------|');
    const sorted = [...phase3Results].sort((a, b) => b.oosSharpe - a.oosSharpe);
    for (const r of sorted) {
      lines.push(`| ${r.configLabel} | ${r.params.tp1} | ${r.params.tp2} | ${r.params.afterTP1SL} | ${r.oosSharpe.toFixed(2)} | ${r.holdoutSharpe.toFixed(2)} | ${fmtPct(r.oosWinRate)} | ${r.tradeCount} | ${r.grade} |`);
    }
    lines.push('');
  }

  lines.push('## Caveats');
  lines.push('');
  lines.push('1. Backtest period (2020-2026) is predominantly bullish');
  lines.push('2. Fill model uses mid (no explicit slippage) — real fills may differ');
  lines.push('3. EMA34 gate effectiveness depends on trend structure of test period');
  lines.push('4. Bear signals are rare (~3-20/yr) — insufficient for standalone conclusions');
  lines.push('');

  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const phaseArg = args.find((_, i, a) => a[i - 1] === '--phase') ?? 'all';
  const baselineOnly = args.includes('--baseline-only');
  const runPhase1 = phaseArg === '1' || phaseArg === 'all';
  const runPhase2A = phaseArg === '2a' || phaseArg === 'all';
  const runPhase2B = phaseArg === '2b' || phaseArg === 'all';
  const runPhase3 = phaseArg === '3' || phaseArg === 'all';
  const runPhase3R = phaseArg === '3r' || phaseArg === 'all';
  const runPhase4 = phaseArg === '4' || phaseArg === 'all';
  const runPhase5 = phaseArg === '5' || phaseArg === 'all';
  const runPhase7 = phaseArg === '7';
  const runPhase8 = phaseArg === '8';
  const tickerFilter = args.find((_, i, a) => a[i - 1] === '--ticker') ?? null;
  const dirFilter = args.find((_, i, a) => a[i - 1] === '--direction') ?? null;

  console.log('╔══════════════════════════════════════════════════════════════════════════╗');
  console.log('║  DTE5 TP/SL Walk-Forward Analysis Study                                ║');
  console.log('║  Baseline: hold-to-expiry | QQQ bull + QQQ/SPY/IWM bear                ║');
  console.log(`║  Phase: ${phaseArg.padEnd(10)} ${baselineOnly ? '(baseline only)' : ''}                                              ║`);
  console.log('╚══════════════════════════════════════════════════════════════════════════╝');

  // Load data
  console.log('\n  Loading ticker data...');
  const tickerDataMap = new Map<string, TickerData>();
  const allDatesSet = new Set<string>();

  for (const ticker of DTE5_TICKERS) {
    const td = await fetchTickerData(ticker);
    tickerDataMap.set(ticker, td);
    for (const c of td.candles) {
      if (c.date >= DTE5_PARAMS.startDate && c.date <= DTE5_PARAMS.endDate) {
        allDatesSet.add(c.date);
      }
    }
    process.stdout.write(`  ${ticker}(${td.candles.length}) `);
  }
  console.log('done.');

  const allTradingDates = [...allDatesSet].sort();
  console.log(`  Trading dates: ${allTradingDates.length}`);

  // Generate DTE5 signals
  // Phase 7 uses all tickers/directions; other phases use QQQ bull only (validated)
  const bullOnly = !runPhase7;
  console.log(`\n  Generating DTE5 signals (${bullOnly ? 'QQQ bull EMA34 only' : 'all tickers/directions'})...`);
  let signals = generateDTE5Signals(tickerDataMap, bullOnly);

  // Apply CLI ticker/direction filters (for Phase 7 per-combo runs)
  if (tickerFilter) {
    signals = signals.filter(s => s.ticker === tickerFilter.toUpperCase());
    console.log(`  Filtered to ticker: ${tickerFilter.toUpperCase()}`);
  }
  if (dirFilter) {
    const dirValue = dirFilter.toLowerCase() === 'bull' ? 'CALL' : 'PUT';
    signals = signals.filter(s => s.direction === dirValue);
    console.log(`  Filtered to direction: ${dirFilter} (${dirValue})`);
  }
  const bullCount = signals.filter(s => s.direction === 'CALL').length;
  const bearCount = signals.filter(s => s.direction === 'PUT').length;
  console.log(`  ${signals.length} signals (${bullCount} bull, ${bearCount} bear)`);

  // Build WFA windows
  const allWindows = buildWFAWindows(allTradingDates, {
    trainWindowDays: DTE5_PARAMS.trainWindowDays,
    forwardStepDays: DTE5_PARAMS.forwardStepDays,
    purgeGapDays: DTE5_PARAMS.purgeGapDays,
    mode: DTE5_PARAMS.mode,
    startDate: DTE5_PARAMS.startDate,
    endDate: DTE5_PARAMS.endDate,
  });

  const selectionWindows = allWindows.slice(0, -DTE5_PARAMS.holdoutCount);
  const holdoutWindows = allWindows.slice(-DTE5_PARAMS.holdoutCount);

  console.log(`\n  WFA: ${allWindows.length} windows (${selectionWindows.length} selection + ${holdoutWindows.length} holdout)`);
  for (const w of allWindows) {
    console.log(`    Train ${w.trainStart}→${w.trainEnd} | OOS ${w.oosStart}→${w.oosEnd}`);
  }

  // Run phases
  let phase1Results: StudyResult[] = [];
  let phase3Results: StudyResult[] = [];

  if (runPhase1) {
    const configs = baselineOnly
      ? buildPhase1Configs().filter(c => c.mechanism === 'baseline')
      : buildPhase1Configs();

    console.log(`\n  Phase 1: ${configs.length} configs`);
    phase1Results = await runConfigsViaWorkers(configs, signals, allTradingDates, selectionWindows, holdoutWindows);
    printResults(phase1Results, 'PHASE 1 — Isolated Mechanisms');

    // Save JSON
    const outDir = path.resolve(__dirname, '../backtesting history/credit-spread/reports/dte5-tp-sl-study');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'phase1-results.json'), JSON.stringify(phase1Results, null, 2));
    console.log(`\n  Phase 1 saved to ${outDir}/phase1-results.json`);
  }

  if (runPhase3) {
    const configs = buildPhase3Configs();
    console.log(`\n  Phase 3: ${configs.length} phased TP configs`);
    phase3Results = await runConfigsViaWorkers(configs, signals, allTradingDates, selectionWindows, holdoutWindows);
    printResults(phase3Results, 'PHASE 3 — Phased TP');

    const outDir = path.resolve(__dirname, '../backtesting history/credit-spread/reports/dte5-tp-sl-study');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'phase3-results.json'), JSON.stringify(phase3Results, null, 2));
    console.log(`\n  Phase 3 saved to ${outDir}/phase3-results.json`);
  }

  // Phase 2A: Holdout Diagnostic & Multi-Mechanism Combos
  let phase2AResults: StudyResult[] = [];
  if (runPhase2A) {
    const configs = buildPhase2AConfigs();
    console.log(`\n  Phase 2A: ${configs.length} holdout diagnostic + combo configs`);
    phase2AResults = await runConfigsViaWorkers(configs, signals, allTradingDates, selectionWindows, holdoutWindows);
    printResults(phase2AResults, 'PHASE 2A — Holdout Diagnostic & Multi-Mechanism Combos');

    const outDir = path.resolve(__dirname, '../backtesting history/credit-spread/reports/dte5-tp-sl-study');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'phase2a-results.json'), JSON.stringify(phase2AResults, null, 2));
    console.log(`\n  Phase 2A saved to ${outDir}/phase2a-results.json`);
  }

  // Phase 2B: SL Parameter Refinement
  let phase2BResults: StudyResult[] = [];
  if (runPhase2B) {
    const configs = buildPhase2BConfigs();
    console.log(`\n  Phase 2B: ${configs.length} SL refinement configs`);
    phase2BResults = await runConfigsViaWorkers(configs, signals, allTradingDates, selectionWindows, holdoutWindows);
    printResults(phase2BResults, 'PHASE 2B — SL Parameter Refinement');

    const outDir = path.resolve(__dirname, '../backtesting history/credit-spread/reports/dte5-tp-sl-study');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'phase2b-results.json'), JSON.stringify(phase2BResults, null, 2));
    console.log(`\n  Phase 2B saved to ${outDir}/phase2b-results.json`);
  }

  // Phase 3R: Phased TP Re-run with nc+ fix
  let phase3RResults: StudyResult[] = [];
  if (runPhase3R) {
    const configs = buildPhase3RConfigs();
    console.log(`\n  Phase 3R: ${configs.length} phased TP configs (with nc+ fix)`);
    phase3RResults = await runConfigsViaWorkers(configs, signals, allTradingDates, selectionWindows, holdoutWindows);
    printResults(phase3RResults, 'PHASE 3R — Phased TP Re-run (nc+ fix)');

    const outDir = path.resolve(__dirname, '../backtesting history/credit-spread/reports/dte5-tp-sl-study');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'phase3r-results.json'), JSON.stringify(phase3RResults, null, 2));
    console.log(`\n  Phase 3R saved to ${outDir}/phase3r-results.json`);
  }

  // Phase 4: Entry-Level Regime Filters
  let phase4Results: StudyResult[] = [];
  if (runPhase4) {
    const configs = buildPhase4Configs();
    console.log(`\n  Phase 4: ${configs.length} regime filter configs`);

    // Log regime data coverage for QQQ
    const qqq = tickerDataMap.get('QQQ');
    if (qqq) {
      let hasContango = 0, hasVrp = 0, total = 0;
      for (const [date, rd] of qqq.regimeByDate) {
        if (date >= DTE5_PARAMS.startDate && date <= DTE5_PARAMS.endDate) {
          total++;
          if (rd.contango != null) hasContango++;
          if (rd.vrp != null) hasVrp++;
        }
      }
      console.log(`  QQQ regime data coverage: ${hasContango}/${total} contango, ${hasVrp}/${total} VRP`);

      // Log how many signals have regime data
      let sigWithContango = 0, sigWithVrp = 0, sigWithContangoPct = 0;
      for (const s of signals) {
        if (s.contango != null) sigWithContango++;
        if (s.vrp != null) sigWithVrp++;
        if (s.contangoPct != null) sigWithContangoPct++;
      }
      console.log(`  Signals with regime data: ${sigWithContango}/${signals.length} contango, ${sigWithVrp}/${signals.length} VRP, ${sigWithContangoPct}/${signals.length} contangoPct`);
    }

    phase4Results = await runConfigsViaWorkers(configs, signals, allTradingDates, selectionWindows, holdoutWindows);
    printResults(phase4Results, 'PHASE 4 — Entry-Level Regime Filters');

    const outDir = path.resolve(__dirname, '../backtesting history/credit-spread/reports/dte5-tp-sl-study');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'phase4-results.json'), JSON.stringify(phase4Results, null, 2));
    console.log(`\n  Phase 4 saved to ${outDir}/phase4-results.json`);
  }

  // Phase 5: Trailing Lock Fine-Tune + Time Stop + EMA Exit
  let phase5Results: StudyResult[] = [];
  if (runPhase5) {
    const configs = buildPhase5Configs();
    console.log(`\n  Phase 5: ${configs.length} trailing lock fine-tune + combo configs`);
    phase5Results = await runConfigsViaWorkers(configs, signals, allTradingDates, selectionWindows, holdoutWindows);
    printResults(phase5Results, 'PHASE 5 — Trailing Lock Fine-Tune + Combos');

    const outDir = path.resolve(__dirname, '../backtesting history/credit-spread/reports/dte5-tp-sl-study');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'phase5-results.json'), JSON.stringify(phase5Results, null, 2));
    console.log(`\n  Phase 5 saved to ${outDir}/phase5-results.json`);
  }

  // Phase 7: Multi-Ticker/Direction Validation
  let phase7Results: StudyResult[] = [];
  if (runPhase7) {
    if (!tickerFilter || !dirFilter) {
      console.error('  ERROR: Phase 7 requires --ticker and --direction flags');
      console.error('  Usage: npx tsx scripts/wfa-dte5-tp-sl-study.ts --phase 7 --ticker QQQ --direction bull');
      process.exit(1);
    }
    const configs = buildPhase7Configs();
    const comboLabel = `${tickerFilter.toUpperCase()}-${dirFilter}`;
    console.log(`\n  Phase 7: ${comboLabel} — ${configs.length} configs (champion + baseline)`);
    console.log(`  Signals available: ${signals.length}`);
    phase7Results = await runConfigsViaWorkers(configs, signals, allTradingDates, selectionWindows, holdoutWindows);
    printResults(phase7Results, `PHASE 7 — ${comboLabel}`);

    const outDir = path.resolve(__dirname, '../backtesting history/credit-spread/reports/dte5-tp-sl-study');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = `phase7-${comboLabel.toLowerCase()}.json`;
    fs.writeFileSync(path.join(outDir, outFile), JSON.stringify(phase7Results, null, 2));
    console.log(`\n  Phase 7 saved to ${outDir}/${outFile}`);
  }

  // Phase 8: EMA Gate & Stack Sweep
  if (runPhase8) {
    console.log('\n  Phase 8: EMA Gate & Stack Sweep');
    console.log(`  Bull gates: ${BULL_GATES.length} | Bear gates: ${BEAR_GATES.length} | Tickers: QQQ, SPY, IWM`);

    const tickers = ['QQQ', 'SPY', 'IWM'];
    const allGates = [...BULL_GATES, ...BEAR_GATES];

    interface Phase8Row {
      gate: string;
      ticker: string;
      direction: string;
      signals: number;
      champion: StudyResult | null;
      baseline: StudyResult | null;
    }
    const phase8Rows: Phase8Row[] = [];
    let batchIdx = 0;
    const totalBatches = allGates.length * tickers.length;

    // Build ALL work items with per-combo signal overrides, then dispatch
    // to a SINGLE persistent worker pool — avoids SQLite SIGSEGV from
    // repeated worker creation/destruction.
    interface P8ConfigDef extends ConfigDef {
      _gate: string;
      _ticker: string;
      _direction: string;
      _signals: EntrySignal[];
    }
    const allP8Configs: P8ConfigDef[] = [];
    const NC = 999;

    for (const gate of allGates) {
      for (const ticker of tickers) {
        batchIdx++;
        const sigs = generateSignalsForGate(tickerDataMap.get(ticker)!, gate, ticker);
        process.stdout.write(`  [${batchIdx}/${totalBatches}] ${gate.label} ${ticker} (${gate.direction}) — ${sigs.length} sigs\n`);

        if (sigs.length < 10) {
          phase8Rows.push({ gate: gate.label, ticker, direction: gate.direction, signals: sigs.length, champion: null, baseline: null });
          continue;
        }

        allP8Configs.push({
          label: `champ|${gate.label}|${ticker}`,
          mechanism: 'champion',
          params: {},
          apply: (base) => ({ ...base, creditProfitTarget: 1.0, creditStopLossMultiple: 2.5,
            trailingActivatePct: 0.50, trailingFloorPct: 0.50, missingChainExitAfterDays: NC }),
          _gate: gate.label, _ticker: ticker, _direction: gate.direction, _signals: sigs,
        });
        allP8Configs.push({
          label: `base|${gate.label}|${ticker}`,
          mechanism: 'baseline_nc',
          params: {},
          apply: (base) => ({ ...base, creditProfitTarget: 1.0, creditStopLossMultiple: 100,
            missingChainExitAfterDays: NC }),
          _gate: gate.label, _ticker: ticker, _direction: gate.direction, _signals: sigs,
        });
      }
    }

    console.log(`\n  Dispatching ${allP8Configs.length} configs to worker pool...`);

    // Use a custom dispatch that passes overrideSignals per work item
    const workerSrc = path.resolve(__dirname, 'wfa-dte5-tp-sl-worker.ts');
    const workerBundle = _workerBundlePath;
    if (!_workerBundleCached) {
      execSync(
        `npx esbuild ${workerSrc} --bundle --platform=node --format=esm --outfile=${workerBundle} --external:better-sqlite3 --packages=external`,
        { cwd: path.resolve(__dirname, '..'), stdio: 'pipe' },
      );
      _workerBundleCached = true;
    }

    const executionConfig: PortfolioExecutionConfig = {
      maxPositions: DTE5_PARAMS.maxPositions,
      maxPerTicker: DTE5_PARAMS.maxPerTicker,
      startingCapital: DTE5_PARAMS.startingCapital,
    };

    // Single pool with empty initial signals — each work item carries its own
    const numWorkers = Math.max(1, Math.min(os.cpus().length - 2, allP8Configs.length));
    console.log(`  Spawning ${numWorkers} workers...`);
    const p8Workers = await Promise.all(
      Array.from({ length: numWorkers }, () =>
        new Promise<Worker>((resolve, reject) => {
          const w = new Worker(workerBundle, {
            workerData: { signals: [], allTradingDates, executionConfig, startingCapital: DTE5_PARAMS.startingCapital },
          });
          w.once('message', (msg) => msg?.type === 'ready' ? resolve(w) : reject(new Error('Worker init failed')));
          w.once('error', reject);
        }),
      ),
    );
    console.log(`  ${numWorkers} workers ready.`);

    const baseConfig: SimConfig = {
      ...DEFAULT_CREDIT_CONFIG,
      creditShortDelta: 0.30,
      creditSpreadWidth: 10,
      creditDTERange: [2, 7] as [number, number],
      creditProfitTarget: 1.0,
      creditStopLossMultiple: 100,
      creditTimeStopDTE: 0,
      minIVRank: 0,
      fillMode: 'mid',
      slippage: { ...DEFAULT_DYNAMIC_SLIPPAGE, enabled: false },
    };

    const p8WorkItems = allP8Configs.map((def, idx) => ({
      type: 'eval' as const,
      id: idx,
      configLabel: def.label,
      mechanism: def.mechanism,
      simConfig: def.apply(baseConfig),
      selectionWindows,
      holdoutWindows,
      overrideSignals: def._signals,
    }));

    interface P8WorkerResult {
      id: number;
      configLabel: string;
      mechanism: string;
      selectionResults: any[];
      allOOSTrades: any[];
      holdoutTrades: any[];
      error?: string;
    }

    const p8WorkerResults: P8WorkerResult[] = new Array(p8WorkItems.length);
    let p8NextIdx = 0;
    let p8Completed = 0;

    await new Promise<void>((resolve, reject) => {
      const onMessage = (worker: Worker) => (msg: any) => {
        if (!msg || msg.type !== 'result') return;
        p8WorkerResults[msg.id] = msg;
        p8Completed++;
        process.stdout.write(`\r  Evaluating: ${p8Completed}/${p8WorkItems.length} configs...`);
        if (p8Completed === p8WorkItems.length) { process.stdout.write('\n'); resolve(); return; }
        const next = p8WorkItems[p8NextIdx++];
        if (next) worker.postMessage(next);
      };
      for (const worker of p8Workers) { worker.on('message', onMessage(worker)); worker.on('error', reject); }
      for (const worker of p8Workers) { const next = p8WorkItems[p8NextIdx++]; if (!next) break; worker.postMessage(next); }
    });

    // Terminate workers
    for (const w of p8Workers) w.postMessage({ type: 'exit' });
    await new Promise(r => setTimeout(r, 200));
    await Promise.all(p8Workers.map(w => w.terminate()));

    // Process results into phase8Rows
    const selStart = selectionWindows[0]?.oosStart ?? DTE5_PARAMS.startDate;
    const selEnd = selectionWindows[selectionWindows.length - 1]?.oosEnd ?? DTE5_PARAMS.endDate;
    const holdStart = holdoutWindows[0]?.oosStart ?? DTE5_PARAMS.startDate;
    const holdEnd = holdoutWindows[holdoutWindows.length - 1]?.oosEnd ?? DTE5_PARAMS.endDate;

    // Group results by gate×ticker
    const grouped = new Map<string, { champion?: StudyResult; baseline?: StudyResult }>();
    for (let ci = 0; ci < allP8Configs.length; ci++) {
      const def = allP8Configs[ci];
      const wr = p8WorkerResults[ci];
      if (!wr || wr.error) continue;

      const oosMetrics = computePortfolioDailyMetrics(wr.allOOSTrades, allTradingDates, selStart, selEnd, DTE5_PARAMS.startingCapital);
      const holdMetrics = computePortfolioDailyMetrics(wr.holdoutTrades, allTradingDates, holdStart, holdEnd, DTE5_PARAMS.startingCapital);
      const oosAnalytics = computeOptionAnalytics(wr.allOOSTrades);
      const avgTrainSharpe = wr.selectionResults.length > 0
        ? wr.selectionResults.reduce((s: number, w: any) => s + w.trainSharpe, 0) / wr.selectionResults.length : 0;
      const wfEfficiency = avgTrainSharpe >= 0.1 ? oosMetrics.sharpe / avgTrainSharpe : 0;
      const { grade } = computeGrade(wr.selectionResults, 150, oosMetrics.sharpe);
      const exitTypeBreakdown: Record<string, number> = {};
      for (const t of wr.allOOSTrades) exitTypeBreakdown[t.exitType] = (exitTypeBreakdown[t.exitType] ?? 0) + 1;

      const result: StudyResult = {
        configLabel: def.label, mechanism: def.mechanism, params: def.params,
        isSharpe: avgTrainSharpe, oosSharpe: oosMetrics.sharpe, holdoutSharpe: holdMetrics.sharpe,
        oosWinRate: oosAnalytics.winRate, oosMaxDD: oosMetrics.maxDrawdownPct,
        oosTotalPnl: wr.allOOSTrades.reduce((s: number, t: any) => s + t.pnl, 0),
        holdoutTotalPnl: wr.holdoutTrades.reduce((s: number, t: any) => s + t.pnl, 0),
        wfEfficiency, grade, tradeCount: wr.allOOSTrades.length, holdoutTradeCount: wr.holdoutTrades.length,
        exitTypeBreakdown, windowDetails: wr.selectionResults,
        oosDetailed: buildDetailedMetrics(wr.allOOSTrades), holdoutDetailed: buildDetailedMetrics(wr.holdoutTrades),
        oosGrowth: simulatePortfolioGrowth(wr.allOOSTrades, DTE5_PARAMS.startingCapital),
        holdoutGrowth: simulatePortfolioGrowth(wr.holdoutTrades, DTE5_PARAMS.startingCapital),
        // Phase-1/2-gate audit payload. See StudyResult comment.
        oosDailyReturns: oosMetrics.dailyReturns,
        holdoutDailyReturns: holdMetrics.dailyReturns,
        oosTrades: wr.allOOSTrades,
        holdoutTrades: wr.holdoutTrades,
      };

      const key = `${def._gate}|${def._ticker}`;
      if (!grouped.has(key)) grouped.set(key, {});
      const g = grouped.get(key)!;
      if (def.mechanism === 'champion') g.champion = result;
      else g.baseline = result;
    }

    // Convert grouped results to phase8Rows
    for (const [key, g] of grouped) {
      const [gate, ticker] = key.split('|');
      const dir = allGates.find(gg => gg.label === gate)?.direction ?? 'bull';
      const sigCount = allP8Configs.find(c => c._gate === gate && c._ticker === ticker)?._signals.length ?? 0;
      phase8Rows.push({ gate, ticker, direction: dir, signals: sigCount, champion: g.champion ?? null, baseline: g.baseline ?? null });
    }

    // Print consolidated results
    console.log(`\n\n${'═'.repeat(180)}`);
    console.log('  PHASE 8: EMA GATE & STACK SWEEP — CHAMPION CONFIG (nc+sl2.5x+tl50-50)');
    console.log(`${'═'.repeat(180)}`);
    console.log('  ' +
      'Gate'.padEnd(22) + 'Ticker'.padEnd(6) + 'Dir'.padEnd(6) +
      'Sigs'.padStart(6) +
      'OOS SR'.padStart(8) + 'Hold SR'.padStart(8) +
      'WR%'.padStart(7) + 'MaxDD%'.padStart(8) + 'Trades'.padStart(8) + 'HoldTr'.padStart(8) +
      'Grade'.padStart(7) +
      'OOS PnL'.padStart(10) + 'Hold PnL'.padStart(10) +
      '$10K→'.padStart(10) + 'CAGR%'.padStart(8) +
      '  vs base'.padStart(10),
    );
    console.log('  ' + '─'.repeat(176));

    const sorted = [...phase8Rows].filter(r => r.champion).sort((a, b) => (b.champion?.oosSharpe ?? -99) - (a.champion?.oosSharpe ?? -99));
    for (const row of sorted) {
      const c = row.champion!;
      const b = row.baseline;
      const delta = b ? (c.oosSharpe - b.oosSharpe).toFixed(2) : '—';
      const marker = c.oosSharpe >= 1.0 && c.holdoutSharpe > 0 ? ' ★' : '';
      console.log('  ' +
        row.gate.padEnd(22) + row.ticker.padEnd(6) + row.direction.padEnd(6) +
        String(row.signals).padStart(6) +
        c.oosSharpe.toFixed(2).padStart(8) + c.holdoutSharpe.toFixed(2).padStart(8) +
        `${c.oosWinRate.toFixed(1)}%`.padStart(7) + `${c.oosMaxDD.toFixed(1)}%`.padStart(8) +
        String(c.tradeCount).padStart(8) + String(c.holdoutTradeCount).padStart(8) +
        c.grade.padStart(7) +
        `${c.oosTotalPnl >= 0 ? '+' : ''}$${(Math.abs(c.oosTotalPnl) / 1000).toFixed(1)}k`.padStart(10) +
        `${c.holdoutDetailed.totalPnl >= 0 ? '+' : ''}$${Math.abs(c.holdoutDetailed.totalPnl).toFixed(0)}`.padStart(10) +
        `$${(c.oosGrowth.finalEquity / 1000).toFixed(1)}k`.padStart(10) +
        `${(c.oosGrowth.cagr * 100).toFixed(1)}%`.padStart(8) +
        ('+' + delta).padStart(10) +
        marker,
      );
    }

    // Print skipped combos
    const skipped = phase8Rows.filter(r => !r.champion);
    if (skipped.length > 0) {
      console.log(`\n  Skipped (< 10 signals): ${skipped.map(r => `${r.gate}/${r.ticker}(${r.signals})`).join(', ')}`);
    }

    // Save full results
    const outDir = path.resolve(__dirname, '../backtesting history/credit-spread/reports/dte5-tp-sl-study');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'phase8-ema-sweep.json'), JSON.stringify(phase8Rows, null, 2));
    console.log(`\n  Phase 8 saved to ${outDir}/phase8-ema-sweep.json`);
  }

  // Generate README (include all available results)
  const allPhaseResults = { phase1Results, phase3Results, phase2AResults, phase2BResults, phase3RResults, phase5Results };
  const hasAnyResults = Object.values(allPhaseResults).some(r => r.length > 0);
  if (hasAnyResults) {
    const outDir = path.resolve(__dirname, '../backtesting history/credit-spread/reports/dte5-tp-sl-study');
    fs.mkdirSync(outDir, { recursive: true });
    const readme = generateMarkdownReport(phase1Results, phase3Results);
    fs.writeFileSync(path.join(outDir, 'README.md'), readme);
    console.log(`\n  README saved to ${outDir}/README.md`);
  }

  console.log('\n  Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
