/**
 * tech-analysis.cjs
 * CommonJS mirror of src/lib/tech-analysis.ts (calculateTechScore v3 only) +
 * the indicator helpers from src/lib/indicators.ts that it depends on.
 *
 * Sources:
 *   src/lib/indicators.ts  — sma, emaFullSeries, rsi, t3_smooth, heikinAshiPine,
 *                            calcATR, calcADX, calcRVOL, detectSqueeze, rma (internal)
 *   src/lib/tech-analysis.ts — calculateTechScore (lines 54-395, v3 only)
 *
 * Rules:
 *   - All TypeScript types/interfaces/generics stripped
 *   - Plain function declarations (not arrow functions)
 *   - ALL math logic preserved exactly — parity mirror
 *   - Only calculateTechScore is exported
 *   - Does NOT include calculateTechScoreV4, aggregateToWeekly, or any v4 code
 */

'use strict';

// ============================================================
// INDICATOR PRIMITIVES (from src/lib/indicators.ts)
// ============================================================

/**
 * Simple Moving Average (SMA) — needed by calcRVOL
 */
function sma(values, period) {
    const result = [];
    if (values.length < period) return result;

    for (let i = 0; i < values.length; i++) {
        if (i < period - 1) {
            result.push(NaN);
            continue;
        }
        let sum = 0;
        for (let j = 0; j < period; j++) {
            sum += values[i - j];
        }
        result.push(sum / period);
    }
    return result;
}

/**
 * EMA that propagates NaNs bar-by-bar on the full series (no slice).
 * Matches Pine's ta.ema(series, len) when series has leading NaNs:
 * output is NaN until a valid value is seen; then use that as seed and continue.
 */
function emaFullSeries(values, period) {
    const result = [];
    if (values.length === 0) return result;
    const k = 2 / (period + 1);

    result[0] = values[0]; // may be NaN
    for (let i = 1; i < values.length; i++) {
        const v = values[i];
        const prev = result[i - 1];
        if (typeof v !== 'number' || isNaN(v)) {
            result.push(NaN);
        } else if (typeof prev !== 'number' || isNaN(prev)) {
            result.push(v); // seed with current
        } else {
            result.push((v - prev) * k + prev);
        }
    }
    return result;
}

/**
 * Relative Strength Index (RSI)
 */
function rsi(values, period) {
    const len = values.length;
    const result = new Array(len).fill(NaN);

    let seedGains = 0;
    let seedLosses = 0;
    let validDiffs = 0;
    let seedEndIdx = -1;

    for (let i = 1; i < len && validDiffs < period; i++) {
        if (!isFinite(values[i]) || !isFinite(values[i - 1])) continue;
        const diff = values[i] - values[i - 1];
        if (diff >= 0) seedGains += diff;
        else seedLosses += Math.abs(diff);
        validDiffs++;
        seedEndIdx = i;
    }

    if (validDiffs < period) return result;

    let avgGain = seedGains / period;
    let avgLoss = seedLosses / period;

    result[seedEndIdx] = 100 - (100 / (1 + avgGain / (avgLoss === 0 ? 1e-10 : avgLoss)));

    for (let i = seedEndIdx + 1; i < len; i++) {
        const curr = values[i];
        const prev = values[i - 1];

        if (!isFinite(curr) || !isFinite(prev)) {
            avgGain = avgGain * (period - 1) / period;
            avgLoss = avgLoss * (period - 1) / period;
        } else {
            const diff = curr - prev;
            const gain = diff >= 0 ? diff : 0;
            const loss = diff < 0 ? Math.abs(diff) : 0;
            avgGain = ((avgGain * (period - 1)) + gain) / period;
            avgLoss = ((avgLoss * (period - 1)) + loss) / period;
        }

        const rs = avgGain / (avgLoss === 0 ? 1e-10 : avgLoss);
        result[i] = 100 - (100 / (1 + rs));
    }

    return result;
}

/**
 * T3 Smoothing (Tillson T3 Moving Average)
 * Formula: xe1..xe6 each = emaFullSeries of prior; b = 0.7
 * T3 = c1*xe6 + c2*xe5 + c3*xe4 + c4*xe3
 */
