
import { emaFullSeries, rsi, t3_smooth, heikinAshiPine, calcATR, calcADX, calcRVOL, detectSqueeze } from './indicators';

export interface TechScoreResult {
    techScore: number;
    type: 'CALL' | 'PUT' | 'NEUTRAL';
    signal: string;
    setup: string;
    confidence: number;
    components: {
        sc_mb: number;
        sc_bxs: number;
        sc_bxl: number;
        sc_ema: number;
        sc_mom: number;
    };
    debug: {
        mb_osc: number;
        bxs: number;
        bxl: number;
        d8: number;
        reversal: boolean;
        close: number;
    };
}

/** Optional weights and criteria periods (Pine Scanner defaults). Omit to use defaults. */
export interface TechScoreOptions {
    w_mb?: number;
    w_bxs?: number;
    w_bxl?: number;
    w_ema?: number;
    w_mom?: number;
    sc_mb_len?: number;
    /** In Pine Scanner, o2/c2 use same period as sc_mb_len (ha_len2=len). Kept for compatibility. */
    sc_mb_smoothing?: number;
    /** Oscillator smooth period (ema(osc, n)). Scanner default 7. */
    sc_osc_len?: number;
    sc_bx_s1?: number;
    sc_bx_s2?: number;
    sc_bx_s3?: number;
    sc_bx_l1?: number;
    sc_bx_l2?: number;
}

// Aligned with Pine Script "Scanner: Criteria Periods" and "Scanner: Scoring" defaults
const DEFAULT_OPTIONS: Required<TechScoreOptions> = {
    w_mb: 30,
    w_bxs: 25,
    w_bxl: 20,
    w_ema: 15,
    w_mom: 10,
    sc_mb_len: 100,
    sc_mb_smoothing: 100,
    sc_osc_len: 7,
    sc_bx_s1: 5,
    sc_bx_s2: 20,
    sc_bx_s3: 15,
    sc_bx_l1: 20,
    sc_bx_l2: 15
};

/**
 * Calculate Tech Score based on user's PineScript logic ("MB+DFP + Options Scanner").
 * @param candles Daily candles (Open, High, Low, Close). Expects ~300+ candles.
 * @param options Optional weights and criteria periods (match Pine Scanner inputs when set).
 */
