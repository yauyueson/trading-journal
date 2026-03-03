
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
    const len = values.length;
    const result: number[] = new Array(len).fill(NaN);

    // Find first index where we can compute a valid diff (both values[i] and values[i-1] are finite)
    // Then collect `period` valid diffs to seed avgGain/avgLoss.
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

    // Not enough valid pairs to seed
    if (validDiffs < period) return result;

    let avgGain = seedGains / period;
    let avgLoss = seedLosses / period;

    result[seedEndIdx] = 100 - (100 / (1 + avgGain / (avgLoss === 0 ? 1e-10 : avgLoss)));

    // Running phase
    for (let i = seedEndIdx + 1; i < len; i++) {
        const curr = values[i];
        const prev = values[i - 1];

        if (!isFinite(curr) || !isFinite(prev)) {
            // NaN bar: decay averages (no new information, equivalent to shrinking window)
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
 * EMA that propagates NaNs bar-by-bar on the full series (no slice).
 * Matches Pine's ta.ema(series, len) when series has leading NaNs:
 * output is NaN until a valid value is seen; then use that as seed and continue.
 */
export function emaFullSeries(values: number[], period: number): number[] {
    const result: number[] = [];
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
 * T3 Smoothing (Tillson T3 Moving Average)
 * Formula from User's PineScript:
 * xe1 = ema(src, len), xe2 = ema(xe1, len), ... xe6 = ema(xe5, len)
 * b = 0.7
 * T3 = c1*xe6 + c2*xe5 + c3*xe4 + c4*xe3
 * Uses full-series EMA with NaN propagation so last-bar T3 matches Pine.
 */
export function t3_smooth(values: number[], period: number, b: number = 0.7): number[] {
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

// ─────────────────────────────────────────────────────────────────────────────
// V4 INDICATOR PRIMITIVES
// New indicators required for the 4-factor scoring model (v4.0).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wilder's Moving Average (RMA) — internal utility.
 * Matches Pine Script's ta.rma(): seeded with SMA of first `period` valid values,
 * then alpha = 1/period rolling average.
 */
function rma(values: number[], period: number): number[] {
    const result: number[] = new Array(values.length).fill(NaN);
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
        result[i] = isFinite(v) ? alpha * v + (1 - alpha) * prev : prev; // carry forward on NaN
    }

    return result;
}

/**
 * Average True Range (ATR)
 * Matches Pine Script's ta.atr(period) — uses Wilder's RMA of True Range.
 */
export function calcATR(
    highs: number[],
    lows: number[],
    closes: number[],
    period: number
): number[] {
    const n = closes.length;
    if (n < 2) return new Array(n).fill(NaN);

    const trValues: number[] = [NaN]; // first bar has no prior close
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
export interface ADXResult {
    adx: number[];
    diPlus: number[];
    diMinus: number[];
}

export function calcADX(
    highs: number[],
    lows: number[],
    closes: number[],
    period: number
): ADXResult {
    const n = closes.length;
    const empty = (): number[] => new Array(n).fill(NaN);

    if (n < 2) return { adx: empty(), diPlus: empty(), diMinus: empty() };

    const trValues: number[] = [NaN];
    const dmPlusValues: number[] = [NaN];
    const dmMinusValues: number[] = [NaN];

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

    const diPlus: number[] = [];
    const diMinus: number[] = [];
    const dxValues: number[] = [];

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
export function calcRVOL(
    volumes: number[],
    period: number = 20
): { rvol: number[]; rvol2Bar: number[] } {
    const volSma = sma(volumes, period);

    const rvol: number[] = volSma.map((avg, i) =>
        isFinite(avg) && avg > 0 ? volumes[i] / avg : NaN
    );

    const rvol2Bar: number[] = rvol.map((rv, i) => {
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
export function detectSqueeze(
    closes: number[],
    highs: number[],
    lows: number[],
    period: number = 20,
    bbMultiplier: number = 2.0,
    kcMultiplier: number = 1.5
): boolean[] {
    const n = closes.length;
    const result: boolean[] = new Array(n).fill(false);
    if (n < period) return result;

    const atrValues = calcATR(highs, lows, closes, period);
    const emaValues = emaFullSeries(closes, period);

    for (let i = period - 1; i < n; i++) {
        // BB — centered on SMA
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

        // KC — centered on EMA
        const kcCenter = emaValues[i];
        const atr = atrValues[i];
        if (!isFinite(kcCenter) || !isFinite(atr)) continue;

        const kcUpper = kcCenter + kcMultiplier * atr;
        const kcLower = kcCenter - kcMultiplier * atr;

        result[i] = bbUpper < kcUpper && bbLower > kcLower;
    }

    return result;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Heikin Ashi built exactly like Pine Script s_calc_mb:
 * haclose = (mb_o+mb_h+mb_l+mb_c)/4, xhaopen = (mb_o+mb_c)/2,
 * haopen = bar 0 ? (mb_o+mb_c)/2 : (xhaopen[1]+haclose[1])/2
 */
export function heikinAshiPine(
    mb_o: number[],
    mb_h: number[],
    mb_l: number[],
    mb_c: number[]
): { haOpens: number[]; haCloses: number[] } {
    const n = mb_o.length;
    const haOpens: number[] = [];
    const haCloses: number[] = [];
    let xhaopenPrev = 0, haclosePrev = 0; // only used when i >= 1
    for (let i = 0; i < n; i++) {
        const haclose = (mb_o[i] + mb_h[i] + mb_l[i] + mb_c[i]) / 4;
        const xhaopen = (mb_o[i] + mb_c[i]) / 2;
        const haopen =
            i === 0 ? (mb_o[0] + mb_c[0]) / 2 : (xhaopenPrev + haclosePrev) / 2;
        haCloses.push(haclose);
        haOpens.push(haopen);
        xhaopenPrev = xhaopen;
        haclosePrev = haclose;
    }
    return { haOpens, haCloses };
}
