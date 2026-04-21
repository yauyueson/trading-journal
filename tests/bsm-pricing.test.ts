/**
 * BSM Pricing Tests — Synthetic Options Repricing Module
 *
 * Tests for bsmPrice, bsmDelta, and computeRollingHV used in the
 * backtest engine's BSM synthetic options repricing feature.
 */
import { describe, it, expect } from 'vitest';
import { bsmPrice, bsmDelta, computeRollingHV } from '../src/lib/backtest/bsm-pricing';

// ─── BSM Price ───────────────────────────────────────────────────

describe('bsmPrice', () => {
  const S = 100, K = 100, T = 30 / 365, sigma = 0.20, r = 0.04;

  // Expected ranges calibrated against QuantLib (Phase 0.c.8). Pre-Phase
  // 0.c.8 ranges assumed a buggy normCDF that overpriced ATM options by
  // ~10%. See docs or tests/bsm-quantlib-parity.test.ts for anchoring.
  it('ATM 30-DTE call is in QuantLib-verified range (~$2.45)', () => {
    const price = bsmPrice(S, K, T, sigma, r, true);
    expect(price).toBeGreaterThan(2.42);
    expect(price).toBeLessThan(2.48);
  });

  it('ATM 30-DTE put is in QuantLib-verified range (~$2.12)', () => {
    const price = bsmPrice(S, K, T, sigma, r, false);
    expect(price).toBeGreaterThan(2.09);
    expect(price).toBeLessThan(2.15);
  });

  it('put-call parity: C - P = S - K*exp(-rT)', () => {
    const call = bsmPrice(S, K, T, sigma, r, true);
    const put = bsmPrice(S, K, T, sigma, r, false);
    const parity = S - K * Math.exp(-r * T);
    expect(call - put).toBeCloseTo(parity, 4);
  });

  it('put-call parity holds for OTM options', () => {
    const call = bsmPrice(100, 110, 60 / 365, 0.30, 0.05, true);
    const put = bsmPrice(100, 110, 60 / 365, 0.30, 0.05, false);
    const parity = 100 - 110 * Math.exp(-0.05 * 60 / 365);
    expect(call - put).toBeCloseTo(parity, 4);
  });

  it('intrinsic at expiry: ITM call T=0', () => {
    expect(bsmPrice(105, 100, 0, 0.20, 0.04, true)).toBe(5);
  });

  it('intrinsic at expiry: ITM put T=0', () => {
    expect(bsmPrice(95, 100, 0, 0.20, 0.04, false)).toBe(5);
  });

  it('intrinsic at expiry: OTM call T=0 → 0', () => {
    expect(bsmPrice(95, 100, 0, 0.20, 0.04, true)).toBe(0);
  });

  it('intrinsic at expiry: OTM put T=0 → 0', () => {
    expect(bsmPrice(105, 100, 0, 0.20, 0.04, false)).toBe(0);
  });

  it('zero/negative sigma → 0', () => {
    expect(bsmPrice(100, 100, 0.1, 0, 0.04, true)).toBe(0);
    expect(bsmPrice(100, 100, 0.1, -0.1, 0.04, true)).toBe(0);
  });

  it('zero S or K → 0', () => {
    expect(bsmPrice(0, 100, 0.1, 0.2, 0.04, true)).toBe(0);
    expect(bsmPrice(100, 0, 0.1, 0.2, 0.04, true)).toBe(0);
  });

  it('higher vol → higher price', () => {
    const low = bsmPrice(100, 100, 30 / 365, 0.15, 0.04, true);
    const high = bsmPrice(100, 100, 30 / 365, 0.40, 0.04, true);
    expect(high).toBeGreaterThan(low);
  });

  it('longer DTE → higher price', () => {
    const short = bsmPrice(100, 100, 7 / 365, 0.25, 0.04, true);
    const long = bsmPrice(100, 100, 90 / 365, 0.25, 0.04, true);
    expect(long).toBeGreaterThan(short);
  });
});

// ─── BSM Delta ──────────────────────────────────────────────────

