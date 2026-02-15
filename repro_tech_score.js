
import { getCandles } from './lib/polygon-client.js';
import { calculateTechScore } from './lib/tech-analysis.js';

async function run() {
    const ticker = 'SPY';
    console.log(`Testing Tech Score for ${ticker}...`);

    const toDate = new Date();
    // Force a specific date if needed for reproduction, or use current
    const toStr = toDate.toISOString().split('T')[0];

    // 1h timeframe setup from strategy-recommend.js
    const from1h = new Date(toDate);
    from1h.setDate(toDate.getDate() - 90);

    // 1d timeframe setup
    const fromDay = new Date(toDate);
    fromDay.setDate(toDate.getDate() - 600);

    console.log(`Fetching 1h candles from ${from1h.toISOString().split('T')[0]} to ${toStr}`);

    try {
        const [candles1d, candles1h] = await Promise.all([
            getCandles(ticker, fromDay.toISOString().split('T')[0], toStr, 'day'),
            getCandles(ticker, from1h.toISOString().split('T')[0], toStr, 'hour')
        ]);

        console.log(`1d candles: ${candles1d.length}`);
        console.log(`1h candles: ${candles1h.length}`);

        if (candles1h.length > 0) {
            console.log('Last 5 1h candles:', JSON.stringify(candles1h.slice(-5), null, 2));
        }

        const score1d = calculateTechScore(candles1d);
        const score1h = calculateTechScore(candles1h);

        console.log('1d Score:', JSON.stringify(score1d, null, 2));
        console.log('1h Score:', JSON.stringify(score1h, null, 2));

    } catch (e) {
        console.error("Error:", e);
    }
}

run();
