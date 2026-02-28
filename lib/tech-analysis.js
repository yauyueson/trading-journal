
import { emaFullSeries, rsi, t3_smooth, heikinAshiPine } from './indicators.js';

/**
 * @typedef {Object} TechScoreResult
 * @property {number} techScore
 * @property {'CALL'|'PUT'|'NEUTRAL'} type
 * @property {string} signal
 * @property {string} setup
 * @property {number} confidence
 * @property {Object} components
 * @property {number} components.sc_mb
 * @property {number} components.sc_bxs
 * @property {number} components.sc_bxl
 * @property {number} components.sc_ema
 * @property {number} components.sc_mom
 * @property {Object} debug
 */

// Aligned with Pine Script "Scanner: Criteria Periods" and "Scanner: Scoring" defaults
const DEFAULT_OPTIONS = {
    w_mb: 30, w_bxs: 25, w_bxl: 20, w_ema: 15, w_mom: 10,
    sc_mb_len: 100, sc_mb_smoothing: 100, sc_osc_len: 7,
    sc_bx_s1: 5, sc_bx_s2: 20, sc_bx_s3: 15, sc_bx_l1: 20, sc_bx_l2: 15
};

/**
 * Calculate Tech Score based on user's PineScript logic ("MB+DFP + Options Scanner").
 * @param {Array<{open:number, high:number, low:number, close:number}>} candles Daily candles.
 * @param {Object} [options] Optional weights and criteria periods (match Pine Scanner when set).
 * @param {number} [options.w_mb] Weight Market Bias (default 30)
 * @param {number} [options.w_bxs] Weight B-Xtrender Short (default 25)
 * @param {number} [options.w_bxl] Weight B-Xtrender Long (default 20)
 * @param {number} [options.w_ema] Weight EMA Stack (default 15)
 * @param {number} [options.w_mom] Weight Momentum (default 10)
 * @param {number} [options.sc_mb_len] Market Bias period (default 100, Pine Scanner)
 * @param {number} [options.sc_mb_smoothing] Unused in Pine: o2/c2 use sc_mb_len
 * @param {number} [options.sc_osc_len] Oscillator smooth period (default 7)
 * @param {number} [options.sc_bx_s1] B-X Short L1 (default 5)
 * @param {number} [options.sc_bx_s2] B-X Short L2 (default 20)
 * @param {number} [options.sc_bx_s3] B-X Short L3 (default 15)
 * @param {number} [options.sc_bx_l1] B-X Long L1 (default 20)
 * @param {number} [options.sc_bx_l2] B-X Long L2 (default 15)
 * @returns {TechScoreResult}
 */
