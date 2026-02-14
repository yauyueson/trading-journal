
/**
 * Technical Analysis Indicators
 * Primitives for Tech Score calculation.
 */

/**
 * Simple Moving Average (SMA)
 */
export function sma(values: number[], period: number): number[] {
    const result: number[] = [];
    if (values.length < period) return result; // Return empty, or handle as needed

    for (let i = 0; i < values.length; i++) {
        if (i < period - 1) {
            result.push(NaN); // Or handle warmup
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
 */
export function ema(values: number[], period: number): number[] {
    const result: number[] = [];
    if (values.length === 0) return result;

    const k = 2 / (period + 1);

    // First EMA is often initialized with SMA, but for simplicity and consistency with some libs,
    // we can start with the first value or SMA of first 'period' elements.
    // PineScript EMA usually starts from the beginning of the series.
    // Standard practice: First valid EMA is at index `period-1`, which is the SMA of first `period` values.

    let currentEma = values[0]; // Fallback if length < period, but let's do SMA init

    // Calculate initial SMA
    if (values.length >= period) {
        let sum = 0;
        for (let i = 0; i < period; i++) sum += values[i];
        currentEma = sum / period;

        // Fill warmup with NaNs
        for (let i = 0; i < period - 1; i++) result.push(NaN);
        result.push(currentEma);

        // Calculate subsequent EMAs
        for (let i = period; i < values.length; i++) {
            currentEma = (values[i] - currentEma) * k + currentEma;
            result.push(currentEma);
        }
    } else {
        // Not enough data for strict EMA definition
        return values.map(_ => NaN);
    }

    return result;
}

/**
 * EMA that matches PineScript behavior (no NaN padding at start, rolling from index 0)
 * PineScript 'ta.ema' often creates values from the very start if using `bar_index`.
 * But `ta.ema` usually becomes valid only after some bars.
 * For the purpose of this algo, using the standard "SMA init" approach is safer for stability.
 * However, the user's script uses `nz` heavily, implying data might be sparse or warmup matters.
 * Let's stick to the standard EMA implementation above but ensure we handle `NaN`s in the consumer.
 */

/**
 * Relative Strength Index (RSI)
 */
export function rsi(values: number[], period: number): number[] {
    const result: number[] = [];
    if (values.length < period + 1) return values.map(_ => NaN);

    let gains = 0;
    let losses = 0;

    // First RSI
    for (let i = 1; i <= period; i++) {
        const diff = values[i] - values[i - 1];
        if (diff >= 0) gains += diff;
        else losses += Math.abs(diff);
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    // Fill warmup
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

    // Pad the beginning to match input length (optional, but good for alignment)
    // The loop above pushes `NaN` for warmup, but check length.
    // We pushed `period` NaNs, then the first value at index `period`.
    // So result[i] corresponds to values[i].

    return result;
}


/**
 * T3 Smoothing (Tillson T3 Moving Average)
 * Formula from User's PineScript:
 * xe1 = ema(src, len), xe2 = ema(xe1, len), ... xe6 = ema(xe5, len)
 * b = 0.7
 * c1...c4 (coefficients)
 * T3 = c1*xe6 + c2*xe5 + c3*xe4 + c4*xe3
 */
export function t3_smooth(values: number[], period: number, b: number = 0.7): number[] {
    const xe1 = ema(values, period);
    const xe2 = ema(xe1, period); // Note: ema handles NaNs by propagating them or restarting? 
    // Our EMA above returns NaNs during warmup. Need to handle that.
    // If input has NaNs, EMA should ideally continue returning NaNs until valid data.

    // Since our EMA implementation returns NaNs for the first `period-1` elements,
    // chaining them will result in growing NaN prefixes.
    // e.g. xe1 has P-1 NaNs. xe2 has (P-1) + (P-1) NaNs? 
    // Actually, `ema` implementation above needs `values.length >= period`.
    // If we pass an array with leading NaNs, we need to handle it.

    // Let's make a robust EMA that skips/preserves leading NaNs.
    const robustEma = (vals: number[], len: number) => {
        // Find first non-NaN index
        let firstValidIdx = vals.findIndex(v => !isNaN(v));
        if (firstValidIdx === -1) return vals.map(_ => NaN);

        const validVals = vals.slice(firstValidIdx);
        const emaVals = ema(validVals, len);

        // Prepend the skipped NaNs
        return [...vals.slice(0, firstValidIdx), ...emaVals];
    };

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

    const result: number[] = [];
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
 */
export interface HACandle {
    open: number;
    high: number;
    low: number;
    close: number;
}

export function heikinAshi(opens: number[], highs: number[], lows: number[], closes: number[]): HACandle[] {
    const result: HACandle[] = [];
    if (opens.length === 0) return result;

    // First HA candle
    // HA_Close = (O+H+L+C)/4
    // HA_Open = (Prev_HA_Open + Prev_HA_Close)/2  <-- Requires prev. For first one, use (O+C)/2 or O.
    // Standard: HA_Open[0] = (O[0] + C[0]) / 2

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