export function calculateTechScore(
    candles: { open: number; high: number; low: number; close: number }[],
    options?: TechScoreOptions
): TechScoreResult {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const closes = candles.map(c => c.close);
    const opens = candles.map(c => c.open);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const len = closes.length;

    // Default return for insufficient data
    if (len < 50) {
        return {
            techScore: 50,
            type: 'NEUTRAL',
            signal: '⚪ WATCH',
            setup: 'Insufficient Data',
            confidence: 0,
            components: { sc_mb: 50, sc_bxs: 50, sc_bxl: 50, sc_ema: 50, sc_mom: 50 },
            debug: { mb_osc: 0, bxs: 0, bxl: 0, d8: 0, reversal: false, close: closes[len - 1] || 0 }
        };
    }

    // --- 1. Market Bias (Pine s_calc_mb: ha_len2 = len, so same period for o2/c2) ---
    // All EMA calls use emaFullSeries to match Pine's ta.ema() (seeds from bar 0, no NaN warmup).
    // SMA-seeded ema() produces NaN for bars 0..period-1, polluting heikinAshiPine and downstream
    // RSI seeds. For shorter datasets (1H/4H), these lost warmup bars are significant.
    const haLen = opts.sc_mb_len;
    const mb_o = emaFullSeries(opens, haLen);
    const mb_c = emaFullSeries(closes, haLen);
    const mb_h = emaFullSeries(highs, haLen);
    const mb_l = emaFullSeries(lows, haLen);

    const { haOpens, haCloses } = heikinAshiPine(mb_o, mb_h, mb_l, mb_c);

    const haLen2 = opts.sc_mb_len;
    const o2 = emaFullSeries(haOpens, haLen2);
    const c2 = emaFullSeries(haCloses, haLen2);

    // Osc = 100 * (c2 - o2)
    const osc = c2.map((c, i) => 100 * (c - o2[i]));

    // sm = ema(osc, sc_osc_len)
    const oscSmooth = emaFullSeries(osc, opts.sc_osc_len);

    const currOsc = osc[len - 1] || 0;
    const currSm = oscSmooth[len - 1] || 0;
    const prevOsc = osc[len - 2] || 0;

    const is_bull = currOsc > 0;
    const is_str = is_bull ? (currOsc >= currSm) : (currOsc <= currSm); // Not used directly in score, but in identify?
    const was_bear = prevOsc < 0;
    const bs_bull = is_bull && was_bear;
    const bs_bear = !is_bull && !was_bear;
    const iss = is_str; // using variable name from script 'iss'

    // Score MB
    // sc_mb = 50.0 + (isb ? min(mb*5, 30) : -min(abs(mb)*5, 30)) + (iss ? 20 : 5)
    let sc_mb = 50.0;
    if (is_bull) {
        sc_mb += Math.min(currOsc * 5, 30);
    } else {
        sc_mb -= Math.min(Math.abs(currOsc) * 5, 30);
    }
    sc_mb += (iss ? 20 : 5);


    // --- 2. B-Xtrender (Short & Long) ---
    const s_l1 = opts.sc_bx_s1, s_l2 = opts.sc_bx_s2, s_l3 = opts.sc_bx_s3;
    const l_l1 = opts.sc_bx_l1, l_l2 = opts.sc_bx_l2;

    // Short Term: RSI(EMA(c, 5) - EMA(c, 20), 15) - 50
    const ema5 = emaFullSeries(closes, s_l1);
    const ema20 = emaFullSeries(closes, s_l2);
    const shortDiff = ema5.map((v, i) => v - ema20[i]);
    const stX = rsi(shortDiff, s_l3).map(v => v - 50);

    // Long Term: RSI(EMA(c, 20), 15) - 50
    const ema20_long = emaFullSeries(closes, l_l1);
    const ltX = rsi(ema20_long, l_l2).map(v => v - 50);

    // T3 Smooth of Short Term
    // mstX = s_t3_smooth(stX, 5)
    // IMPORTANT: PineScript T3 implementation might handle NaNs differently.
    // Our t3_smooth returns NaNs if inputs are NaN.
    // stX has NaNs at start.
    const mstX = t3_smooth(stX, 5); // b=0.7 default

    const currBxs = stX[len - 1] || 0;     // 'bxs' in script
    const currMabxs = mstX[len - 1] || 0;  // 'mabxs' in script
    const prevMabxs = mstX[len - 2] || 0;
    const prev2Mabxs = mstX[len - 3] || 0;

    // Rev Up/Down
    const rev_up = currMabxs > prevMabxs && prevMabxs < prev2Mabxs;
    const rev_dn = currMabxs < prevMabxs && prevMabxs > prev2Mabxs;

    const currBxl = ltX[len - 1] || 0;     // 'bxl' in script

    // Score BX Short (v2.7: direction-aware reversal + MA slope)
    let sc_bxs = 50.0;
    sc_bxs += Math.min(Math.max(currBxs * 2, -50), 50);  // Direction-aware: BXS drives sign
    // MA slope: confirms momentum direction (+10 aligned, -5 opposing)
    sc_bxs += (currMabxs > prevMabxs ? 10 : -5);
    // Reversal bonus: only add for reversals in the bullish direction (rev_up),
    // penalize for bearish reversals (rev_dn). Prevents bearish pivots from inflating the score.
    sc_bxs += (rev_up ? 15 : rev_dn ? -15 : 0);

    // Score BX Long
    // sc_bxl = 50.0 + min(max(bxl*3, -50), 50)
    let sc_bxl = 50.0 + Math.min(Math.max(currBxl * 3, -50), 50);


    // --- 3. EMA Stack (15%) ---
    const e8 = emaFullSeries(closes, 8);
    const e21 = emaFullSeries(closes, 21);
    const e34 = emaFullSeries(closes, 34);

    const currE8 = e8[len - 1] || 0;
    const currE21 = e21[len - 1] || 0;
    const currE34 = e34[len - 1] || 0;
    const currClose = closes[len - 1] || 0;

    // d8 = (c - e8)/e8 * 100 ...
    const d8 = ((currClose - currE8) / currE8) * 100;
    const d21 = ((currClose - currE21) / currE21) * 100;
    // d34 calculated but not used in score directly, only relative sign

    const b_stack = currE8 > currE21 && currE21 > currE34;
    const br_stack = currE8 < currE21 && currE21 < currE34;

    // Score EMA — direction-aware interpolation (v2.7)
    // When price is above EMAs (d8>0, d21>0) → bullish → score above 50
    // When price is below EMAs (d8<0, d21<0) → bearish → score below 50
    let sc_ema = 50.0;
    const signAligned = (d8 > 0 && d21 > 0) || (d8 < 0 && d21 < 0);
    const bull_ema = d8 > 0 && d21 > 0;
    const signStrength = signAligned ? Math.min(Math.abs(d8), Math.abs(d21)) : 0;
    // Bullish: add up to 15 points. Bearish: subtract up to 15 points.
    sc_ema += (bull_ema ? 1 : -1) * (10 + Math.min(signStrength / 2, 1) * 15);

    // Stack-order component [±5..±25]: continuous gap between adjacent EMAs
    const gap1 = currE8 - currE21;
    const gap2 = currE21 - currE34;
    const stackAligned = gap1 * gap2 > 0; // both same direction = ordered stack
    const bullStack = stackAligned && gap1 > 0;  // E8>E21>E34: bull stack
    const stackStrength = stackAligned
        ? Math.min(Math.abs(gap1), Math.abs(gap2)) / currClose * 100 : 0;
    // Bull stack: add up to 20 points. Bear stack (E8<E21<E34): subtract up to 20 points.
    sc_ema += (bullStack ? 1 : (stackAligned ? -1 : 0)) * (5 + Math.min(stackStrength / 0.5, 1) * 20);


    // --- 4. Momentum (10%) ---
    // ch1 = (close - close[1])/close[1]*100
    // ch3 = (close - close[3])/close[3]*100
    const prevClose1 = closes[len - 2] || currClose;
    const prevClose3 = closes[len - 4] || currClose; // index len-1 is current (0 days ago). len-4 is 3 days ago?
    // Pinscript: close[1] is 1 bar ago. close[3] is 3 bars ago.
    // If len-1 is current. len-2 is 1 ago. len-4 is 3 ago.

    const ch1 = ((currClose - prevClose1) / prevClose1) * 100;
    const ch3 = ((currClose - prevClose3) / prevClose3) * 100;

    // Momentum — signed interpolation (direction-aware, v2.7)
    // Positive momentum → adds above baseline; negative momentum → subtracts from baseline.
    // A -5% crash should reduce the score, not inflate it like a +5% rally.
    let sc_mom = 50.0;
    // 1-bar change: sign × 0–20 points (capped at |ch1| = 2%)
    sc_mom += Math.sign(ch1) * Math.min(Math.abs(ch1) / 2, 1) * 20;
    // 3-bar change: sign × 0–20 points (capped at |ch3| = 5%)
    sc_mom += Math.sign(ch3) * Math.min(Math.abs(ch3) / 5, 1) * 20;


    // --- 5. Total Score ---
    const w_mb = opts.w_mb, w_bxs = opts.w_bxs, w_bxl = opts.w_bxl, w_ema = opts.w_ema, w_mom = opts.w_mom;
    const totalW = w_mb + w_bxs + w_bxl + w_ema + w_mom;

    // NaN Protection + [0,100] clamping (v2.7)
    const f_mb = Math.max(0, Math.min(100, isNaN(sc_mb) ? 50 : sc_mb));
    const f_bxs = Math.max(0, Math.min(100, isNaN(sc_bxs) ? 50 : sc_bxs));
    const f_bxl = Math.max(0, Math.min(100, isNaN(sc_bxl) ? 50 : sc_bxl));
    const f_ema = Math.max(0, Math.min(100, isNaN(sc_ema) ? 50 : sc_ema));
    const f_mom = Math.max(0, Math.min(100, isNaN(sc_mom) ? 50 : sc_mom));

    const comp = (f_mb * w_mb + f_bxs * w_bxs + f_bxl * w_bxl + f_ema * w_ema + f_mom * w_mom) / totalW;


    // --- Identification / Signal ---
    // Logic from s_identify
    const oscVal = currOsc; // mb
    const bull = is_bull;
    // d8, d21, d34, cup8, cdn8, etc.
    const cup8 = currClose > currE8 && prevClose1 <= (e8[len - 2] || 0);
    const cdn8 = currClose < currE8 && prevClose1 >= (e8[len - 2] || 0);
    const cr_up = currBxs > 0 && (stX[len - 2] || 0) <= 0;
    const cr_dn = currBxs < 0 && (stX[len - 2] || 0) >= 0;
    const t21 = Math.abs(d21) < 1.0;
    const t34 = Math.abs(((currClose - currE34) / currE34) * 100) < 1.5;

    let name = "Mixed";
    let type: 'CALL' | 'PUT' | 'NEUTRAL' = "NEUTRAL";
    let conf = 0;

    // Note: This logic is complex, translating literally
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
        name = "Breakdown"; type = "PUT", conf = 3;
    } else if ((bs_bear || oscVal < 0) && rev_dn && currBxs < 10 && cdn8) {
        name = "Distribution"; type = "PUT"; conf = 1;
    } else if (!bull && oscVal < -2 && currBxs < -5 && currBxl < -8 && d8 < 0 && br_stack) {
        name = "Strong Down"; type = "PUT"; conf = 2;
    } else {
        if (bull && currBxs > 0) { name = "Bullish"; type = "CALL"; }
        else if (!bull && currBxs < 0) { name = "Bearish"; type = "PUT"; }
    }

    // Signal String
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
        type,
        signal: sig,
        setup: name,
        confidence: conf,
        components: {
            sc_mb: Math.round(f_mb),
            sc_bxs: Math.round(f_bxs),
            sc_bxl: Math.round(f_bxl),
            sc_ema: Math.round(f_ema),
            sc_mom: Math.round(f_mom)
        },
        debug: {
            mb_osc: parseFloat(oscVal.toFixed(2)),
            bxs: parseFloat(currBxs.toFixed(2)),
            bxl: parseFloat(currBxl.toFixed(2)),
            d8: parseFloat(d8.toFixed(2)),
            reversal: rev_up || rev_dn,
            close: currClose
        }
    };
}

