// Simple test script to diagnose backfill issues
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getCandles } from '../lib/market-data-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env.local');

console.log('Step 1: Loading environment variables...');
if (fs.existsSync(envPath)) {
    const envConfig = fs.readFileSync(envPath, 'utf8');
    envConfig.split('\n').forEach(line => {
        const parts = line.split('=');
        if (parts.length >= 2) {
            const key = parts[0].trim();
            let value = parts.slice(1).join('=').trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            if (key && !key.startsWith('#')) {
                process.env[key] = value;
            }
        }
    });
    console.log('✓ Environment loaded');
} else {
    console.error('✗ .env.local not found');
    process.exit(1);
}

console.log('\nStep 2: Checking MARKET_DATA_TOKEN...');
const token = process.env.MARKET_DATA_TOKEN;
if (!token) {
    console.error('✗ MARKET_DATA_TOKEN not found in environment');
    process.exit(1);
}
console.log(`✓ Token found: ${token.substring(0, 10)}...`);

console.log('\nStep 3: Testing MarketData API with TSLA...');
const toDate = new Date();
const fromDate = new Date();
fromDate.setDate(toDate.getDate() - 30);

const fromStr = fromDate.toISOString().split('T')[0];
const toStr = toDate.toISOString().split('T')[0];

console.log(`  Fetching TSLA candles from ${fromStr} to ${toStr}...`);

try {
    const candles = await getCandles('TSLA', fromStr, toStr, 'D');
    console.log(`✓ Success! Got ${candles.length} candles`);
    if (candles.length > 0) {
        console.log('  Sample:', candles[0]);
    }
} catch (error) {
    console.error('✗ Error:', error.message);
    console.error('  Stack:', error.stack);
    process.exit(1);
}

console.log('\n✓ All tests passed! MarketData integration is working.');
