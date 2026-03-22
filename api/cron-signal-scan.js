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

import { SCAN_TICKERS } from '../lib/_shared/config.js';
import { loadStrategyConfigFromDB } from '../lib/_shared/strategyConfig.js';

// Signal preset weight maps — production subset of src/lib/backtest/types.ts SIGNAL_PRESETS
const SIGNAL_PRESETS = {
    vol: { w_mb: 0, w_bxs: 0, w_bxl: 0, w_ema: 0, w_adx: 0 },  // RVOL + Momentum
    mom: { w_mb: 0, w_bxs: 0, w_bxl: 0, w_ema: 0, w_adx: 0, w_vol: 0 },  // Momentum only
    em:  { w_mb: 0, w_bxs: 0, w_bxl: 0, w_adx: 0, w_vol: 0 },  // EMA + Momentum
    ema: { w_mb: 0, w_bxs: 0, w_bxl: 0, w_mom: 0, w_adx: 0, w_vol: 0 },  // EMA only
};

const MIN_CANDLES = 200;        // Need ~200 for stable tech analysis
const DELAY_MS = 300;           // Between tickers (rate limit courtesy)

// ── Supabase helpers ────────────────────────────────────────────────────────────

import { supabaseGet, supabaseUpsert as _supabaseUpsert } from '../lib/_shared/supabase-rest.js';

