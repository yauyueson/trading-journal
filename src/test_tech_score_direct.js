
// Basic indicators (stripped of TS types)

function sma(values, period) {
    const result = [];
    if (values.length < period) return result;
    for (let i = 0; i < values.length; i++) {
        if (i < period - 1) { result.push(NaN); continue; }
        let sum = 0;
        for (let j = 0; j < period; j++) sum += values[i - j];
        result.push(sum / period);
    }
    return result;
}

function ema(values, period) {
    const result = [];
    if (values.length === 0) return result;
    const k = 2 / (period + 1);
    let currentEma = values[0];
    if (values.length >= period) {
        let sum = 0;
        for (let i = 0; i < period; i++) sum += values[i];
        currentEma = sum / period;
        for (let i = 0; i < period - 1; i++) result.push(NaN);
        result.push(currentEma);
        for (let i = period; i < values.length; i++) {
            currentEma = (values[i] - currentEma) * k + currentEma;
            result.push(currentEma);
        }
    } else { return values.map(_ => NaN); }
    return result;
}

function rsi(values, period) {
    const result = [];
    if (values.length < period + 1) return values.map(_ => NaN);
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const diff = values[i] - values[i - 1];
        if (diff >= 0) gains += diff; else losses += Math.abs(diff);
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    for (let i = 0; i < period; i++) result.push(NaN);
    result.push(100 - (100 / (1 + avgGain / (avgLoss === 0 ? 1e-10 : avgLoss))));
    for (let i = period + 1; i < values.length; i++) {
        const diff = values[i] - values[i - 1];
        const gain = diff >= 0 ? diff : 0;
        const loss = diff < 0 ? Math.abs(diff) : 0;
        avgGain = ((avgGain * (period - 1)) + gain) / period;
        avgLoss = ((avgLoss * (period - 1)) + loss) / period;
        const rs = avgGain / (avgLoss === 0 ? 1e-10 : avgLoss);
        result.push(100 - (100 / (1 + rs)));
    }
    return result;
}

function robustEma(vals, len) {
    let firstValidIdx = vals.findIndex(v => !isNaN(v));
    if (firstValidIdx === -1) return vals.map(_ => NaN);
    const validVals = vals.slice(firstValidIdx);
    const emaVals = ema(validVals, len);
    return [...vals.slice(0, firstValidIdx), ...emaVals];
}

function t3_smooth(values, period, b = 0.7) {
    const e1 = robustEma(values, period);
    const e2 = robustEma(e1, period);
    const e3 = robustEma(e2, period);
    const e4 = robustEma(e3, period);
    const e5 = robustEma(e4, period);
    const e6 = robustEma(e5, period);
    const c1 = -b * b * b;
    const c2 = 3 * b * b + 3 * b * b * b;
    const c3 = -6 * b * b - 3 * b - 3 * b * b * b;
    const c4 = 1 + 3 * b + b * b * b + 3 * b * b;
    const result = [];
    for (let i = 0; i < values.length; i++) {
        const v3 = e3[i], v4 = e4[i], v5 = e5[i], v6 = e6[i];
        if (isNaN(v3) || isNaN(v4) || isNaN(v5) || isNaN(v6)) result.push(NaN);
        else result.push(c1 * v6 + c2 * v5 + c3 * v4 + c4 * v3);
    }
    return result;
}

function heikinAshi(opens, highs, lows, closes) {
    const result = [];
    if (opens.length === 0) return result;
    let prevHaOpen = (opens[0] + closes[0]) / 2;
    let prevHaClose = (opens[0] + highs[0] + lows[0] + closes[0]) / 4;
    result.push({ open: prevHaOpen, high: Math.max(highs[0], prevHaOpen, prevHaClose), low: Math.min(lows[0], prevHaOpen, prevHaClose), close: prevHaClose });
    for (let i = 1; i < opens.length; i++) {
        const haClose = (opens[i] + highs[i] + lows[i] + closes[i]) / 4;
        const haOpen = (prevHaOpen + prevHaClose) / 2;
        const haHigh = Math.max(highs[i], haOpen, haClose);
        const haLow = Math.min(lows[i], haOpen, haClose);
        result.push({ open: haOpen, high: haHigh, low: haLow, close: haClose });
        prevHaOpen = haOpen; prevHaClose = haClose;
    }
    return result;
}

