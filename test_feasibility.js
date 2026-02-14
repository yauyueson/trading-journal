
import fs from 'fs';
import path from 'path';
import { getCandles } from './lib/polygon-client.js';

// Manually load .env
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
    }
} catch (e) {
    console.error('Error loading .env:', e);
}

async function testFeasibility() {
    const ticker = 'SPY';
    // We need substantial history for double smoothing (EMA100 then EMA100)
    // 252 trading days/year * 2 years = ~504 candles needed.
    // Let's try to fetch 2.5 years to be safe.

    const toDate = new Date().toISOString().split('T')[0];
    const fromDateObj = new Date();
    fromDateObj.setFullYear(fromDateObj.getFullYear() - 3); // 3 years back
    const fromDate = fromDateObj.toISOString().split('T')[0];

    console.log(`Fetching candles for ${ticker} from ${fromDate} to ${toDate}...`);

    try {
        const candles = await getCandles(ticker, fromDate, toDate, 'day');
        console.log(`Successfully fetched ${candles.length} candles.`);

        if (candles.length > 0) {
            console.log('First Candle:', candles[0]);
            console.log('Last Candle:', candles[candles.length - 1]);
        }

        if (candles.length < 500) {
            console.warn("WARNING: Fetched count might be insufficient for stable EMA100+EMA100 calculation.");
        } else {
            console.log("PASS: Sufficient history available for algorithm.");
        }

    } catch (e) {
        console.error("FAILED to fetch data:", e);
    }
}

testFeasibility();
