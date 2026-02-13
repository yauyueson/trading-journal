import { getOptionChain } from './api/market-data-client.js';

// Set token directly (avoiding dotenv dependency issue if not installed)
// Token from .env.local
process.env.MARKET_DATA_TOKEN = 'S3hVSUltM05oNlpySGR4ZkFVaUdHZlJGR0xaclB4SXRKbTExbE9UcHE1RT0';

async function main() {
    try {
        console.log("Fetching SPY option chain...");
        // Fetch a small chain to inspect response
        // Using a close expiration to ensure data
        const chain = await getOptionChain('SPY', { minDte: 30, maxDte: 40 });

        if (chain.length > 0) {
            console.log("First option keys:", Object.keys(chain[0]));
            console.log("First option sample:", chain[0]);

            // Check if there are any raw properties that were not mapped
            // Note: getOptionChain returns MAPPED data. 
            // I need to intercept the RAW data to see 'probabilityITM'.
            // Accessing internal fetch is not exposed.
            // I will copy-paste the raw fetch logic here to see raw data.
        } else {
            console.log("No options found.");
        }
    } catch (e) {
        console.error("Error:", e);
    }
}

// Run main
// main();

// Redefining main to fetch RAW data
const BASE_URL = 'https://api.marketdata.app/v1';

async function fetchRaw(ticker) {
    const token = process.env.MARKET_DATA_TOKEN;
    const url = `${BASE_URL}/options/chain/${ticker.toUpperCase()}/?minDte=30&maxDte=40`;

    console.log(`Fetching ${url} with token...`);
    const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
        console.error("Values:", await response.text());
        return;
    }

    const data = await response.json();
    if (data.s === 'ok') {
        // Log available columns if columnar
        const keys = Object.keys(data);
        console.log("Root keys:", keys);

        // Check for probability fields in root keys
        const probKeys = keys.filter(k => k.toLowerCase().includes('prob') || k.toLowerCase().includes('itm'));
        console.log("Potential Probability Keys:", probKeys);

        // Print first value of each potential key
        probKeys.forEach(k => {
            if (Array.isArray(data[k])) {
                console.log(`${k}[0]:`, data[k][0]);
            }
        });

        // Also check if 'impliedVolatility' or 'delta' are there
        console.log("Delta available?", keys.includes('delta'));
    } else {
        console.log("API Error:", data);
    }
}

fetchRaw('SPY');
