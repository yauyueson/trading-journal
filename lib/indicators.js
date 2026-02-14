
/**
 * Technical Analysis Indicators
 * Primitives for Tech Score calculation.
 */

/**
 * Simple Moving Average (SMA)
 * @param {number[]} values 
 * @param {number} period 
 * @returns {number[]}
 */
export function sma(values, period) {
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
 * Exponential Moving Average (EMA)
 * @param {number[]} values 
 * @param {number} period 
 * @returns {number[]}
 */
export function ema(values, period) {
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
    } else {
        return values.map(_ => NaN);
    }

    return result;
}

/**
 * Relative Strength Index (RSI)
 * @param {number[]} values 
 * @param {number} period 
 * @returns {number[]}
 */
export function rsi(values, period) {
    const result = [];
    if (values.length < period + 1) return values.map(_ => NaN);

    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
        const diff = values[i] - values[i - 1];
        if (diff >= 0) gains += diff;
        else losses += Math.abs(diff);
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

/**
 * T3 Smoothing
 * @param {number[]} values 
 * @param {number} period 
 * @param {number} b 
 * @returns {number[]}
 */
export function t3_smooth(values, period, b = 0.7) {
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
 * Heikin Ashi Candles
 * @param {number[]} opens 
 * @param {number[]} highs 
 * @param {number[]} lows 
 * @param {number[]} closes 
 * @returns {Array<{open:number, high:number, low:number, close:number}>}
 */
export function heikinAshi(opens, highs, lows, closes) {
    const result = [];
    if (opens.length === 0) return result;

    let prevHaOpen = (opens[0] + closes[0]) / 2;
    let prevHaClose = (opens[0] + highs[0] + lows[0] + closes[0]) / 4;

    result.push({
        open: prevHaOpen,
        high: Math.max(highs[0], prevHaOpen, prevHaClose),
        low: Math.min(lows[0], prevHaOpen, prevHaClose),
        close: prevHaClose
    });

    for (let i = 1; i < opens.length; i++) {
        const haClose = (opens[i] + highs[i] + lows[i] + closes[i]) / 4;
        const haOpen = (prevHaOpen + prevHaClose) / 2;
        const haHigh = Math.max(highs[i], haOpen, haClose);
        const haLow = Math.min(lows[i], haOpen, haClose);

        result.push({ open: haOpen, high: haHigh, low: haLow, close: haClose });

        prevHaOpen = haOpen;
        prevHaClose = haClose;
    }

    return result;
}