function t3_smooth(values, period, b) {
    if (b === undefined) b = 0.7;
    const e1 = emaFullSeries(values, period);
    const e2 = emaFullSeries(e1, period);
    const e3 = emaFullSeries(e2, period);
    const e4 = emaFullSeries(e3, period);
    const e5 = emaFullSeries(e4, period);
    const e6 = emaFullSeries(e5, period);

    const c1 = -b * b * b;
    const c2 = 3 * b * b + 3 * b * b * b;
    const c3 = -6 * b * b - 3 * b - 3 * b * b * b;
    const c4 = 1 + 3 * b + b * b * b + 3 * b * b;

    const result = [];
    for (let i = 0; i < values.length; i++) {
        const v3 = e3[i];
        const v4 = e4[i];
        const v5 = e5[i];
        const v6 = e6[i];

        if (isNaN(v3) || isNaN(v4) || isNaN(v5) || isNaN(v6)) {
            result.push(NaN);
        } else {
            result.push(c1 * v6 + c2 * v5 + c3 * v4 + c4 * v3);
        }
    }
    return result;
}

/**
 * Heikin Ashi built exactly like Pine Script s_calc_mb:
 * haclose = (mb_o+mb_h+mb_l+mb_c)/4, xhaopen = (mb_o+mb_c)/2,
 * haopen = bar 0 ? (mb_o+mb_c)/2 : (xhaopen[1]+haclose[1])/2
 */
function heikinAshiPine(mb_o, mb_h, mb_l, mb_c) {
    const n = mb_o.length;
    const haOpens = [];
    const haCloses = [];
    let xhaopenPrev = 0, haclosePrev = 0;
    for (let i = 0; i < n; i++) {
        const haclose = (mb_o[i] + mb_h[i] + mb_l[i] + mb_c[i]) / 4;
        const xhaopen = (mb_o[i] + mb_c[i]) / 2;
        const haopen = i === 0 ? (mb_o[0] + mb_c[0]) / 2 : (xhaopenPrev + haclosePrev) / 2;
        haCloses.push(haclose);
        haOpens.push(haopen);
        xhaopenPrev = xhaopen;
        haclosePrev = haclose;
    }
    return { haOpens, haCloses };
}

/**
 * Wilder's Moving Average (RMA) — internal utility.
 * Matches Pine Script's ta.rma(): seeded with SMA of first `period` valid values,
 * then alpha = 1/period rolling average.
 */
function rma(values, period) {
    const result = new Array(values.length).fill(NaN);
    const alpha = 1.0 / period;

    let seedSum = 0;
    let seedCount = 0;
    let seedIdx = -1;

    for (let i = 0; i < values.length; i++) {
        if (isFinite(values[i])) {
            seedSum += values[i];
            seedCount++;
            if (seedCount === period) {
                result[i] = seedSum / period;
                seedIdx = i;
                break;
            }
        }
    }

    if (seedIdx === -1) return result;

    for (let i = seedIdx + 1; i < values.length; i++) {
        const v = values[i];
        const prev = result[i - 1];
        result[i] = isFinite(v) ? alpha * v + (1 - alpha) * prev : prev;
    }

    return result;
}

/**
 * Average True Range (ATR)
 * Matches Pine Script's ta.atr(period) — uses Wilder's RMA of True Range.
 */
function calcATR(highs, lows, closes, period) {
    const n = closes.length;
    if (n < 2) return new Array(n).fill(NaN);

    const trValues = [NaN];
    for (let i = 1; i < n; i++) {
        const tr = Math.max(
            highs[i] - lows[i],
            Math.abs(highs[i] - closes[i - 1]),
            Math.abs(lows[i] - closes[i - 1])
        );
        trValues.push(tr);
    }

    return rma(trValues, period);
}

/**
 * Average Directional Index (ADX) with DI+ and DI−.
 * Matches Pine Script's [adx_v, plus_di, minus_di] = ta.adx(period) equivalent.
 * Returns full series arrays.
 */