async function supabaseUpsert(table, rows) {
    return _supabaseUpsert(table, rows, 'signal-scan');
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

// ── Time Stop Monitor (WFA v3) ──────────────────────────────────────────────────
// Runs here (not in cron-trade-outcomes) so alerts fire during market hours,
// giving the user time to exit before the closing bell.

async function checkTimeStopBreaches(timeStopDTE = 3) {
    const TIME_STOP_DTE = timeStopDTE;
    const today = new Date().toISOString().split('T')[0];

    const active = await supabaseGet('positions',
        'select=id,ticker,expiration,type&status=eq.active&type=in.(Credit Put Spread,Credit Call Spread)');
    if (!active || active.length === 0) return [];

    const breached = [];
    for (const pos of active) {
        if (!pos.expiration) continue;
        const expDate = new Date(pos.expiration + 'T16:00:00Z');
        const todayDate = new Date(today + 'T16:00:00Z');
        const daysToExp = Math.round((expDate - todayDate) / (1000 * 60 * 60 * 24));
        if (daysToExp <= TIME_STOP_DTE) {
            breached.push({ ...pos, daysToExp });
        }
    }
    return breached;
}

async function sendTimeStopAlert(breached) {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl || breached.length === 0) return;

    const fields = breached.map(p => ({
        name: `${p.ticker} \u2014 ${p.daysToExp} DTE`,
        value: `${p.type} exp ${p.expiration} \u2014 **close now** (time stop = 3 DTE)`,
        inline: false,
    }));

    try {
        await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                embeds: [{
                    title: `\u23F0 Time Stop Alert \u2014 ${breached.length} position(s) at \u22643 DTE`,
                    color: 0xff6600,
                    fields,
                    footer: { text: 'Trading Journal \u00b7 WFA v3 time stop monitor' },
                    timestamp: new Date().toISOString(),
                }]
            }),
            signal: AbortSignal.timeout(5000),
        });
    } catch (err) {
        console.warn('[signal-scan] Time stop Discord failed:', err.message);
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
            const ivLabel = s.iv30 != null ? `IV: ${(s.iv30 * 100).toFixed(0)}%` : 'IV: n/a';
            const ivWarn = s.iv30 != null && s.iv30 < 0.20 ? ' ⚠️ low premium' : '';
            fields.push({
                name: `${s.ticker} ${emoji} ${dirLabel}`,
                value: `Score: **${s.score}** | ${s.setup} | Conf: ${s.confidence}\nADX: ${s.adx} | RVOL: ${s.rvol} | ${ivLabel}${ivWarn} | $${s.close.toFixed(2)}`,
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
                    footer: { text: `Trading Journal · ${totalScanned} tickers scanned · ${signals.length} signals · slots open: check /portfolio` },
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
    const secret = req.headers['authorization']?.replace('Bearer ', '');
    const expectedSecret = process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;
    if (!expectedSecret || secret !== expectedSecret) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const today = new Date().toISOString().split('T')[0];
    const config = await loadStrategyConfigFromDB();
    const activeProfile = 'swing';
    const profile = config.profiles[activeProfile] || config.profiles.swing;
    const presetWeights = SIGNAL_PRESETS[profile.signalPreset] || {};
    const MIN_SCORE = profile.minScore || 70;
    const MIN_RVOL = profile.rvolGate || 0.5;
    const ADX_GATE = profile.adxGate;  // null = disabled
    const IVR_MIN = 0;  // WFA v3 lock: IV rank filter disabled (reduces over-filtering)
    const MIN_DIR_CONF = profile.minDirConfidence ?? 70;  // WFA v3 lock: use profile value (swing=70, shortTerm=0)

    // WFA v3: halt scan if portfolio at maxPositions capacity
    const MAX_POSITIONS = profile.maxPositions || 5;
    let activeCount = 0;
    try {
        const active = await supabaseGet('positions',
            'select=id&status=eq.active&type=in.(Credit Put Spread,Credit Call Spread)');
        activeCount = active?.length || 0;
    } catch (_) {}

    if (activeCount >= MAX_POSITIONS) {
        console.log(`[signal-scan] Portfolio at capacity (${activeCount}/${MAX_POSITIONS}) — skipping scan`);
        await sendDiscord([], 0, today);
        return res.status(200).json({ ok: true, date: today, scanned: 0, signals: [], skipped: 'at_capacity' });
    }

    console.log(`[signal-scan] Starting daily scan for ${SCAN_TICKERS.length} tickers — ${today} (signal: ${profile.signalPreset}, adxGate: ${ADX_GATE ?? 'disabled'}, ivrMin: ${IVR_MIN}, slots: ${MAX_POSITIONS - activeCount}/${MAX_POSITIONS})`);

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

            // 3. Run tech analysis with signal preset weights
            const result = calculateTechScore(candles, presetWeights);
            scanned++;

            // 4. Quality gate filters
            const adx = result.debug?.adx ?? 20;
            const rvol = result.debug?.rvol ?? 1;

            // ADX gate: skip if adxGate is null (disabled)
            if (ADX_GATE != null && adx < ADX_GATE) continue;
            if (rvol < MIN_RVOL) continue;
            if (result.type === 'NEUTRAL') continue;
            if (result.techScore < MIN_SCORE) continue;
            if (result.dirConfidence < MIN_DIR_CONF) continue;

            // Fetch latest IV for premium adequacy + IVR filter
            let iv30 = null;
            let ivRank = null;
            try {
                const ivRows = await supabaseGet('orats_iv_cache',
                    `select=iv30d&ticker=eq.${ticker}&order=date.desc&limit=1`);
                if (ivRows && ivRows.length > 0) iv30 = ivRows[0].iv30d;
            } catch (_) {}

            // IVR filter: skip if IV rank below threshold
            // iv30 from orats_iv_cache is percentage (e.g. 24.3 = 24.3%); ivRankMin is also percentage
            if (iv30 != null && iv30 < IVR_MIN) continue;

            const signal = {
                ticker,
                date: today,
                score: result.techScore,
                dirConfidence: result.dirConfidence,
                direction: result.type,
                setup: result.setup,
                confidence: result.confidence,
                components: result.components,
                debug: result.debug,
                adx,
                rvol,
                close: result.debug?.close ?? 0,
                iv30,
                ivAdequate: iv30 == null || iv30 >= IVR_MIN,
            };
            signals.push(signal);

            // 5. Upsert to signal_history (fire-and-forget)
            supabaseUpsert('signal_history', [{
                ticker,
                date: today,
                score: result.techScore,
                dir_confidence: result.dirConfidence,
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

    // Time stop monitoring (WFA v3) — fires during market hours so user can act
    try {
        const breached = await checkTimeStopBreaches(profile.timeStopDTE || 3);
        if (breached.length > 0) {
            console.log(`[signal-scan] ${breached.length} position(s) breached time stop (\u22643 DTE)`);
            await sendTimeStopAlert(breached);
        }
    } catch (tsErr) {
        console.warn('[signal-scan] Time stop check failed:', tsErr.message);
    }

    console.log(`[signal-scan] Done: ${scanned} scanned, ${signals.length} signals, ${errors.length} errors`);

    return res.status(200).json({
        ok: true,
        date: today,
        scanned,
        signals: signals.map(s => ({ ticker: s.ticker, score: s.score, direction: s.direction, setup: s.setup, confidence: s.confidence })),
        errors: errors.length > 0 ? errors : undefined,
    });
}