// ============================================================
// V4 FACTOR MODEL — 4-Factor Hierarchical Scoring
// ============================================================

export interface TechScoreV4Result {
    techScore: number;
    type: 'CALL' | 'PUT' | 'NEUTRAL';
    signal: string;
    setup: string;
    confidence: number;
    entryContext: 'OPTIMAL' | 'ACCEPTABLE' | 'MARGINAL' | 'CHASING';
    factors: {
        trend: number;        // Trend Direction factor (0-100)
        structure: number;    // Structure Quality factor (0-100)
        entryQuality: number; // Entry Quality factor (0-100)
        volume: number;       // Volume Confirmation factor (0-100)
    };
    mtf: {
        weeklyScore: number;
        weeklyDir: number;
        modifier: number;
    };
    dynamicTPSL: {
        tpMult: number;
        slMult: number;
    };
    debug: {
        mb: number; bxs: number; bxl: number; adxV: number;
        rvol: number; d1_ema8: number; isSqueeze: boolean; close: number;
    };
}

type Candle = { open: number; high: number; low: number; close: number; volume?: number };

// ── Factor 1: Trend Direction ────────────────────────────────────────────────
// TypeScript mirror of Pine s_calc_trend_factor
function calcTrendFactor(dir: number, mb: number, iss: boolean, bxs: number, bxl: number): number {
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    const mbNorm  = clamp(mb  * dir / 5.0);
    const bxsNorm = clamp(bxs * dir / 30.0);
    const bxlNorm = clamp(bxl * dir / 25.0);
    const allAligned = mbNorm > 0 && bxsNorm > 0 && bxlNorm > 0;
    const convergence = allAligned ? 1.15 : (mbNorm > 0 && bxsNorm > 0 ? 1.0 : 0.85);
    const raw = (mbNorm * 0.45 + bxsNorm * 0.35 + bxlNorm * 0.20) * convergence;
    const strBonus = iss && mbNorm > 0.3 ? 0.10 : 0.0;
    return Math.max(0, Math.min(100, 50 + (raw + strBonus) * 100));
}

