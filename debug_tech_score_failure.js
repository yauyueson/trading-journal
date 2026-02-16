
import { getCandles } from './lib/polygon-client.js';

// MOCK: Copy of the aggregation logic from strategy-recommend.js
const aggregateRTH = (baseCandles, hoursPerBar) => {
    if (!baseCandles || baseCandles.length === 0) return [];
    const aggs = [];
    let currentBar = null;

    // Parse a candle's time in ET
    const getET = (ts) => {
        const d = new Date(ts);
        // Create formatted string in ET
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            hour: 'numeric',
            minute: 'numeric',
            hour12: false
        }).formatToParts(d);
        const hVal = parts.find(p => p.type === 'hour')?.value;
        const mVal = parts.find(p => p.type === 'minute')?.value;

        if (!hVal || !mVal) {
            console.log('Failed to parse time for:', ts, d.toISOString());
            return { h: 0, m: 0 };
        }

        let h = parseInt(hVal);
        if (h === 24) h = 0;
        const m = parseInt(mVal);
        return { h, m };
    };

    // Sort
    const sorted = [...baseCandles].sort((a, b) => a.timestamp - b.timestamp);

    for (const c of sorted) {
        const { h, m } = getET(c.timestamp);
        // Filter RTH: 09:30 <= time < 16:00
        const tVal = h * 100 + m;
        // console.log(`${c.date} ${h}:${m} tVal=${tVal}`); // DEBUG

        if (tVal < 930 || tVal >= 1600) continue;

        let isNewBar = false;

        if (!currentBar) {
            isNewBar = true;
        } else {
            const timeDiff = c.timestamp - currentBar.timestamp;
            if (timeDiff > 12 * 60 * 60 * 1000) {
                isNewBar = true;
            } else {
                const minsFromOpen = (h * 60 + m) - (9 * 60 + 30);
                const barIdx = Math.floor(minsFromOpen / (hoursPerBar * 60));

                const startET = getET(currentBar.timestamp);
                const startMinsFromOpen = (startET.h * 60 + startET.m) - (9 * 60 + 30);
                const startBarIdx = Math.floor(startMinsFromOpen / (hoursPerBar * 60));

                if (barIdx !== startBarIdx) isNewBar = true;
            }
        }

        if (isNewBar) {
            if (currentBar) aggs.push(currentBar);
            currentBar = {
                timestamp: c.timestamp,
                date: c.date,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                volume: c.volume
            };
        } else {
            currentBar.high = Math.max(currentBar.high, c.high);
            currentBar.low = Math.min(currentBar.low, c.low);
            currentBar.close = c.close;
            currentBar.volume += c.volume;
        }
    }
    if (currentBar) aggs.push(currentBar);
    return aggs;
};

async function run() {
    const ticker = 'SPY';
    console.log(`Debugging Tech Score for ${ticker}...`);

    const toDate = new Date();
    const toStr = toDate.toISOString().split('T')[0];
    const fromIntraday = new Date(toDate);
    fromIntraday.setDate(toDate.getDate() - 5);

    try {
        console.log(`Fetching 30m candles from ${fromIntraday.toISOString().split('T')[0]} to ${toStr}...`);
        const candles30m = await getCandles(ticker, fromIntraday.toISOString().split('T')[0], toStr, 'minute', 30);
        console.log(`fetched ${candles30m.length} 30m candles.`);

        if (candles30m.length > 0) {
            console.log('Sample 30m candle:', JSON.stringify(candles30m[0]));
            candles30m.forEach((c, i) => { if (i < 5) console.log(`C[${i}]:`, c.timestamp, c.date); });
        }

        const candles1h = aggregateRTH(candles30m, 1);
        console.log(`Aggregated 1h: ${candles1h.length} bars.`);

        const candles4h = aggregateRTH(candles30m, 4);
        console.log(`Aggregated 4h: ${candles4h.length} bars.`);

        if (candles1h.length < 50) console.warn("WARNING: 1h < 50 bars, will return null tech score");
        if (candles4h.length < 50) console.warn("WARNING: 4h < 50 bars, will return null tech score");

        // Check recent bars
        console.log('Last 5 1h bars:', JSON.stringify(candles1h.slice(-5), null, 2));

    } catch (e) {
        console.error("Error:", e);
    }
}

run();
