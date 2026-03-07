// api/cron-iv.js
// Merged IV cron handler. Routes via ?job= query param:
//   ?job=snapshot  — daily IV30/IV90 snapshots + regime alerts (was cron-iv-snapshot.js)
//   ?job=backfill  — backfill 10yr ORATS historical IV cache (was cron-iv-backfill.js)

import { createClient } from '@supabase/supabase-js';
import { createRequire } from 'module';
import { getHistoricalCores } from '../lib/orats-client.js';

const require = createRequire(import.meta.url);
const { buildIVTermStructure, parseChain } = require('../lib/_shared/scoring.cjs');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

const POPULAR_TICKERS = [
    'SPY', 'QQQ', 'IWM', 'DIA', 'GLD', 'TLT',
    'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMD', 'AMZN', 'GOOGL', 'META', 'NFLX',
    'COIN', 'MSTR', 'PLTR', 'HOOD', 'ROKU',
];

const SCAN_TICKERS = [
    'SPY', 'QQQ', 'GOOG', 'JPM', 'META', 'TSLA', 'MSFT', 'NFLX',
    'AAPL', 'NVDA', 'AMD', 'COST', 'IREN', 'BA', 'AMZN', 'HOOD',
    'CRWV', 'COIN', 'MSTR', 'PLTR', 'AVGO', 'LULU', 'UBER', 'GS',
    'UNH', 'IWM', 'GLD',
];

const DELAY_MS = 300;
const BATCH_SIZE = 500;
const YEARS_BACK = 10;

// ── Snapshot helpers ────────────────────────────────────

async function fetchTickerIV(ticker) {
    const { getOptionChain } = await import('../lib/orats-client.js');
    try {
        const chain = await getOptionChain(ticker, { minDte: 23, maxDte: 97 });
        if (!chain || chain.length === 0) return null;
        const underlyingPrice = chain.find(o => o.underlyingPrice > 0)?.underlyingPrice ?? null;
        if (!underlyingPrice) return null;
        const fullChain = parseChain(chain, underlyingPrice);
        const structure = buildIVTermStructure(fullChain, underlyingPrice);
        return { ticker: ticker.toUpperCase(), iv30: structure.iv30, iv90: structure.iv90 };
    } catch (e) {
        console.warn(`Error fetching IV for ${ticker}:`, e.message);
        return null;
    }
}

async function runSnapshot(supabase) {
    const { data: positions } = await supabase.from('positions').select('ticker').eq('status', 'active');
    const activeTickers = (positions || []).map(p => p.ticker);
    const allTickers = [...new Set([...activeTickers, ...POPULAR_TICKERS])]
        .map(t => t.toUpperCase()).filter(Boolean).sort();

    console.log(`[iv-snapshot] Updating ${allTickers.length} tickers`);

    const results = [];
    const snapshots = [];
    const delay = Number(process.env.CRON_IV_DELAY_MS || DELAY_MS);

    for (let i = 0; i < allTickers.length; i++) {
        const ticker = allTickers[i];
        if (i > 0 && delay > 0) await new Promise(r => setTimeout(r, delay));
        const data = await fetchTickerIV(ticker);
        if (data?.iv30) {
            snapshots.push({ ticker: data.ticker, recorded_date: new Date().toISOString().split('T')[0], iv30: data.iv30, iv90: data.iv90, source: 'live_iv' });
            results.push({ ticker, status: 'ok', iv30: data.iv30 });
        } else {
            results.push({ ticker, status: 'failed/no-data' });
        }
    }

    if (snapshots.length > 0) {
        const { error } = await supabase.from('ticker_iv_snapshots').upsert(snapshots, { onConflict: 'ticker,recorded_date' });
        if (error) throw new Error(`Snapshot upsert failed: ${error.message}`);
    }

    // Regime change alerts
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (webhookUrl && snapshots.length > 0) {
        const fromDate = new Date();
        fromDate.setDate(fromDate.getDate() - 5);
        const fromDateStr = fromDate.toISOString().slice(0, 10);

        for (const snap of snapshots) {
            try {
                const { data: history } = await supabase
                    .from('ticker_iv_snapshots')
                    .select('recorded_date,iv30,iv90')
                    .eq('ticker', snap.ticker)
                    .gte('recorded_date', fromDateStr)
                    .order('recorded_date', { ascending: false })
                    .limit(5);

                if (!history || history.length < 3) continue;
                const toMode = row => {
                    const ratio = row.iv30 && row.iv90 > 0 ? row.iv30 / row.iv90 : 1.0;
                    return ratio > 1.05 ? 'CREDIT' : ratio < 0.95 ? 'DEBIT' : 'NEUTRAL';
                };
                const modes = history.map(toMode);
                const todayMode = modes[0];
                const olderMode = modes.slice(2).find(m => m !== 'NEUTRAL');
                if (!olderMode || olderMode === todayMode || todayMode === 'NEUTRAL') continue;

                const ratio = history[0].iv30 && history[0].iv90 > 0 ? (history[0].iv30 / history[0].iv90).toFixed(3) : 'N/A';
                await fetch(webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ embeds: [{ title: `📊 Regime Shift: ${snap.ticker}`, description: `**${snap.ticker}** regime shifted from **${olderMode}** → **${todayMode}**`, color: todayMode === 'CREDIT' ? 0x00cc66 : 0x3399ff, fields: [{ name: 'IV30/IV90 Ratio', value: ratio, inline: true }, { name: 'Previous Regime', value: olderMode, inline: true }, { name: 'New Regime', value: todayMode, inline: true }], footer: { text: 'Cron IV · Regime Early Warning' }, timestamp: new Date().toISOString() }] }),
                    signal: AbortSignal.timeout(5000),
                });
                console.log(`[RegimeAlert] ${snap.ticker}: ${olderMode} → ${todayMode}`);
            } catch (err) {
                console.warn(`[RegimeAlert] ${snap.ticker}:`, err?.message);
            }
        }
    }

    return { success: true, processed: allTickers.length, updated: snapshots.length, results };
}

