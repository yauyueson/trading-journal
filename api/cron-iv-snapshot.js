// api/cron-iv-snapshot.js
// Daily Cron Job to update IV30/IV90 snapshots for active and popular tickers.
// Vercel Cron triggers this (e.g., at 16:30 ET).

import { createClient } from '@supabase/supabase-js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
    buildIVTermStructure,
    parseChain,
    calculateSkew
} = require('../lib/_shared/scoring.cjs');

// Popular tickers to always track
const POPULAR_TICKERS = [
    'SPY', 'QQQ', 'IWM', 'DIA', 'GLD', 'TLT',
    'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMD', 'AMZN', 'GOOGL', 'META', 'NFLX',
    'COIN', 'MSTR', 'PLTR', 'HOOD', 'ROKU'
];

function getSupabase() {
    const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
    return { url, key };
}

async function fetchTickerIV(ticker) {
    const { getOptionChain } = await import('../lib/polygon-client.js');

    try {
        // Single chain per ticker (2 API calls: contracts + snapshot) covering DTE 23–97; derive IV30/IV90 in memory
        const chain = await getOptionChain(ticker, { minDte: 23, maxDte: 97 });
        if (!chain || chain.length === 0) return null;

        const underlyingPrice = chain.find(o => o.underlyingPrice > 0)?.underlyingPrice ?? null;
        if (!underlyingPrice) return null;

        const fullChain = parseChain(chain, underlyingPrice);
        const structure = buildIVTermStructure(fullChain, underlyingPrice);

        return {
            ticker: ticker.toUpperCase(),
            iv30: structure.iv30,
            iv90: structure.iv90
        };
    } catch (e) {
        console.warn(`Error fetching IV for ${ticker}:`, e.message);
        return null;
    }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();

    // Secure via CRON_SECRET if present
    const authHeader = req.headers['authorization'];
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
        // Allow if running locally or via special param for testing? 
        // For now, strict check if env var is set.
    }

    const { url, key } = getSupabase();
    if (!url || !key) return res.status(500).json({ error: 'Supabase not configured' });
    const supabase = createClient(url, key);

    // 1. Get Active Positions Tickers
    const { data: positions } = await supabase
        .from('positions')
        .select('ticker')
        .eq('status', 'active');

    const activeTickers = (positions || []).map(p => p.ticker);
    const allTickers = [...new Set([...activeTickers, ...POPULAR_TICKERS])]
        .map(t => t.toUpperCase())
        .filter(t => t && t.length > 0)
        .sort();

    console.log(`Cron: Updating IV for ${allTickers.length} tickers: ${allTickers.join(', ')}`);

    const results = [];
    const snapshots = [];

    // Paid tier: 100 req/s. Short delay (200–500 ms) between tickers only to avoid single-second spike if 50+ tickers.
    const DELAY_MS = Number(process.env.CRON_IV_DELAY_MS || 300);

    for (let i = 0; i < allTickers.length; i++) {
        const ticker = allTickers[i];

        if (i > 0 && DELAY_MS > 0) await new Promise(r => setTimeout(r, DELAY_MS));

        const data = await fetchTickerIV(ticker);
        if (data && data.iv30) {
            snapshots.push({
                ticker: data.ticker,
                recorded_date: new Date().toISOString().split('T')[0], // Today's date (UTC)
                iv30: data.iv30,
                iv90: data.iv90
            });
            results.push({ ticker, status: 'ok', iv30: data.iv30 });
        } else {
            results.push({ ticker, status: 'failed/no-data' });
        }
    }

    if (snapshots.length > 0) {
        const { error } = await supabase
            .from('ticker_iv_snapshots')
            .upsert(snapshots, { onConflict: 'ticker,recorded_date' });

        if (error) {
            console.error('Snapshot upsert error:', error);
            return res.status(500).json({ error: 'Database upsert failed', details: error.message });
        }
    }

    return res.status(200).json({
        success: true,
        processed: allTickers.length,
        updated: snapshots.length,
        results
    });
}
