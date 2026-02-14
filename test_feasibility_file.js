
import fs from 'fs';
import path from 'path';
import { getCandles } from './lib/polygon-client.js';

const LOG_FILE = 'feasibility_result.txt';

function log(msg) {
    console.log(msg);
    fs.appendFileSync(LOG_FILE, msg + '\n');
}

// Clear log file
fs.writeFileSync(LOG_FILE, 'Starting test...\n');

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
        log('Loaded .env');
    } else {
        log('.env not found');
    }
} catch (e) {
    log('Error loading .env: ' + e.message);
}

const API_KEY = process.env.POLYGON_API_KEY;

if (!API_KEY) {
    log("NO API KEY FOUND!");
} else {
    log("API Key loaded (length: " + API_KEY.length + ")");
}

async function testFeasibility() {
    const ticker = 'SPY';

    // 2 years back
    const toDate = new Date().toISOString().split('T')[0];
    const fromDateObj = new Date();
    fromDateObj.setFullYear(fromDateObj.getFullYear() - 2);
    const fromDate = fromDateObj.toISOString().split('T')[0];

    log(`Fetching candles for ${ticker} from ${fromDate} to ${toDate}...`);

    try {
        const candles = await getCandles(ticker, fromDate, toDate, 'day');
        log(`Successfully fetched ${candles.length} candles.`);

        if (candles.length > 0) {
            log('First Candle Date: ' + candles[0].date);
            log('Last Candle Date: ' + candles[candles.length - 1].date);
        }

        if (candles.length < 400) {
            log("WARNING: Fetched count might be insufficient for stable EMA100+EMA100 calculation.");
        } else {
            log("PASS: Sufficient history available for algorithm.");
        }

    } catch (e) {
        log("FAILED to fetch data: " + e.message);
    }
}

testFeasibility();
