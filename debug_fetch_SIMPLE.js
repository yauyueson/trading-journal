
// Minimal fetch script without dependencies
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper for file logging
function log(msg) {
    console.log(msg);
    fs.appendFileSync('simple_log_output.txt', msg + '\n');
}

// Clear log
fs.writeFileSync('simple_log_output.txt', '');

// Load .env manually
try {
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
        const envConfig = fs.readFileSync(envPath, 'utf8');
        envConfig.split('\n').forEach(line => {
            const [key, value] = line.split('=');
            if (key && value) {
                process.env[key.trim()] = value.trim();
            }
        });
        log("Loaded .env");
    }
} catch (e) {
    log("Error loading .env: " + e.message);
}

const API_KEY = process.env.POLYGON_API_KEY;
if (!API_KEY) {
    log("POLYGON_API_KEY missing!");
    process.exit(1);
}

const ticker = 'SPY';

async function run() {
    try {
        log(`Fetching 1 day of 30m candles for ${ticker}...`);

        const toDate = new Date();
        const toStr = toDate.toISOString().split('T')[0];
        const fromDate = new Date(toDate);
        fromDate.setDate(toDate.getDate() - 1);
        const fromStr = fromDate.toISOString().split('T')[0];

        // Ensure fromStr and toStr are valid
        // Also Polygon adjusted=true, sort=asc, limit=5000
        const endpoint = `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/30/minute/${fromStr}/${toStr}?adjusted=true&sort=asc&limit=5000&apiKey=${API_KEY}`;

        log(`URL: ${endpoint.replace(API_KEY, '***')}`);

        const response = await fetch(endpoint);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        log(`Results: ${data.results ? data.results.length : 0} candles.`);

        if (data.results && data.results.length > 0) {
            log('Sample: ' + JSON.stringify(data.results[0]));
        }

    } catch (e) {
        log("Error: " + e.message);
    }
}

run();