function calcADX(highs, lows, closes, period) {
    const n = closes.length;
    function empty() { return new Array(n).fill(NaN); }

    if (n < 2) return { adx: empty(), diPlus: empty(), diMinus: empty() };

    const trValues = [NaN];
    const dmPlusValues = [NaN];
    const dmMinusValues = [NaN];

    for (let i = 1; i < n; i++) {
        const h = highs[i], l = lows[i], prevH = highs[i - 1], prevL = lows[i - 1];
        const tr = Math.max(h - l, Math.abs(h - closes[i - 1]), Math.abs(l - closes[i - 1]));
        const upMove = h - prevH;
        const downMove = prevL - l;
        trValues.push(tr);
        dmPlusValues.push(upMove > downMove && upMove > 0 ? upMove : 0);
        dmMinusValues.push(downMove > upMove && downMove > 0 ? downMove : 0);
    }

    const atr = rma(trValues, period);
    const smoothPlus = rma(dmPlusValues, period);
    const smoothMinus = rma(dmMinusValues, period);

    const diPlus = [];
    const diMinus = [];
    const dxValues = [];

    for (let i = 0; i < n; i++) {
        const a = atr[i];
        if (!isFinite(a) || a === 0) {
            diPlus.push(NaN); diMinus.push(NaN); dxValues.push(NaN);
        } else {
            const dip = 100 * smoothPlus[i] / a;
            const dim = 100 * smoothMinus[i] / a;
            diPlus.push(dip);
            diMinus.push(dim);
            const diSum = dip + dim;
            dxValues.push(diSum === 0 ? 0 : 100 * Math.abs(dip - dim) / diSum);
        }
    }

    return { adx: rma(dxValues, period), diPlus, diMinus };
}

/**
 * Relative Volume (RVOL)
 * Returns {rvol, rvol2Bar} where rvol2Bar is a 2-bar rolling average of RVOL.
 * Matches Pine Script's s_calc_rvol() logic.
 */
function calcRVOL(volumes, period) {
    if (period === undefined) period = 20;
    const volSma = sma(volumes, period);

    const rvol = volSma.map(function(avg, i) {
        return isFinite(avg) && avg > 0 ? volumes[i] / avg : NaN;
    });

    const rvol2Bar = rvol.map(function(rv, i) {
        if (i === 0) return rv;
        const prev = rvol[i - 1];
        if (!isFinite(rv)) return isFinite(prev) ? prev : NaN;
        if (!isFinite(prev)) return rv;
        return (rv + prev) / 2;
    });

    return { rvol, rvol2Bar };
}

/**
 * Bollinger / Keltner Channel Squeeze Detection.
 * Squeeze = BB width < KC width (volatility contraction).
 * Matches Pine Script: is_sqz = BB_upper < KC_upper AND BB_lower > KC_lower.
 * Returns a boolean[] series (true = squeeze active on that bar).
 */
function detectSqueeze(closes, highs, lows, period, bbMultiplier, kcMultiplier) {
    if (period === undefined) period = 20;
    if (bbMultiplier === undefined) bbMultiplier = 2.0;
    if (kcMultiplier === undefined) kcMultiplier = 1.5;

    const n = closes.length;
    const result = new Array(n).fill(false);
    if (n < period) return result;

    const atrValues = calcATR(highs, lows, closes, period);
    const emaValues = emaFullSeries(closes, period);

    for (let i = period - 1; i < n; i++) {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += closes[j];
        const mean = sum / period;

        let variance = 0;
        for (let j = i - period + 1; j <= i; j++) {
            const d = closes[j] - mean;
            variance += d * d;
        }
        const stdDev = Math.sqrt(variance / period);
        const bbUpper = mean + bbMultiplier * stdDev;
        const bbLower = mean - bbMultiplier * stdDev;

        const kcCenter = emaValues[i];
        const atr = atrValues[i];
        if (!isFinite(kcCenter) || !isFinite(atr)) continue;

        const kcUpper = kcCenter + kcMultiplier * atr;
        const kcLower = kcCenter - kcMultiplier * atr;

        result[i] = bbUpper < kcUpper && bbLower > kcLower;
    }

    return result;
}

// ============================================================
// Direction Confidence Score (0-100)
// ============================================================

