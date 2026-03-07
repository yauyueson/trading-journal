// api/cron-signal-scan.js
// Daily signal scanner — triggered externally via cronjobs.org (21:00 UTC / 4:00 PM ET weekdays).
// 1. Tops up stock_candles cache with latest day's data from Tiingo
// 2. Runs calculateTechScore on each ticker
// 3. Upserts actionable signals to signal_history table
// 4. Sends Discord embed with all signals

import { createRequire } from 'node:module';
import { getCandles } from '../lib/tiingo-client.js';

const require = createRequire(import.meta.url);
const { calculateTechScore } = require('../lib/_shared/tech-analysis.cjs');

// ── Config ──────────────────────────────────────────────────────────────────────

const SCAN_TICKERS = [
    'SPY', 'QQQ', 'GOOG', 'JPM', 'META', 'TSLA', 'MSFT', 'NFLX',
    'AAPL', 'NVDA', 'AMD', 'COST', 'IREN', 'BA', 'AMZN', 'HOOD',
    'CRWV', 'COIN', 'MSTR', 'PLTR', 'AVGO', 'LULU', 'UBER', 'GS',
    'UNH', 'IWM', 'GLD',
];

const MIN_CANDLES = 200;        // Need ~200 for stable tech analysis
const MIN_SCORE = 70;           // Only alert on actionable signals
const MIN_ADX = 15;             // Quality gate: trend strength
const MIN_RVOL = 0.5;           // Quality gate: volume participation
const DELAY_MS = 300;           // Between tickers (rate limit courtesy)

// ── Supabase helpers ────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function supabaseGet(table, queryParams) {
    const url = `${SUPABASE_URL}/rest/v1/${table}?${queryParams}`;
    const res = await fetch(url, {
        headers: { 'apikey': SUPABASE_ANON, 'Authorization': `Bearer ${SUPABASE_ANON}` },
    });
    if (!res.ok) return null;
    return res.json();
}

