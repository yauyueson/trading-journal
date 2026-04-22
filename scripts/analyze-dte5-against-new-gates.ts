/**
 * Analyze the active DTE5 champion against the Phase 1 + Phase 2
 * adoption gates introduced by the foundation overhaul.
 *
 * Purpose: a non-destructive, post-hoc check. Does NOT run the engine,
 * does NOT produce a new seal, does NOT rotate the holdout. Reads the
 * existing `backtesting history/credit-spread/reports/dte5-tp-sl-study/
 * phase8-ema-sweep.json` output and reports which of the new gates the
 * active DTE5 strategy would pass / fail / cannot-check.
 *
 * Gates checkable from aggregated WFA output (this script covers):
 *   - passesMinTrades       (trade count ≥ minOosTrades)
 *   - passesMaxDD           (oosMaxDD ≤ maxOosDrawdownPct)
 *   - passesWFA             (oosSharpe > 0)
 *   - passesSanitySharpe    (oosSharpe ≤ maxSaneOosSharpe)
 *   - passesSanityMaxDD     (oosMaxDD ≥ minSaneOosDrawdownPct) — Phase 1.c
 *   - passesStability       (holdoutOOSRatio in [min, max])    — Phase 1.b
 *
 * Gates NOT checkable without a full daily-return stream (script flags):
 *   - passesSanityEdge          — needs per-trade grossPnl + maxProfit.
 *   - passesStatConsistency     — needs bootstrap + Mertens SE,
 *                                  both derived from daily returns.
 *   - passesHoldoutAndIR (SPY)  — needs aligned daily SPY returns.
 *
 * Output: pass/fail/cannot-check matrix + one-line verdict. A "cannot-
 * check" is NOT a failure; it means running the active DTE5 through
 * the autoresearch runner (or an extended WFA variant that stamps
 * daily returns) is the only way to get a full verdict.
 *
 * Usage: `npx tsx scripts/analyze-dte5-against-new-gates.ts`
 */
import fs from 'fs';
import path from 'path';
import { computeEffectiveSampleSize } from './autoresearch/lib/effective-sample-size';
import { computeMertensSharpeSE } from './autoresearch/lib/mertens-sharpe-se';
import { bootstrapSharpeCI } from './autoresearch/lib/bootstrap-sharpe';

interface WindowDetail {
  windowIdx: number;
  trainSharpe: number;
  oosSharpe: number;
  oosWR: number;
  oosMaxDD: number;
  oosTradeCount: number;
}

interface ChampionTrade {
  mode?: string;
  grossPnl?: number;
  maxProfit?: number;
  entrySlippage?: number;
  spreadWidth?: number;
  pnl?: number;
}

interface ChampionRow {
  configLabel: string;
  mechanism: string;
  params: Record<string, unknown>;
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
  windowDetails?: WindowDetail[];
  // Phase-1/2-gate audit payload. Present on runs produced AFTER the
  // 2026-04-21 wfa-dte5-tp-sl-study.ts extension; absent on older runs.
  oosDailyReturns?: number[];
  holdoutDailyReturns?: number[];
  oosTrades?: ChampionTrade[];
  holdoutTrades?: ChampionTrade[];
}

interface GateConfig {
  minOosTrades: number;
  maxOosDrawdownPct: number;
  minSaneOosDrawdownPct: number;
  maxSaneOosSharpe: number;
  maxSanePerTradeEdge: number;
  minStabilityHoldoutOosRatio: number;
  maxStabilityHoldoutOosRatio: number;
  maxStatConsistencyRatio: number;
}

