#!/usr/bin/env npx tsx
/**
 * Spread Configuration Comparison — Portfolio Growth Simulation
 *
 * Fresh run using current engine (post-audit, honest pricing).
 * Simulates actual $10K portfolio equity growth with compounding.
 * Compares delta/width combos for QQQ bull EMA34 DTE5.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env.local');
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

import Database from 'better-sqlite3';
import { initDB, getCachedChain, findContractDirect, type ChainRow } from '../src/lib/backtest/chain-cache';

// ── Types ────────────────────────────────────────────────
interface Config {
  ticker: string;
  startDate: string;
  endDate: string;
  startingCapital: number;
  targetDelta: number;
  longPutDelta?: number;
  maxDTE: number;
  maxRiskPct: number;
  maxPositions: number;
  commissionPerContract: number;
  minPremium: number;
  trendEMA?: number;
  direction: 'bull' | 'bear';
  compounding: boolean;
}

interface Trade {
  entryDate: string;
  exitDate: string;
  strike: number;
  longStrike?: number;
  spreadWidth?: number;
  stockPriceEntry: number;
  stockPriceExit: number;
  premium: number;
  exitCost: number;
  pnl: number;
  totalPnl: number;
  contracts: number;
  maxRiskPerContract: number;
  delta: number;
  iv: number;
  dte: number;
  breached: boolean;
  isSpread: boolean;
}

// ── Helpers ──────────────────────────────────────────────
function ema(closes: number[], period: number): Map<string, number> {
  // We need dates too, but this helper just computes EMA values
  const k = 2 / (period + 1);
  const vals: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) vals.push(closes[0]);
    else vals.push(closes[i] * k + vals[i - 1] * (1 - k));
  }
  return new Map(); // placeholder
}

function findPutByDelta(chain: ChainRow[], targetDelta: number, maxDTE: number) {
  const minDTE = 2;
  const candidates = chain.filter(r => r.dte >= minDTE && r.dte <= maxDTE);
  if (candidates.length === 0) return null;
  let best: ChainRow | null = null;
  let bestDist = Infinity;
  for (const r of candidates) {
    const absDelta = Math.abs(r.delta - 1);
    if (absDelta > 0.50) continue;
    if (r.put_bid <= 0) continue;
    const dist = Math.abs(absDelta - targetDelta);
    if (dist < bestDist) { bestDist = dist; best = r; }
  }
  if (!best) return null;
  return {
    row: best,
    delta: Math.abs(best.delta - 1),
    bid: best.put_bid,
    ask: best.put_ask,
    mid: best.put_mid,
    iv: best.put_iv,
  };
}

// ── Core Strategy Runner (with compounding) ──────────────
function runStrategy(config: Config, allDates: string[], dailyCloses: Map<string, number>): {
  trades: Trade[];
  equityCurve: Array<{ date: string; equity: number }>;
  totalPnl: number;
  totalTrades: number;
  winRate: number;
  maxDrawdown: number;
  sharpe: number;
  cagr: number;
  finalEquity: number;
  avgPremium: number;
  avgMaxRisk: number;
  avgContracts: number;
} {
  const trades: Trade[] = [];
  let equity = config.startingCapital;
  const equityCurve: Array<{ date: string; equity: number }> = [];

  // Compute EMA
  const emaMap = new Map<string, number>();
  if (config.trendEMA) {
    const k = 2 / (config.trendEMA + 1);
    let emaVal = 0;
    let started = false;
    for (const d of allDates) {
      const c = dailyCloses.get(d);
      if (c == null) continue;
      if (!started) { emaVal = c; started = true; }
      else emaVal = c * k + emaVal * (1 - k);
      emaMap.set(d, emaVal);
    }
  }

  const openPositions: Array<{
    entryDate: string;
    strike: number;
    longStrike?: number;
    spreadWidth?: number;
    premium: number;
    contracts: number;
    maxRiskPerContract: number;
    stockPriceEntry: number;
    delta: number;
    iv: number;
    dte: number;
    expiryDate: string;
    isSpread: boolean;
  }> = [];

  let peakEquity = equity;
  let maxDD = 0;

  for (let i = 0; i < allDates.length; i++) {
    const date = allDates[i];
    const todayClose = dailyCloses.get(date);

    equityCurve.push({ date, equity });

    // Close expired positions
    for (let p = openPositions.length - 1; p >= 0; p--) {
      const pos = openPositions[p];
      if (date >= pos.expiryDate) {
        // Try market pricing first
        const shortMkt = findContractDirect(config.ticker, date, pos.strike, pos.expiryDate, 'Put');
        const longMkt = pos.longStrike != null
          ? findContractDirect(config.ticker, date, pos.longStrike, pos.expiryDate, 'Put')
          : null;

        let closePnl: number;
        let closeCost: number;
        let breached: boolean;
        let stockPrice: number;

        if (shortMkt) {
          stockPrice = shortMkt.row.stock_price;
          const shortAsk = shortMkt.ask ?? shortMkt.mid;
          const longBid = longMkt ? (longMkt.bid ?? longMkt.mid) : 0;
          closeCost = pos.isSpread ? shortAsk - longBid : shortAsk;
          const pnlPerShare = pos.premium - closeCost;
          const legCount = pos.isSpread ? 2 : 1;
          const pnlPerContract = pnlPerShare * 100 - config.commissionPerContract * legCount * 2;
          closePnl = pnlPerContract * pos.contracts;
          breached = stockPrice < pos.strike;
        } else {
          // Intrinsic fallback
          stockPrice = todayClose ?? pos.stockPriceEntry;
          const shortIntrinsic = Math.max(0, pos.strike - stockPrice);
          const longIntrinsic = pos.longStrike != null ? Math.max(0, pos.longStrike - stockPrice) : 0;
          closeCost = pos.isSpread ? shortIntrinsic - longIntrinsic : shortIntrinsic;
          const pnlPerShare = pos.premium - closeCost;
          const legCount = pos.isSpread ? 2 : 1;
          const pnlPerContract = pnlPerShare * 100 - config.commissionPerContract * legCount * 2;
          closePnl = pnlPerContract * pos.contracts;
          breached = stockPrice < pos.strike;
        }

        equity += closePnl;
        trades.push({
          entryDate: pos.entryDate,
          exitDate: date,
          strike: pos.strike,
          longStrike: pos.longStrike,
          spreadWidth: pos.spreadWidth,
          stockPriceEntry: pos.stockPriceEntry,
          stockPriceExit: stockPrice,
          premium: pos.premium,
          exitCost: closeCost,
          pnl: closePnl / pos.contracts,
          totalPnl: closePnl,
          contracts: pos.contracts,
          maxRiskPerContract: pos.maxRiskPerContract,
          delta: pos.delta,
          iv: pos.iv,
          dte: pos.dte,
          breached,
          isSpread: pos.isSpread,
        });
        openPositions.splice(p, 1);
      }
    }

    // Track drawdown
    peakEquity = Math.max(peakEquity, equity);
    if (peakEquity > 0) maxDD = Math.max(maxDD, (peakEquity - equity) / peakEquity);

    // Skip entry if at capacity
    if (openPositions.length >= config.maxPositions) continue;
    if (todayClose == null) continue;

    // EMA filter
    if (config.trendEMA) {
      const emaVal = emaMap.get(date);
      if (emaVal == null) continue;
      if (config.direction === 'bull' && todayClose <= emaVal) continue;
    }

    // Get chain
    const chain = getCachedChain(config.ticker, date);
    if (chain.length === 0) continue;

    // Find short put
    const shortPut = findPutByDelta(chain, config.targetDelta, config.maxDTE);
    if (!shortPut) continue;

    // Find long put (wing)
    let longPut: ReturnType<typeof findPutByDelta> = null;
    let isSpread = false;
    let spreadWidth = 0;
    if (config.longPutDelta && config.longPutDelta > 0) {
      // Find wing on same expiry
      const sameExpiry = chain.filter(r => r.dte === shortPut.row.dte);
      let best: ChainRow | null = null;
      let bestDist = Infinity;
      for (const r of sameExpiry) {
        const absDelta = Math.abs(r.delta - 1);
        if (absDelta > 0.50) continue;
        if (r.strike >= shortPut.row.strike) continue; // wing must be lower
        const dist = Math.abs(absDelta - config.longPutDelta);
        if (dist < bestDist) { bestDist = dist; best = r; }
      }
      if (best) {
        longPut = {
          row: best,
          delta: Math.abs(best.delta - 1),
          bid: best.put_bid,
          ask: best.put_ask,
          mid: best.put_mid,
          iv: best.put_iv,
        };
        isSpread = true;
        spreadWidth = shortPut.row.strike - best.strike;
      }
    }

    // Calculate premium (worst-side fills)
    let premium: number;
    if (isSpread && longPut) {
      premium = shortPut.bid - longPut.ask; // sell short bid, buy long ask
    } else {
      premium = shortPut.bid;
    }
    if (premium <= config.minPremium) continue;

    // Calculate max risk per contract
    let maxRiskPerContract: number;
    if (isSpread && longPut) {
      maxRiskPerContract = (spreadWidth - premium) * 100;
    } else {
      maxRiskPerContract = (shortPut.row.strike - premium) * 100; // cash secured
    }
    if (maxRiskPerContract <= 0) continue;

    // Size from current equity (compounding)
    const sizingBase = config.compounding ? equity : config.startingCapital;
    const maxRisk = sizingBase * config.maxRiskPct;
    const contracts = Math.max(1, Math.floor(maxRisk / maxRiskPerContract));

    // Compute expiry date
    const entryDateObj = new Date(date + 'T12:00:00Z');
    const expiryDateObj = new Date(entryDateObj.getTime() + shortPut.row.dte * 86400000);
    const expiryDate = expiryDateObj.toISOString().split('T')[0];

    openPositions.push({
      entryDate: date,
      strike: shortPut.row.strike,
      longStrike: longPut?.row.strike,
      spreadWidth: isSpread ? spreadWidth : undefined,
      premium,
      contracts,
      maxRiskPerContract,
      stockPriceEntry: shortPut.row.stock_price,
      delta: shortPut.delta,
      iv: shortPut.iv,
      dte: shortPut.row.dte,
      expiryDate,
      isSpread,
    });
  }

  // Force-close any remaining open positions
  const lastDate = allDates[allDates.length - 1];
  for (const pos of openPositions) {
    const shortMkt = findContractDirect(config.ticker, lastDate, pos.strike, pos.expiryDate, 'Put');
    const longMkt = pos.longStrike != null
      ? findContractDirect(config.ticker, lastDate, pos.longStrike, pos.expiryDate, 'Put')
      : null;

    let closePnl: number;
    let closeCost: number;
    let breached: boolean;
    let stockPrice: number;

    if (shortMkt) {
      stockPrice = shortMkt.row.stock_price;
      const shortAsk = shortMkt.ask ?? shortMkt.mid;
      const longBid = longMkt ? (longMkt.bid ?? longMkt.mid) : 0;
      closeCost = pos.isSpread ? shortAsk - longBid : shortAsk;
      const pnlPerShare = pos.premium - closeCost;
      const legCount = pos.isSpread ? 2 : 1;
      const pnlPerContract = pnlPerShare * 100 - config.commissionPerContract * legCount * 2;
      closePnl = pnlPerContract * pos.contracts;
      breached = stockPrice < pos.strike;
    } else {
      stockPrice = dailyCloses.get(lastDate) ?? pos.stockPriceEntry;
      const shortIntrinsic = Math.max(0, pos.strike - stockPrice);
      const longIntrinsic = pos.longStrike != null ? Math.max(0, pos.longStrike - stockPrice) : 0;
      closeCost = pos.isSpread ? shortIntrinsic - longIntrinsic : shortIntrinsic;
      const pnlPerShare = pos.premium - closeCost;
      const legCount = pos.isSpread ? 2 : 1;
      const pnlPerContract = pnlPerShare * 100 - config.commissionPerContract * legCount * 2;
      closePnl = pnlPerContract * pos.contracts;
      breached = stockPrice < pos.strike;
    }

    equity += closePnl;
    trades.push({
      entryDate: pos.entryDate,
      exitDate: lastDate,
      strike: pos.strike,
      longStrike: pos.longStrike,
      spreadWidth: pos.spreadWidth,
      stockPriceEntry: pos.stockPriceEntry,
      stockPriceExit: stockPrice,
      premium: pos.premium,
      exitCost: closeCost,
      pnl: closePnl / pos.contracts,
      totalPnl: closePnl,
      contracts: pos.contracts,
      maxRiskPerContract: pos.maxRiskPerContract,
      delta: pos.delta,
      iv: pos.iv,
      dte: pos.dte,
      breached,
      isSpread: pos.isSpread,
    });
  }

  equityCurve.push({ date: lastDate, equity });
  peakEquity = Math.max(peakEquity, equity);
  if (peakEquity > 0) maxDD = Math.max(maxDD, (peakEquity - equity) / peakEquity);

  // Analytics
  const winners = trades.filter(t => t.totalPnl > 0);
  const years = (new Date(config.endDate).getTime() - new Date(config.startDate).getTime()) / (365.25 * 86400000);
  const cagr = years > 0 && config.startingCapital > 0
    ? ((equity / config.startingCapital) ** (1 / years) - 1) * 100
    : 0;

  // Daily return Sharpe
  const dailyPnlMap = new Map<string, number>();
  for (const t of trades) {
    dailyPnlMap.set(t.exitDate, (dailyPnlMap.get(t.exitDate) ?? 0) + t.totalPnl);
  }
  let eq2 = config.startingCapital;
  const rets: number[] = [];
  for (const d of allDates) {
    const dayPnl = dailyPnlMap.get(d) ?? 0;
    if (eq2 > 0) rets.push(dayPnl / eq2);
    eq2 += dayPnl;
  }
  const avg = rets.length > 0 ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const std = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - avg) ** 2, 0) / (rets.length - 1)) : 0;
  const sharpe = std > 0 ? (avg / std) * Math.sqrt(252) : 0;

  const totalPremiums = trades.reduce((s, t) => s + t.premium * t.contracts * 100, 0);
  const totalRisks = trades.reduce((s, t) => s + t.maxRiskPerContract * t.contracts, 0);
  const totalContracts = trades.reduce((s, t) => s + t.contracts, 0);

  return {
    trades,
    equityCurve,
    totalPnl: equity - config.startingCapital,
    totalTrades: trades.length,
    winRate: trades.length > 0 ? winners.length / trades.length * 100 : 0,
    maxDrawdown: maxDD * 100,
    sharpe,
    cagr,
    finalEquity: equity,
    avgPremium: trades.length > 0 ? totalPremiums / totalContracts / 100 : 0,
    avgMaxRisk: trades.length > 0 ? totalRisks / totalContracts : 0,
    avgContracts: trades.length > 0 ? totalContracts / trades.length : 0,
  };
}

// ── WFA Runner ───────────────────────────────────────────
function runWFA(
  allDates: string[],
  dailyCloses: Map<string, number>,
  config: Config,
  trainDays: number,
  testDays: number,
): {
  oosSharpe: number;
  oosCagr: number;
  oosPnl: number;
  oosMaxDD: number;
  oosTrades: number;
  oosWR: number;
  posWindows: number;
  totalWindows: number;
  finalEquity: number;
  equityCurve: Array<{ date: string; equity: number }>;
  avgPremium: number;
  avgMaxRisk: number;
  avgContracts: number;
} {
  const windows: Array<{ testStart: string; testEnd: string; result: ReturnType<typeof runStrategy> }> = [];
  let startIdx = 0;

  while (startIdx + trainDays + testDays <= allDates.length) {
    const testStart = allDates[startIdx + trainDays];
    const testEnd = allDates[Math.min(startIdx + trainDays + testDays - 1, allDates.length - 1)];

    const windowDates = allDates.filter(d => d >= testStart && d <= testEnd);
    const result = runStrategy({ ...config, startDate: testStart, endDate: testEnd }, windowDates, dailyCloses);
    windows.push({ testStart, testEnd, result });
    startIdx += testDays;
  }

  // Build composite equity curve with compounding across windows
  let equity = config.startingCapital;
  const allTrades: Trade[] = [];
  const equityCurve: Array<{ date: string; equity: number }> = [];
  let peakEquity = equity;
  let maxDD = 0;

  for (const w of windows) {
    for (const t of w.result.trades) {
      // Scale trade PnL relative to equity at start of window
      const scaleFactor = equity / config.startingCapital;
      const scaledPnl = t.totalPnl * scaleFactor;
      allTrades.push({ ...t, totalPnl: scaledPnl });
      equity += scaledPnl;
      peakEquity = Math.max(peakEquity, equity);
      if (peakEquity > 0) maxDD = Math.max(maxDD, (peakEquity - equity) / peakEquity);
    }
    equityCurve.push({ date: w.testEnd, equity });
  }

  const oosWR = allTrades.length > 0 ? allTrades.filter(t => t.totalPnl > 0).length / allTrades.length * 100 : 0;
  const posWindows = windows.filter(w => w.result.totalPnl > 0).length;

  // Daily return Sharpe from all OOS dates
  const dailyPnlMap = new Map<string, number>();
  for (const t of allTrades) {
    dailyPnlMap.set(t.exitDate, (dailyPnlMap.get(t.exitDate) ?? 0) + t.totalPnl);
  }
  const oosDateSet = new Set<string>();
  for (const w of windows) {
    for (const d of allDates) {
      if (d >= w.testStart && d <= w.testEnd) oosDateSet.add(d);
    }
  }
  const oosDates = [...oosDateSet].sort();
  let eq2 = config.startingCapital;
  const rets: number[] = [];
  for (const d of oosDates) {
    const dayPnl = dailyPnlMap.get(d) ?? 0;
    if (eq2 > 0) rets.push(dayPnl / eq2);
    eq2 += dayPnl;
  }
  const avg = rets.length > 0 ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const std = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - avg) ** 2, 0) / (rets.length - 1)) : 0;
  const oosSharpe = std > 0 ? (avg / std) * Math.sqrt(252) : 0;

  const years = oosDates.length > 1
    ? (new Date(oosDates[oosDates.length - 1]).getTime() - new Date(oosDates[0]).getTime()) / (365.25 * 86400000)
    : 0;
  const oosCagr = years > 0 ? ((equity / config.startingCapital) ** (1 / years) - 1) * 100 : 0;

  // Average trade metrics
  const rawTrades = windows.flatMap(w => w.result.trades);
  const totalPremiums = rawTrades.reduce((s, t) => s + t.premium * t.contracts * 100, 0);
  const totalRisks = rawTrades.reduce((s, t) => s + t.maxRiskPerContract * t.contracts, 0);
  const totalContracts = rawTrades.reduce((s, t) => s + t.contracts, 0);

  return {
    oosSharpe,
    oosCagr,
    oosPnl: equity - config.startingCapital,
    oosMaxDD: maxDD * 100,
    oosTrades: allTrades.length,
    oosWR,
    posWindows,
    totalWindows: windows.length,
    finalEquity: equity,
    equityCurve,
    avgPremium: totalContracts > 0 ? totalPremiums / totalContracts / 100 : 0,
    avgMaxRisk: totalContracts > 0 ? totalRisks / totalContracts : 0,
    avgContracts: totalContracts > 0 ? totalContracts / rawTrades.length : 0,
  };
}

// ── Main ─────────────────────────────────────────────────
async function main() {
  const DTE = 7;
  const STARTING_CAPITAL = 10_000;
  const TRAIN_DAYS = 252;
  const TEST_DAYS = 126;

  console.log('╔══════════════════════════════════════════════════════════════════════════╗');
  console.log('║  Spread Config Comparison — QQQ Bull EMA34 DTE5 — $10K Portfolio       ║');
  console.log('║  Post-audit engine • Worst-side fills • $0 commission (Robinhood)      ║');
  console.log('║  Portfolio growth simulation with compounding                           ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════╝\n');

  // Initialize chain cache
  initDB();

  const db = new Database('data/option-chains.sqlite');
  const allDates: string[] = db.prepare(
    'SELECT DISTINCT trade_date FROM option_chains WHERE ticker = ? AND trade_date >= ? AND trade_date <= ? ORDER BY trade_date'
  ).all('QQQ', '2020-01-01', '2026-02-28').map((r: any) => r.trade_date);

  // Build daily close map
  const dailyCloses = new Map<string, number>();
  for (const d of allDates) {
    const chain = getCachedChain('QQQ', d);
    if (chain.length > 0) dailyCloses.set(d, chain[0].stock_price);
  }
  db.close();

  console.log(`Trading dates: ${allDates.length} (${allDates[0]} → ${allDates[allDates.length - 1]})\n`);

  const SPREADS = [
    // Current strategy
    { label: 'sp25/15',  shortDelta: 0.25, wingDelta: 0.15, note: '← CURRENT' },
    { label: 'sp25/10',  shortDelta: 0.25, wingDelta: 0.10, note: '' },

    // Narrower (less capital tied up)
    { label: 'sp30/20',  shortDelta: 0.30, wingDelta: 0.20, note: '' },
    { label: 'sp30/25',  shortDelta: 0.30, wingDelta: 0.25, note: 'narrow $5' },
    { label: 'sp35/25',  shortDelta: 0.35, wingDelta: 0.25, note: '' },
    { label: 'sp35/30',  shortDelta: 0.35, wingDelta: 0.30, note: 'narrow $5' },

    // Aggressive (more premium, less width)
    { label: 'sp40/30',  shortDelta: 0.40, wingDelta: 0.30, note: '' },
    { label: 'sp40/35',  shortDelta: 0.40, wingDelta: 0.35, note: 'narrow $5' },

    // Wider OTM (safer)
    { label: 'sp20/10',  shortDelta: 0.20, wingDelta: 0.10, note: '' },
    { label: 'sp15/05',  shortDelta: 0.15, wingDelta: 0.05, note: 'deep OTM' },
  ];

  const baseConfig: Config = {
    ticker: 'QQQ',
    startDate: '2020-01-01',
    endDate: '2026-02-28',
    startingCapital: STARTING_CAPITAL,
    targetDelta: 0.25,
    longPutDelta: 0.15,
    maxDTE: DTE,
    maxRiskPct: 0.20,   // 20% of capital per trade (same as live config)
    maxPositions: 1,
    commissionPerContract: 0, // Robinhood
    minPremium: 0.01,
    trendEMA: 34,
    direction: 'bull',
    compounding: true,
  };

  // ── Part 1: Full-period portfolio simulation ───────────
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('PART 1: Full-Period Portfolio Growth ($10K start, compounding, 20% risk)');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  console.log(
    'Config'.padEnd(12) +
    'Final$'.padStart(10) +
    'PnL'.padStart(10) +
    'CAGR'.padStart(8) +
    'Sharpe'.padStart(9) +
    'MaxDD'.padStart(8) +
    'WR%'.padStart(6) +
    'Trades'.padStart(8) +
    'AvgPrem'.padStart(9) +
    'AvgRisk$'.padStart(10) +
    'AvgCts'.padStart(8) +
    '  Note'
  );
  console.log('-'.repeat(108));

  interface ResultRow {
    label: string;
    note: string;
    result: ReturnType<typeof runStrategy>;
  }
  const fullResults: ResultRow[] = [];

  for (const sp of SPREADS) {
    const cfg: Config = {
      ...baseConfig,
      targetDelta: sp.shortDelta,
      longPutDelta: sp.wingDelta > 0 ? sp.wingDelta : undefined,
    };
    const result = runStrategy(cfg, allDates, dailyCloses);
    fullResults.push({ label: sp.label, note: sp.note, result });

    console.log(
      sp.label.padEnd(12) +
      `$${result.finalEquity.toFixed(0)}`.padStart(10) +
      `$${result.totalPnl.toFixed(0)}`.padStart(10) +
      `${result.cagr.toFixed(1)}%`.padStart(8) +
      result.sharpe.toFixed(3).padStart(9) +
      `${result.maxDrawdown.toFixed(1)}%`.padStart(8) +
      `${result.winRate.toFixed(0)}%`.padStart(6) +
      String(result.totalTrades).padStart(8) +
      `$${result.avgPremium.toFixed(2)}`.padStart(9) +
      `$${result.avgMaxRisk.toFixed(0)}`.padStart(10) +
      `${result.avgContracts.toFixed(1)}`.padStart(8) +
      `  ${sp.note}`
    );
  }

  // ── Part 2: WFA (out-of-sample) ────────────────────────
  console.log('\n\n═══════════════════════════════════════════════════════════════════════');
  console.log('PART 2: Walk-Forward Analysis (252d train / 126d test, compounding)');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  console.log(
    'Config'.padEnd(12) +
    'Final$'.padStart(10) +
    'OOS PnL'.padStart(10) +
    'CAGR'.padStart(8) +
    'Sharpe'.padStart(9) +
    'MaxDD'.padStart(8) +
    'WR%'.padStart(6) +
    'Trades'.padStart(8) +
    '+Win'.padStart(7) +
    'AvgPrem'.padStart(9) +
    'AvgRisk$'.padStart(10) +
    '  Note'
  );
  console.log('-'.repeat(107));

  interface WFARow {
    label: string;
    note: string;
    wfa: ReturnType<typeof runWFA>;
  }
  const wfaResults: WFARow[] = [];

  for (const sp of SPREADS) {
    const cfg: Config = {
      ...baseConfig,
      targetDelta: sp.shortDelta,
      longPutDelta: sp.wingDelta > 0 ? sp.wingDelta : undefined,
    };
    const wfa = runWFA(allDates, dailyCloses, cfg, TRAIN_DAYS, TEST_DAYS);
    wfaResults.push({ label: sp.label, note: sp.note, wfa });

    console.log(
      sp.label.padEnd(12) +
      `$${wfa.finalEquity.toFixed(0)}`.padStart(10) +
      `$${wfa.oosPnl.toFixed(0)}`.padStart(10) +
      `${wfa.oosCagr.toFixed(1)}%`.padStart(8) +
      wfa.oosSharpe.toFixed(3).padStart(9) +
      `${wfa.oosMaxDD.toFixed(1)}%`.padStart(8) +
      `${wfa.oosWR.toFixed(0)}%`.padStart(6) +
      String(wfa.oosTrades).padStart(8) +
      `${wfa.posWindows}/${wfa.totalWindows}`.padStart(7) +
      `$${wfa.avgPremium.toFixed(2)}`.padStart(9) +
      `$${wfa.avgMaxRisk.toFixed(0)}`.padStart(10) +
      `  ${sp.note}`
    );
  }

  // ── Part 3: Hold-out (train 2020-2024H1, test 2024H2-2026) ──
  console.log('\n\n═══════════════════════════════════════════════════════════════════════');
  console.log('PART 3: Hold-Out Validation (train 2020-2024H1, test 2024H2 → 2026)');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  console.log(
    'Config'.padEnd(12) +
    'HO Final$'.padStart(11) +
    'HO PnL'.padStart(10) +
    'HO CAGR'.padStart(9) +
    'HO Sharpe'.padStart(11) +
    'HO MaxDD'.padStart(9) +
    'HO WR%'.padStart(8) +
    'HO Trades'.padStart(10) +
    'AvgCts'.padStart(8) +
    '  Note'
  );
  console.log('-'.repeat(98));

  const hoDates = allDates.filter(d => d >= '2024-07-01');
  for (const sp of SPREADS) {
    const cfg: Config = {
      ...baseConfig,
      targetDelta: sp.shortDelta,
      longPutDelta: sp.wingDelta > 0 ? sp.wingDelta : undefined,
      startDate: '2024-07-01',
      endDate: '2026-02-28',
    };
    const result = runStrategy(cfg, hoDates, dailyCloses);

    console.log(
      sp.label.padEnd(12) +
      `$${result.finalEquity.toFixed(0)}`.padStart(11) +
      `$${result.totalPnl.toFixed(0)}`.padStart(10) +
      `${result.cagr.toFixed(1)}%`.padStart(9) +
      result.sharpe.toFixed(3).padStart(11) +
      `${result.maxDrawdown.toFixed(1)}%`.padStart(9) +
      `${result.winRate.toFixed(0)}%`.padStart(8) +
      String(result.totalTrades).padStart(10) +
      `${result.avgContracts.toFixed(1)}`.padStart(8) +
      `  ${sp.note}`
    );
  }

  // ── Part 4: Capital efficiency analysis ────────────────
  console.log('\n\n═══════════════════════════════════════════════════════════════════════');
  console.log('PART 4: Capital Efficiency — $ at risk per trade vs return');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  console.log(
    'Config'.padEnd(12) +
    'AvgRisk$'.padStart(10) +
    'AvgPrem$'.padStart(10) +
    'Prem/Risk'.padStart(11) +
    'AvgCts'.padStart(8) +
    'Capital%'.padStart(10) +
    'CAGR'.padStart(8) +
    'CAGR/Risk'.padStart(11) +
    '  Note'
  );
  console.log('-'.repeat(90));

  for (const row of fullResults) {
    const r = row.result;
    const premRiskRatio = r.avgMaxRisk > 0 ? (r.avgPremium * 100 / r.avgMaxRisk * 100).toFixed(1) : '--';
    const capitalUtilPct = (r.avgMaxRisk * r.avgContracts / STARTING_CAPITAL * 100).toFixed(1);
    const cagrPerRisk = r.avgMaxRisk > 0 ? (r.cagr / (r.avgMaxRisk * r.avgContracts / STARTING_CAPITAL * 100)).toFixed(2) : '--';

    console.log(
      row.label.padEnd(12) +
      `$${r.avgMaxRisk.toFixed(0)}`.padStart(10) +
      `$${(r.avgPremium * 100).toFixed(0)}`.padStart(10) +
      `${premRiskRatio}%`.padStart(11) +
      `${r.avgContracts.toFixed(1)}`.padStart(8) +
      `${capitalUtilPct}%`.padStart(10) +
      `${r.cagr.toFixed(1)}%`.padStart(8) +
      `${cagrPerRisk}`.padStart(11) +
      `  ${row.note}`
    );
  }

  // ── Save results ───────────────────────────────────────
  const outputDir = 'backtesting history/credit-spread/reports/spread-comparison';
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const output = {
    generatedAt: new Date().toISOString(),
    engine: 'post-audit, worst-side fills, honest pricing',
    startingCapital: STARTING_CAPITAL,
    riskPct: baseConfig.maxRiskPct,
    commission: baseConfig.commissionPerContract,
    ticker: 'QQQ',
    ema: 34,
    dte: DTE,
    direction: 'bull',
    compounding: true,
    fullPeriod: fullResults.map(r => ({
      label: r.label,
      note: r.note,
      finalEquity: r.result.finalEquity,
      totalPnl: r.result.totalPnl,
      cagr: r.result.cagr,
      sharpe: r.result.sharpe,
      maxDrawdown: r.result.maxDrawdown,
      winRate: r.result.winRate,
      totalTrades: r.result.totalTrades,
      avgPremium: r.result.avgPremium,
      avgMaxRisk: r.result.avgMaxRisk,
      avgContracts: r.result.avgContracts,
    })),
    wfa: wfaResults.map(r => ({
      label: r.label,
      note: r.note,
      finalEquity: r.wfa.finalEquity,
      oosPnl: r.wfa.oosPnl,
      oosCagr: r.wfa.oosCagr,
      oosSharpe: r.wfa.oosSharpe,
      oosMaxDD: r.wfa.oosMaxDD,
      oosTrades: r.wfa.oosTrades,
      oosWR: r.wfa.oosWR,
      posWindows: r.wfa.posWindows,
      totalWindows: r.wfa.totalWindows,
    })),
  };

  fs.writeFileSync(path.join(outputDir, 'spread-comparison.json'), JSON.stringify(output, null, 2));
  console.log(`\nResults saved to ${outputDir}/spread-comparison.json`);
}

main().catch(console.error);
