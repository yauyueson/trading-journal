/**
 * Synthetic Repricing Tests — Layered fallback for missing chain strikes
 *
 * Tests the three fallback layers:
 * 1. Same-day interpolation from neighboring strikes
 * 2. BSM repricing with last known IV
 * 3. BSM repricing with OU-evolved IV
 * 4. Hard NO_CHAIN when no fallback is possible
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { syntheticRepriceLeg } from '../src/lib/backtest/synthetic-reprice';
import type { LegFallbackContext } from '../src/lib/backtest/synthetic-reprice';
import { initDB, closeDB } from '../src/lib/backtest/chain-cache';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Use an in-memory test DB
const TEST_DB_PATH = path.resolve(__dirname, '.test-synthetic-reprice.sqlite');

function seedTestData(dbPath: string) {
  // Init via chain-cache to get the schema
  const db = initDB(dbPath);

  // Insert a chain for SPY on 2024-01-15, expiry 2024-03-15
  // Strikes: 450, 455, 460, 465, 470 (skip 462 — the target strike for interpolation)
  const insert = db.prepare(`
    INSERT OR REPLACE INTO option_chains
    (ticker, trade_date, expir_date, dte, strike, stock_price,
     call_bid, call_mid, call_ask, call_iv, call_volume, call_oi,
     put_bid, put_mid, put_ask, put_iv, put_volume, put_oi,
     delta, gamma, theta, vega)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tradeDate = '2024-01-15';
  const expiry = '2024-03-15';
  const stockPrice = 462;
  const dte = 60;

  // Insert neighbor strikes around 462 (which won't be in the chain)
  const strikes = [
    { strike: 450, putIV: 0.22, putMid: 2.50, callIV: 0.18, callMid: 14.50, delta: 0.70 },
    { strike: 455, putIV: 0.21, putMid: 3.20, callIV: 0.19, callMid: 11.00, delta: 0.63 },
    // 462 is missing — this is the target
    { strike: 465, putIV: 0.20, putMid: 5.50, callIV: 0.20, callMid: 7.00, delta: 0.50 },
    { strike: 470, putIV: 0.19, putMid: 9.20, callIV: 0.21, callMid: 4.50, delta: 0.38 },
  ];

  for (const s of strikes) {
    insert.run(
      'SPY', tradeDate, expiry, dte, s.strike, stockPrice,
      s.callMid * 0.95, s.callMid, s.callMid * 1.05, s.callIV, 1000, 5000,
      s.putMid * 0.95, s.putMid, s.putMid * 1.05, s.putIV, 1000, 5000,
      s.delta, 0.02, -0.03, 0.15,
    );
  }

  // Also insert a fetch_log entry so isCached works
  db.prepare('INSERT OR REPLACE INTO fetch_log (ticker, trade_date, rows_fetched) VALUES (?, ?, ?)')
    .run('SPY', tradeDate, strikes.length);

  return db;
}

describe('syntheticRepriceLeg', () => {
  beforeAll(() => {
    // Clean up any previous test DB
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    seedTestData(TEST_DB_PATH);
  });

  afterAll(() => {
    closeDB();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  const baseCtx: LegFallbackContext = {
    ticker: 'SPY',
    date: '2024-01-15',
    strike: 462,
    expiry: '2024-03-15',
    type: 'Put',
    entryIV: 0.21,
    entryDate: '2024-01-02',
    lastValidIV: 0.205,
    ivTheta: 0.20,
    kappa: 4.0,
    r: 0.04,
  };

  it('Layer 1: interpolates from neighboring strikes when target is missing', () => {
    const result = syntheticRepriceLeg(baseCtx, 462);
    expect(result).not.toBeNull();
    expect(result!.repricingMethod).toBe('interpolated');
    // IV should be between the two neighbors (455 putIV=0.21, 465 putIV=0.20)
    expect(result!.iv).toBeGreaterThanOrEqual(0.19);
    expect(result!.iv).toBeLessThanOrEqual(0.22);
    // Price should be reasonable for a 60-DTE OTM put
    expect(result!.mid).toBeGreaterThan(0);
    expect(result!.mid).toBeLessThan(20);
  });

  it('Layer 2: BSM with last IV when no chain data exists for the date', () => {
    // Use a date that has no chain data at all
    const ctx: LegFallbackContext = {
      ...baseCtx,
      date: '2024-01-20', // no chain data for this date
    };
    const result = syntheticRepriceLeg(ctx, 462);
    expect(result).not.toBeNull();
    expect(result!.repricingMethod).toBe('bsm_last_iv');
    expect(result!.iv).toBe(0.205); // should use lastValidIV
    expect(result!.mid).toBeGreaterThan(0);
  });

  it('Layer 3: BSM with OU-evolved IV when no lastValidIV', () => {
    const ctx: LegFallbackContext = {
      ...baseCtx,
      date: '2024-01-20',
      lastValidIV: null,
    };
    const result = syntheticRepriceLeg(ctx, 462);
    expect(result).not.toBeNull();
    expect(result!.repricingMethod).toBe('bsm_ou_iv');
    // IV should be between entry IV (0.21) and theta (0.20) — OU mean reversion
    expect(result!.iv).toBeGreaterThan(0.19);
    expect(result!.iv).toBeLessThan(0.22);
    expect(result!.mid).toBeGreaterThan(0);
  });

  it('Hard NO_CHAIN: returns null when no IV data at all', () => {
    const ctx: LegFallbackContext = {
      ...baseCtx,
      date: '2024-01-20',
      lastValidIV: null,
      entryIV: 0,
      ivTheta: 0,
    };
    const result = syntheticRepriceLeg(ctx, null);
    expect(result).toBeNull();
  });

  it('interpolation produces correct put delta (negative)', () => {
    const result = syntheticRepriceLeg(baseCtx, 462);
    expect(result).not.toBeNull();
    // Put delta should be negative
    expect(result!.delta).toBeLessThan(0);
    // Should be a reasonable OTM put delta
    expect(result!.delta).toBeGreaterThan(-0.8);
  });

  it('call-side interpolation works too', () => {
    const ctx: LegFallbackContext = {
      ...baseCtx,
      type: 'Call',
      entryIV: 0.19,
    };
    const result = syntheticRepriceLeg(ctx, 462);
    expect(result).not.toBeNull();
    expect(result!.repricingMethod).toBe('interpolated');
    expect(result!.delta).toBeGreaterThan(0);
  });

  it('BSM fallback produces synthetic ChainRow with correct metadata', () => {
    const ctx: LegFallbackContext = {
      ...baseCtx,
      date: '2024-01-20',
    };
    const result = syntheticRepriceLeg(ctx, 462);
    expect(result).not.toBeNull();
    expect(result!.row.ticker).toBe('SPY');
    expect(result!.row.trade_date).toBe('2024-01-20');
    expect(result!.row.strike).toBe(462);
    expect(result!.row.stock_price).toBe(462);
  });
});
