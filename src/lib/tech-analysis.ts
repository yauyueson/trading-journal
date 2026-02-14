
import { ema, rsi, t3_smooth, heikinAshi } from './indicators';

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
    sc_bx_s1?: number;
    sc_bx_s2?: number;
    sc_bx_s3?: number;
    sc_bx_l1?: number;
    sc_bx_l2?: number;
}

const DEFAULT_OPTIONS: Required<TechScoreOptions> = {
    w_mb: 30,
    w_bxs: 25,
    w_bxl: 20,
    w_ema: 15,
    w_mom: 10,
    sc_mb_len: 100,
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

    // --- 1. Market Bias ---
    const haLen = opts.sc_mb_len;
    const mb_o = ema(opens, haLen);
    const mb_c = ema(closes, haLen);
    const mb_h = ema(highs, haLen);
    const mb_l = ema(lows, haLen);

    // Construct "Heikin Ashi" from the smoothed values
    // PineScript: haclose = (mb_o + mb_h + mb_l + mb_c) / 4 ...
    // Note: We need to pass the *smoothed* arrays to heikinAshi? 
    // No, standard HA takes raw arrays. But the script applies EMA *before* forming HA.
    // So we treat mb_o/h/l/c as the inputs to HA generation.
    const haCandles = heikinAshi(mb_o, mb_h, mb_l, mb_c);

    // Extract HA components
    const haOpens = haCandles.map(c => c.open);
    const haCloses = haCandles.map(c => c.close);

    const haLen2 = opts.sc_mb_len;
    const o2 = ema(haOpens, haLen2);
    const c2 = ema(haCloses, haLen2);

    // Osc = 100 * (c2 - o2)
    const osc = c2.map((c, i) => 100 * (c - o2[i]));

    // sm = ema(osc, 7)
    const oscSmooth = ema(osc, 7);

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
    const ema5 = ema(closes, s_l1);
    const ema20 = ema(closes, s_l2);
    const shortDiff = ema5.map((v, i) => v - ema20[i]);
    const stX = rsi(shortDiff, s_l3).map(v => v - 50);

    // Long Term: RSI(EMA(c, 20), 15) - 50
    const ema20_long = ema(closes, l_l1); // same as ema20 if period matches
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

    // Score BX Short
    // sc_bxs = 50.0 + min(max(bxs*2, -50), 50) + (mabxs>mabxs[1]?15:5) + ((rvu or rvd)?15:0)
    let sc_bxs = 50.0;
    sc_bxs += Math.min(Math.max(currBxs * 2, -50), 50);
    sc_bxs += (currMabxs > prevMabxs ? 15 : 5);
    sc_bxs += ((rev_up || rev_dn) ? 15 : 0);

    // Score BX Long
    // sc_bxl = 50.0 + min(max(bxl*3, -50), 50)
    let sc_bxl = 50.0 + Math.min(Math.max(currBxl * 3, -50), 50);


    // --- 3. EMA Stack (15%) ---
    // e8, e21, e34
    const e8 = ema(closes, 8);
    const e21 = ema(closes, 21);
    const e34 = ema(closes, 34);

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

    // Score EMA
    // sc_ema = 50.0 + (((d8>0 and d21>0) or (d8<0 and d21<0))?25:10) + ((bstk or brstk)?25:5)
    let sc_ema = 50.0;
    const sameSign = (d8 > 0 && d21 > 0) || (d8 < 0 && d21 < 0);
    sc_ema += (sameSign ? 25 : 10);
    sc_ema += ((b_stack || br_stack) ? 25 : 5);


    // --- 4. Momentum (10%) ---
    // ch1 = (close - close[1])/close[1]*100
    // ch3 = (close - close[3])/close[3]*100
    const prevClose1 = closes[len - 2] || currClose;
    const prevClose3 = closes[len - 4] || currClose; // index len-1 is current (0 days ago). len-4 is 3 days ago?
    // Pinscript: close[1] is 1 bar ago. close[3] is 3 bars ago.
    // If len-1 is current. len-2 is 1 ago. len-4 is 3 ago.

    const ch1 = ((currClose - prevClose1) / prevClose1) * 100;
    const ch3 = ((currClose - prevClose3) / prevClose3) * 100;

    // sc_mom = 50.0 + (abs(ch1)>2?25:abs(ch1)>1?15:5) + (abs(ch3)>5?25:abs(ch3)>2?15:5)
    let sc_mom = 50.0;
    const absCh1 = Math.abs(ch1);
    const absCh3 = Math.abs(ch3);

    sc_mom += (absCh1 > 2 ? 25 : absCh1 > 1 ? 15 : 5);
    sc_mom += (absCh3 > 5 ? 25 : absCh3 > 2 ? 15 : 5);


    // --- 5. Total Score ---
    const w_mb = opts.w_mb, w_bxs = opts.w_bxs, w_bxl = opts.w_bxl, w_ema = opts.w_ema, w_mom = opts.w_mom;
    const totalW = w_mb + w_bxs + w_bxl + w_ema + w_mom;

    // NaN Protection (nz(..., 50))
    const f_mb = isNaN(sc_mb) ? 50 : sc_mb;
    const f_bxs = isNaN(sc_bxs) ? 50 : sc_bxs;
    const f_bxl = isNaN(sc_bxl) ? 50 : sc_bxl;
    const f_ema = isNaN(sc_ema) ? 50 : sc_ema;
    const f_mom = isNaN(sc_mom) ? 50 : sc_mom;

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