export function calculateTechScore(candles, options = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const closes = candles.map(c => c.close);
    const opens = candles.map(c => c.open);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const len = closes.length;

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
    const haLen = opts.sc_mb_len;
    const mb_o = emaFullSeries(opens, haLen);
    const mb_c = emaFullSeries(closes, haLen);
    const mb_h = emaFullSeries(highs, haLen);
    const mb_l = emaFullSeries(lows, haLen);

    const { haOpens, haCloses } = heikinAshiPine(mb_o, mb_h, mb_l, mb_c);

    const haLen2 = opts.sc_mb_len;
    const o2 = emaFullSeries(haOpens, haLen2);
    const c2 = emaFullSeries(haCloses, haLen2);

    const osc = c2.map((c, i) => 100 * (c - o2[i]));
    const oscSmooth = emaFullSeries(osc, opts.sc_osc_len);

    const currOsc = osc[len - 1] || 0;
    const currSm = oscSmooth[len - 1] || 0;
    const prevOsc = osc[len - 2] || 0;

    const is_bull = currOsc > 0;
    const is_str = is_bull ? (currOsc >= currSm) : (currOsc <= currSm);
    const was_bear = prevOsc < 0;
    const bs_bull = is_bull && was_bear;
    const bs_bear = !is_bull && !was_bear;
    const iss = is_str; // iss in script

    let sc_mb = 50.0;
    if (is_bull) {
        sc_mb += Math.min(currOsc * 5, 30);
    } else {
        sc_mb -= Math.min(Math.abs(currOsc) * 5, 30);
    }
    sc_mb += (iss ? 20 : 5);


    // --- 2. B-Xtrender ---
    const s_l1 = opts.sc_bx_s1, s_l2 = opts.sc_bx_s2, s_l3 = opts.sc_bx_s3;
    const l_l1 = opts.sc_bx_l1, l_l2 = opts.sc_bx_l2;

    const ema5 = emaFullSeries(closes, s_l1);
    const ema20 = emaFullSeries(closes, s_l2);
    const shortDiff = ema5.map((v, i) => v - ema20[i]);
    const stX = rsi(shortDiff, s_l3).map(v => v - 50);

    const ema20_long = emaFullSeries(closes, l_l1);
    const ltX = rsi(ema20_long, l_l2).map(v => v - 50);

    const mstX = t3_smooth(stX, 5); // T3 smoothing of stX

    const currBxs = stX[len - 1] || 0;
    const currMabxs = mstX[len - 1] || 0;
    const prevMabxs = mstX[len - 2] || 0;
    const prev2Mabxs = mstX[len - 3] || 0;

    // Check direction change sequence
    const rev_up = currMabxs > prevMabxs && prevMabxs < prev2Mabxs;
    const rev_dn = currMabxs < prevMabxs && prevMabxs > prev2Mabxs;

    const currBxl = ltX[len - 1] || 0;

    let sc_bxs = 50.0;
    sc_bxs += Math.min(Math.max(currBxs * 2, -50), 50);  // Direction-aware: BXS drives sign
    // MA slope: confirms momentum direction (+10 aligned, -5 opposing)
    sc_bxs += (currMabxs > prevMabxs ? 10 : -5);
    // Reversal bonus: only add for reversals in the bullish direction (rev_up),
    // penalize for bearish reversals (rev_dn). Prevents bearish pivots from inflating the score.
    sc_bxs += (rev_up ? 15 : rev_dn ? -15 : 0);

    let sc_bxl = 50.0 + Math.min(Math.max(currBxl * 3, -50), 50);


    // --- 3. EMA Stack (15%) ---
    const e8 = emaFullSeries(closes, 8);
    const e21 = emaFullSeries(closes, 21);
    const e34 = emaFullSeries(closes, 34);

    const currE8 = e8[len - 1] || 0;
    const currE21 = e21[len - 1] || 0;
    const currE34 = e34[len - 1] || 0;
    const currClose = closes[len - 1] || 0;

    const d8 = ((currClose - currE8) / currE8) * 100;
    const d21 = ((currClose - currE21) / currE21) * 100;

    const b_stack = currE8 > currE21 && currE21 > currE34;
    const br_stack = currE8 < currE21 && currE21 < currE34;

    // Score EMA — direction-aware interpolation
    // When price is above EMAs (d8>0, d21>0) → bullish → score above 50
    // When price is below EMAs (d8<0, d21<0) → bearish → score below 50
    let sc_ema = 50.0;
    const signAligned = (d8 > 0 && d21 > 0) || (d8 < 0 && d21 < 0);
    const bull_ema = d8 > 0 && d21 > 0;
    const signStrength = signAligned ? Math.min(Math.abs(d8), Math.abs(d21)) : 0;
    // Bullish: add up to 15 points. Bearish: subtract up to 15 points.
    sc_ema += (bull_ema ? 1 : -1) * (10 + Math.min(signStrength / 2, 1) * 15);

    const gap1 = currE8 - currE21;
    const gap2 = currE21 - currE34;
    const stackAligned = gap1 * gap2 > 0;
    const bullStack = stackAligned && gap1 > 0;  // E8>E21>E34: bull stack
    const stackStrength = stackAligned
        ? Math.min(Math.abs(gap1), Math.abs(gap2)) / currClose * 100 : 0;
    // Bull stack: add up to 20 points. Bear stack (E8<E21<E34): subtract up to 20 points.
    sc_ema += (bullStack ? 1 : (stackAligned ? -1 : 0)) * (5 + Math.min(stackStrength / 0.5, 1) * 20);


    // --- 4. Momentum (10%) ---
    const prevClose1 = closes[len - 2] || currClose;
    const prevClose3 = closes[len - 4] || currClose;

    const ch1 = ((currClose - prevClose1) / prevClose1) * 100;
    const ch3 = ((currClose - prevClose3) / prevClose3) * 100;

    // Momentum — signed interpolation (direction-aware)
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

    const f_mb = Math.max(0, Math.min(100, isNaN(sc_mb) ? 50 : sc_mb));
    const f_bxs = Math.max(0, Math.min(100, isNaN(sc_bxs) ? 50 : sc_bxs));
    const f_bxl = Math.max(0, Math.min(100, isNaN(sc_bxl) ? 50 : sc_bxl));
    const f_ema = Math.max(0, Math.min(100, isNaN(sc_ema) ? 50 : sc_ema));
    const f_mom = Math.max(0, Math.min(100, isNaN(sc_mom) ? 50 : sc_mom));

    const comp = (f_mb * w_mb + f_bxs * w_bxs + f_bxl * w_bxl + f_ema * w_ema + f_mom * w_mom) / totalW;


    // --- Identification ---
    const oscVal = currOsc;
    const bull = is_bull;
    const cup8 = currClose > currE8 && prevClose1 <= (e8[len - 2] || 0);
    const cdn8 = currClose < currE8 && prevClose1 >= (e8[len - 2] || 0);
    // Crossing checks need previous values
    const prevBxs = stX[len - 2] || 0;
    const cr_up = currBxs > 0 && prevBxs <= 0;
    const cr_dn = currBxs < 0 && prevBxs >= 0;
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

    // --- Pullback Quality Gate ---
    // Direction-aware: for CALL we want price at or below EMA-8 (d8 <= 0 is best);
    //                  for PUT  we want price at or above EMA-8 (d8 >= 0 is best).
    // This prevents perfect-storm signals from chasing the breakout bar.
    const dirD8 = type === 'CALL' ? d8 : (type === 'PUT' ? -d8 : 0);
    const pullbackQuality =
        dirD8 > 1.5 ? 'EXTENDED' :  // Chasing: price >1.5% past EMA-8 — worst entry
            dirD8 > 0.0 ? 'MOMENTUM' :  // On the break: acceptable but not ideal
                dirD8 >= -0.5 ? 'SWEET' :  // Near EMA-8: good entry zone
                    'PULLBACK';    // Retesting/at EMA-8: ideal entry

    // Entry zone price levels for display & downstream DTE/strike selection
    const entryZone = (type === 'CALL' || type === 'PUT') ? {
        ideal: parseFloat(currE8.toFixed(2)),
        fair: parseFloat((type === 'CALL' ? currE8 * 1.005 : currE8 * 0.995).toFixed(2)),
        extended: parseFloat((type === 'CALL' ? currE8 * 1.015 : currE8 * 0.985).toFixed(2)),
        current: parseFloat(currClose.toFixed(2))
    } : null;

    let sig = "❌ AVOID";
    if (type === "CALL") {
        if (comp >= 85 && conf === 3 && pullbackQuality === 'PULLBACK') sig = "🟢 STR BUY"; // perfect entry
        else if (comp >= 85 && pullbackQuality === 'EXTENDED') sig = "⏳ WAIT PB";            // chasing — hold off
        else if (comp >= 85) sig = "🟢 BUY";
        else if (comp >= 70 && pullbackQuality !== 'EXTENDED') sig = "🟡 BUY";
        else sig = "⚪ WATCH";
    } else if (type === "PUT") {
        if (comp >= 85 && conf === 3 && pullbackQuality === 'PULLBACK') sig = "🔴 STR SELL"; // perfect entry
        else if (comp >= 85 && pullbackQuality === 'EXTENDED') sig = "⏳ WAIT PB";            // chasing — hold off
        else if (comp >= 85) sig = "🔴 SELL";
        else if (comp >= 70 && pullbackQuality !== 'EXTENDED') sig = "🟠 SELL";
        else sig = "⚪ WATCH";
    }

    return {
        techScore: Math.round(comp),
        type,
        signal: sig,
        setup: name,
        confidence: conf,
        pullbackQuality,  // 'EXTENDED' | 'MOMENTUM' | 'SWEET' | 'PULLBACK'
        entryZone,        // { ideal, fair, extended, current } price levels
        d8: parseFloat(d8.toFixed(2)),  // % distance from EMA-8 (+ = above, - = below)
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