async function supabaseUpsert(table, rows, onConflict) {
    const key = SUPABASE_SERVICE || SUPABASE_ANON;
    const url = `${SUPABASE_URL}/rest/v1/${table}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'apikey': key,
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json',
            'Prefer': `resolution=merge-duplicates`,
        },
        body: JSON.stringify(rows),
    });
    if (!res.ok) {
        const text = await res.text();
        console.warn(`[signal-scan] Upsert ${table} failed: ${res.status} ${text}`);
    }
}

// ── Candle helpers ──────────────────────────────────────────────────────────────

async function getCachedCandles(ticker, limit = 350) {
    const rows = await supabaseGet('stock_candles',
        `select=date,open,high,low,close,volume&ticker=eq.${ticker}&timeframe=eq.1D&order=date.desc&limit=${limit}`
    );
    if (!rows || rows.length === 0) return null;
    // Reverse to chronological order
    return rows.reverse().map(r => ({
        date: r.date,
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
    }));
}

async function topUpCandles(ticker, lastCachedDate) {
    const today = new Date().toISOString().split('T')[0];
    if (lastCachedDate >= today) return []; // Already up to date

    // Fetch from day after last cached to today
    const d = new Date(lastCachedDate + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    const fromDate = d.toISOString().split('T')[0];

    try {
        const newCandles = await getCandles(ticker, fromDate, today, 'day', 1);
        if (newCandles.length > 0) {
            // Upsert to stock_candles
            const rows = newCandles.map(c => ({
                ticker, date: c.date, open: c.open, high: c.high,
                low: c.low, close: c.close, volume: Math.round(c.volume),
                timeframe: '1D',
            }));
            await supabaseUpsert('stock_candles', rows, 'ticker,date,timeframe');
            console.log(`[signal-scan] ${ticker}: topped up ${newCandles.length} candles (${fromDate} → ${today})`);
        }
        return newCandles;
    } catch (err) {
        console.warn(`[signal-scan] ${ticker}: top-up failed — ${err.message}`);
        return [];
    }
}

// ── Discord ─────────────────────────────────────────────────────────────────────

async function sendDiscord(signals, totalScanned, date) {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return;

    const fields = [];
    if (signals.length === 0) {
        fields.push({ name: 'No actionable signals today', value: 'All tickers below threshold or filtered by quality gates.', inline: false });
    } else {
        for (const s of signals.slice(0, 25)) {
            const emoji = s.direction === 'CALL' ? '🟢' : '🔴';
            const dirLabel = s.direction === 'CALL' ? 'BUY' : 'SELL';
            fields.push({
                name: `${s.ticker} ${emoji} ${dirLabel}`,
                value: `Score: **${s.score}** | ${s.setup} | Conf: ${s.confidence}\nADX: ${s.adx} | RVOL: ${s.rvol} | $${s.close.toFixed(2)}`,
                inline: false,
            });
        }
        if (signals.length > 25) {
            fields.push({ name: `+${signals.length - 25} more`, value: 'Truncated (Discord 25-field limit)', inline: false });
        }
    }

    try {
        await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                embeds: [{
                    title: `📡 Daily Signal Scan — ${date}`,
                    color: signals.length > 0 ? 0x3399ff : 0xaaaaaa,
                    fields,
                    footer: { text: `Trading Journal · ${totalScanned} tickers scanned · ${signals.length} signals` },
                    timestamp: new Date().toISOString(),
                }]
            }),
            signal: AbortSignal.timeout(5000),
        });
    } catch (err) {
        console.warn('[signal-scan] Discord send failed:', err.message);
    }
}

// ── Handler ─────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
    // Auth
    const secret = req.query.secret || req.headers['authorization']?.replace('Bearer ', '');
    const expectedSecret = process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;
    if (!expectedSecret || secret !== expectedSecret) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const today = new Date().toISOString().split('T')[0];
    console.log(`[signal-scan] Starting daily scan for ${SCAN_TICKERS.length} tickers — ${today}`);

    const signals = [];
    const errors = [];
    let scanned = 0;

    for (const ticker of SCAN_TICKERS) {
        try {
            // 1. Get cached candles
            let candles = await getCachedCandles(ticker);

            if (!candles || candles.length === 0) {
                // No cache — fetch from Tiingo directly (1 year)
                const d = new Date();
                d.setFullYear(d.getFullYear() - 1);
                const fromDate = d.toISOString().split('T')[0];
                candles = await getCandles(ticker, fromDate, today, 'day', 1);
            } else {
                // 2. Top up if stale
                const lastDate = candles[candles.length - 1].date;
                const newCandles = await topUpCandles(ticker, lastDate);
                if (newCandles.length > 0) {
                    candles = [...candles, ...newCandles];
                }
            }

            if (!candles || candles.length < MIN_CANDLES) {
                console.warn(`[signal-scan] ${ticker}: only ${candles?.length || 0} candles, need ${MIN_CANDLES} — skipping`);
                continue;
            }

            // 3. Run tech analysis
            const result = calculateTechScore(candles);
            scanned++;

            // 4. Quality gate filters
            const adx = result.debug?.adx ?? 20;
            const rvol = result.debug?.rvol ?? 1;

            if (adx < MIN_ADX) continue;
            if (rvol < MIN_RVOL) continue;
            if (result.type === 'NEUTRAL') continue;
            if (result.techScore < MIN_SCORE) continue;

            const signal = {
                ticker,
                date: today,
                score: result.techScore,
                direction: result.type,
                setup: result.setup,
                confidence: result.confidence,
                components: result.components,
                debug: result.debug,
                adx,
                rvol,
                close: result.debug?.close ?? 0,
            };
            signals.push(signal);

            // 5. Upsert to signal_history (fire-and-forget)
            supabaseUpsert('signal_history', [{
                ticker,
                date: today,
                score: result.techScore,
                direction: result.type,
                setup: result.setup,
                confidence: result.confidence,
                components: result.components,
                debug: result.debug,
            }], 'ticker,date').catch(() => {});

        } catch (err) {
            console.error(`[signal-scan] ${ticker}: FAILED —`, err.message);
            errors.push({ ticker, error: err.message });
        }

        // Rate limit courtesy
        if (DELAY_MS > 0) await new Promise(r => setTimeout(r, DELAY_MS));
    }

    // Sort signals by score descending
    signals.sort((a, b) => b.score - a.score);

    // Send Discord
    await sendDiscord(signals, scanned, today);

    console.log(`[signal-scan] Done: ${scanned} scanned, ${signals.length} signals, ${errors.length} errors`);

    return res.status(200).json({
        ok: true,
        date: today,
        scanned,
        signals: signals.map(s => ({ ticker: s.ticker, score: s.score, direction: s.direction, setup: s.setup, confidence: s.confidence })),
        errors: errors.length > 0 ? errors : undefined,
    });
}