// ── Factor 2: Structure Quality ──────────────────────────────────────────────
// TypeScript mirror of Pine s_calc_structure_factor
function calcStructureFactor(
    dir: number, d1: number, d2: number, d3: number,
    bstk: boolean, brstk: boolean, adxV: number, setupName: string
): number {
    const emaAligned = (dir > 0 && bstk) || (dir < 0 && brstk);
    const emaPartial = (dir > 0 && d1 > 0 && d2 > 0) || (dir < 0 && d1 < 0 && d2 < 0);
    const emaComp = emaAligned ? 0.40 : emaPartial ? 0.20 : (d1 * dir > 0 ? 0.05 : -0.15);
    const gapNorm = emaAligned ? Math.min(Math.abs(d2) / 3.0, 1.0) * 0.10 : 0.0;
    const adxComp = adxV > 25 ? 0.15 : adxV > 20 ? 0.05 : -0.05;
    const isStrong = ['Perfect Storm','Breakout','Breakdown','Strong Trend','Strong Down'].includes(setupName);
    const raw = emaComp + gapNorm + adxComp + (isStrong ? 0.10 : 0.0);
    return Math.max(0, Math.min(100, 50 + raw * 100));
}

// ── Factor 3: Entry Quality ──────────────────────────────────────────────────
// TypeScript mirror of Pine s_calc_entry_quality_4h
// NOTE: When called with daily candles, e8/e21/atr are daily values.
//       The scoring logic is identical — the "4H" label refers to entry-timing semantics.
function calcEntryQuality(
    dir: number, close: number, e8: number, e21: number, atr: number,
    rvolNow: number, ch1: number, bxs: number, isSqueeze: boolean
): number {
    const d1 = e8 > 0 ? (close - e8) / e8 * 100 : 0;
    const distE21Atr = atr > 0 ? (close - e21) / atr * dir : 0;
    const dirD1 = dir > 0 ? d1 : -d1;

    // Pullback depth (40%)
    const pbRaw = dirD1 > 2.0  ? -0.40 :
                  dirD1 > 1.0  ? -0.40 + (2.0 - dirD1) * 0.25 :
                  dirD1 > 0.0  ? -0.15 + (1.0 - dirD1) * 0.25 :
                  dirD1 > -0.5 ?  0.10 + Math.abs(dirD1) * 0.60 :
                  dirD1 > -1.5 ?  0.40 :
                                   0.40 - (Math.abs(dirD1) - 1.5) * 0.20;
    const e21Bonus = distE21Atr < 0.5 ? 0.10 : distE21Atr < 1.0 ? 0.05 : 0.0;

    // Momentum reset (30%)
    const bxsDir = bxs * dir;
    const ch1Dir = ch1 * dir;
    const momReset = bxsDir < -5 && ch1Dir > 0    ?  0.35 :
                     bxsDir < 0  && ch1Dir > 0    ?  0.25 :
                     bxsDir < 0  && ch1Dir >= -0.1 ?  0.15 :
                     bxsDir > 0  && ch1Dir > 0.5  ? -0.15 :
                     bxsDir > 10                   ? -0.20 : 0.0;

    // Volatility contraction (15%)
    const volContr = isSqueeze ? 0.30 : rvolNow < 0.7 ? 0.15 : rvolNow < 1.0 ? 0.05 : 0.0;

    // Overextension penalty (15%) — continuous gradient vs binary cliff
    const absDist = Math.abs(distE21Atr);
    const overext = absDist > 3.0 ? -0.40 : absDist > 2.5 ? -0.30 :
                    absDist > 2.0 ? -0.15 : absDist > 1.5 ? -0.05 : 0.0;

    const eqRaw = (pbRaw + e21Bonus) * 0.40 + momReset * 0.30 + volContr * 0.15 + overext * 0.15;
    return Math.max(0, Math.min(100, 50 + eqRaw * 100));
}

