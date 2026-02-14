
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

async function test() {
    console.log('API Key present:', !!process.env.POLYGON_API_KEY);
    try {
        const candles = await getCandles('SPY', '2023-10-01', '2023-10-10', 'day');
        console.log('Candles:', candles.slice(0, 2));
    } catch (e) {
        console.error(e);
    }
}

test();
