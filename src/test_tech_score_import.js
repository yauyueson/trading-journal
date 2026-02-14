
// Test Runner relying on LIB modules
import fs from 'fs';
import path from 'path';
import { getCandles } from '../lib/polygon-client.js';
import { calculateTechScore } from '../lib/tech-analysis.js';

const LOG_FILE = 'test_tech_import_output.txt';
function log(msg) {
    console.log(msg);
    fs.appendFileSync(LOG_FILE, msg + '\n');
}

// Clear log
fs.writeFileSync(LOG_FILE, 'Starting Import Test...\n');

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
        log("Loaded .env for test.");
    }
} catch (e) {
    log("Error loading .env: " + e.message);
}

async function runTest() {
    const ticker = 'SPY';

    const toDate = new Date().toISOString().split('T')[0];
    const fromDateObj = new Date();
    fromDateObj.setFullYear(fromDateObj.getFullYear() - 2);
    const fromDate = fromDateObj.toISOString().split('T')[0];

    log(`Fetching candles for ${ticker}...`);
    try {
        const candles = await getCandles(ticker, fromDate, toDate, 'day');
        log(`Fetched ${candles.length} candles.`);

        // Full history
        log("\n--- TEST: Full History (~400+ candles) from ../lib/tech-analysis.js ---");
        const scoreFull = calculateTechScore(candles);
        const lastCandle = candles[candles.length - 1];
        log(`Last Candle Date: ${lastCandle.date} Close: ${lastCandle.close}`);
        log("Score Object: " + JSON.stringify(scoreFull, null, 2));

    } catch (e) {
        log("Error in test: " + e.message);
    }
}

runTest();