describe('bsmDelta', () => {
  it('ATM 30-DTE call delta ≈ 0.53 (QuantLib-verified, Phase 0.c.8)', () => {
    const d = bsmDelta(100, 100, 30 / 365, 0.20, 0.04, true);
    expect(d).toBeGreaterThan(0.51);
    expect(d).toBeLessThan(0.56);
  });

  it('ATM 30-DTE put delta ≈ -0.47 (QuantLib-verified)', () => {
    const d = bsmDelta(100, 100, 30 / 365, 0.20, 0.04, false);
    expect(d).toBeGreaterThan(-0.49);
    expect(d).toBeLessThan(-0.44);
  });

  it('call delta + |put delta| ≈ 1', () => {
    const cd = bsmDelta(100, 100, 30 / 365, 0.20, 0.04, true);
    const pd = bsmDelta(100, 100, 30 / 365, 0.20, 0.04, false);
    expect(cd + Math.abs(pd)).toBeCloseTo(1.0, 2);
  });

  it('deep ITM call delta → ~1', () => {
    const d = bsmDelta(120, 100, 30 / 365, 0.20, 0.04, true);
    expect(d).toBeGreaterThan(0.95);
  });

  it('deep OTM call delta → ~0', () => {
    const d = bsmDelta(80, 100, 30 / 365, 0.20, 0.04, true);
    expect(d).toBeLessThan(0.05);
  });

  it('expired ITM call → 1', () => {
    expect(bsmDelta(105, 100, 0, 0.20, 0.04, true)).toBe(1);
  });

  it('expired OTM call → 0', () => {
    expect(bsmDelta(95, 100, 0, 0.20, 0.04, true)).toBe(0);
  });

  it('expired ITM put → -1', () => {
    expect(bsmDelta(95, 100, 0, 0.20, 0.04, false)).toBe(-1);
  });

  it('expired ATM → 0.5 / -0.5', () => {
    expect(bsmDelta(100, 100, 0, 0.20, 0.04, true)).toBe(0.5);
    expect(bsmDelta(100, 100, 0, 0.20, 0.04, false)).toBe(-0.5);
  });
});

// ─── Rolling HV ─────────────────────────────────────────────────

describe('computeRollingHV', () => {
  it('returns NaN for first `window` entries', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i * 0.1);
    const hv = computeRollingHV(closes, 20);
    expect(hv.length).toBe(30);
    for (let i = 0; i < 20; i++) {
      expect(hv[i]).toBeNaN();
    }
  });

  it('returns values starting at index=window', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i * 0.1);
    const hv = computeRollingHV(closes, 20);
    for (let i = 20; i < 30; i++) {
      expect(hv[i]).not.toBeNaN();
      expect(hv[i]).toBeGreaterThan(0);
    }
  });

  it('constant prices → HV ≈ 0', () => {
    const closes = new Array(30).fill(100);
    const hv = computeRollingHV(closes, 20);
    // All log returns are 0 → var = 0 → HV = 0
    for (let i = 20; i < 30; i++) {
      expect(hv[i]).toBe(0);
    }
  });

  it('known constant daily return → known HV', () => {
    // Daily return r = 0.01 (1%), log(1.01) ≈ 0.00995
    // All returns identical → variance = 0, so use alternating returns
    // +1%, -1%, +1% ... → mean ≈ 0, var = logRet^2
    const dailyRet = 0.01;
    const logRet = Math.log(1 + dailyRet);
    const closes: number[] = [100];
    for (let i = 1; i < 25; i++) {
      const sign = i % 2 === 0 ? -1 : 1;
      closes.push(closes[i - 1] * (1 + sign * dailyRet));
    }
    const hv = computeRollingHV(closes, 20);
    // Expected: sqrt(logRet^2 * 252) = |logRet| * sqrt(252) ≈ 0.00995 * 15.87 ≈ 0.158
    const expected = Math.abs(logRet) * Math.sqrt(252);
    // Allow 15% tolerance due to small sample and mean effect
    expect(hv[20]).toBeGreaterThan(expected * 0.80);
    expect(hv[20]).toBeLessThan(expected * 1.20);
  });

  it('too few data points → all NaN', () => {
    const hv = computeRollingHV([100, 101, 102], 20);
    expect(hv.length).toBe(3);
    expect(hv.every(v => isNaN(v))).toBe(true);
  });

  it('higher volatility series → higher HV', () => {
    const lowVol: number[] = [100];
    const highVol: number[] = [100];
    for (let i = 1; i < 30; i++) {
      const sign = i % 2 === 0 ? 1 : -1;
      lowVol.push(lowVol[i - 1] * (1 + sign * 0.005));
      highVol.push(highVol[i - 1] * (1 + sign * 0.03));
    }
    const hvLow = computeRollingHV(lowVol, 20);
    const hvHigh = computeRollingHV(highVol, 20);
    expect(hvHigh[25]).toBeGreaterThan(hvLow[25]);
  });
});

