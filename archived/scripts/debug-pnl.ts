/**
 * Debug script: Sample actual trade entry credits, exit costs, and PnL
 * to find why PnL is inflated ~20×.
 */
import path from 'path';
import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, '../.env') });
dotenvConfig({ path: path.resolve(__dirname, '../.env.local'), override: true });

import { SIGNAL_PRESETS } from '../src/lib/backtest/types';
import { precomputeSignals4H, type IVDataRow } from '../src/lib/backtest/intraday-signals';
import { DEFAULT_SHORT_CREDIT_CONFIG, type SimConfig, type SignalPresetKey } from '../src/lib/backtest/option-sim';
import type { FillMode } from '../src/lib/backtest/types';
import { DEFAULT_DYNAMIC_SLIPPAGE } from '../src/lib/backtest/types';
import { initDB, getCachedChain, findSpreadStrikes, findContractDirect } from '../src/lib/backtest/chain-cache';
import { evaluateCreditSpread4H } from '../src/lib/backtest/intraday-monitor';
import { applyFill } from '../src/lib/backtest/slippage';
import { initIntradayDB, get130MCandles, aggregateToDaily } from '../src/lib/backtest/intraday-cache';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
async function supabaseGet(table: string, query: string): Promise<any[]> {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`;
  const res = await fetch(url, { headers: { apikey: SUPABASE_KEY!, Authorization: `Bearer ${SUPABASE_KEY}` } });
  return res.json();
}

async function main() {
  initDB();
  const intradayDb = initIntradayDB();

  const ticker = 'SPY';
  const config: SimConfig = {
    ...DEFAULT_SHORT_CREDIT_CONFIG,
    creditDTERange: [7, 21] as [number, number],
    creditShortDelta: 0.45,
    creditSpreadWidth: 5,
    creditProfitTarget: 0.30,
    creditStopLossMultiple: 100,
    creditTimeStopDTE: 1,
    minIVRank: 0,
    signalWeightPreset: 'mf' as SignalPresetKey,
    indicatorPeriodMultiplier: 3.75,
    bsmKappa: 4.0,
    bsmRiskFreeRate: 0.04,
    dailyCalibration: true,
    ivThetaSource: 'hv60' as const,
    fillMode: 'mid' as FillMode,
    slippage: { ...DEFAULT_DYNAMIC_SLIPPAGE, enabled: false },
  };

  // Fetch data for SPY
  const candles130m = get130MCandles(intradayDb, ticker, '2024-01-01', '2025-06-30');
  const dailyCandles = aggregateToDaily(candles130m);
  const ivRows = await supabaseGet('orats_iv_cache',
    `select=date,iv30d,iv60d,hv20d,hv30d,hv60d&ticker=eq.${ticker}&date=gte.2024-01-01&date=lte.2025-06-30&order=date.asc&limit=2000`);
  const ivData: IVDataRow[] = ivRows.map((r: any) => ({
    date: r.date, iv30d: r.iv30d, iv60d: r.iv60d,
    hv20d: r.hv20d, hv30d: r.hv30d, hv60d: r.hv60d,
  }));

  // Generate signals
  const techOptions = SIGNAL_PRESETS['mf'];
  const rawSignals = precomputeSignals4H(candles130m, ivData, 3.75, techOptions);
  const signals = rawSignals
    .filter(s => s.type !== 'NEUTRAL' && s.score >= 65)
    .slice(0, 20);

  console.log(`SPY: ${candles130m.length} candles, ${signals.length} signals sampled\n`);

  const allDates = [...new Set(dailyCandles.map(c => c.date))].sort();

  // Evaluate first 20 signals and dump details
  console.log('Signal#  Date        Dir   Score  Entry$   TP$    MaxLoss  ExitCost  PnL$    ExitType     DTE  Strikes');
  console.log('─'.repeat(120));

  let totalPnl = 0;
  let tradeCount = 0;

  for (let i = 0; i < signals.length; i++) {
    const sig = signals[i];
    const barDate = sig.date.split('T')[0].split(' ')[0];

    // First, check raw chain data
    const chain = getCachedChain(ticker, barDate);
    const optionType: 'Call' | 'Put' = sig.type === 'CALL' ? 'Put' : 'Call';
    const spread = findSpreadStrikes(chain, config.creditShortDelta, config.creditSpreadWidth, optionType, config.creditDTERange);

    if (!spread) continue;

    // Now evaluate the full trade
    const trade = evaluateCreditSpread4H(
      { ticker, date: barDate, direction: sig.type as 'CALL' | 'PUT', score: sig.score },
      config, candles130m, allDates, '2025-06-30',
      {
        getChain: (t, d) => getCachedChain(t, d),
        findSpread: (chain, delta, width, type, dte) => findSpreadStrikes(chain, delta, width, type as 'Call' | 'Put', dte),
        findContract: (t, d, strike, expiry, type) => findContractDirect(t, d, strike, expiry, type as 'Call' | 'Put'),
        applyFillFn: (mid, bid, ask, side, cfg, oi, dte) => applyFill('mid' as FillMode, mid, bid, ask, side, cfg, oi, dte),
      },
    );

    if (!trade) continue;

    tradeCount++;
    totalPnl += trade.pnl;

    const shortStrike = spread.short.row.strike;
    const longStrike = spread.long.row.strike;

    console.log(
      `${String(i+1).padStart(7)}  ${barDate}  ${sig.type.padEnd(5)} ${String(sig.score).padStart(5)}  ` +
      `$${spread.netCredit.toFixed(3).padStart(6)}  $${(spread.netCredit * (1-config.creditProfitTarget)).toFixed(3).padStart(5)}  ` +
      `$${spread.maxLoss.toFixed(3).padStart(7)}  $${trade.exitPrice.toFixed(3).padStart(8)}  ` +
      `$${trade.pnl.toFixed(1).padStart(7)}  ${trade.exitType.padEnd(13)} ${String(trade.entryDTE).padStart(3)}  ` +
      `${shortStrike}/${longStrike}`
    );
  }

  console.log('─'.repeat(120));
  console.log(`${tradeCount} trades | Avg PnL: $${(totalPnl/tradeCount).toFixed(2)} | Total PnL: $${totalPnl.toFixed(2)}`);
  console.log(`\nExpected for $5 spread at 0.45 delta, TP 30%:`);
  console.log(`  If credit ~$2.50 → TP profit = $0.75/share = $75/contract`);
  console.log(`  If credit ~$1.50 → TP profit = $0.45/share = $45/contract`);
}

main().catch(err => { console.error(err); process.exit(1); });
