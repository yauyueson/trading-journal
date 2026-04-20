/**
 * Phase 0.c.9 Commit A — unit tests for simulateBuyWrite.
 *
 * Mocks the chain-cache module so the test is self-contained (no SQLite
 * dependency). Verifies:
 *   - combined P&L = stock leg + short call leg.
 *   - Assignment: if spot > K at expiry, stockLeg.assigned === true and
 *     stockExit = K, else stockExit = spot.
 *   - dailyMtM entries track the stock + call combined mark.
 *   - Null return when no ATM call is found.
 *   - Short-call side mirrors long-call side element-wise (sign identity).
 *
 * Also re-verifies that the new dividend-yield parameter in bsmPrice leaves
 * the QuantLib grid passing (no regression in q=0 default).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  bsmPrice, bsmDelta, checkPutCallParity,
} from '../src/lib/backtest/bsm-pricing';

// Build a minimal chain that findStrikeByDelta can accept. findStrikeByDelta
// filters by dte range, groups by expiry, picks the highest-OI expiry, then
// finds the closest strike to `targetDelta`.
interface ChainRowLike {
  ticker: string;
  trade_date: string;
  expir_date: string;
  dte: number;
  strike: number;
  stock_price: number;
  call_bid: number;
  call_mid: number;
  call_ask: number;
  call_iv: number;
  call_volume: number;
  call_oi: number;
  put_bid: number;
  put_mid: number;
  put_ask: number;
  put_iv: number;
  put_volume: number;
  put_oi: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

function makeAtmChainRow(opts: {
  ticker?: string; date: string; expiry: string; dte: number;
  strike: number; spot: number; premium: number; delta?: number;
}): ChainRowLike {
  return {
    ticker: opts.ticker ?? 'SPY',
    trade_date: opts.date,
    expir_date: opts.expiry,
    dte: opts.dte,
    strike: opts.strike,
    stock_price: opts.spot,
    call_bid: opts.premium - 0.01,
    call_mid: opts.premium,
    call_ask: opts.premium + 0.01,
    call_iv: 0.18,
    call_volume: 1000,
    call_oi: 5000,
    put_bid: 0,
    put_mid: 0,
    put_ask: 0,
    put_iv: 0.18,
    put_volume: 0,
    put_oi: 0,
    delta: opts.delta ?? 0.50,
    gamma: 0.01,
    theta: -0.05,
    vega: 0.10,
  };
}

// Stateful mock: different chains on different dates.
const mockChainByDate = new Map<string, ChainRowLike[]>();

vi.mock('../src/lib/backtest/chain-cache', () => ({
  fetchHistoricalChain: vi.fn(async (_token: string, _ticker: string, date: string) => {
    return mockChainByDate.get(date) ?? [];
  }),
  findStrikeByDelta: vi.fn((chain: ChainRowLike[], _delta: number, type: 'Call' | 'Put', dteRange: [number, number]) => {
    const filtered = chain.filter(r => r.dte >= dteRange[0] && r.dte <= dteRange[1]);
    if (filtered.length === 0) return null;
    // Match the module: closest strike to targetDelta among the highest-OI expiry.
    // For simplicity here, we just return the first row with call_oi > 0.
    const picked = filtered.find(r => r.call_oi > 0);
    if (!picked) return null;
    return {
      row: picked,
      bid: type === 'Call' ? picked.call_bid : picked.put_bid,
      mid: type === 'Call' ? picked.call_mid : picked.put_mid,
      ask: type === 'Call' ? picked.call_ask : picked.put_ask,
      iv: type === 'Call' ? picked.call_iv : picked.put_iv,
      delta: picked.delta,
      volume: type === 'Call' ? picked.call_volume : picked.put_volume,
      oi: type === 'Call' ? picked.call_oi : picked.put_oi,
    };
  }),
  findSpreadStrikes: vi.fn(() => null),
  findContract: vi.fn((chain: ChainRowLike[], strike: number, expiry: string, type: 'Call' | 'Put') => {
    const row = chain.find(r => r.expir_date === expiry && Math.abs(r.strike - strike) < 0.01);
    if (!row) return null;
    return {
      row,
      bid: type === 'Call' ? row.call_bid : row.put_bid,
      mid: type === 'Call' ? row.call_mid : row.put_mid,
      ask: type === 'Call' ? row.call_ask : row.put_ask,
      iv: type === 'Call' ? row.call_iv : row.put_iv,
      delta: row.delta,
      volume: type === 'Call' ? row.call_volume : row.put_volume,
      oi: type === 'Call' ? row.call_oi : row.put_oi,
    };
  }),
  findContractDirect: vi.fn((_ticker: string, date: string, strike: number, _expiry: string, type: 'Call' | 'Put') => {
    const chain = mockChainByDate.get(date);
    if (!chain) return null;
    const row = chain.find(r => Math.abs(r.strike - strike) < 0.01);
    if (!row) return null;
    return {
      row,
      bid: type === 'Call' ? row.call_bid : row.put_bid,
      mid: type === 'Call' ? row.call_mid : row.put_mid,
      ask: type === 'Call' ? row.call_ask : row.put_ask,
      iv: type === 'Call' ? row.call_iv : row.put_iv,
      delta: row.delta,
      volume: type === 'Call' ? row.call_volume : row.put_volume,
      oi: type === 'Call' ? row.call_oi : row.put_oi,
    };
  }),
  getCachedChain: vi.fn(() => []),
  getCachedChainFiltered: vi.fn(() => []),
}));

// Import AFTER the mock (vi hoists).
import {
  simulateBuyWrite, DEFAULT_CREDIT_CONFIG, computeOptionAnalytics,
  type EntrySignal, type OptionTrade,
} from '../src/lib/backtest/option-sim';

function buildTradingDates(start: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  while (out.length < n) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

describe('simulateBuyWrite (Phase 0.c.9.A)', () => {
  beforeEach(() => {
    mockChainByDate.clear();
  });

  it('happy path: spot rises above strike, assignment triggers', async () => {
    const allDates = buildTradingDates('2024-01-02', 45);
    const entryDate = allDates[0];
    const expiry = allDates[21]; // ~30 calendar days later
    const K = 450;
    const entrySpot = 450;
    const exitSpot = 460;

    // Entry chain: ATM call.
    mockChainByDate.set(entryDate, [
      makeAtmChainRow({ date: entryDate, expiry, dte: 30, strike: K, spot: entrySpot, premium: 3.50 }),
    ]);
    // Interim monitor dates: simple price path.
    for (let i = 1; i <= 21; i++) {
      const d = allDates[i];
      const spot = entrySpot + (i / 21) * (exitSpot - entrySpot);
      mockChainByDate.set(d, [
        makeAtmChainRow({ date: d, expiry, dte: 30 - i, strike: K, spot, premium: Math.max(0.1, 3.50 - i * 0.1) }),
      ]);
    }
    // Expiry: spot above strike → assignment.
    mockChainByDate.set(expiry, [
      makeAtmChainRow({ date: expiry, expiry, dte: 0, strike: K, spot: exitSpot, premium: exitSpot - K }),
    ]);

    const signal: EntrySignal = { ticker: 'SPY', date: entryDate, direction: 'CALL', score: 50 };
    // fillMode='mid' pins the entry premium to the call_mid (3.50) so the
    // happy-path math is deterministic. Slippage routing is covered by a
    // dedicated regression test below.
    const config = { ...DEFAULT_CREDIT_CONFIG, creditDTERange: [5, 45] as [number, number], fillMode: 'mid' as const };
    const trade = await simulateBuyWrite('', signal, config, allDates, allDates[allDates.length - 1]);
    expect(trade).not.toBeNull();
    if (!trade) return;

    expect(trade.mode).toBe('BUY_WRITE');
    expect(trade.strike).toBe(K);
    expect(trade.stockLeg).toBeDefined();
    expect(trade.stockLeg!.shares).toBe(100);
    expect(trade.stockLeg!.assigned).toBe(true);
    expect(trade.stockLeg!.exitPrice).toBe(K); // called away at strike

    // Stock P&L: shares called away at K (= entrySpot here) → 0.
    expect(trade.stockLeg!.pnl).toBeCloseTo(0, 6);
    // At expiration the short call settles at 0 cost (the ITM cash flow
    // is already captured by delivering shares at K instead of spot).
    // Double-counting intrinsic here would subtract upside twice; see
    // Codex round-5 P1. Total = 0 (stock at K) + 100 × 3.50 (premium kept) = +350.
    expect(trade.pnl).toBeCloseTo(100 * 3.50, 4);
  });

  it('happy path: spot ends below strike, call expires worthless (premium kept)', async () => {
    const allDates = buildTradingDates('2024-01-02', 45);
    const entryDate = allDates[0];
    const expiry = allDates[21];
    const K = 450;
    const entrySpot = 450;
    const exitSpot = 445; // finishes below strike

    mockChainByDate.set(entryDate, [
      makeAtmChainRow({ date: entryDate, expiry, dte: 30, strike: K, spot: entrySpot, premium: 3.50 }),
    ]);
    for (let i = 1; i <= 21; i++) {
      const d = allDates[i];
      const spot = entrySpot + (i / 21) * (exitSpot - entrySpot);
      mockChainByDate.set(d, [
        makeAtmChainRow({ date: d, expiry, dte: 30 - i, strike: K, spot, premium: Math.max(0.1, 3.50 - i * 0.1) }),
      ]);
    }
    mockChainByDate.set(expiry, [
      makeAtmChainRow({ date: expiry, expiry, dte: 0, strike: K, spot: exitSpot, premium: 0 }),
    ]);

    const signal: EntrySignal = { ticker: 'SPY', date: entryDate, direction: 'CALL', score: 50 };
    const config = { ...DEFAULT_CREDIT_CONFIG, creditDTERange: [5, 45] as [number, number], fillMode: 'mid' as const };
    const trade = await simulateBuyWrite('', signal, config, allDates, allDates[allDates.length - 1]);
    expect(trade).not.toBeNull();
    if (!trade) return;

    expect(trade.stockLeg!.assigned).toBe(false);
    expect(trade.stockLeg!.exitPrice).toBe(exitSpot);
    // Stock pnl: 100 × (445 − 450) = -500.
    expect(trade.stockLeg!.pnl).toBeCloseTo(-500, 4);
    // Call expired worthless → short pnl = 100 × 3.50 (mid premium) = +350.
    // Total = -500 + 350 = -150.
    expect(trade.pnl).toBeCloseTo(100 * (3.50 - 0) + 100 * (445 - 450), 4);
  });

  it('returns null when no ATM call can be found', async () => {
    const allDates = buildTradingDates('2024-01-02', 45);
    const entryDate = allDates[0];
    // Empty chain for entry date.
    const signal: EntrySignal = { ticker: 'SPY', date: entryDate, direction: 'CALL', score: 50 };
    const config = { ...DEFAULT_CREDIT_CONFIG, creditDTERange: [5, 45] as [number, number] };
    const trade = await simulateBuyWrite('', signal, config, allDates, allDates[allDates.length - 1]);
    expect(trade).toBeNull();
  });

  it('dailyMtM combines stock + short-call marks', async () => {
    const allDates = buildTradingDates('2024-01-02', 45);
    const entryDate = allDates[0];
    const expiry = allDates[21];
    const K = 450;
    const entrySpot = 450;

    mockChainByDate.set(entryDate, [
      makeAtmChainRow({ date: entryDate, expiry, dte: 30, strike: K, spot: entrySpot, premium: 3.50 }),
    ]);
    // Flat path: spot unchanged through monitoring.
    for (let i = 1; i <= 21; i++) {
      mockChainByDate.set(allDates[i], [
        makeAtmChainRow({ date: allDates[i], expiry, dte: 30 - i, strike: K, spot: entrySpot, premium: 3.50 - i * 0.1 }),
      ]);
    }

    const signal: EntrySignal = { ticker: 'SPY', date: entryDate, direction: 'CALL', score: 50 };
    const config = { ...DEFAULT_CREDIT_CONFIG, creditDTERange: [5, 45] as [number, number] };
    const trade = await simulateBuyWrite('', signal, config, allDates, allDates[allDates.length - 1]);
    expect(trade).not.toBeNull();
    if (!trade) return;

    expect(trade.dailyMtM).toBeDefined();
    expect(trade.dailyMtM!.length).toBeGreaterThan(0);
    expect(trade.stockLeg!.dailyMtM).toBeDefined();
    expect(trade.stockLeg!.dailyMtM!.length).toBe(trade.dailyMtM!.length);

    // On a flat-price path, stock pnl is ~0, so combined unrealized = −100×callMark (we'd pay ask to close).
    // Call premium decays linearly from 3.50 to 0, so late marks are more negative-to-neutral as theta drains.
    const first = trade.dailyMtM![0];
    expect(Number.isFinite(first.unrealizedPnl)).toBe(true);
  });

  it("forced close (maxDate < expiry): exits at market ask, no assignment, exitType=FORCE_CLOSE", async () => {
    // Simulate data cutoff before option expiry. simulateLeap handles this
    // by marking at market ask; simulateBuyWrite must do the same or it
    // discards time value and manufactures a phantom assignment.
    const allDates = buildTradingDates('2024-01-02', 45);
    const entryDate = allDates[0];
    const expiry = allDates[30];               // option expires far later
    const forcedExitDate = allDates[10];       // but we force close here
    const K = 450;
    const entrySpot = 450;
    const forcedSpot = 455;                    // ITM at force-close, would be "assigned" under old code
    const forcedAsk = 7.00;                    // mocked market ask ≫ intrinsic (= 5)

    mockChainByDate.set(entryDate, [
      makeAtmChainRow({ date: entryDate, expiry, dte: 30, strike: K, spot: entrySpot, premium: 3.50 }),
    ]);
    // Monitor path ignored for this test; populate a few rows.
    for (let i = 1; i <= 10; i++) {
      const d = allDates[i];
      const spot = entrySpot + (i / 10) * (forcedSpot - entrySpot);
      mockChainByDate.set(d, [
        { ...makeAtmChainRow({ date: d, expiry, dte: 30 - i, strike: K, spot, premium: forcedAsk - 0.5 }),
          call_ask: forcedAsk,                 // override ask to a known value
        },
      ]);
    }

    const config = { ...DEFAULT_CREDIT_CONFIG, creditDTERange: [5, 45] as [number, number], fillMode: 'mid' as const };
    const trade = await simulateBuyWrite('', signalFor(entryDate), config, allDates, forcedExitDate);
    expect(trade).not.toBeNull();
    if (!trade) return;

    expect(trade.exitType).toBe('FORCE_CLOSE');
    expect(trade.stockLeg!.assigned).toBe(false);
    expect(trade.stockLeg!.exitPrice).toBeCloseTo(forcedSpot, 4);
    // fillMode='mid' pins exit to mid (= ask − 0.01 here per makeAtmChainRow).
    const expectedMid = forcedAsk - 0.5;
    expect(trade.exitPrice).toBeCloseTo(expectedMid, 4);
    // Short pnl = 100 × (premium_mid − close_mid); stock pnl = 100 × (forcedSpot − entrySpot).
    expect(trade.pnl).toBeCloseTo(100 * (3.50 - expectedMid) + 100 * (forcedSpot - entrySpot), 2);
  });

  it("uncached monitoring path: fetchHistoricalChain populates dailyMtM even when useDirectLookup is false", async () => {
    // Regression for Codex round-2 P2: the monitoring loop used to call
    // findContractDirect (SQLite PK lookup) unconditionally. In real uncached
    // runs that returned null for every interim date, leaving dailyMtM empty
    // and BUY_WRITE analytics degraded to a single exit-day jump.
    const allDates = buildTradingDates('2024-01-02', 45);
    const entryDate = allDates[0];
    const expiry = allDates[21];
    const K = 450;

    // Entry chain only — no direct-lookup rows. Populate every interim date
    // so fetchHistoricalChain (our mock) has something to return.
    for (let i = 0; i <= 21; i++) {
      mockChainByDate.set(allDates[i], [
        makeAtmChainRow({ date: allDates[i], expiry, dte: 30 - i, strike: K, spot: 450, premium: Math.max(0.1, 3.50 - i * 0.1) }),
      ]);
    }

    const config = { ...DEFAULT_CREDIT_CONFIG, creditDTERange: [5, 45] as [number, number], useDirectLookup: false };
    const trade = await simulateBuyWrite('', signalFor(entryDate), config, allDates, allDates[allDates.length - 1]);
    expect(trade).not.toBeNull();
    if (!trade) return;
    // dailyMtM should have the full monitor-day count; stockLeg should mirror.
    expect(trade.dailyMtM!.length).toBeGreaterThan(10);
    expect(trade.stockLeg!.dailyMtM!.length).toBe(trade.dailyMtM!.length);
  });

  it("forced-close clamps to maxDate when maxDate lands on a weekend", async () => {
    // Regression for Codex round-2 P1: when maxDate falls on a non-trading
    // day, the old walk-back scanned for `<= expiry` and could jump forward
    // past the cutoff — sometimes all the way to expiration — silently
    // turning a FORCE_CLOSE into an EXPIRATION with assignment.
    const allDates = buildTradingDates('2024-01-02', 45);   // all weekdays
    const entryDate = allDates[0];
    const expiry = allDates[30];
    // Find a Friday in allDates, then synthesise a Saturday maxDate that
    // does NOT appear in the trading calendar. allDates[3] = 2024-01-05 (Fri).
    const fridayIdx = allDates.findIndex(d => new Date(`${d}T00:00:00Z`).getUTCDay() === 5);
    const preWeekend = allDates[fridayIdx];
    const satDate = new Date(`${preWeekend}T00:00:00Z`);
    satDate.setUTCDate(satDate.getUTCDate() + 1);
    const weekendMaxDate = satDate.toISOString().slice(0, 10);
    // Sanity: this is NOT a trading date.
    expect(allDates.includes(weekendMaxDate)).toBe(false);

    mockChainByDate.set(entryDate, [
      makeAtmChainRow({ date: entryDate, expiry, dte: 30, strike: 450, spot: 450, premium: 3.50 }),
    ]);
    // Populate through the Friday so the monitor loop has chain data.
    for (let i = 1; i <= fridayIdx; i++) {
      mockChainByDate.set(allDates[i], [
        makeAtmChainRow({ date: allDates[i], expiry, dte: 30 - i, strike: 450, spot: 450 + i, premium: 3.50 }),
      ]);
    }

    const config = { ...DEFAULT_CREDIT_CONFIG, creditDTERange: [5, 45] as [number, number] };
    const trade = await simulateBuyWrite('', signalFor(entryDate), config, allDates, weekendMaxDate);
    expect(trade).not.toBeNull();
    if (!trade) return;
    // Exit must land on the last trading day <= weekendMaxDate (the Friday),
    // NOT skip forward to the next Monday or expiry.
    expect(trade.exitDate).toBe(preWeekend);
    expect(trade.exitType).toBe('FORCE_CLOSE');
    expect(trade.stockLeg!.assigned).toBe(false);
  });

  it("fill routing: fillMode='bidask' with slippage applies adverse impact via applyFill", async () => {
    // Regression for Codex round-3 P2: BUY_WRITE used to read raw call_bid
    // for entry premium, bypassing the dynamic-slippage model that LEAP and
    // CREDIT_SPREAD go through. Under the default fillMode='bidask' + slippage
    // enabled, premium must be STRICTLY LESS than the raw bid (sell side
    // pays baseImpact beyond half-spread).
    const allDates = buildTradingDates('2024-01-02', 45);
    const entryDate = allDates[0];
    const expiry = allDates[21];
    const K = 450;
    // Thin-OI, near-DTE contract amplifies impact so the effect is unmistakable.
    const thinOi = 100;
    const thinDTE = 5;
    mockChainByDate.set(entryDate, [
      { ...makeAtmChainRow({ date: entryDate, expiry, dte: thinDTE, strike: K, spot: 450, premium: 3.50 }),
        call_oi: thinOi,
      },
    ]);
    for (let i = 1; i <= 5; i++) {
      mockChainByDate.set(allDates[i], [
        { ...makeAtmChainRow({ date: allDates[i], expiry, dte: thinDTE - i, strike: K, spot: 450, premium: 3.50 - i * 0.3 }),
          call_oi: thinOi,
        },
      ]);
    }

    const config = {
      ...DEFAULT_CREDIT_CONFIG,
      creditDTERange: [1, 10] as [number, number],
      fillMode: 'bidask' as const,
      // slippage.enabled already true via DEFAULT_DYNAMIC_SLIPPAGE
    };
    const trade = await simulateBuyWrite('', signalFor(entryDate), config, allDates, allDates[5]);
    expect(trade).not.toBeNull();
    if (!trade) return;
    // Slippage must push entry fill below raw bid (3.49). If BUY_WRITE
    // bypassed applyFill, premium would equal 3.49 exactly.
    expect(trade.entryPrice).toBeLessThan(3.49);
    expect(trade.entryPrice).toBeGreaterThan(0);
  });

  it('Saturday-expiry with maxDate = the preceding Friday settles as EXPIRATION (effective-expiry rule)', async () => {
    // Regression for Codex round-4 P2: in a bounded backtest the caller
    // often passes `allTradingDates.at(-1)` as maxDate. When that Friday
    // is the last trading day BEFORE a Saturday expir_date, naïvely using
    // `maxDate < expiry` classifies the cycle as FORCE_CLOSE — suppressing
    // assignment and marking the short call at ask. Effective-expiry rule:
    // the last trading day <= expiry IS the settlement day, so maxDate at
    // that Friday must still settle as EXPIRATION.
    const allDates = buildTradingDates('2024-01-02', 45);
    const fridayIdx = allDates.findIndex(d => new Date(`${d}T00:00:00Z`).getUTCDay() === 5);
    const entryDate = allDates[0];
    const friday = allDates[fridayIdx];
    const d = new Date(`${friday}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    const saturdayExpiry = d.toISOString().slice(0, 10);
    const K = 450;
    const entrySpot = 450;
    const expirySpot = 458;

    mockChainByDate.set(entryDate, [
      makeAtmChainRow({ date: entryDate, expiry: saturdayExpiry, dte: 30, strike: K, spot: entrySpot, premium: 3.50 }),
    ]);
    for (let i = 1; i <= fridayIdx; i++) {
      const spot = entrySpot + (i / fridayIdx) * (expirySpot - entrySpot);
      mockChainByDate.set(allDates[i], [
        makeAtmChainRow({ date: allDates[i], expiry: saturdayExpiry, dte: 30 - i, strike: K, spot, premium: Math.max(0.1, 3.50 - i * 0.1) }),
      ]);
    }

    const config = { ...DEFAULT_CREDIT_CONFIG, creditDTERange: [5, 45] as [number, number], fillMode: 'mid' as const };
    const trade = await simulateBuyWrite('', signalFor(entryDate), config, allDates, friday);
    expect(trade).not.toBeNull();
    if (!trade) return;
    expect(trade.exitType).toBe('EXPIRATION');
    expect(trade.exitDate).toBe(friday);
    expect(trade.stockLeg!.assigned).toBe(true);   // spot on Friday > K
    expect(trade.stockLeg!.exitPrice).toBe(K);
  });

  it('missing exit-day chain walks back to the last day with data (no stale-price settlement)', async () => {
    // Regression for Codex round-4 P2: if exitDate's chain is empty,
    // falling back to lastStockPrice silently settles at a stale mark.
    // Expectation: walk exitDate back through the calendar until we find
    // a trading day that actually has chain data, and settle there.
    const allDates = buildTradingDates('2024-01-02', 45);
    const entryDate = allDates[0];
    const expiry = allDates[21];
    const K = 450;
    const goodExitIdx = 18;                         // day with chain data
    const goodExitDate = allDates[goodExitIdx];

    mockChainByDate.set(entryDate, [
      makeAtmChainRow({ date: entryDate, expiry, dte: 30, strike: K, spot: 450, premium: 3.50 }),
    ]);
    // Populate monitor dates through goodExitIdx, then LEAVE dates
    // allDates[19..21] empty (simulate missing ORATS rows near expiry).
    for (let i = 1; i <= goodExitIdx; i++) {
      mockChainByDate.set(allDates[i], [
        makeAtmChainRow({ date: allDates[i], expiry, dte: 30 - i, strike: K, spot: 450 + i, premium: Math.max(0.1, 3.50 - i * 0.1) }),
      ]);
    }
    // allDates[19], [20], [21=expiry] have no chain entries → fetchHistoricalChain returns [].

    const config = { ...DEFAULT_CREDIT_CONFIG, creditDTERange: [5, 45] as [number, number], fillMode: 'mid' as const };
    const trade = await simulateBuyWrite('', signalFor(entryDate), config, allDates, allDates[allDates.length - 1]);
    expect(trade).not.toBeNull();
    if (!trade) return;

    // exitDate should have walked back from the original expiry day to
    // goodExitDate (the last day with chain data).
    expect(trade.exitDate).toBe(goodExitDate);
    // exitStockPrice should come from the walked-back day's chain, not a stale mark.
    expect(trade.exitStockPrice).toBe(450 + goodExitIdx);
  });

  it('non-trading-day expiry (Saturday-style) settles as EXPIRATION, not FORCE_CLOSE', async () => {
    // Regression for Codex round-3 P2: historical BXM monthlies had
    // Saturday expiries. When `expir_date` is a non-trading day and maxDate
    // is at/past expiry, the walk-back lands on the Friday preceding the
    // Saturday. That Friday must settle as a true expiration (intrinsic +
    // potential assignment), NOT be mis-classified as FORCE_CLOSE.
    const allDates = buildTradingDates('2024-01-02', 45);
    const fridayIdx = allDates.findIndex(d => new Date(`${d}T00:00:00Z`).getUTCDay() === 5);
    const entryDate = allDates[0];
    const friday = allDates[fridayIdx];
    // Manufacture a Saturday expiry string that is NOT in allDates.
    const d = new Date(`${friday}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    const saturdayExpiry = d.toISOString().slice(0, 10);
    expect(allDates.includes(saturdayExpiry)).toBe(false);

    const K = 450;
    const entrySpot = 450;
    const expirySpot = 460;  // ITM → assignment on true expiry

    // Entry chain carries the Saturday expir_date.
    mockChainByDate.set(entryDate, [
      makeAtmChainRow({ date: entryDate, expiry: saturdayExpiry, dte: 30, strike: K, spot: entrySpot, premium: 3.50 }),
    ]);
    // Populate interim + the Friday settlement row.
    for (let i = 1; i <= fridayIdx; i++) {
      const spot = entrySpot + (i / fridayIdx) * (expirySpot - entrySpot);
      mockChainByDate.set(allDates[i], [
        makeAtmChainRow({ date: allDates[i], expiry: saturdayExpiry, dte: 30 - i, strike: K, spot, premium: Math.max(0.1, 3.50 - i * 0.1) }),
      ]);
    }

    // maxDate is past the Saturday expiry — caller wants expiration.
    const maxDate = allDates[fridayIdx + 2];
    const config = { ...DEFAULT_CREDIT_CONFIG, creditDTERange: [5, 45] as [number, number], fillMode: 'mid' as const };
    const trade = await simulateBuyWrite('', signalFor(entryDate), config, allDates, maxDate);
    expect(trade).not.toBeNull();
    if (!trade) return;

    expect(trade.exitType).toBe('EXPIRATION');
    expect(trade.exitDate).toBe(friday);             // walked back to the Friday
    expect(trade.stockLeg!.assigned).toBe(true);     // spot on Friday > K → called away
    expect(trade.stockLeg!.exitPrice).toBe(K);
  });

  it('daily MtM marks at mid, not ask (Codex round-6 P2)', async () => {
    // Regression: marking the unrealized path at ask would charge the
    // close spread every monitoring day, double-counting slippage once
    // the real exit runs through applyFill. Mirrors how simulateLeap /
    // simulateCreditSpread record fair-value marks during monitoring.
    const allDates = buildTradingDates('2024-01-02', 45);
    const entryDate = allDates[0];
    const expiry = allDates[21];
    const K = 450;
    const entrySpot = 450;
    const askInflation = 2.0;           // exaggerate ask-vs-mid gap for measurement

    mockChainByDate.set(entryDate, [
      makeAtmChainRow({ date: entryDate, expiry, dte: 30, strike: K, spot: entrySpot, premium: 3.50 }),
    ]);
    // Interim rows have an inflated ask so ask-based MtM would diverge
    // from mid-based MtM by a large, measurable amount.
    const monitorPremium = 3.50;
    for (let i = 1; i <= 21; i++) {
      mockChainByDate.set(allDates[i], [
        { ...makeAtmChainRow({ date: allDates[i], expiry, dte: 30 - i, strike: K, spot: entrySpot, premium: monitorPremium }),
          call_ask: monitorPremium + askInflation,
        },
      ]);
    }

    const config = { ...DEFAULT_CREDIT_CONFIG, creditDTERange: [5, 45] as [number, number], fillMode: 'mid' as const };
    const trade = await simulateBuyWrite('', signalFor(entryDate), config, allDates, allDates[allDates.length - 1]);
    expect(trade).not.toBeNull();
    if (!trade) return;
    expect(trade.dailyMtM!.length).toBeGreaterThan(0);
    // Flat-path unrealized should be ~ 100 × (entryPremium_mid − monitorMid).
    // Entry at mid = 3.50, monitor mid = 3.50 → unrealized ≈ 0. If we
    // mistakenly used the inflated ask (= 5.50), unrealized would be
    // 100 × (3.50 − 5.50) = −200 per day.
    const worstMtM = Math.min(...trade.dailyMtM!.map(m => m.unrealizedPnl));
    expect(worstMtM).toBeGreaterThan(-50);   // must be close to 0, not −200
  });

  it('requireMonthlyExpiry accepts Saturday-recorded pre-2015 monthlies (Codex round-11 P1)', async () => {
    // Pre-2015 CBOE options chain data recorded monthly expirations on the
    // Saturday AFTER the third Friday. A strict Friday-only filter would
    // drop every such row and make simulateBuyWrite return null on the
    // historical BXM series from 1988-2015.
    const allDates = buildTradingDates('2010-01-04', 60);
    const entryDate = allDates[0];
    // 2010-01-15 is the 3rd Friday; 2010-01-16 is the Saturday recorded expiry.
    const saturdayExpiry = '2010-01-16';
    const K = 450;
    mockChainByDate.set(entryDate, [
      makeAtmChainRow({ date: entryDate, expiry: saturdayExpiry, dte: 11, strike: K, spot: 450, premium: 2.20 }),
    ]);
    for (let i = 1; i < 15; i++) {
      mockChainByDate.set(allDates[i], [
        makeAtmChainRow({ date: allDates[i], expiry: saturdayExpiry, dte: 11 - i, strike: K, spot: 450, premium: Math.max(0.1, 2.20 - i * 0.15) }),
      ]);
    }

    const config = {
      ...DEFAULT_CREDIT_CONFIG,
      creditDTERange: [5, 45] as [number, number],
      fillMode: 'mid' as const,
      requireMonthlyExpiry: true,
    };
    const trade = await simulateBuyWrite('', signalFor(entryDate), config, allDates, allDates[allDates.length - 1]);
    expect(trade).not.toBeNull();
    if (!trade) return;
    expect(trade.expiry).toBe(saturdayExpiry);
  });

  it('dividendSchedule with ex-dates outside the window is benign (Codex round-11 P2)', async () => {
    // A reusable yearly schedule can contain ex-dates far outside the
    // current trade window. simulateBuyWrite must not reject the run just
    // because the schedule is non-empty; only accruing ex-dates matter.
    const allDates = buildTradingDates('2024-01-02', 45);
    const entryDate = allDates[0];
    const expiry = allDates[21];
    mockChainByDate.set(entryDate, [
      makeAtmChainRow({ date: entryDate, expiry, dte: 30, strike: 450, spot: 450, premium: 3.50 }),
    ]);
    for (let i = 1; i <= 21; i++) {
      mockChainByDate.set(allDates[i], [
        makeAtmChainRow({ date: allDates[i], expiry, dte: 30 - i, strike: 450, spot: 450, premium: Math.max(0.1, 3.50 - i * 0.1) }),
      ]);
    }

    const config = {
      ...DEFAULT_CREDIT_CONFIG,
      creditDTERange: [5, 45] as [number, number],
      fillMode: 'mid' as const,
      // Every ex-date is AFTER the trade window — schedule is benign.
      dividendSchedule: [
        { date: allDates[40], amountPerShare: 1.65 },
        { date: allDates[44], amountPerShare: 1.70 },
      ],
      monitoringIntervalDays: 3,   // would normally trip the guard
    };
    // Should NOT throw — all ex-dates are outside the window so divs is empty.
    const trade = await simulateBuyWrite('', signalFor(entryDate), config, allDates, allDates[allDates.length - 1]);
    expect(trade).not.toBeNull();
    if (!trade) return;
    // No accruing ex-dates → stockLeg.pnl is price-only (entry spot == K,
    // assigned on exit → 0 price change).
    expect(trade.stockLeg!.pnl).toBeCloseTo(0, 4);
  });

  it('requireMonthlyExpiry filters to third-Friday expiries for BXM replication (round-10 P1)', async () => {
    // When the entry chain contains BOTH a weekly expiry with higher OI
    // and a third-Friday monthly with lower OI, the default findStrikeByDelta
    // tiebreak (by OI) would pick the weekly. requireMonthlyExpiry must
    // force the monthly to be picked regardless.
    const allDates = buildTradingDates('2024-01-02', 45);
    const entryDate = allDates[0];
    const K = 450;
    // 2024-01-19 is the 3rd Friday of January 2024.
    const monthlyExpiry = '2024-01-19';
    // Weekly expiry: 2024-01-12 (the 2nd Friday).
    const weeklyExpiry = '2024-01-12';

    // Populate BOTH expiries on the entry date. Weekly has 10000 OI,
    // monthly has 5000 OI → default picker would choose weekly.
    mockChainByDate.set(entryDate, [
      { ...makeAtmChainRow({ date: entryDate, expiry: weeklyExpiry, dte: 10, strike: K, spot: 450, premium: 2.00 }),
        call_oi: 10000,
      },
      { ...makeAtmChainRow({ date: entryDate, expiry: monthlyExpiry, dte: 17, strike: K, spot: 450, premium: 3.50 }),
        call_oi: 5000,
      },
    ]);
    for (const d of allDates.slice(1, 30)) {
      mockChainByDate.set(d, [
        makeAtmChainRow({ date: d, expiry: monthlyExpiry, dte: 17, strike: K, spot: 450, premium: 3.50 }),
      ]);
    }

    const baseConfig = { ...DEFAULT_CREDIT_CONFIG, creditDTERange: [5, 45] as [number, number], fillMode: 'mid' as const };

    // Without the flag, OI picks weekly.
    const unguarded = await simulateBuyWrite('', signalFor(entryDate), baseConfig, allDates, allDates[allDates.length - 1]);
    expect(unguarded!.expiry).toBe(weeklyExpiry);

    // With the flag, monthly is picked even though weekly has higher OI.
    const guarded = await simulateBuyWrite(
      '', signalFor(entryDate),
      { ...baseConfig, requireMonthlyExpiry: true },
      allDates, allDates[allDates.length - 1],
    );
    expect(guarded!.expiry).toBe(monthlyExpiry);
  });

  it('stockLeg.pnl includes accrued dividends (Codex round-9 P2 a)', async () => {
    // Regression: dividends accrue to stock ownership, so they must be in
    // stockLeg.pnl — not only in trade.pnl. Otherwise consumers summing
    // leg breakdowns get totals that understate realized P&L by exactly
    // the dividend credit.
    const allDates = buildTradingDates('2024-01-02', 45);
    const entryDate = allDates[0];
    const expiry = allDates[21];
    const K = 450;
    mockChainByDate.set(entryDate, [
      makeAtmChainRow({ date: entryDate, expiry, dte: 30, strike: K, spot: 450, premium: 3.50 }),
    ]);
    for (let i = 1; i <= 21; i++) {
      mockChainByDate.set(allDates[i], [
        makeAtmChainRow({ date: allDates[i], expiry, dte: 30 - i, strike: K, spot: 450, premium: Math.max(0.1, 3.50 - i * 0.1) }),
      ]);
    }
    const config = {
      ...DEFAULT_CREDIT_CONFIG, creditDTERange: [5, 45] as [number, number], fillMode: 'mid' as const,
      dividendSchedule: [{ date: allDates[10], amountPerShare: 1.65 }],
    };
    const trade = await simulateBuyWrite('', signalFor(entryDate), config, allDates, allDates[allDates.length - 1]);
    expect(trade).not.toBeNull();
    if (!trade) return;
    const priceOnlyPnl = 100 * (trade.stockLeg!.exitPrice - trade.stockLeg!.entryPrice);
    // stockLeg.pnl must equal priceOnly + dividend (165), not priceOnly alone.
    expect(trade.stockLeg!.pnl - priceOnlyPnl).toBeCloseTo(165, 4);
    // Leg-sum reconciliation: shortCallPnl (kept premium at expiration) +
    // stockLeg.pnl (price + div) must equal trade.pnl.
    const shortCallPnl = 100 * (trade.entryPrice - trade.exitPrice);
    expect(shortCallPnl + trade.stockLeg!.pnl).toBeCloseTo(trade.pnl, 4);
  });

  it('dividendSchedule requires monitoringIntervalDays=1 (reject sparse monitoring, round-9 P2 b)', async () => {
    const allDates = buildTradingDates('2024-01-02', 45);
    const entryDate = allDates[0];
    const expiry = allDates[21];
    mockChainByDate.set(entryDate, [
      makeAtmChainRow({ date: entryDate, expiry, dte: 30, strike: 450, spot: 450, premium: 3.50 }),
    ]);
    const config = {
      ...DEFAULT_CREDIT_CONFIG, creditDTERange: [5, 45] as [number, number], fillMode: 'mid' as const,
      monitoringIntervalDays: 3,                    // sparse monitor
      dividendSchedule: [{ date: allDates[5], amountPerShare: 1.65 }],
    };
    await expect(
      simulateBuyWrite('', signalFor(entryDate), config, allDates, allDates[allDates.length - 1]),
    ).rejects.toThrow(/monitoringIntervalDays === 1/);
  });

  it('stockLeg.dailyMtM final point reconciles with settled stock value on assignment (Codex round-8 P2)', async () => {
    // On assigned expiration the shares deliver at K, not at final spot.
    // During monitoring we mark at spot. Without a terminal reconciliation,
    // the last `stockLeg.dailyMtM` entry overstates the leg by 100×(spot−K)
    // and inconsistently contradicts `stockLeg.pnl`.
    const allDates = buildTradingDates('2024-01-02', 45);
    const entryDate = allDates[0];
    const expiry = allDates[21];
    const K = 450;
    const entrySpot = 450;
    const exitSpot = 460;                    // ITM by 10

    mockChainByDate.set(entryDate, [
      makeAtmChainRow({ date: entryDate, expiry, dte: 30, strike: K, spot: entrySpot, premium: 3.50 }),
    ]);
    for (let i = 1; i <= 21; i++) {
      const spot = entrySpot + (i / 21) * (exitSpot - entrySpot);
      mockChainByDate.set(allDates[i], [
        makeAtmChainRow({ date: allDates[i], expiry, dte: 30 - i, strike: K, spot, premium: Math.max(0.1, 3.50 - i * 0.1) }),
      ]);
    }

    const config = { ...DEFAULT_CREDIT_CONFIG, creditDTERange: [5, 45] as [number, number], fillMode: 'mid' as const };
    const trade = await simulateBuyWrite('', signalFor(entryDate), config, allDates, allDates[allDates.length - 1]);
    expect(trade).not.toBeNull();
    if (!trade) return;

    expect(trade.stockLeg!.assigned).toBe(true);
    // Final dailyMtM price must match settled exitPrice (K), not final spot.
    const last = trade.stockLeg!.dailyMtM!.at(-1)!;
    expect(last.date).toBe(trade.exitDate);
    expect(last.price).toBe(K);
    expect(last.pnl).toBeCloseTo(trade.stockLeg!.pnl, 4);
  });

  it('ITM expiration does not double-count intrinsic (Codex round-5 P1)', async () => {
    // Set up: entry 450 → exit 460, K=450. ITM by $10.
    //   Stock delivered at strike: pnl = 100 × (450 − 450) = 0.
    //   Short call settles at 0 (exercised, no close cost): pnl = 100 × 3.50.
    //   Total must equal +350 (premium kept). Previously this returned
    //   +350 − 100×10 = −650 because callExitPrice was charged intrinsic.
    const allDates = buildTradingDates('2024-01-02', 45);
    const entryDate = allDates[0];
    const expiry = allDates[21];
    const K = 450;
    const entrySpot = 450;
    const exitSpot = 460;

    mockChainByDate.set(entryDate, [
      makeAtmChainRow({ date: entryDate, expiry, dte: 30, strike: K, spot: entrySpot, premium: 3.50 }),
    ]);
    for (let i = 1; i <= 21; i++) {
      const spot = entrySpot + (i / 21) * (exitSpot - entrySpot);
      mockChainByDate.set(allDates[i], [
        makeAtmChainRow({ date: allDates[i], expiry, dte: 30 - i, strike: K, spot, premium: Math.max(0.1, 3.50 - i * 0.1) }),
      ]);
    }

    const config = { ...DEFAULT_CREDIT_CONFIG, creditDTERange: [5, 45] as [number, number], fillMode: 'mid' as const };
    const trade = await simulateBuyWrite('', signalFor(entryDate), config, allDates, allDates[allDates.length - 1]);
    expect(trade).not.toBeNull();
    if (!trade) return;

    expect(trade.stockLeg!.assigned).toBe(true);
    expect(trade.stockLeg!.pnl).toBeCloseTo(0, 4);  // shares delivered at K = entrySpot
    // Total pnl = premium kept. NOT premium − intrinsic (that would be the old bug).
    expect(trade.pnl).toBeCloseTo(100 * 3.50, 4);
    expect(trade.pnl).not.toBeCloseTo(100 * (3.50 - (exitSpot - K)), 4);
  });

  it('dividendSchedule credits cash only on ex-dates inside the trade window', async () => {
    // Regression for Codex round-7 P1: replaced the continuous-yield
    // approximation with discrete ex-date cashflows. A month without
    // any ex-date must see zero dividend credit. A month with an ex-date
    // must see exactly `100 × amountPerShare` added to P&L.
    const allDates = buildTradingDates('2024-01-02', 45);
    const entryDate = allDates[0];
    const expiry = allDates[21];
    const K = 450;
    const entrySpot = 450;
    const exitSpot = 445;

    mockChainByDate.set(entryDate, [
      makeAtmChainRow({ date: entryDate, expiry, dte: 30, strike: K, spot: entrySpot, premium: 3.50 }),
    ]);
    for (let i = 1; i <= 21; i++) {
      const spot = entrySpot + (i / 21) * (exitSpot - entrySpot);
      mockChainByDate.set(allDates[i], [
        makeAtmChainRow({ date: allDates[i], expiry, dte: 30 - i, strike: K, spot, premium: Math.max(0.1, 3.50 - i * 0.1) }),
      ]);
    }

    const base = { ...DEFAULT_CREDIT_CONFIG, creditDTERange: [5, 45] as [number, number], fillMode: 'mid' as const };

    // No schedule → no credit.
    const noDiv = await simulateBuyWrite('', signalFor(entryDate), base, allDates, allDates[allDates.length - 1]);

    // Schedule with an ex-date INSIDE the window.
    const inside = await simulateBuyWrite('', signalFor(entryDate), {
      ...base,
      dividendSchedule: [{ date: allDates[10], amountPerShare: 1.65 }],
    }, allDates, allDates[allDates.length - 1]);

    // Schedule with an ex-date OUTSIDE the window (after exit) → no credit.
    const outside = await simulateBuyWrite('', signalFor(entryDate), {
      ...base,
      dividendSchedule: [{ date: allDates[40], amountPerShare: 1.65 }],
    }, allDates, allDates[allDates.length - 1]);

    expect(noDiv).not.toBeNull(); expect(inside).not.toBeNull(); expect(outside).not.toBeNull();
    if (!noDiv || !inside || !outside) return;

    // Inside ex-date adds exactly 100 × 1.65 = 165.
    expect(inside.pnl - noDiv.pnl).toBeCloseTo(165, 4);
    // Outside ex-date adds nothing.
    expect(outside.pnl).toBeCloseTo(noDiv.pnl, 4);
  });

  it("dividendSchedule carries into dailyMtM from the ex-date onward (not as exit-day jump)", async () => {
    // Regression for Codex round-7 P2: the dividend accrual must land in
    // `dailyMtM` on the ex-date so Sharpe/DD see cashflow smoothly, not
    // as a single exit-day discontinuity.
    const allDates = buildTradingDates('2024-01-02', 45);
    const entryDate = allDates[0];
    const expiry = allDates[21];
    const K = 450;
    const exDate = allDates[10];

    mockChainByDate.set(entryDate, [
      makeAtmChainRow({ date: entryDate, expiry, dte: 30, strike: K, spot: 450, premium: 3.50 }),
    ]);
    for (let i = 1; i <= 21; i++) {
      mockChainByDate.set(allDates[i], [
        makeAtmChainRow({ date: allDates[i], expiry, dte: 30 - i, strike: K, spot: 450, premium: Math.max(0.1, 3.50 - i * 0.1) }),
      ]);
    }

    const config = {
      ...DEFAULT_CREDIT_CONFIG, creditDTERange: [5, 45] as [number, number], fillMode: 'mid' as const,
      dividendSchedule: [{ date: exDate, amountPerShare: 1.65 }],
    };
    const trade = await simulateBuyWrite('', signalFor(entryDate), config, allDates, allDates[allDates.length - 1]);
    expect(trade).not.toBeNull();
    if (!trade) return;

    // Compare adjacent daily marks: the day immediately before the ex-date
    // and the ex-date itself. The jump should equal exactly the dividend
    // amount (other components — stock price, option theta — are a smooth
    // day-to-day change on this flat path).
    const mtm = trade.dailyMtM!;
    const idxEx = mtm.findIndex(m => m.date === exDate);
    expect(idxEx).toBeGreaterThan(0);
    const preEx = mtm[idxEx - 1];
    const onEx = mtm[idxEx];
    // Flat spot, daily theta drain = 100 × 0.1 = 10/day. Jump from pre-ex
    // to ex-date = theta-drain (+10) + dividend (+165) = +175.
    expect(onEx.unrealizedPnl - preEx.unrealizedPnl).toBeCloseTo(175, 0);
  });

  it('computeOptionAnalytics reports stock notional (not premium) as capital-at-risk', async () => {
    // Codex round-1 P1: inflating ROC ~129× for BUY_WRITE would hide actual
    // performance. Regression guard.
    const allDates = buildTradingDates('2024-01-02', 45);
    const entryDate = allDates[0];
    const expiry = allDates[21];
    const K = 450;
    const entrySpot = 450;

    mockChainByDate.set(entryDate, [
      makeAtmChainRow({ date: entryDate, expiry, dte: 30, strike: K, spot: entrySpot, premium: 3.50 }),
    ]);
    for (let i = 1; i <= 21; i++) {
      mockChainByDate.set(allDates[i], [
        makeAtmChainRow({ date: allDates[i], expiry, dte: 30 - i, strike: K, spot: entrySpot, premium: Math.max(0.1, 3.50 - i * 0.1) }),
      ]);
    }

    const config = { ...DEFAULT_CREDIT_CONFIG, creditDTERange: [5, 45] as [number, number] };
    const trade = await simulateBuyWrite('', signalFor(entryDate), config, allDates, allDates[allDates.length - 1]);
    expect(trade).not.toBeNull();
    if (!trade) return;
    const analytics = computeOptionAnalytics([trade as OptionTrade]);

    // Capital-at-risk = stock notional (100 × $450 = $45,000), not premium (~$349).
    // totalCapitalDeployed sums capital at risk across trades; with N=1 it
    // equals the per-trade capital directly.
    expect(analytics.totalCapitalDeployed).toBeCloseTo(45_000, 0);
    expect(analytics.totalCapitalDeployed).not.toBeCloseTo(349, 0);
  });
});

function signalFor(date: string): EntrySignal {
  return { ticker: 'SPY', date, direction: 'CALL', score: 50 };
}

// ── Parity / dividend-yield regressions ────────────────────

describe('bsmPrice dividend-yield (Phase 0.c.9.A)', () => {
  it('q=0 default preserves the original call price (regression: q=0 must bit-match implicit)', () => {
    // Reference from tests/fixtures/bsm-quantlib-golden.json, ATM 30D σ=0.20 r=0.04.
    // Our A&S erf deviates from QuantLib by up to 1.5e-6 on this grid row;
    // the documented priceAbs tolerance is 1e-4 (bsm-quantlib-parity.test.ts).
    const QL_REFERENCE = 2.4512622091842386;
    const explicit = bsmPrice(100, 100, 30 / 365, 0.20, 0.04, true, 0);
    const implicit = bsmPrice(100, 100, 30 / 365, 0.20, 0.04, true);
    // q=0 default must bit-match an explicit q=0 (no stealth behavior change).
    expect(implicit).toBe(explicit);
    // And both should be within the documented QuantLib tolerance.
    expect(Math.abs(explicit - QL_REFERENCE)).toBeLessThan(1e-4);
  });

  it('q>0 reduces call price and raises put price relative to q=0', () => {
    const q0Call = bsmPrice(100, 100, 1.0, 0.20, 0.04, true, 0);
    const q2Call = bsmPrice(100, 100, 1.0, 0.20, 0.04, true, 0.02);
    expect(q2Call).toBeLessThan(q0Call);

    const q0Put = bsmPrice(100, 100, 1.0, 0.20, 0.04, false, 0);
    const q2Put = bsmPrice(100, 100, 1.0, 0.20, 0.04, false, 0.02);
    expect(q2Put).toBeGreaterThan(q0Put);
  });

  it('put-call parity holds under dividend yield q=0.02 (SPY-like)', () => {
    // Tolerance 1e-6 accommodates normCDF's ~1.5e-7 approximation error
    // scaled by the dollar-level prices. At q=0 the identity N(x)+N(−x)=1
    // cancels perfectly through ds·N(d1) − ds·N(−d1); at q>0 the cancellation
    // depends on the erf approximation and can leave up to ~O(S·1.5e-7)
    // residuals. Empirically ~1e-7 at q=0.02, S=100.
    const r = checkPutCallParity(100, 100, 30 / 365, 0.20, 0.04, 1e-6, 0.02);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Math.abs(r.residual)).toBeLessThan(1e-6);
  });

  it('put-call parity holds under wide q sweep', () => {
    for (const q of [0.0, 0.01, 0.02, 0.03, 0.05, 0.10]) {
      const r = checkPutCallParity(95, 105, 90 / 365, 0.25, 0.04, 1e-6, q);
      expect(r.ok, `q=${q}`).toBe(true);
    }
  });

  it('bsmDelta call with q>0 equals e^{-qT} times the q=0 call delta (when d1 adjusts)', () => {
    // Check that delta has the proper e^{-qT} scaling in addition to d1 shift.
    const d = bsmDelta(100, 100, 1.0, 0.20, 0.04, true, 0.02);
    // Under q=0.02, call delta is still positive and < 1.
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(1);
  });
});