/** Aggregate daily candles into weekly candles (Mon–Fri). */
export function aggregateToWeekly(dailyCandles: Candle[]): Candle[] {
    const weekly: Candle[] = [];
    let current: Candle | null = null;
    for (const c of dailyCandles) {
        if (!current) {
            current = { ...c, volume: c.volume ?? 0 };
        } else {
            // Approximate weekly grouping: collect until open gaps significantly reset
            // Simplification: use 5-bar groups as proxy for weeks
            current = {
                open:   current.open,
                high:   Math.max(current.high, c.high),
                low:    Math.min(current.low, c.low),
                close:  c.close,
                volume: (current.volume ?? 0) + (c.volume ?? 0)
            };
        }
    }
    // Produce weekly candles in 5-bar windows
    for (let i = 0; i < dailyCandles.length; i += 5) {
        const slice = dailyCandles.slice(i, i + 5);
        if (slice.length < 3) continue;
        weekly.push({
            open:   slice[0].open,
            high:   Math.max(...slice.map(s => s.high)),
            low:    Math.min(...slice.map(s => s.low)),
            close:  slice[slice.length - 1].close,
            volume: slice.reduce((acc, s) => acc + (s.volume ?? 0), 0)
        });
    }
    return weekly;
}

/**
 * Calculate v4 Tech Score — 4-Factor Hierarchical Model.
 * @param dailyCandles  Daily OHLCV candles (≥ 150 required; ≥ 300 recommended).
 * @param weeklyCandles Optional weekly candles for MTF modifier. Pass result of aggregateToWeekly()
 *                      or null/undefined to default to neutral MTF modifier (1.0).
 * @param rvolPeriod    RVOL baseline period. Default 20.
 * @param tp_atr        Base TP ATR multiplier. Default 2.0.
 * @param sl_atr        Base SL ATR multiplier. Default 1.0.
 */
