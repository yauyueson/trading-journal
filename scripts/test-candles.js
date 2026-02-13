// scripts/test-candles.js - run from project root: node scripts/test-candles.js
import { getCandles } from '../lib/polygon-client.js';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env.local');

if (fs.existsSync(envPath)) {
    const envConfig = fs.readFileSync(envPath, 'utf8');
    envConfig.split('\n').forEach(line => {
        const parts = line.split('=');
        if (parts.length >= 2) {
            const key = parts[0].trim();
            const value = parts.slice(1).join('=').trim();
            if (key && !key.startsWith('#')) {
                process.env[key] = value;
            }
        }
    });
}

async function test() {
    console.log('Testing getCandles for SPY...');
    const to = new Date().toISOString().split('T')[0];
    const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    console.log(`Fetching from ${from} to ${to}`);
    const candles = await getCandles('SPY', from, to, 'D');

    if (candles.length > 0) {
        console.log(`Success! Got ${candles.length} candles.`);
        console.log('Sample candle:', candles[0]);
    } else {
        console.error('Failed or empty result.');
    }
}

test();