// Tech Score Logic
function calculateTechScore(candles) {
    const closes = candles.map(c => c.close);
    const opens = candles.map(c => c.open);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const len = closes.length;

    if (len < 50) return { techScore: 50, type: 'NEUTRAL', signal: '⚪ WATCH', setup: 'Insufficient Data', confidence: 0, components: { sc_mb: 50, sc_bxs: 50, sc_bxl: 50, sc_ema: 50, sc_mom: 50 }, debug: { mb_osc: 0, bxs: 0, bxl: 0, d8: 0, reversal: false, close: closes[len - 1] || 0 } };

    // 1. Market Bias
    const haLen = 100;
    const mb_o = ema(opens, haLen);
    const mb_c = ema(closes, haLen);
    const mb_h = ema(highs, haLen);
    const mb_l = ema(lows, haLen);
    const haCandles = heikinAshi(mb_o, mb_h, mb_l, mb_c);
    const haOpens = haCandles.map(c => c.open);
    const haCloses = haCandles.map(c => c.close);
    const haLen2 = 100;
    const o2 = ema(haOpens, haLen2);
    const c2 = ema(haCloses, haLen2);
    const osc = c2.map((c, i) => 100 * (c - o2[i]));
    const oscSmooth = ema(osc, 7);

    const currOsc = osc[len - 1] || 0;
    const currSm = oscSmooth[len - 1] || 0;
    const prevOsc = osc[len - 2] || 0;
    const is_bull = currOsc > 0;
    const is_str = is_bull ? (currOsc >= currSm) : (currOsc <= currSm);
    const was_bear = prevOsc < 0;
    const bs_bull = is_bull && was_bear;
    const bs_bear = !is_bull && !was_bear;
    const iss = is_str;

    let sc_mb = 50.0;
    if (is_bull) sc_mb += Math.min(currOsc * 5, 30); else sc_mb -= Math.min(Math.abs(currOsc) * 5, 30);
    sc_mb += (iss ? 20 : 5);

    // 2. B-Xtrender
    const s_l1 = 5, s_l2 = 20, s_l3 = 15;
    const l_l1 = 20, l_l2 = 15;
    const ema5 = ema(closes, s_l1);
    const ema20 = ema(closes, s_l2);
    const shortDiff = ema5.map((v, i) => v - ema20[i]);
    const stX = rsi(shortDiff, s_l3).map(v => v - 50);
    const ema20_long = ema(closes, l_l1);
    const ltX = rsi(ema20_long, l_l2).map(v => v - 50);
    const mstX = t3_smooth(stX, 5);
    const currBxs = stX[len - 1] || 0;
    const currMabxs = mstX[len - 1] || 0;
    const prevMabxs = mstX[len - 2] || 0;
    const prev2Mabxs = mstX[len - 3] || 0;
    const rev_up = currMabxs > prevMabxs && prevMabxs < prev2Mabxs;
    const rev_dn = currMabxs < prevMabxs && prevMabxs > prev2Mabxs;
    const currBxl = ltX[len - 1] || 0;

    let sc_bxs = 50.0;
    sc_bxs += Math.min(Math.max(currBxs * 2, -50), 50);
    sc_bxs += (currMabxs > prevMabxs ? 15 : 5);
    sc_bxs += ((rev_up || rev_dn) ? 15 : 0);

    let sc_bxl = 50.0 + Math.min(Math.max(currBxl * 3, -50), 50);

    // 3. EMA Stack
    const e8 = ema(closes, 8);
    const e21 = ema(closes, 21);
    const e34 = ema(closes, 34);
    const currE8 = e8[len - 1] || 0;
    const currE21 = e21[len - 1] || 0;
    const currE34 = e34[len - 1] || 0;
    const currClose = closes[len - 1] || 0;
    const d8 = ((currClose - currE8) / currE8) * 100;
    const d21 = ((currClose - currE21) / currE21) * 100;
    const b_stack = currE8 > currE21 && currE21 > currE34;
    const br_stack = currE8 < currE21 && currE21 < currE34;
    let sc_ema = 50.0;
    const sameSign = (d8 > 0 && d21 > 0) || (d8 < 0 && d21 < 0);
    sc_ema += (sameSign ? 25 : 10);
    sc_ema += ((b_stack || br_stack) ? 25 : 5);

    // 4. Momentum
    const prevClose1 = closes[len - 2] || currClose;
    const prevClose3 = closes[len - 4] || currClose;
    const ch1 = ((currClose - prevClose1) / prevClose1) * 100;
    const ch3 = ((currClose - prevClose3) / prevClose3) * 100;
    let sc_mom = 50.0;
    const absCh1 = Math.abs(ch1);
    const absCh3 = Math.abs(ch3);
    sc_mom += (absCh1 > 2 ? 25 : absCh1 > 1 ? 15 : 5);
    sc_mom += (absCh3 > 5 ? 25 : absCh3 > 2 ? 15 : 5);

    // Total Score
    const w_mb = 30, w_bxs = 25, w_bxl = 20, w_ema = 15, w_mom = 10;
    const totalW = w_mb + w_bxs + w_bxl + w_ema + w_mom;
    const f_mb = isNaN(sc_mb) ? 50 : sc_mb;
    const f_bxs = isNaN(sc_bxs) ? 50 : sc_bxs;
    const f_bxl = isNaN(sc_bxl) ? 50 : sc_bxl;
    const f_ema = isNaN(sc_ema) ? 50 : sc_ema;
    const f_mom = isNaN(sc_mom) ? 50 : sc_mom;
    const comp = (f_mb * w_mb + f_bxs * w_bxs + f_bxl * w_bxl + f_ema * w_ema + f_mom * w_mom) / totalW;

    // Identify
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
        name = "Breakdown"; type = "PUT", conf = 3;
    } else if ((bs_bear || oscVal < 0) && rev_dn && currBxs < 10 && cdn8) {
        name = "Distribution"; type = "PUT"; conf = 1;
    } else if (!bull && oscVal < -2 && currBxs < -5 && currBxl < -8 && d8 < 0 && br_stack) {
        name = "Strong Down"; type = "PUT"; conf = 2;
    } else {
        if (bull && currBxs > 0) { name = "Bullish"; type = "CALL"; }
        else if (!bull && currBxs < 0) { name = "Bearish"; type = "PUT"; }
    }

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