function loadGates(): GateConfig {
  const p = path.resolve(process.cwd(), 'config/adoption-gates.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as { gates: GateConfig };
  return raw.gates;
}

function findChampion(results: Array<{ gate: string; ticker: string; direction: string; champion?: ChampionRow }>): ChampionRow | null {
  // Per CLAUDE.md: DTE5 Bull Put Credit Spread, QQQ, EMA55 gate (bull = put-credit-spread direction).
  const match = results.find(r =>
    r.ticker === 'QQQ' &&
    r.direction === 'bull' &&
    r.gate === 'ema55' &&
    r.champion?.configLabel.includes('champ') &&
    r.champion?.configLabel.includes('ema55'),
  );
  return match?.champion ?? null;
}

interface GateVerdict {
  name: string;
  pass: boolean | null;   // null = cannot-check
  details: string;
}

function checkGates(champ: ChampionRow, gates: GateConfig): GateVerdict[] {
  const verdicts: GateVerdict[] = [];
  const { oosSharpe, holdoutSharpe, oosMaxDD, tradeCount } = champ;

  verdicts.push({
    name: 'passesMinTrades',
    pass: tradeCount >= gates.minOosTrades,
    details: `oosTrades=${tradeCount} vs minOosTrades=${gates.minOosTrades}`,
  });
  verdicts.push({
    name: 'passesMaxDD',
    pass: oosMaxDD <= gates.maxOosDrawdownPct,
    details: `oosMaxDD=${oosMaxDD.toFixed(2)}% vs max=${gates.maxOosDrawdownPct}%`,
  });
  verdicts.push({
    name: 'passesWFA',
    pass: oosSharpe > 0,
    details: `oosSharpe=${oosSharpe.toFixed(3)} > 0`,
  });
  verdicts.push({
    name: 'passesSanitySharpe',
    pass: oosSharpe <= gates.maxSaneOosSharpe,
    details: `oosSharpe=${oosSharpe.toFixed(3)} vs ceiling=${gates.maxSaneOosSharpe}`,
  });
  verdicts.push({
    name: 'passesSanityMaxDD (Phase 1.c)',
    pass: oosMaxDD >= gates.minSaneOosDrawdownPct,
    details: `oosMaxDD=${oosMaxDD.toFixed(2)}% vs floor=${gates.minSaneOosDrawdownPct}% (TRAILING_LOCK fingerprint if below)`,
  });

  // Phase 1.b: holdout/OOS Sharpe ratio in [min, max].
  const holdoutOOSRatio = oosSharpe > 0.01 ? holdoutSharpe / oosSharpe : 0;
  verdicts.push({
    name: 'passesStability (Phase 1.b)',
    pass:
      holdoutOOSRatio >= gates.minStabilityHoldoutOosRatio &&
      holdoutOOSRatio <= gates.maxStabilityHoldoutOosRatio,
    details: `holdoutOOSRatio=${holdoutOOSRatio.toFixed(3)} in [${gates.minStabilityHoldoutOosRatio}, ${gates.maxStabilityHoldoutOosRatio}]`,
  });

  // Phase 1.d — mean per-trade edge on OOS credit-spread trades.
  // Checkable when `oosTrades` is present on the row (runs after the
  // 2026-04-21 wfa-dte5-tp-sl-study.ts extension).
  if (champ.oosTrades && champ.oosTrades.length > 0) {
    const csTrades = champ.oosTrades.filter(
      t => t.mode === 'CREDIT_SPREAD' && (t.maxProfit ?? 0) > 0,
    );
    if (csTrades.length >= 20) {
      const edges = csTrades.map(t => {
        const unclampedGross = (t.maxProfit ?? 0) + (t.entrySlippage ?? 0);
        const grossMaxProfit = t.spreadWidth != null
          ? Math.min(unclampedGross, t.spreadWidth)
          : unclampedGross;
        if (!(grossMaxProfit > 0)) return 0;
        return (t.grossPnl ?? t.pnl ?? 0) / (grossMaxProfit * 100);
      });
      const meanEdge = edges.reduce((s, e) => s + e, 0) / edges.length;
      verdicts.push({
        name: 'passesSanityEdge (Phase 1.d)',
        pass: meanEdge < gates.maxSanePerTradeEdge,
        details: `meanPerTradeEdge=${meanEdge.toFixed(3)} vs ceiling=${gates.maxSanePerTradeEdge} (${csTrades.length} CS trades)`,
      });
    } else {
      verdicts.push({
        name: 'passesSanityEdge (Phase 1.d)',
        pass: true,
        details: `only ${csTrades.length} credit-spread OOS trades (< 20); gate auto-passes in runner logic`,
      });
    }
  } else {
    verdicts.push({
      name: 'passesSanityEdge (Phase 1.d)',
      pass: null,
      details: 'needs oosTrades on the study row; re-run wfa-dte5-tp-sl-study.ts after 2026-04-21 to populate',
    });
  }

  // Phase 2.n — stat-consistency gate (bootstrap vs Mertens SE ratio).
  if (champ.oosDailyReturns && champ.oosDailyReturns.length >= 30) {
    const returns = champ.oosDailyReturns;
    // Seeded bootstrap for reproducibility across recheck invocations.
    const seed = 20260421;
    let s = seed >>> 0;
    const rng = (): number => {
      s = (Math.imul(1664525, s) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
    const [lo, hi] = bootstrapSharpeCI(returns, 1000, rng);
    const bootstrapSE = hi > lo ? (hi - lo) / (2 * 1.96) : 1;
    const nEff = computeEffectiveSampleSize(returns, 20);
    const mertens = computeMertensSharpeSE(returns, nEff, 252);
    const mertensSE = mertens.annualizedSe;
    if (bootstrapSE > 0 && mertensSE > 0) {
      const ratio = Math.max(bootstrapSE / mertensSE, mertensSE / bootstrapSE);
      verdicts.push({
        name: 'passesStatConsistency (Phase 2.n)',
        pass: ratio <= gates.maxStatConsistencyRatio,
        details: `ratio=${ratio.toFixed(2)}x vs ceiling=${gates.maxStatConsistencyRatio}x (bs SE ${bootstrapSE.toFixed(3)} / Mertens SE ${mertensSE.toFixed(3)}, N_eff=${nEff.toFixed(0)}/${returns.length})`,
      });
    } else {
      verdicts.push({
        name: 'passesStatConsistency (Phase 2.n)',
        pass: true,
        details: 'one SE estimate is zero (degenerate series); gate auto-passes',
      });
    }
  } else {
    verdicts.push({
      name: 'passesStatConsistency (Phase 2.n)',
      pass: null,
      details: 'needs oosDailyReturns (length ≥ 30) on the study row',
    });
  }

  // passesHoldoutAndIR requires a daily SPY benchmark series aligned to
  // the holdout window. Not loaded by this recheck script. Flag
  // cannot-check regardless of whether `holdoutDailyReturns` is
  // present — the IR computation needs a second series we don't have.
  verdicts.push({
    name: 'passesHoldoutAndIR',
    pass: null,
    details: 'needs aligned daily SPY returns; out of scope for this recheck (handled by main autoresearch runner)',
  });

  return verdicts;
}

function main(): void {
  const reportPath = path.resolve(
    process.cwd(),
    'backtesting history/credit-spread/reports/dte5-tp-sl-study/phase8-ema-sweep.json',
  );
  if (!fs.existsSync(reportPath)) {
    console.error(`FATAL: cannot find ${reportPath}. Check working directory.`);
    process.exit(1);
  }

  const results = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as Array<{
    gate: string; ticker: string; direction: string; champion?: ChampionRow;
  }>;
  const champ = findChampion(results);
  if (!champ) {
    console.error('FATAL: could not find DTE5 QQQ bull EMA55 champion row in phase8-ema-sweep.json.');
    process.exit(1);
  }

  const gates = loadGates();
  const verdicts = checkGates(champ, gates);

  console.log('\nDTE5 champion recheck against Phase 1/2 gates');
  console.log('='.repeat(70));
  console.log(`Config: ${champ.configLabel}`);
  console.log(`OOS Sharpe: ${champ.oosSharpe.toFixed(3)}  Holdout Sharpe: ${champ.holdoutSharpe.toFixed(3)}`);
  console.log(`OOS MaxDD: ${champ.oosMaxDD.toFixed(2)}%  Trades: ${champ.tradeCount}  Win rate: ${champ.oosWinRate.toFixed(1)}%`);
  console.log('-'.repeat(70));

  for (const v of verdicts) {
    const tag = v.pass === null ? '(cannot check)' : v.pass ? '✓ PASS' : '✗ FAIL';
    console.log(`  ${tag.padEnd(16)} ${v.name.padEnd(38)} ${v.details}`);
  }

  console.log('-'.repeat(70));
  const failed = verdicts.filter(v => v.pass === false);
  const unchecked = verdicts.filter(v => v.pass === null);
  if (failed.length === 0) {
    console.log(`VERDICT: no checkable gate fails. ${unchecked.length} gate(s) pending additional data.`);
    if (unchecked.length > 0) {
      console.log('Next step: re-run `npx tsx scripts/wfa-dte5-tp-sl-study.ts --phase 8`');
      console.log('against the current chain cache — the 2026-04-21 study-orchestrator update');
      console.log('stamps oosTrades + daily returns into the phase8-ema-sweep.json, which');
      console.log('this recheck script will pick up on the next invocation.');
    }
  } else {
    console.log(`VERDICT: ${failed.length} gate(s) would reject DTE5 under the new foundation:`);
    for (const v of failed) console.log(`  - ${v.name}: ${v.details}`);
    console.log('Action: investigate whether the gate bound is miscalibrated or the strategy');
    console.log('has a defect the older study missed.');
  }
}

main();
