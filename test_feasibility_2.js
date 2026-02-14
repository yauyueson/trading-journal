
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
        console.log('Loaded .env');
    } else {
        console.error('.env not found');
    }
} catch (e) {
    console.error('Error loading .env:', e);
}

const API_KEY = process.env.POLYGON_API_KEY;

if (!API_KEY) {
    console.error("NO API KEY FOUND!");
    process.exit(1);
} else {
    console.log("API Key loaded (length: " + API_KEY.length + ")");
}


async function testFeasibility() {
    const ticker = 'SPY';

    // 3 years back
    const toDate = new Date().toISOString().split('T')[0];
    const fromDateObj = new Date();
    fromDateObj.setFullYear(fromDateObj.getFullYear() - 3);
    const fromDate = fromDateObj.toISOString().split('T')[0];

    console.log(`Fetching candles for ${ticker} from ${fromDate} to ${toDate}...`);

    try {
        const candles = await getCandles(ticker, fromDate, toDate, 'day');
        console.log(`Successfully fetched ${candles.length} candles.`);

        if (candles.length > 0) {
            console.log('First Candle Date:', candles[0].date);
            console.log('Last Candle Date:', candles[candles.length - 1].date);
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