// Test Runner
import fs from 'fs';
import path from 'path';
import { getCandles } from '../lib/polygon-client.js';

const LOG_FILE = 'test_tech_output.txt';
function log(msg) {
    console.log(msg);
    fs.appendFileSync(LOG_FILE, msg + '\n');
}
// Clear log
fs.writeFileSync(LOG_FILE, 'Starting Test...\n');

try {
    const envPath = path.resolve('.env');

    if (fs.existsSync(envPath)) {
        const envConfig = fs.readFileSync(envPath, 'utf8');
        envConfig.split('\n').forEach(line => {
            const [key, value] = line.split('=');
            if (key && value) {
                process.env[key.trim()] = value.trim();
            }
        });
        console.log("Loaded .env for test.");
    }
} catch (e) {
    console.error("Error loading .env", e);
}

async function runTest() {
    const ticker = 'SPY';

    const toDate = new Date().toISOString().split('T')[0];
    const fromDateObj = new Date();
    fromDateObj.setFullYear(fromDateObj.getFullYear() - 2);
    const fromDate = fromDateObj.toISOString().split('T')[0];

    log(`Fetching candles for ${ticker}...`);
    try {
        const candles = await getCandles(ticker, fromDate, toDate, 'day');
        log(`Fetched ${candles.length} candles.`);

        // Full history
        log("\n--- TEST: Full History (~400+ candles) ---");
        const scoreFull = calculateTechScore(candles);
        const lastCandle = candles[candles.length - 1];
        log(`Last Candle Date: ${lastCandle.date} Close: ${lastCandle.close}`);
        log("Score Object: " + JSON.stringify(scoreFull, null, 2));

    } catch (e) {
        log("Error in test: " + e.message);
    }
}

runTest();