// ── Backfill helpers ────────────────────────────────────

async function getCacheCoverage(tickers) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return new Map();
    const coverage = new Map();
    await Promise.all(tickers.map(async ticker => {
        try {
            const p = new URLSearchParams({ select: 'date', ticker: `eq.${ticker}`, order: 'date.desc', limit: '1' });
            const res = await fetch(`${SUPABASE_URL}/rest/v1/orats_iv_cache?${p}`, {
                headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
            });
            if (res.ok) {
                const rows = await res.json();
                if (rows.length > 0) coverage.set(ticker, rows[0].date);
            }
        } catch { /* ignore */ }
    }));
    return coverage;
}

async function upsertBatch(rows) {
    if (!SUPABASE_URL || !SUPABASE_KEY || rows.length === 0) return 0;
    let upserted = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        try {
            const res = await fetch(`${SUPABASE_URL}/rest/v1/orats_iv_cache`, {
                method: 'POST',
                headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
                body: JSON.stringify(rows.slice(i, i + BATCH_SIZE)),
            });
            if (res.ok) upserted += Math.min(BATCH_SIZE, rows.length - i);
            else console.warn(`[iv-backfill] Upsert batch failed: ${res.status}`);
        } catch (err) {
            console.warn(`[iv-backfill] Upsert error:`, err.message);
        }
    }
    return upserted;
}

async function runBackfill() {
    const cutoffDate = new Date();
    cutoffDate.setFullYear(cutoffDate.getFullYear() - YEARS_BACK);
    const cutoff = cutoffDate.toISOString().split('T')[0];

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dow = yesterday.getDay();
    if (dow === 0) yesterday.setDate(yesterday.getDate() - 2);
    if (dow === 6) yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    const coverage = await getCacheCoverage(SCAN_TICKERS);
    const needsUpdate = SCAN_TICKERS.filter(t => {
        const maxDate = coverage.get(t);
        return !maxDate || maxDate < yesterdayStr;
    });

    console.log(`[iv-backfill] ${needsUpdate.length}/${SCAN_TICKERS.length} tickers need update`);

    if (needsUpdate.length === 0) {
        return { success: true, message: 'All tickers already cached', processed: 0, skipped: SCAN_TICKERS.length, totalUpserted: 0 };
    }

    const results = [];
    let totalUpserted = 0;

    for (let i = 0; i < needsUpdate.length; i++) {
        const ticker = needsUpdate[i];
        if (i > 0) await new Promise(r => setTimeout(r, DELAY_MS));
        try {
            const cores = await getHistoricalCores(ticker);
            if (!cores || cores.length === 0) { results.push({ ticker, status: 'no-data', rows: 0 }); continue; }
            const rows = cores
                .filter(c => { const d = c.tradeDate || c.date; return d && d >= cutoff; })
                .map(c => ({ ticker: ticker.toUpperCase(), date: c.tradeDate || c.date, iv30d: c.iv30d != null ? Number(c.iv30d) : null, iv60d: c.iv60d != null ? Number(c.iv60d) : null, hv20d: c.clsHv20d != null ? Number(c.clsHv20d) : null, hv30d: c.clsHv30d != null ? Number(c.clsHv30d) : null, hv60d: c.clsHv60d != null ? Number(c.clsHv60d) : null }));
            const upserted = await upsertBatch(rows);
            totalUpserted += upserted;
            results.push({ ticker, status: 'ok', rows: upserted });
            console.log(`[iv-backfill] ${ticker}: ${upserted} rows cached`);
        } catch (err) {
            console.error(`[iv-backfill] ${ticker} failed:`, err.message);
            results.push({ ticker, status: 'error', error: err.message });
        }
    }

    return { success: true, processed: needsUpdate.length, skipped: SCAN_TICKERS.length - needsUpdate.length, totalUpserted, results };
}

// ── Main handler ────────────────────────────────────────

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const { job = 'snapshot', manual } = req.query;
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers['authorization'];
    if (cronSecret && manual !== '1' && authHeader !== `Bearer ${cronSecret}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return res.status(500).json({ error: 'Supabase not configured' });
    }

    try {
        if (job === 'backfill') {
            const result = await runBackfill();
            return res.status(200).json(result);
        }

        // Default: snapshot
        const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
        const result = await runSnapshot(supabase);
        return res.status(200).json(result);
    } catch (err) {
        console.error(`[cron-iv] job=${job} error:`, err.message);
        return res.status(500).json({ error: err.message });
    }
}
