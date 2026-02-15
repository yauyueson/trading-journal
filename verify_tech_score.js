
import { getCandles } from './lib/polygon-client.js';

// Copy-paste the aggregation logic for isolated testing
const aggregateRTH = (baseCandles, hoursPerBar) => {
    if (!baseCandles || baseCandles.length === 0) return [];
    const aggs = [];
    let currentBar = null;

    // Parse a candle's time in ET
    const getET = (ts) => {
        // Create formatted string in ET to extract hour/minute
        const d = new Date(ts);
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            hour: 'numeric',
            minute: 'numeric',
            hour12: false
        }).formatToParts(d);
        const hVal = parts.find(p => p.type === 'hour').value;
        const mVal = parts.find(p => p.type === 'minute').value;
        let h = parseInt(hVal);
        if (h === 24) h = 0; // Handle 24 as 0
        const m = parseInt(mVal);
        return { h, m };
    };

    // Sort candles by timestamp just in case
    const sorted = [...baseCandles].sort((a, b) => a.timestamp - b.timestamp);

    for (const c of sorted) {
        const { h, m } = getET(c.timestamp);
        // Filter RTH: 09:30 <= time < 16:00
        const tVal = h * 100 + m;

        if (tVal < 930 || tVal >= 1600) continue;

        let isNewBar = false;

        if (!currentBar) {
            isNewBar = true;
        } else {
            const timeDiff = c.timestamp - currentBar.timestamp;
            if (timeDiff > 12 * 60 * 60 * 1000) {
                isNewBar = true; // Gap > 12h = new day
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
            // Update current bar
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
    console.log(`Verifying RTH Aggregation for ${ticker}...`);

    const toDate = new Date();
    const toStr = toDate.toISOString().split('T')[0];
    const fromDate = new Date(toDate);
    fromDate.setDate(toDate.getDate() - 5);

    try {
        console.log("Fetching 30m candles...");
        const candles30m = await getCandles(ticker, fromDate.toISOString().split('T')[0], toStr, 'minute', 30);
        console.log(`Fetched ${candles30m.length} 30m candles.`);

        if (candles30m.length > 0) {
            const aggs1h = aggregateRTH(candles30m, 1);
            console.log(`Aggregated to ${aggs1h.length} 1h RTH bars.`);

            console.log("First 5 1h bars:");
            aggs1h.slice(0, 5).forEach(c => {
                const d = new Date(c.timestamp);
                const et = d.toLocaleString('en-US', { timeZone: 'America/New_York' });
                console.log(`${et} | O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${c.volume}`);
            });

            const aggs4h = aggregateRTH(candles30m, 4);
            console.log(`Aggregated to ${aggs4h.length} 4h RTH bars.`);
            console.log("First 5 4h bars:");
            aggs4h.slice(0, 5).forEach(c => {
                const d = new Date(c.timestamp);
                const et = d.toLocaleString('en-US', { timeZone: 'America/New_York' });
                console.log(`${et} | O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${c.volume}`);
            });
        }

    } catch (e) {
        console.error(e);
    }
}

run();
