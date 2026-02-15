
import { getCandles } from './lib/polygon-client.js';

async function run() {
    const ticker = 'SPY';
    console.log(`Checking 1h timestamps for ${ticker}...`);

    const toDate = new Date();
    const toStr = toDate.toISOString().split('T')[0];
    const from1h = new Date(toDate);
    from1h.setDate(toDate.getDate() - 5); // Just 5 days to be quick

    try {
        const candles = await getCandles(ticker, from1h.toISOString().split('T')[0], toStr, 'hour');

        console.log(`Fetched ${candles.length} candles.`);
        if (candles.length > 0) {
            // Log first 10 candles with raw timestamp and localized string
            candles.slice(0, 10).forEach(c => {
                // 'date' field in polygon-client output is YYYY-MM-DD string, losing time info!
                // We need to inspect the raw response or modify getCandles to return full timestamp.
                console.log(`Date: ${c.date}, Open: ${c.open}`);
            });

            // Wait! The current getCandles implementation returns:
            // date: new Date(candle.t).toISOString().split('T')[0]
            // This confirms TIME IS LOST in the current implementation!
            console.log("CONFIRMED: Time component is stripped by getCandles!");

            // To fix this, we need to return 'timestamp' or full ISO string.
        }
    } catch (e) {
        console.error(e);
    }
}

run();
