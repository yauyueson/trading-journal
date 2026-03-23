// api/cron-130m-topup.js
// Daily 130M candle top-up — triggered externally via cronjobs.org (21:10 UTC / 4:10 PM ET weekdays).
// Fetches today's 10-min bars from Tiingo IEX, aggregates to 130M, upserts to Supabase cache.
// Keeps the signal board warm so users get instant cache hits.
//
// Schedule: 10 min after cron-signal-scan (21:00 UTC) to avoid rate-limit contention.

import { getIntradayNMinCandles } from '../lib/tiingo-client.js';
import { SCAN_TICKERS } from '../lib/_shared/config.js';
import { supabaseGet, supabaseUpsert as _supabaseUpsert } from '../lib/_shared/supabase-rest.js';

async function supabaseUpsert(table, rows) {
    return _supabaseUpsert(table, rows, '130m-topup');
}

// ── 130M Aggregation (from any minute-level bars) ────────────────────────────

function aggregateMinuteTo130M(bars) {
    if (!bars || bars.length === 0) return [];
    const groups = new Map();
    for (const c of bars) {
        const minutesSince930 = (c.hour * 60 + c.minute) - 570;
        if (minutesSince930 < 0) continue;
        const block = Math.min(Math.floor(minutesSince930 / 130), 2);
        const key = `${c.date}|${block}`;
        if (!groups.has(key)) groups.set(key, { date: c.date, block, candles: [] });
        groups.get(key).candles.push(c);
    }
    const result = [];
    for (const [, group] of groups) {
        const sorted = group.candles.sort((a, b) => a.timestamp - b.timestamp);
        if (sorted.length === 0) continue;
        result.push({
            timestamp: sorted[0].timestamp,
            date: group.date,
            block: group.block,
            open: sorted[0].open,
            high: Math.max(...sorted.map(c => c.high)),
            low: Math.min(...sorted.map(c => c.low)),
            close: sorted[sorted.length - 1].close,
            volume: sorted.reduce((sum, c) => sum + c.volume, 0),
        });
    }
    return result.sort((a, b) => a.timestamp - b.timestamp);
}

// ── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
    // Auth
    const secret = req.headers['authorization']?.replace('Bearer ', '');
    const expectedSecret = process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;
    if (!expectedSecret || secret !== expectedSecret) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const today = new Date().toISOString().split('T')[0];
    console.log(`[130m-topup] Starting daily top-up for ${SCAN_TICKERS.length} tickers — ${today}`);

    // Find the last cached date per ticker (batch query)
    let lastDates = new Map();
    try {
        // Get the max date for each ticker's 130M cache
        const rows = await supabaseGet('stock_candles',
            `select=ticker,date&timeframe=eq.130M_2&order=date.desc&limit=${SCAN_TICKERS.length}`
        );
        if (rows) {
            // Group by ticker, take first (most recent) date
            for (const r of rows) {
                if (!lastDates.has(r.ticker)) lastDates.set(r.ticker, r.date);
            }
        }
    } catch (err) {
        console.warn('[130m-topup] Could not fetch last cached dates:', err.message);
    }

    const results = { topped: 0, skipped: 0, failed: 0, noCache: 0, tickers: {} };

    for (const ticker of SCAN_TICKERS) {
        try {
            const lastDate = lastDates.get(ticker);
            if (!lastDate) {
                // No cache at all — skip (run prefetch-130m.mjs to bootstrap)
                results.noCache++;
                results.tickers[ticker] = 'no-cache';
                continue;
            }

            if (lastDate >= today) {
                results.skipped++;
                results.tickers[ticker] = 'up-to-date';
                continue;
            }

            // Fetch 10-min bars from day after last cached to today
            const d = new Date(lastDate + 'T12:00:00Z');
            d.setUTCDate(d.getUTCDate() + 1);
            const fromDate = d.toISOString().slice(0, 10);

            const bars10m = await getIntradayNMinCandles(ticker, fromDate, today, 10);
            if (bars10m.length === 0) {
                results.skipped++;
                results.tickers[ticker] = 'no-new-data';
                continue;
            }

            const bars130m = aggregateMinuteTo130M(bars10m);
            if (bars130m.length === 0) {
                results.skipped++;
                results.tickers[ticker] = 'no-bars-after-agg';
                continue;
            }

            // Upsert with block-encoded timeframe
            const rows = bars130m.map(b => ({
                ticker,
                date: b.date,
                open: b.open,
                high: b.high,
                low: b.low,
                close: b.close,
                volume: Math.round(b.volume),
                timeframe: `130M_${b.block}`,
            }));
            await supabaseUpsert('stock_candles', rows);
            results.topped++;
            results.tickers[ticker] = `+${bars130m.length} bars`;
            console.log(`[130m-topup] ${ticker}: +${bars130m.length} 130M bars (${fromDate} → ${today})`);
        } catch (err) {
            results.failed++;
            results.tickers[ticker] = `error: ${err.message}`;
            console.warn(`[130m-topup] ${ticker}: failed — ${err.message}`);
        }
    }

    console.log(`[130m-topup] Done: ${results.topped} topped, ${results.skipped} skipped, ${results.noCache} no-cache, ${results.failed} failed`);

    return res.status(200).json({
        ok: true,
        date: today,
        ...results,
    });
}
