
import { calculateTechScore } from './lib/tech-analysis';
import { getCandles } from '../lib/polygon-client.js'; // Adjust path if needed.
// polygon-client.js is in root/lib. So ../../lib? No, src is in root.
// File is src/test_tech_score.ts. 
// path to lib/polygon-client.js is ../lib/polygon-client.js.

// Mock process.env for the client if needed, but client reads from process.env directly.
// We need to load .env manually here too if tsx doesn't do it.
import fs from 'fs';
import path from 'path';

// Load .env
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
        console.log("Loaded .env for test.");
    }
} catch (e) {
    console.error("Error loading .env", e);
}


async function runTest() {
    const ticker = 'SPY';

    // 400 days
    const toDate = new Date().toISOString().split('T')[0];
    const fromDateObj = new Date();
    fromDateObj.setFullYear(fromDateObj.getFullYear() - 2);
    const fromDate = fromDateObj.toISOString().split('T')[0];

    console.log(`Fetching candles for ${ticker}...`);
    try {
        // @ts-ignore
        const candles = await getCandles(ticker, fromDate, toDate, 'day');
        console.log(`Fetched ${candles.length} candles.`);

        // Slice for "warmup test"
        const shortCandles = candles.slice(-60); // only 60
        console.log("\n--- TEST: Short History (60 candles) ---");
        const scoreShort = calculateTechScore(shortCandles);
        console.log("Score Object:", JSON.stringify(scoreShort, null, 2));

        // Full history
        console.log("\n--- TEST: Full History (~400+ candles) ---");
        const scoreFull = calculateTechScore(candles);
        const lastCandle = candles[candles.length - 1];
        console.log(`Last Candle Date: ${lastCandle.date} Close: ${lastCandle.close}`);
        console.log("Score Object:", JSON.stringify(scoreFull, null, 2));

        console.log("\nComparison with TradingView (Visual Check):");
        console.log(`Ticker: ${ticker}`);
        console.log(`Date: ${lastCandle.date}`);
        console.log(`Market Bias Osc: ${scoreFull.debug.mb_osc}`);
        console.log(`B-Xtrender Short: ${scoreFull.debug.bxs}`);
        console.log(`B-Xtrender Long: ${scoreFull.debug.bxl}`);
        console.log(`EMA8 Diff%: ${scoreFull.debug.d8}`);
        console.log(`Reversal: ${scoreFull.debug.reversal}`);

    } catch (e) {
        console.error("Error in test:", e);
    }
}

runTest();
