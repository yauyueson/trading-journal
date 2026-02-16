
import { getCandles } from './lib/polygon-client.js';

async function run() {
    const ticker = 'SPY';
    console.log(`Testing FETCH ONLY for ${ticker}...`);

    const toDate = new Date();
    const toStr = toDate.toISOString().split('T')[0];
    const fromDate = new Date(toDate);
    fromDate.setDate(toDate.getDate() - 1);

    try {
        console.log(`Fetching 1 day of 30m candles...`);
        // Set a timeout to force exit if fetch hangs
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000));

        const fetchPromise = getCandles(ticker, fromDate.toISOString().split('T')[0], toStr, 'minute', 30);

        const candles = await Promise.race([fetchPromise, timeout]);
        console.log(`Fetched ${candles.length} candles.`);
    } catch (e) {
        console.error("Error/Timeout:", e);
    }
}

run();