function calcDirConfidence(dir, d8, d21, b_stack, br_stack, ch3, ch10, adx) {
    if (dir === 0) return 0;

    // EMA Alignment (55% weight)
    var emaScore;
    var fullStack = dir > 0 ? b_stack : br_stack;
    var d8Aligned = d8 * dir > 0;
    var d21Aligned = d21 * dir > 0;
    if (fullStack && Math.abs(d21) > 1) emaScore = 95;
    else if (fullStack) emaScore = 85;
    else if (d8Aligned && d21Aligned) emaScore = 70;
    else if (d8Aligned) emaScore = 40;
    else emaScore = 15;

    // Momentum Agreement (30% weight)
    var ch3Dir = ch3 * dir;
    var ch10Dir = ch10 * dir;
    var momScore;
    if (ch3Dir > 0.5 && ch10Dir > 0) momScore = 90;
    else if (ch3Dir > 0 && ch10Dir > 0) momScore = 75;
    else if (ch3Dir > 0) momScore = 55;
    else if (ch3Dir > -0.5) momScore = 35;
    else momScore = 15;

    // ADX Trend Strength (15% weight)
    var adxScore;
    if (adx > 30) adxScore = 90;
    else if (adx > 25) adxScore = 70;
    else if (adx > 20) adxScore = 55;
    else if (adx > 15) adxScore = 35;
    else adxScore = 20;

    return Math.round(emaScore * 0.55 + momScore * 0.30 + adxScore * 0.15);
}

// ============================================================
// TECH SCORE v3  (from src/lib/tech-analysis.ts, lines 54-395)
// ============================================================

// Aligned with Pine Script v3.2 "Scanner: Scoring" defaults (7 components)
const DEFAULT_OPTIONS = {
    w_mb: 25,
    w_bxs: 20,
    w_bxl: 15,
    w_ema: 12,
    w_mom: 8,
    w_adx: 12,
    w_vol: 8,
    sc_mb_len: 20,
    sc_mb_smoothing: 20,
    sc_osc_len: 7,
    sc_bx_s1: 5,
    sc_bx_s2: 20,
    sc_bx_s3: 15,
    sc_bx_l1: 20,
    sc_bx_l2: 15
};

/**
 * Calculate Tech Score aligned with Pine Script v3.2 ("MB+DFP + Options Scanner").
 * 7 components: MB, BXS, BXL, EMA, MOM, ADX, RVOL — all direction-aware.
 * @param {Array} candles  Daily candles (OHLCV). Expects ~300+ candles. Volume optional (defaults to 1).
 * @param {Object} [options]  Optional weights and criteria periods (match Pine Scanner inputs when set).
 */