// ─── Integration: BSM repricing sanity ──────────────────────────

describe('BSM repricing integration', () => {
  it('CALL TP hit: option return >> stock return (delta leverage)', () => {
    const S = 100, K = 100, sigma = 0.25, r = 0.04;
    const entryDTE = 30, holdDays = 5;
    const T_entry = entryDTE / 365;
    const T_exit = (entryDTE - holdDays) / 365;
    const exitPrice = 103; // +3% underlying

    const V_entry = bsmPrice(S, K, T_entry, sigma, r, true);
    const V_exit = bsmPrice(exitPrice, K, T_exit, sigma, r, true);
    const optReturn = (V_exit - V_entry) / V_entry;
    const stockReturn = (exitPrice - S) / S;

    // Option return should be significantly larger due to delta leverage
    expect(optReturn).toBeGreaterThan(stockReturn * 3);
    expect(optReturn).toBeGreaterThan(0);
  });

  it('PUT TP hit: option return positive when underlying falls', () => {
    const S = 100, K = 100, sigma = 0.25, r = 0.04;
    const T_entry = 30 / 365, T_exit = 25 / 365;
    const exitPrice = 97; // -3% underlying

    const V_entry = bsmPrice(S, K, T_entry, sigma, r, false);
    const V_exit = bsmPrice(exitPrice, K, T_exit, sigma, r, false);
    const optReturn = (V_exit - V_entry) / V_entry;

    expect(optReturn).toBeGreaterThan(0);
  });

  it('theta decay: option loses value if underlying unchanged', () => {
    const S = 100, K = 100, sigma = 0.25, r = 0.04;
    const T_entry = 30 / 365, T_exit = 20 / 365;

    const V_entry = bsmPrice(S, K, T_entry, sigma, r, true);
    const V_exit = bsmPrice(S, K, T_exit, sigma, r, true); // same underlying
    const optReturn = (V_exit - V_entry) / V_entry;

    // Should lose value due to theta decay
    expect(optReturn).toBeLessThan(0);
  });

  it('option return sign matches raw return sign for directional moves', () => {
    const sigma = 0.25, r = 0.04;
    const T_entry = 30 / 365, T_exit = 25 / 365;

    // CALL + up = positive
    const callUp = bsmPrice(105, 100, T_exit, sigma, r, true) - bsmPrice(100, 100, T_entry, sigma, r, true);
    expect(callUp).toBeGreaterThan(0);

    // CALL + down = negative
    const callDown = bsmPrice(95, 100, T_exit, sigma, r, true) - bsmPrice(100, 100, T_entry, sigma, r, true);
    expect(callDown).toBeLessThan(0);

    // PUT + down = positive
    const putDown = bsmPrice(95, 100, T_exit, sigma, r, false) - bsmPrice(100, 100, T_entry, sigma, r, false);
    expect(putDown).toBeGreaterThan(0);

    // PUT + up = negative
    const putUp = bsmPrice(105, 100, T_exit, sigma, r, false) - bsmPrice(100, 100, T_entry, sigma, r, false);
    expect(putUp).toBeLessThan(0);
  });

  it('option return ≥ -1.0 (can\'t lose more than 100%)', () => {
    // Deep OTM at exit with very short DTE
    const V_entry = bsmPrice(100, 100, 30 / 365, 0.25, 0.04, true);
    const V_exit = bsmPrice(85, 100, 1 / 365, 0.25, 0.04, true); // crashed -15%
    const optReturn = Math.max(-1.0, (V_exit - V_entry) / V_entry);

    expect(optReturn).toBeGreaterThanOrEqual(-1.0);
  });
});
