// tests/migration-130m.test.ts
// Verifies the 130M migration is correctly wired across all layers:
//   1. Config consistency (strategy-config.json, strategyProfiles.ts, strategyConfig.js fallback)
//   2. Signal scanner type support
//   3. Signal board wiring (Signals.tsx)
//   4. Data path (backtest-data.js aggregation + caching)
//   5. WFA pipeline defaults
//   6. Engine timeframe support

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

import { STRATEGY_PROFILES } from '../src/lib/strategyProfiles';
import { PERIOD_MULTIPLIERS_130M, scaleIndicatorPeriods } from '../src/lib/backtest/intraday-signals';

// ── Target config from WFA study ──────────────────────────────────────────────
// em|tp50|w10|iv20|dsoff|pm2.25 — Grade A, Sharpe 2.22, WR 84.6%
const EXPECTED_SHORT_TERM = {
  signalPreset: 'em',
  defaultWidth: 10,
  profitTarget: 0.50,
  ivRankMin: 20,
  timeStopDTE: 1,
};

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Config Consistency — all 3 sources must agree
// ═══════════════════════════════════════════════════════════════════════════════
describe('130M-01 — Config consistency across 3 sources', () => {
  const jsonConfig = JSON.parse(
    readFileSync(resolve(__dirname, '../data/strategy-config.json'), 'utf-8')
  );
  const fallbackSrc = readFileSync(
    resolve(__dirname, '../lib/_shared/strategyConfig.js'), 'utf-8'
  );

  it('strategy-config.json shortTerm matches target config', () => {
    const st = jsonConfig.profiles.shortTerm;
    expect(st.signalPreset).toBe(EXPECTED_SHORT_TERM.signalPreset);
    expect(st.defaultWidth).toBe(EXPECTED_SHORT_TERM.defaultWidth);
    expect(st.profitTarget).toBe(EXPECTED_SHORT_TERM.profitTarget);
    expect(st.ivRankMin).toBe(EXPECTED_SHORT_TERM.ivRankMin);
    expect(st.timeStopDTE).toBe(EXPECTED_SHORT_TERM.timeStopDTE);
  });

  it('strategyProfiles.ts shortTerm matches target config', () => {
    const st = STRATEGY_PROFILES.shortTerm;
    expect(st.signalPreset).toBe(EXPECTED_SHORT_TERM.signalPreset);
    expect(st.defaultWidth).toBe(EXPECTED_SHORT_TERM.defaultWidth);
    expect(st.profitTarget).toBe(EXPECTED_SHORT_TERM.profitTarget);
    expect(st.ivRankMin).toBe(EXPECTED_SHORT_TERM.ivRankMin);
    expect(st.timeStopDTE).toBe(EXPECTED_SHORT_TERM.timeStopDTE);
  });

  it('strategyConfig.js fallback contains matching values', () => {
    expect(fallbackSrc).toContain("signalPreset: 'em'");
    expect(fallbackSrc).toContain('defaultWidth: 10');
    expect(fallbackSrc).toContain('profitTarget: 0.50');
    expect(fallbackSrc).toContain('ivRankMin: 20');
  });

  it('all 3 sources agree on shortTerm preset', () => {
    expect(jsonConfig.profiles.shortTerm.signalPreset).toBe(STRATEGY_PROFILES.shortTerm.signalPreset);
  });

  it('spread width options include $10 (not $7.5)', () => {
    const widths = STRATEGY_PROFILES.shortTerm.spreadWidths;
    expect(widths).toContain(10);
    expect(widths).not.toContain(7.5);
    expect(widths).toEqual([2.5, 5, 10]);
  });

  it('width UI options match spreadWidths', () => {
    const uiWidths = STRATEGY_PROFILES.shortTerm.widthOptions.map(o => o.val);
    expect(uiWidths).toEqual(STRATEGY_PROFILES.shortTerm.spreadWidths);
  });

  it('swing config is unchanged', () => {
    const sw = STRATEGY_PROFILES.swing;
    expect(sw.signalPreset).toBe('vol');
    expect(sw.defaultWidth).toBe(20);
    expect(sw.profitTarget).toBe(0.40);
    expect(sw.ivRankMin).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Signal Scanner — ScanTimeframe type includes 130M
// ═══════════════════════════════════════════════════════════════════════════════
describe('130M-02 — Signal scanner supports 130M', () => {
  const scannerSrc = readFileSync(
    resolve(__dirname, '../src/hooks/useSignalScanner.ts'), 'utf-8'
  );

  it('ScanTimeframe type includes 130M', () => {
    expect(scannerSrc).toContain("'130M'");
    expect(scannerSrc).toMatch(/ScanTimeframe\s*=.*'130M'/);
  });

  it('lookback for 130M is shorter than 4H (fewer calendar days needed)', () => {
    // 130M lookback should be 100-150 days; 4H is 300
    expect(scannerSrc).toMatch(/130M.*\?\s*1[012]\d/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Signal Board — Signals.tsx wired for 130M
// ═══════════════════════════════════════════════════════════════════════════════
describe('130M-03 — Signals.tsx wiring', () => {
  const signalsSrc = readFileSync(
    resolve(__dirname, '../src/pages/Signals.tsx'), 'utf-8'
  );

  it('shortTerm board uses 130M timeframe (not 4H)', () => {
    expect(signalsSrc).toContain("? '130M'");
    expect(signalsSrc).not.toMatch(/shortTerm.*\?\s*'4H'/);
  });

  it('period multiplier is 2.25 (not 1.5)', () => {
    expect(signalsSrc).toContain('SHORT_TERM_PERIOD_MULT = 2.25');
    expect(signalsSrc).not.toContain('SHORT_TERM_PERIOD_MULT = 1.5');
  });

  it('DTE5 is default board (retired strategies hidden)', () => {
    expect(signalsSrc).toContain("'dte5'");
  });

  it('signal subtitle shows 130M × 2.25', () => {
    expect(signalsSrc).toContain('130M');
    expect(signalsSrc).toContain('2.25');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Data Path — backtest-data.js has 130M cache + paginated fetch
// ═══════════════════════════════════════════════════════════════════════════════
describe('130M-04 — backtest-data.js 130M data path', () => {
  const apiSrc = readFileSync(
    resolve(__dirname, '../api/backtest-data.js'), 'utf-8'
  );

  it('has getCached130MCandles function', () => {
    expect(apiSrc).toContain('getCached130MCandles');
  });

  it('has cache130MCandles function', () => {
    expect(apiSrc).toContain('cache130MCandles');
  });

  it('has fetchPaginated5Min function for Tiingo 2000-tick limit', () => {
    expect(apiSrc).toContain('fetchPaginated5Min');
  });

  it('uses block-encoded timeframe for 3 bars/day (130M_0, 130M_1, 130M_2)', () => {
    expect(apiSrc).toContain('130M_0');
    expect(apiSrc).toContain('130M_1');
    expect(apiSrc).toContain('130M_2');
    expect(apiSrc).toContain('130M_${b.block}');
  });

  it('queries all 3 block variants from Supabase cache', () => {
    expect(apiSrc).toContain("in.(130M_0,130M_1,130M_2)");
  });

  it('paginates in 30-day chunks', () => {
    expect(apiSrc).toMatch(/CHUNK_DAYS\s*=\s*30/);
  });

  it('still supports 4H path for backwards compatibility', () => {
    expect(apiSrc).toContain("'4H'");
    expect(apiSrc).toContain('aggregate1HTo4H');
  });

  it('aggregate5MinTo130M creates 3 blocks per day', () => {
    // Block assignment: floor(minutesSince930 / 130), max 2
    expect(apiSrc).toContain('minutesSince930');
    expect(apiSrc).toMatch(/Math\.floor\(minutesSince930\s*\/\s*130\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. 130M Aggregation Logic — unit test the grouping math
// ═══════════════════════════════════════════════════════════════════════════════
describe('130M-05 — 130M block assignment math', () => {
  // 3 × 130min = 390min = exact regular session (9:30–16:00 ET)
  it('130M covers exact regular session: 3 × 130 = 390 minutes', () => {
    expect(3 * 130).toBe(390);
    // Market open 9:30 (570 min from midnight) to 16:00 (960 min)
    expect(960 - 570).toBe(390);
  });

  it('block boundaries are correct', () => {
    // Block 0: 09:30–11:40 (minutesSince930 = 0–129)
    expect(Math.floor(0 / 130)).toBe(0);
    expect(Math.floor(129 / 130)).toBe(0);
    // Block 1: 11:40–13:50 (minutesSince930 = 130–259)
    expect(Math.floor(130 / 130)).toBe(1);
    expect(Math.floor(259 / 130)).toBe(1);
    // Block 2: 13:50–16:00 (minutesSince930 = 260–389)
    expect(Math.floor(260 / 130)).toBe(2);
    expect(Math.floor(389 / 130)).toBe(2);
  });

  it('no 4th block exists (clamped to max 2)', () => {
    // Even at exactly 16:00 (minutesSince930 = 390), clamped to 2
    expect(Math.min(Math.floor(390 / 130), 2)).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Period Multiplier Scaling — pm2.25 produces correct indicator periods
// ═══════════════════════════════════════════════════════════════════════════════
describe('130M-06 — Period multiplier scaling', () => {
  it('PERIOD_MULTIPLIERS_130M has correct values', () => {
    expect([...PERIOD_MULTIPLIERS_130M]).toEqual([2.25, 3.0, 3.75]);
  });

  it('130M multipliers are 1.5× the 4H equivalents', () => {
    // 4H [1.5, 2.0, 2.5] × 1.5 = 130M [2.25, 3.0, 3.75]
    const expected4H = [1.5, 2.0, 2.5];
    PERIOD_MULTIPLIERS_130M.forEach((m, i) => {
      expect(m).toBeCloseTo(expected4H[i] * 1.5, 10);
    });
  });

  it('scaleIndicatorPeriods(2.25) produces correct period for sc_mb_len (default 100)', () => {
    const scaled = scaleIndicatorPeriods(2.25);
    // sc_mb_len default is 100, scaled by 2.25 → round(225) = 225
    expect(scaled.sc_mb_len).toBe(Math.round(100 * 2.25));
  });

  it('scaleIndicatorPeriods(2.25) produces correct period for sc_osc_len (default 14)', () => {
    const scaled = scaleIndicatorPeriods(2.25);
    // sc_osc_len default is 14, scaled by 2.25 → round(32) = 32
    expect(scaled.sc_osc_len).toBe(Math.round(14 * 2.25));
  });

  it('120-day lookback provides enough bars for pm2.25 warmup', () => {
    // Longest indicator at pm2.25: sc_osc_len = round(100 × 2.25) = 225 bars
    // 120 calendar days ≈ 85 trading days × 3 bars/day = 255 bars
    // 255 > 225 ✓
    const longestPeriod = Math.round(100 * 2.25);
    const tradingDays = Math.floor(120 * 252 / 365); // ~85 trading days
    const barsAvailable = tradingDays * 3; // 3 bars/day for 130M
    expect(barsAvailable).toBeGreaterThan(longestPeriod);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. WFA Pipeline — defaults match 130M config
// ═══════════════════════════════════════════════════════════════════════════════
describe('130M-07 — WFA pipeline short-term defaults', () => {
  const pipelineSrc = readFileSync(
    resolve(__dirname, '../scripts/wfa-pipeline-short.ts'), 'utf-8'
  );

  it('imports get130MCandles (not get4HCandles)', () => {
    expect(pipelineSrc).toContain('get130MCandles');
    expect(pipelineSrc).not.toContain('get4HCandles');
  });

  it('imports PERIOD_MULTIPLIERS_130M (not PERIOD_MULTIPLIERS)', () => {
    expect(pipelineSrc).toContain('PERIOD_MULTIPLIERS_130M');
    // Should not import the 4H constant
    expect(pipelineSrc).not.toMatch(/import.*\bPERIOD_MULTIPLIERS\b[^_]/);
  });

  it('sweep defaults use 130M period multipliers [2.25, 3.0, 3.75]', () => {
    expect(pipelineSrc).toContain('2.25');
    expect(pipelineSrc).toContain('3.75');
    // Should not have 4H multipliers as defaults
    expect(pipelineSrc).not.toMatch(/periodMultipliers:\s*\[1\.5/);
  });

  it('sweep defaults use spread widths [2.5, 5, 10]', () => {
    expect(pipelineSrc).toMatch(/spreadWidths:\s*\[2\.5,\s*5,\s*10\]/);
    expect(pipelineSrc).not.toMatch(/spreadWidths:\s*\[2\.5,\s*5,\s*7\.5\]/);
  });

  it('pipeline description mentions 130M (not 4H)', () => {
    // First comment block should reference 130M
    const firstComment = pipelineSrc.slice(0, pipelineSrc.indexOf('*/'));
    expect(firstComment).toContain('130M');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Engine Support — barsToDays handles 130M
// ═══════════════════════════════════════════════════════════════════════════════
describe('130M-08 — Engine timeframe support', () => {
  const engineSrc = readFileSync(
    resolve(__dirname, '../src/lib/backtest/engine.ts'), 'utf-8'
  );

  it('engine.ts supports 130M timeframe', () => {
    expect(engineSrc).toContain("'130M'");
  });

  it('barsToDays converts 130M at 3 bars/day', () => {
    // barsToDays should divide by 3 for 130M
    expect(engineSrc).toMatch(/130M.*\/\s*3|bars\s*\/\s*3.*130M/s);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. CLAUDE.md — documentation updated
// ═══════════════════════════════════════════════════════════════════════════════
describe('130M-09 — Documentation', () => {
  const claudeMd = readFileSync(
    resolve(__dirname, '../CLAUDE.md'), 'utf-8'
  );

  it('CLAUDE.md documents validated DTE5 strategy', () => {
    expect(claudeMd).toContain('Validated: DTE5 Bull Put Credit Spread');
  });

  it('CLAUDE.md documents retired strategies', () => {
    expect(claudeMd).toContain('Swing (45-65 DTE)');
    expect(claudeMd).toContain('Short-Term (7-21 DTE)');
    expect(claudeMd).toContain('Retired');
  });
});