function calculateTechScore(candles, options) {
    const opts = Object.assign({}, DEFAULT_OPTIONS, options);
    const closes = candles.map(function(c) { return c.close; });
    const opens = candles.map(function(c) { return c.open; });
    const highs = candles.map(function(c) { return c.high; });
    const lows = candles.map(function(c) { return c.low; });
    const volumes = candles.map(function(c) { return c.volume != null ? c.volume : 1; });
    const len = closes.length;

    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

    // Default return for insufficient data
    if (len < 50) {
        return {
            techScore: 50,
            dirConfidence: 0,
            type: 'NEUTRAL',
            signal: '⚪ WATCH',
            setup: 'Insufficient Data',
            confidence: 0,
            components: { sc_mb: 50, sc_bxs: 50, sc_bxl: 50, sc_ema: 50, sc_mom: 50, sc_adx: 50, sc_vol: 50 },
            debug: { mb_osc: 0, bxs: 0, bxl: 0, d8: 0, reversal: false, close: closes[len - 1] || 0, adx: 20, rvol: 1, regime: 'neutral' }
        };
    }

    // =====================================================================
    // PHASE 1: Compute raw indicators
    // =====================================================================

    // --- MB (Market Bias) ---
    const haLen = opts.sc_mb_len;
    const mb_o = emaFullSeries(opens, haLen);
    const mb_c = emaFullSeries(closes, haLen);
    const mb_h = emaFullSeries(highs, haLen);
    const mb_l = emaFullSeries(lows, haLen);

    const haResult = heikinAshiPine(mb_o, mb_h, mb_l, mb_c);
    const haOpens = haResult.haOpens;
    const haCloses = haResult.haCloses;

    const haLen2 = opts.sc_mb_len;
    const o2 = emaFullSeries(haOpens, haLen2);
    const c2 = emaFullSeries(haCloses, haLen2);

    const osc = c2.map(function(c, i) { return 100 * (c - o2[i]); });
    const oscSmooth = emaFullSeries(osc, opts.sc_osc_len);

    const currOsc = osc[len - 1] || 0;
    const currSm = oscSmooth[len - 1] || 0;
    const prevOsc = osc[len - 2] || 0;

    const is_bull = currOsc > 0;
    const is_str = is_bull ? (currOsc >= currSm) : (currOsc <= currSm);
    const was_bear = prevOsc < 0;
    const bs_bull = is_bull && was_bear;
    const bs_bear = !is_bull && !was_bear;
    const iss = is_str;

    // --- BXS / BXL ---
    const s_l1 = opts.sc_bx_s1, s_l2 = opts.sc_bx_s2, s_l3 = opts.sc_bx_s3;
    const l_l1 = opts.sc_bx_l1, l_l2 = opts.sc_bx_l2;

    const ema5 = emaFullSeries(closes, s_l1);
    const ema20 = emaFullSeries(closes, s_l2);
    const shortDiff = ema5.map(function(v, i) { return v - ema20[i]; });
    const stX = rsi(shortDiff, s_l3).map(function(v) { return v - 50; });

    const ema20_long = emaFullSeries(closes, l_l1);
    const ltX = rsi(ema20_long, l_l2).map(function(v) { return v - 50; });

    const mstX = t3_smooth(stX, 5);

    const currBxs = stX[len - 1] || 0;
    const currMabxs = mstX[len - 1] || 0;
    const prevMabxs = mstX[len - 2] || 0;
    const prev2Mabxs = mstX[len - 3] || 0;

    const rev_up = currMabxs > prevMabxs && prevMabxs < prev2Mabxs;
    const rev_dn = currMabxs < prevMabxs && prevMabxs > prev2Mabxs;

    const currBxl = ltX[len - 1] || 0;

    // --- EMA Stack ---
    const e8 = emaFullSeries(closes, 8);
    const e21 = emaFullSeries(closes, 21);
    const e34 = emaFullSeries(closes, 34);

    const currE8 = e8[len - 1] || 0;
    const currE21 = e21[len - 1] || 0;
    const currE34 = e34[len - 1] || 0;
    const currClose = closes[len - 1] || 0;
    const prevClose1 = closes[len - 2] || currClose;

    const d8 = ((currClose - currE8) / currE8) * 100;
    const d21 = ((currClose - currE21) / currE21) * 100;

    const b_stack = currE8 > currE21 && currE21 > currE34;
    const br_stack = currE8 < currE21 && currE21 < currE34;

    // --- ATR, ADX, RVOL, Squeeze ---
    const atrSeries = calcATR(highs, lows, closes, 14);
    const atr14 = atrSeries[len - 1] || (currClose * 0.01);

    const adxResult = calcADX(highs, lows, closes, 14);
    const adxSeries = adxResult.adx;
    const adx_v = adxSeries[len - 1] != null ? adxSeries[len - 1] : 20;

    const rvolResult = calcRVOL(volumes, 20);
    const rvol2Bar = rvolResult.rvol2Bar;
    const rvol_now = rvol2Bar[len - 1] != null ? rvol2Bar[len - 1] : 1.0;

    const sqzSeries = detectSqueeze(closes, highs, lows);
    const is_sqz_hist = sqzSeries[len - 1] || sqzSeries[len - 2] || sqzSeries[len - 3];

    // --- Momentum raw values ---
    const prevClose3 = closes[len - 4] || currClose;
    const prevClose10 = closes[len - 11] || currClose;
    const ch1 = ((currClose - prevClose1) / prevClose1) * 100;
    const ch3 = ((currClose - prevClose3) / prevClose3) * 100;
    const ch10 = ((currClose - prevClose10) / prevClose10) * 100;

    // =====================================================================
    // PHASE 2: Signal identification (s_identify) — BEFORE scoring
    // =====================================================================
    const oscVal = currOsc;
    const bull = is_bull;
    const cup8 = currClose > currE8 && prevClose1 <= (e8[len - 2] || 0);
    const cdn8 = currClose < currE8 && prevClose1 >= (e8[len - 2] || 0);
    const cr_up = currBxs > 0 && (stX[len - 2] || 0) <= 0;
    const cr_dn = currBxs < 0 && (stX[len - 2] || 0) >= 0;
    const t21 = Math.abs(d21) < 1.0;
    const t34 = Math.abs(((currClose - currE34) / currE34) * 100) < 1.5;

    let name = "Mixed";
    let type = "NEUTRAL";
    let conf = 0;

    if ((bs_bull || (bull && oscVal > 2)) && (cr_up || (currBxs > 0 && rev_up)) && currBxl > 0 && cup8 && b_stack) {
        name = "Perfect Storm"; type = "CALL"; conf = 3;
    } else if (bull && oscVal > 1 && currBxs > 0 && !cr_dn && currBxl > 0 && (t21 || t34) && d8 > -2 && b_stack) {
        name = "Pullback Buy"; type = "CALL"; conf = 2;
    } else if (bull && oscVal > 2 && currBxs > 10 && currBxl > 5 && cup8 && d8 > 1 && d21 > 0) {
        name = "Breakout"; type = "CALL"; conf = 3;
    } else if ((bs_bull || oscVal > 0) && rev_up && currBxs > -10 && cup8) {
        name = "Divergence"; type = "CALL"; conf = 1;
    } else if (bull && oscVal > 2 && currBxs > 5 && currBxl > 8 && d8 > 0 && b_stack) {
        name = "Strong Trend"; type = "CALL"; conf = 2;
    } else if ((bs_bear || (!bull && oscVal < -2)) && (cr_dn || (currBxs < 0 && rev_dn)) && currBxl < 0 && cdn8 && br_stack) {
        name = "Perfect Storm"; type = "PUT"; conf = 3;
    } else if (!bull && oscVal < -1 && currBxs < 0 && !cr_up && currBxl < 0 && (t21 || t34) && d8 < 2 && br_stack) {
        name = "Failed Rally"; type = "PUT"; conf = 2;
    } else if (!bull && oscVal < -2 && currBxs < -10 && currBxl < -5 && cdn8 && d8 < -1 && d21 < 0) {
        name = "Breakdown"; type = "PUT"; conf = 3;
    } else if ((bs_bear || oscVal < 0) && rev_dn && currBxs < 10 && cdn8) {
        name = "Distribution"; type = "PUT"; conf = 1;
    } else if (!bull && oscVal < -2 && currBxs < -5 && currBxl < -8 && d8 < 0 && br_stack) {
        name = "Strong Down"; type = "PUT"; conf = 2;
    } else {
        if (bull && currBxs > 0) { name = "Bullish"; type = "CALL"; }
        else if (!bull && currBxs < 0) { name = "Bearish"; type = "PUT"; }
    }

    // Direction from identified signal (Pine: st = 1 for CALL, -1 for PUT)
    const dir = type === 'CALL' ? 1 : type === 'PUT' ? -1 : 0;

    // Direction confidence — structural reliability of the direction signal
    const dirConfidence = calcDirConfidence(dir, d8, d21, b_stack, br_stack, ch3, ch10, adx_v);

    // =====================================================================
    // PHASE 3: Direction-aware component scoring (Pine v3.2 aligned)
    // =====================================================================

    // --- MB Score (direction-aware) ---
    const mb_aligned = currOsc * dir;
    const mb_credit = mb_aligned > 0
        ? Math.min(Math.abs(currOsc) * 3, 30)
        : -Math.min(Math.abs(currOsc) * 2, 35);
    const mb_str_bonus = mb_aligned > 0 && iss ? 20 : 0;
    const sc_mb = clamp(50 + mb_credit + mb_str_bonus, 15, 100);

    // --- BXS Score (direction-aware) ---
    const bxs_aligned = currBxs * dir;
    const bxs_credit = bxs_aligned > 0
        ? Math.min(Math.abs(currBxs) * 1.5, 30)
        : -Math.min(Math.abs(currBxs) * 1.5, 35);
    const bxs_momentum_bonus = (currMabxs > prevMabxs && bxs_aligned > 0) ? 10 : 0;
    const bxs_reversal_bonus = ((rev_up && type === 'CALL') || (rev_dn && type === 'PUT')) ? 10 : 0;
    const sc_bxs = clamp(50 + bxs_credit + bxs_momentum_bonus + bxs_reversal_bonus, 15, 100);

    // --- BXL Score (direction-aware) ---
    const bxl_aligned = currBxl * dir;
    const bxl_credit = bxl_aligned > 0
        ? Math.min(Math.abs(currBxl) * 2, 50)
        : -Math.min(Math.abs(currBxl) * 2, 35);
    const sc_bxl = clamp(50 + bxl_credit, 15, 100);

    // --- EMA Score (discrete 4-level, Pine v3.2) ---
    const ema_call_aligned = d8 > 0 && d21 > 0 && b_stack;
    const ema_put_aligned = d8 < 0 && d21 < 0 && br_stack;
    const ema_with_dir = (type === 'CALL' && ema_call_aligned) || (type === 'PUT' && ema_put_aligned);
    const ema_against = (type === 'CALL' && ema_put_aligned) || (type === 'PUT' && ema_call_aligned);
    const ema_partial_call = d8 > 0 && type === 'CALL' && !ema_call_aligned;
    const ema_partial_put = d8 < 0 && type === 'PUT' && !ema_put_aligned;
    const sc_ema = ema_with_dir ? 90 : (ema_partial_call || ema_partial_put) ? 70 : ema_against ? 25 : 55;

    // --- Momentum Score (3-tier ATR-normalized, Pine v3.2) ---
    const atr_pct = (atr14 / currClose) * 100;
    const norm_ch1 = atr_pct > 0 ? ch1 / atr_pct : 0;
    const norm_ch3 = atr_pct > 0 ? ch3 / (atr_pct * Math.sqrt(3)) : 0;
    const norm_ch10 = atr_pct > 0 ? ch10 / (atr_pct * Math.sqrt(10)) : 0;

    function momTier(normVal) {
        const aligned = normVal * dir;
        if (aligned > 0.5) return 30;      // strong aligned
        if (aligned > 0) return 15;        // weak aligned
        if (aligned > -0.3) return 5;      // flat
        return aligned > -0.5 ? -5 : -10; // opposing
    }
    const mom_t1 = momTier(norm_ch1);
    const mom_t3 = momTier(norm_ch3);
    const mom_t10 = momTier(norm_ch10);
    const sc_mom = clamp(50 + (mom_t1 * 0.25 + mom_t3 * 0.35 + mom_t10 * 0.40) * 1.6, 15, 100);

    // --- ADX Regime Score (new component) ---
    const is_trending = adx_v > 25;
    const is_ranging = adx_v < 20;
    const regime = is_trending ? 'trending' : is_ranging ? 'ranging' : 'neutral';

    const is_strong_setup = ['Perfect Storm', 'Breakout', 'Breakdown', 'Strong Trend', 'Strong Down'].includes(name);
    const is_mid_setup = ['Directional', 'Pullback Buy', 'Failed Rally', 'Divergence', 'Distribution'].includes(name);
    let sc_adx;
    if (is_trending) {
        sc_adx = is_strong_setup ? 90 : is_mid_setup ? 70 : 45;
    } else if (is_ranging) {
        sc_adx = is_strong_setup ? 40 : is_mid_setup ? 55 : 65;
    } else {
        sc_adx = is_strong_setup ? 70 : is_mid_setup ? 60 : 55;
    }

    // --- RVOL Score (tiered, Pine v3.2) ---
    const sc_vol = rvol_now >= 2.0 ? 100 : rvol_now >= 1.5 ? 90 : rvol_now >= 1.3 ? 75
        : rvol_now >= 1.0 ? 60 : rvol_now >= 0.7 ? 40 : 25;

    // =====================================================================
    // PHASE 4: ADX dynamic weight adjustment + Composite
    // =====================================================================
    let dw_mb = opts.w_mb, dw_bxs = opts.w_bxs, dw_bxl = opts.w_bxl;
    let dw_ema = opts.w_ema, dw_mom = opts.w_mom;
    let dw_adx = opts.w_adx, dw_vol = opts.w_vol;

    if (is_trending) {
        dw_ema *= 1.5; dw_mb *= 0.9; dw_bxs *= 0.9;
    } else if (is_ranging) {
        dw_mb *= 1.2; dw_bxs *= 1.2; dw_ema *= 0.6;
    }

    // NaN protection + [0,100] clamping
    const f_mb = clamp(isNaN(sc_mb) ? 50 : sc_mb, 0, 100);
    const f_bxs = clamp(isNaN(sc_bxs) ? 50 : sc_bxs, 0, 100);
    const f_bxl = clamp(isNaN(sc_bxl) ? 50 : sc_bxl, 0, 100);
    const f_ema = clamp(isNaN(sc_ema) ? 50 : sc_ema, 0, 100);
    const f_mom = clamp(isNaN(sc_mom) ? 50 : sc_mom, 0, 100);
    const f_adx = clamp(isNaN(sc_adx) ? 50 : sc_adx, 0, 100);
    const f_vol = clamp(isNaN(sc_vol) ? 50 : sc_vol, 0, 100);

    const totalW = dw_mb + dw_bxs + dw_bxl + dw_ema + dw_mom + dw_adx + dw_vol;
    let comp = (f_mb * dw_mb + f_bxs * dw_bxs + f_bxl * dw_bxl + f_ema * dw_ema +
                f_mom * dw_mom + f_adx * dw_adx + f_vol * dw_vol) / totalW;

    // Coherence multiplier (same as before — MB/BXS/BXL agreement)
    const coreAgree = (currOsc * dir > 0 ? 1 : 0) + (currBxs * dir > 0 ? 1 : 0) + (currBxl * dir > 0 ? 1 : 0);
    const coherence = coreAgree === 3 ? 1.10 : coreAgree === 2 ? 1.0 : coreAgree === 1 ? 0.85 : 0.70;
    comp = Math.min(comp * coherence, 100);

    // Squeeze bonus (Pine v3.2)
    if (is_sqz_hist && (name === 'Squeeze Breakout' || name === 'Squeeze Breakdown')) {
        comp = Math.min(comp + 5, 100);
    }

    // =====================================================================
    // PHASE 5: Signal string
    // =====================================================================
    let sig = "❌ AVOID";
    if (type === "CALL") {
        if (comp >= 85 && conf === 3) sig = "🟢 STR BUY";
        else if (comp >= 85) sig = "🟢 BUY";
        else if (comp >= 70) sig = "🟡 BUY";
        else sig = "⚪ WATCH";
    } else if (type === "PUT") {
        if (comp >= 85 && conf === 3) sig = "🔴 STR SELL";
        else if (comp >= 85) sig = "🔴 SELL";
        else if (comp >= 70) sig = "🟠 SELL";
        else sig = "⚪ WATCH";
    }

    return {
        techScore: Math.round(comp),
        dirConfidence: dirConfidence,
        type: type,
        signal: sig,
        setup: name,
        confidence: conf,
        components: {
            sc_mb: Math.round(f_mb),
            sc_bxs: Math.round(f_bxs),
            sc_bxl: Math.round(f_bxl),
            sc_ema: Math.round(f_ema),
            sc_mom: Math.round(f_mom),
            sc_adx: Math.round(f_adx),
            sc_vol: Math.round(f_vol)
        },
        debug: {
            mb_osc: parseFloat(oscVal.toFixed(2)),
            bxs: parseFloat(currBxs.toFixed(2)),
            bxl: parseFloat(currBxl.toFixed(2)),
            d8: parseFloat(d8.toFixed(2)),
            reversal: rev_up || rev_dn,
            close: currClose,
            adx: parseFloat(adx_v.toFixed(1)),
            rvol: parseFloat(rvol_now.toFixed(2)),
            regime: regime
        }
    };
}

module.exports = { calculateTechScore, calcDirConfidence, emaFullSeries };