export function calculateTechScoreV4(
    dailyCandles: Candle[],
    weeklyCandles?: Candle[] | null,
    rvolPeriod = 20,
    tp_atr = 2.0,
    sl_atr = 1.0
): TechScoreV4Result {
    const neutral: TechScoreV4Result = {
        techScore: 50, type: 'NEUTRAL', signal: '👀 WATCH', setup: 'Insufficient Data',
        confidence: 0, entryContext: 'MARGINAL',
        factors: { trend: 50, structure: 50, entryQuality: 50, volume: 50 },
        mtf: { weeklyScore: 50, weeklyDir: 0, modifier: 1.0 },
        dynamicTPSL: { tpMult: tp_atr, slMult: sl_atr },
        debug: { mb: 0, bxs: 0, bxl: 0, adxV: 20, rvol: 1, d1_ema8: 0, isSqueeze: false, close: 0 }
    };
    if (dailyCandles.length < 50) return neutral;

    const closes  = dailyCandles.map(c => c.close);
    const opens   = dailyCandles.map(c => c.open);
    const highs   = dailyCandles.map(c => c.high);
    const lows    = dailyCandles.map(c => c.low);
    const volumes = dailyCandles.map(c => c.volume ?? 1);
    const len = closes.length;
    const last = len - 1;

    // ── MB (same as v3) ──────────────────────────────────────────────────────
    const haLen = 20;
    const { haOpens, haCloses } = heikinAshiPine(
        emaFullSeries(opens, haLen), emaFullSeries(highs, haLen),
        emaFullSeries(lows, haLen),  emaFullSeries(closes, haLen)
    );
    const osc     = emaFullSeries(haCloses, haLen).map((c, i) => 100 * (c - emaFullSeries(haOpens, haLen)[i]));
    const oscSmth = emaFullSeries(osc, 7);
    const mb      = osc[last] ?? 0;
    const isb     = mb > 0;
    const iss     = isb ? mb >= (oscSmth[last] ?? 0) : mb <= (oscSmth[last] ?? 0);

    // ── BXS / BXL ────────────────────────────────────────────────────────────
    const stX  = rsi(emaFullSeries(closes, 5).map((v, i) => v - emaFullSeries(closes, 20)[i]), 15).map(v => v - 50);
    const ltX  = rsi(emaFullSeries(closes, 20), 15).map(v => v - 50);
    const mstX = t3_smooth(stX, 5);
    const bxs  = stX[last] ?? 0;
    const bxl  = ltX[last] ?? 0;
    const mabxs     = mstX[last] ?? 0;
    const prevMabxs = mstX[last - 1] ?? 0;
    const rev_up = mabxs > prevMabxs && prevMabxs < (mstX[last - 2] ?? 0);
    const rev_dn = mabxs < prevMabxs && prevMabxs > (mstX[last - 2] ?? 0);

    // ── EMA Stack ────────────────────────────────────────────────────────────
    const e8s  = emaFullSeries(closes, 8);
    const e21s = emaFullSeries(closes, 21);
    const e34s = emaFullSeries(closes, 34);
    const currClose = closes[last];
    const e8  = e8s[last] ?? currClose;
    const e21 = e21s[last] ?? currClose;
    const e34 = e34s[last] ?? currClose;
    const d1 = e8  > 0 ? (currClose - e8)  / e8  * 100 : 0;
    const d2 = e21 > 0 ? (currClose - e21) / e21 * 100 : 0;
    const d3 = e34 > 0 ? (currClose - e34) / e34 * 100 : 0;
    const bstk  = e8 > e21 && e21 > e34;
    const brstk = e8 < e21 && e21 < e34;

    // ── ADX ──────────────────────────────────────────────────────────────────
    const { adx: adxSeries } = calcADX(highs, lows, closes, 14);
    const adxV = adxSeries[last] ?? 20;

    // ── RVOL ─────────────────────────────────────────────────────────────────
    const { rvol: rvolSeries } = calcRVOL(volumes, rvolPeriod);
    const rvolNow = rvolSeries[last] ?? 1.0;

    // ── ATR ───────────────────────────────────────────────────────────────────
    const atrSeries = calcATR(highs, lows, closes, 14);
    const atr = atrSeries[last] ?? (currClose * 0.01);

    // ── Squeeze ───────────────────────────────────────────────────────────────
    const sqzSeries = detectSqueeze(closes, highs, lows);
    const isSqueeze = sqzSeries[last] || sqzSeries[last - 1] || sqzSeries[last - 2];

    // ── Setup Identification (reused from v3 pattern) ─────────────────────────
    const prevClose1 = closes[last - 1] ?? currClose;
    const cup8 = currClose > e8  && prevClose1 <= (e8s[last - 1] ?? 0);
    const cdn8 = currClose < e8  && prevClose1 >= (e8s[last - 1] ?? 0);
    const cr_up = bxs > 0 && (stX[last - 1] ?? 0) <= 0;
    const bs_bull = mb > 0 && (osc[last - 1] ?? 0) < 0;
    const bs_bear = mb < 0 && (osc[last - 1] ?? 0) > 0;
    const t21 = Math.abs(d2) < 1.0;
    const t34 = Math.abs(d3) < 1.5;
    let setupName = 'Mixed';
    let setupConf = 1;
    if      ((bs_bull || mb > 2) && (cr_up || (bxs > 0 && rev_up)) && bxl > 0 && cup8 && bstk) { setupName = 'Perfect Storm'; setupConf = 3; }
    else if (isb && mb > 2 && bxs > 10 && bxl > 5 && cup8 && d1 > 1 && d2 > 0)                 { setupName = 'Breakout'; setupConf = 3; }
    else if (isb && mb > 1 && bxs > 0 && bxl > 0 && (t21 || t34) && d1 > -2 && bstk)            { setupName = 'Pullback Buy'; setupConf = 2; }
    else if (isb && mb > 2 && bxs > 5 && bxl > 8 && d1 > 0 && bstk)                             { setupName = 'Strong Trend'; setupConf = 2; }
    else if ((bs_bear || mb < -2) && bxs < -10 && bxl < -5 && cdn8 && d1 < -1 && d2 < 0)        { setupName = 'Breakdown'; setupConf = 3; }
    else if (!isb && mb < -1 && bxs < 0 && bxl < 0 && (t21 || t34) && d1 < 2 && brstk)          { setupName = 'Failed Rally'; setupConf = 2; }
    else if (!isb && mb < -2 && bxs < -5 && bxl < -8 && d1 < 0 && brstk)                        { setupName = 'Strong Down'; setupConf = 2; }
    else if (isb && bxs > 0) { setupName = 'Bullish'; setupConf = 1; }
    else if (!isb && bxs < 0) { setupName = 'Bearish'; setupConf = 1; }

    // ── Direction from MB + BXS ───────────────────────────────────────────────
    const dir = isb && bxs > 0 ? 1 : (!isb && bxs < 0 ? -1 : 0);

    // ── V4 Factors ────────────────────────────────────────────────────────────
    const fTrend     = calcTrendFactor(dir, mb, iss, bxs, bxl);
    const fStructure = calcStructureFactor(dir, d1, d2, d3, bstk, brstk, adxV, setupName);
    const ch1 = last > 0 && closes[last - 1] > 0 ? (currClose - closes[last - 1]) / closes[last - 1] * 100 : 0;
    const fEntry  = calcEntryQuality(dir, currClose, e8, e21, atr, rvolNow, ch1, bxs, isSqueeze);
    const fVolume = rvolNow >= 2.0 ? 100 : rvolNow >= 1.5 ? 90 : rvolNow >= 1.3 ? 75 :
                    rvolNow >= 1.0 ? 60  : rvolNow >= 0.7 ? 40 : 25;

    // ── Weekly MTF (optional) ─────────────────────────────────────────────────
    let wkScore = 50, wkDir = 0, mtfMod = 1.0;
    if (weeklyCandles && weeklyCandles.length >= 10) {
        const wClose = weeklyCandles.map(c => c.close);
        const wOpen  = weeklyCandles.map(c => c.open);
        const wHigh  = weeklyCandles.map(c => c.high);
        const wLow   = weeklyCandles.map(c => c.low);
        const wLen = wClose.length;
        const wLast = wLen - 1;
        const wHa = heikinAshiPine(emaFullSeries(wOpen, 20), emaFullSeries(wHigh, 20), emaFullSeries(wLow, 20), emaFullSeries(wClose, 20));
        const wOsc = emaFullSeries(wHa.haCloses, 20).map((c, i) => 100 * (c - emaFullSeries(wHa.haOpens, 20)[i]));
        const wMb = wOsc[wLast] ?? 0;
        const wIsb = wMb > 0;
        const wStX = rsi(emaFullSeries(wClose, 5).map((v, i) => v - emaFullSeries(wClose, 20)[i]), 15).map(v => v - 50);
        const wBxs = wStX[wLast] ?? 0;
        const wLtX = rsi(emaFullSeries(wClose, 20), 15).map(v => v - 50);
        const wBxl = wLtX[wLast] ?? 0;
        const wE8s = emaFullSeries(wClose, 8); const wE21s = emaFullSeries(wClose, 21); const wE34s = emaFullSeries(wClose, 34);
        const we8 = wE8s[wLast] ?? wClose[wLast]; const we21 = wE21s[wLast] ?? wClose[wLast]; const we34 = wE34s[wLast] ?? wClose[wLast];
        const wd1 = we8  > 0 ? (wClose[wLast] - we8)  / we8  * 100 : 0;
        const wd2 = we21 > 0 ? (wClose[wLast] - we21) / we21 * 100 : 0;
        const wd3 = we34 > 0 ? (wClose[wLast] - we34) / we34 * 100 : 0;
        const wBstk = we8 > we21 && we21 > we34; const wBrstk = we8 < we21 && we21 < we34;
        const { adx: wAdxSeries } = calcADX(wHigh, wLow, wClose, 14);
        const wAdv = wAdxSeries[wLast] ?? 20;
        const wIss = wIsb ? wMb >= (emaFullSeries(wOsc, 7)[wLast] ?? 0) : wMb <= (emaFullSeries(wOsc, 7)[wLast] ?? 0);
        wkDir = wIsb && wBxs > 0 ? 1 : (!wIsb && wBxs < 0 ? -1 : 0);
        const wkTrend  = calcTrendFactor(wkDir, wMb, wIss, wBxs, wBxl);
        const wkStruct = calcStructureFactor(wkDir, wd1, wd2, wd3, wBstk, wBrstk, wAdv, '');
        let barsAligned = 0;
        for (let k = Math.max(0, wLast - 7); k <= wLast; k++) if ((wkDir > 0 && wOsc[k] > 0) || (wkDir < 0 && wOsc[k] < 0)) barsAligned++;
        const persistence = barsAligned >= 6 ? 90 : barsAligned >= 4 ? 75 : barsAligned >= 2 ? 55 : 35;
        wkScore = wkTrend * 0.40 + wkStruct * 0.35 + persistence * 0.25;
        const mtfAligned = (dir > 0 && wkDir > 0) || (dir < 0 && wkDir < 0);
        const mtfOpposed = (dir > 0 && wkDir < 0) || (dir < 0 && wkDir > 0);
        mtfMod = mtfAligned ? 1.0 + (wkScore - 50) / 500 :
                 mtfOpposed && wkScore > 65 ? 0.75 :
                 mtfOpposed && wkScore > 55 ? 0.85 :
                 mtfOpposed ? 0.92 : 1.0;
    }

    // ── Hierarchical Composite ────────────────────────────────────────────────
    const base = fTrend * 0.50 + fStructure * 0.30 + fVolume * 0.20;
    const eqNorm = (fEntry - 50) / 50;
    let entryMult = 1.0 + eqNorm * 0.30;
    if (base > 75 && entryMult < 0.85) entryMult = 0.85;
    const coreAgree = (mb * dir > 0 ? 1 : 0) + (bxs * dir > 0 ? 1 : 0) + (bxl * dir > 0 ? 1 : 0);
    const coherence = coreAgree === 3 ? 1.10 : coreAgree === 2 ? 1.0 : coreAgree === 1 ? 0.85 : 0.70;
    const st = dir > 0 ? 'CALL' : dir < 0 ? 'PUT' : 'NEUTRAL';
    let comp = Math.min(base * entryMult * coherence * mtfMod, 100);
    if (st === 'NEUTRAL') comp = Math.min(comp, 55);

    // ── Entry Context & Confidence ────────────────────────────────────────────
    const entryContext: TechScoreV4Result['entryContext'] =
        fEntry >= 75 ? 'OPTIMAL' : fEntry >= 60 ? 'ACCEPTABLE' : fEntry >= 45 ? 'MARGINAL' : 'CHASING';
    let conf = setupConf;
    if (conf === 3 && entryContext === 'CHASING') conf = 2;
    if (conf === 2 && entryContext === 'OPTIMAL') conf = 3;

    // ── Dynamic TP/SL ─────────────────────────────────────────────────────────
    const eqNormTPSL = entryContext === 'OPTIMAL' ? 0.75 : entryContext === 'ACCEPTABLE' ? 0.25 :
                       entryContext === 'MARGINAL' ? -0.10 : -0.40;
    const tpMult = tp_atr * (1.0 + eqNormTPSL * 0.25);
    const slMult = sl_atr * (1.0 - eqNormTPSL * 0.30);

    // ── Signal Generation ─────────────────────────────────────────────────────
    let sig = '👀 WATCH';
    if (st === 'CALL') {
        if (entryContext === 'CHASING' && comp >= 80)             sig = '⏳ WAIT PB';
        else if (entryContext === 'CHASING')                      sig = '👀 WATCH · CALL';
        else if (comp >= 85 && conf === 3 && entryContext === 'OPTIMAL') sig = '🟢 STR BUY ✦';
        else if (comp >= 75 && entryContext === 'OPTIMAL')        sig = '🟢 BUY ✦';
        else if (comp >= 80 && entryContext === 'ACCEPTABLE')     sig = '🟢 BUY';
        else if (comp >= 70)                                       sig = '🟡 BUY';
        else if (entryContext === 'OPTIMAL' && comp >= 60)        sig = '👀 WATCH PB✓';
        else                                                       sig = '👀 WATCH · CALL';
    } else if (st === 'PUT') {
        if (entryContext === 'CHASING' && comp >= 80)             sig = '⏳ WAIT PB';
        else if (entryContext === 'CHASING')                      sig = '👀 WATCH · PUT';
        else if (comp >= 85 && conf === 3 && entryContext === 'OPTIMAL') sig = '🔴 STR SELL ✦';
        else if (comp >= 75 && entryContext === 'OPTIMAL')        sig = '🔴 SELL ✦';
        else if (comp >= 80 && entryContext === 'ACCEPTABLE')     sig = '🔴 SELL';
        else if (comp >= 70)                                       sig = '🟡 SELL';
        else if (entryContext === 'OPTIMAL' && comp >= 60)        sig = '👀 WATCH PB✓';
        else                                                       sig = '👀 WATCH · PUT';
    }

    return {
        techScore: Math.round(comp),
        type: st,
        signal: sig,
        setup: setupName,
        confidence: conf,
        entryContext,
        factors: {
            trend:        Math.round(fTrend),
            structure:    Math.round(fStructure),
            entryQuality: Math.round(fEntry),
            volume:       Math.round(fVolume)
        },
        mtf: { weeklyScore: Math.round(wkScore), weeklyDir: wkDir, modifier: parseFloat(mtfMod.toFixed(3)) },
        dynamicTPSL: { tpMult: parseFloat(tpMult.toFixed(2)), slMult: parseFloat(slMult.toFixed(2)) },
        debug: {
            mb: parseFloat(mb.toFixed(2)), bxs: parseFloat(bxs.toFixed(2)), bxl: parseFloat(bxl.toFixed(2)),
            adxV: parseFloat(adxV.toFixed(1)), rvol: parseFloat(rvolNow.toFixed(2)),
            d1_ema8: parseFloat(d1.toFixed(2)), isSqueeze, close: currClose
        }
    };
}
