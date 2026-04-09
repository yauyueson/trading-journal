// api/cron-signal-scan.js
// Daily signal scanner — triggered externally via cronjobs.org (21:00 UTC / 4:00 PM ET weekdays).
// 1. Tops up stock_candles cache with latest day's data from Tiingo
// 2. Tops up 130M candle cache (10-min bars → 130M aggregation)
// 3. Runs calculateTechScore on each ticker
// 4. Upserts actionable signals to signal_history table
// 5. Sends Discord embed with all signals

import { createRequire } from 'node:module';
import { getCandles, getIntradayNMinCandles } from '../lib/tiingo-client.js';

const require = createRequire(import.meta.url);
const { calculateTechScore, emaFullSeries } = require('../lib/_shared/tech-analysis.cjs');

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
// Strategy-aware: shortTerm uses 1 DTE, swing/untagged uses 3 DTE.

async function checkTimeStopBreaches() {
    const today = new Date().toISOString().split('T')[0];

    const active = await supabaseGet('positions',
        'select=id,ticker,expiration,type,strategy_type&status=eq.active&type=in.(Credit Put Spread,Credit Call Spread)');
    if (!active || active.length === 0) return [];

    const breached = [];
    for (const pos of active) {
        if (!pos.expiration) continue;
        const expDate = new Date(pos.expiration + 'T16:00:00Z');
        const todayDate = new Date(today + 'T16:00:00Z');
        const daysToExp = Math.round((expDate - todayDate) / (1000 * 60 * 60 * 24));
        const threshold = pos.strategy_type === 'shortTerm' ? 1 : 3;
        if (daysToExp <= threshold) {
            breached.push({ ...pos, daysToExp, threshold });
        }
    }
    return breached;
}

async function sendTimeStopAlert(breached) {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl || breached.length === 0) return;

    const fields = breached.map(p => ({
        name: `${p.ticker} \u2014 ${p.daysToExp} DTE`,
        value: `${p.type} exp ${p.expiration} \u2014 **close now** (time stop = ${p.threshold} DTE)`,
        inline: false,
    }));

    try {
        await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                embeds: [{
                    title: `\u23F0 Time Stop Alert \u2014 ${breached.length} position(s) breaching DTE threshold`,
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

// ── 130M Candle Top-Up ──────────────────────────────────────────────────────────
// Fetches today's 10-min bars from Tiingo IEX, aggregates to 130M, upserts to cache.
// 10-min bars divide perfectly into 130M blocks (13 bars per block).

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
            timestamp: sorted[0].timestamp, date: group.date, block: group.block,
            open: sorted[0].open, high: Math.max(...sorted.map(c => c.high)),
            low: Math.min(...sorted.map(c => c.low)), close: sorted[sorted.length - 1].close,
            volume: sorted.reduce((sum, c) => sum + c.volume, 0),
        });
    }
    return result.sort((a, b) => a.timestamp - b.timestamp);
}

async function topUp130MCandles(today) {
    console.log(`[signal-scan/130M] Starting 130M top-up for ${SCAN_TICKERS.length} tickers`);
    let topped = 0, skipped = 0, failed = 0;

    // Get last cached date per ticker
    const lastDates = new Map();
    try {
        const rows = await supabaseGet('stock_candles',
            `select=ticker,date&timeframe=eq.130M_2&order=date.desc&limit=${SCAN_TICKERS.length}`);
        if (rows) for (const r of rows) if (!lastDates.has(r.ticker)) lastDates.set(r.ticker, r.date);
    } catch (err) {
        console.warn('[signal-scan/130M] Could not fetch last cached dates:', err.message);
        return { topped: 0, skipped: 0, failed: 0 };
    }

    for (const ticker of SCAN_TICKERS) {
        try {
            const lastDate = lastDates.get(ticker);
            if (!lastDate || lastDate >= today) { skipped++; continue; }

            const d = new Date(lastDate + 'T12:00:00Z');
            d.setUTCDate(d.getUTCDate() + 1);
            const fromDate = d.toISOString().slice(0, 10);

            const bars10m = await getIntradayNMinCandles(ticker, fromDate, today, 10);
            if (bars10m.length === 0) { skipped++; continue; }

            const bars130m = aggregateMinuteTo130M(bars10m);
            if (bars130m.length === 0) { skipped++; continue; }

            const rows = bars130m.map(b => ({
                ticker, date: b.date, open: b.open, high: b.high, low: b.low,
                close: b.close, volume: Math.round(b.volume), timeframe: `130M_${b.block}`,
            }));
            await supabaseUpsert('stock_candles', rows);
            topped++;
            console.log(`[signal-scan/130M] ${ticker}: +${bars130m.length} bars (${fromDate} → ${today})`);
        } catch (err) {
            failed++;
            console.warn(`[signal-scan/130M] ${ticker}: failed — ${err.message}`);
        }
    }

    console.log(`[signal-scan/130M] Done: ${topped} topped, ${skipped} skipped, ${failed} failed`);
    return { topped, skipped, failed };
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

// ── Short-Term 130M Signal Scan ──────────────────────────────────────────────────

const SHORT_TERM_PERIOD_MULT = 2.25;

function scaleIndicatorPeriods(mult, base) {
    return {
        ...base,
        sc_mb_len: Math.round((base.sc_mb_len ?? 100) * mult),
        sc_osc_len: Math.round((base.sc_osc_len ?? 14) * mult),
        sc_bx_s1: Math.round((base.sc_bx_s1 ?? 8) * mult),
        sc_bx_s2: Math.round((base.sc_bx_s2 ?? 21) * mult),
        sc_bx_l1: Math.round((base.sc_bx_l1 ?? 50) * mult),
        sc_bx_l2: Math.round((base.sc_bx_l2 ?? 100) * mult),
    };
}

async function get130MCandles(ticker, lookbackDays = 120) {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - lookbackDays * 86400000).toISOString().slice(0, 10);

    const rows = await supabaseGet('stock_candles',
        `select=date,open,high,low,close,volume,timeframe&ticker=eq.${ticker}&timeframe=like.130M_*&date=gte.${from}&date=lte.${to}&order=date.asc,timeframe.asc&limit=1500`
    );
    if (!rows || rows.length === 0) return [];

    return rows.map(r => ({
        date: r.date,
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
    }));
}

async function scanShortTermSignals(config, today) {
    const stProfile = config.profiles.shortTerm;
    if (!stProfile) return { signals: [], scanned: 0, errors: [] };

    const presetWeights = SIGNAL_PRESETS[stProfile.signalPreset] || SIGNAL_PRESETS.em;
    const techOptions = scaleIndicatorPeriods(SHORT_TERM_PERIOD_MULT, presetWeights);
    const MIN_SCORE = stProfile.minScore || 70;
    const MIN_RVOL = stProfile.rvolGate || 0.5;
    const ADX_GATE = stProfile.adxGate;
    const IVR_MIN = stProfile.ivRankMin || 20;
    const MIN_DIR_CONF = stProfile.minDirConfidence ?? 0;

    console.log(`[signal-scan/ST] Starting short-term 130M scan (signal: ${stProfile.signalPreset}, pm: ${SHORT_TERM_PERIOD_MULT}, ivr: ${IVR_MIN})`);

    const signals = [];
    const errors = [];
    let scanned = 0;

    for (const ticker of SCAN_TICKERS) {
        try {
            const candles = await get130MCandles(ticker);
            if (!candles || candles.length < 50) continue;

            const result = calculateTechScore(candles, techOptions);
            scanned++;

            const adx = result.debug?.adx ?? 20;
            const rvol = result.debug?.rvol ?? 1;
            if (ADX_GATE != null && adx < ADX_GATE) continue;
            if (rvol < MIN_RVOL) continue;
            if (result.type === 'NEUTRAL') continue;
            if (result.techScore < MIN_SCORE) continue;
            if (result.dirConfidence < MIN_DIR_CONF) continue;

            // IV rank filter for short-term
            let iv30 = null;
            try {
                const ivRows = await supabaseGet('orats_iv_cache',
                    `select=iv30d&ticker=eq.${ticker}&order=date.desc&limit=1`);
                if (ivRows && ivRows.length > 0) iv30 = ivRows[0].iv30d;
            } catch (_) {}

            if (IVR_MIN > 0 && iv30 != null && iv30 < IVR_MIN) continue;

            signals.push({
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
                strategyType: 'shortTerm',
            });

            // Upsert to signal_history with short-term tag
            supabaseUpsert('signal_history', [{
                ticker,
                date: today,
                score: result.techScore,
                dir_confidence: result.dirConfidence,
                direction: result.type,
                setup: `ST:${result.setup}`,
                confidence: result.confidence,
                components: result.components,
                debug: result.debug,
            }], 'ticker,date').catch(() => {});

        } catch (err) {
            errors.push({ ticker, error: err.message });
        }
    }

    signals.sort((a, b) => b.score - a.score);
    return { signals, scanned, errors };
}

async function sendShortTermDiscord(signals, totalScanned, date) {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return;

    const fields = [];
    if (signals.length === 0) {
        fields.push({ name: 'No short-term signals today', value: 'All tickers below threshold or filtered by IV rank / quality gates.', inline: false });
    } else {
        for (const s of signals.slice(0, 25)) {
            const emoji = s.direction === 'CALL' ? '\uD83D\uDFE2' : '\uD83D\uDD34';
            const dirLabel = s.direction === 'CALL' ? 'BUY' : 'SELL';
            const ivLabel = s.iv30 != null ? `IV: ${(s.iv30 * 100).toFixed(0)}%` : 'IV: n/a';
            fields.push({
                name: `${s.ticker} ${emoji} ${dirLabel}`,
                value: `Score: **${s.score}** | ${s.setup} | Conf: ${s.confidence}\nADX: ${s.adx} | RVOL: ${s.rvol} | ${ivLabel} | $${s.close.toFixed(2)}`,
                inline: false,
            });
        }
    }

    try {
        await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                embeds: [{
                    title: `\uD83D\uDCCA Short-Term Signal Scan (130M) \u2014 ${date}`,
                    color: signals.length > 0 ? 0x22c55e : 0xaaaaaa,
                    fields,
                    footer: { text: `Trading Journal \u00b7 ${totalScanned} tickers \u00b7 ${signals.length} signals \u00b7 em|tp50|w10|iv20|d45|ts1|pm2.25` },
                    timestamp: new Date().toISOString(),
                }]
            }),
            signal: AbortSignal.timeout(5000),
        });
    } catch (err) {
        console.warn('[signal-scan/ST] Discord send failed:', err.message);
    }
}

// ── DTE5 Signal Check (QQQ/SPY/IWM bull EMA34 gate) ────────────────────────────
// WFA-validated: QQQ bull Sharpe 1.29, SPY bull 0.85, IWM bull 0.76
// All bears killed: QQQ bear (15 trades/6yr), SPY bear (Grade D), IWM bear (negative Sharpe)

async function checkDTE5Signal(today) {
    // Multi-ticker bull-only DTE5 signal check
    // Bull: close > EMA34 (QQQ, SPY, IWM — all WFA-validated)
    // Exit: SL 2.5x credit, trailing lock 50/50, hold-to-expiry
    const TICKER_CONFIGS = {
        QQQ: {
            bull: { ema: 34, spread: 'sp30/20', delta: 0.30, longDelta: 0.20 },
        },
        SPY: {
            bull: { ema: 34, spread: 'sp30/20', delta: 0.30, longDelta: 0.20 },
        },
        IWM: {
            bull: { ema: 34, spread: 'sp30/20', delta: 0.30, longDelta: 0.20 },
        },
    };

    const results = [];

    try {
        // Check active DTE5 positions
        const activeDTE5 = await supabaseGet('positions',
            'select=id&status=eq.active&strategy_type=eq.dte5');
        const hasActivePosition = activeDTE5?.length > 0;

        for (const [ticker, cfg] of Object.entries(TICKER_CONFIGS)) {
            const candles = await getCachedCandles(ticker, 350);
            if (!candles || candles.length < MIN_CANDLES) {
                results.push({ ticker, direction: null, fired: false, reason: 'insufficient_data', criteria: {} });
                continue;
            }

            const closes = candles.map(c => c.close);
            const lastClose = closes[closes.length - 1];
            const lastOpen = candles[candles.length - 1].open;

            // Compute all needed EMAs
            const ema21 = emaFullSeries(closes, 21);
            const ema34 = emaFullSeries(closes, 34);
            const ema55 = emaFullSeries(closes, 55);
            const e21 = ema21[ema21.length - 1];
            const e34 = ema34[ema34.length - 1];
            const e55 = ema55[ema55.length - 1];

            // ── BULL CHECK (QQQ, SPY, IWM — WFA-validated) ──
            if (cfg.bull) {
                const bullEma = cfg.bull.ema === 34 ? e34 : e21;
                const bullPass = lastClose > bullEma;
                const criteria = {
                    'close > EMA34': { pass: bullPass, value: `$${lastClose.toFixed(2)} ${bullPass ? '>' : '≤'} $${bullEma.toFixed(2)}` },
                    'no active position': { pass: !hasActivePosition, value: hasActivePosition ? 'blocked' : 'clear' },
                };
                const fired = bullPass && !hasActivePosition;

                if (fired) {
                    await supabaseUpsert('signal_history', [{
                        ticker, date: today, timeframe: '1D', score: 100,
                        direction: 'CALL', setup: 'DTE5_BULL_PUT', confidence: 100, status: 'GO',
                        components: JSON.stringify({ strategy: 'dte5', side: 'bull', ema34: e34.toFixed(2), close: lastClose.toFixed(2), open: lastOpen.toFixed(2), gate: 'close > EMA34' }),
                    }]);
                }

                results.push({ ticker, direction: 'bull', fired, spread: cfg.bull.spread, criteria });
            }

            // Bear signals disabled per WFA Phase 7: QQQ (15 trades/6yr), SPY (Grade D), IWM (negative Sharpe)
        }

        // Discord summary — one embed with all tickers
        const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
        if (webhookUrl) {
            const firedSignals = results.filter(r => r.fired);
            const fields = results.map(r => {
                const icon = r.fired ? '🟢' : '⚫';
                const dir = r.direction === 'bull' ? 'BULL PUT' : 'BEAR CALL';
                const criteriaStr = Object.entries(r.criteria)
                    .map(([k, v]) => `${v.pass ? '✅' : '❌'} ${k}: ${v.value}`)
                    .join('\n');
                return { name: `${icon} ${r.ticker} ${dir}`, value: criteriaStr, inline: false };
            });

            const goCount = firedSignals.length;
            const color = goCount > 0 ? 0xF59E0B : 0x6B7280; // amber if signals, gray if none
            await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    embeds: [{
                        title: `DTE5 Signal Scan — ${today}`,
                        description: goCount > 0
                            ? `**${goCount} signal(s) fired.** ${firedSignals.map(s => `${s.ticker} ${s.direction === 'bull' ? 'BULL PUT' : 'BEAR CALL'} ${s.spread}`).join(', ')}`
                            : 'No signals — all criteria not met. See details below.',
                        color,
                        fields,
                        footer: { text: `DTE5 Bull+Bear Strategy • Recommended: QQQ bull + SPY bear` },
                        timestamp: new Date().toISOString(),
                    }],
                }),
            });
        }

        console.log(`[DTE5] ${results.filter(r => r.fired).length}/${results.length} signals fired`);
        return results;
    } catch (err) {
        console.warn('[DTE5] Signal check failed:', err.message);
        return [{ ticker: 'ALL', direction: null, fired: false, reason: 'error', error: err.message, criteria: {} }];
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

    // 130M candle cache top-up (keeps short-term signal board warm)
    let topUp130M = { topped: 0, skipped: 0, failed: 0 };
    try {
        topUp130M = await topUp130MCandles(today);
    } catch (err) {
        console.warn('[signal-scan/130M] Top-up failed:', err.message);
    }

    // Send swing Discord
    await sendDiscord(signals, scanned, today);

    // ── Short-Term 130M Signal Scan ──────────────────────────────────────
    let stResult = { signals: [], scanned: 0, errors: [] };
    try {
        stResult = await scanShortTermSignals(config, today);
        console.log(`[signal-scan/ST] Done: ${stResult.scanned} scanned, ${stResult.signals.length} signals`);
        await sendShortTermDiscord(stResult.signals, stResult.scanned, today);
    } catch (stErr) {
        console.warn('[signal-scan/ST] Short-term scan failed:', stErr.message);
    }

    // ── DTE5 Signal Check (multi-ticker bull + bear) ────────────────────
    let dte5Result = [];
    try {
        dte5Result = await checkDTE5Signal(today);
        const fired = dte5Result.filter(r => r.fired);
        console.log(`[signal-scan/DTE5] ${fired.length}/${dte5Result.length} signals fired: ${fired.map(r => `${r.ticker} ${r.direction}`).join(', ') || 'none'}`);
    } catch (dte5Err) {
        console.warn('[signal-scan/DTE5] Check failed:', dte5Err.message);
    }

    // ── DTE5 Expiration Auto-Close ────────────────────────────────────────
    try {
        const expiredDTE5 = await supabaseGet('positions',
            `select=id,ticker,legs,expiration&status=eq.active&strategy_type=eq.dte5&expiration=lte.${today}`);
        if (expiredDTE5?.length > 0) {
            for (const pos of expiredDTE5) {
                // Close the expired position
                const url = process.env.SUPABASE_URL;
                const key = process.env.SUPABASE_ANON_KEY;
                if (url && key) {
                    await fetch(`${url}/rest/v1/positions?id=eq.${pos.id}`, {
                        method: 'PATCH',
                        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
                        body: JSON.stringify({ status: 'closed', closed_at: pos.expiration, exit_type: 'TIME' }),
                    });
                }

                // Determine OTM/ITM
                const legs = pos.legs || [];
                const shortLeg = legs.find(l => l.side === 'short');
                const shortStrike = shortLeg?.strike;
                const qqqCandles = await getCachedCandles('QQQ', 5);
                const closePrice = qqqCandles?.[qqqCandles.length - 1]?.close;
                const itm = closePrice && shortStrike ? closePrice < shortStrike : null;
                const spreadDesc = legs.length === 2
                    ? `$${shortLeg?.strike || '?'}/$${legs.find(l => l.side === 'long')?.strike || '?'}P`
                    : pos.ticker;

                console.log(`[DTE5] Auto-closed expired: ${pos.ticker} ${spreadDesc} (${itm ? 'ITM' : 'OTM'})`);

                // Discord alert
                const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
                if (webhookUrl) {
                    await fetch(webhookUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            embeds: [{
                                title: `DTE5 Expired: ${pos.ticker} ${spreadDesc}`,
                                description: `Position expired ${itm === true ? '**ITM** (loss)' : itm === false ? '**OTM** (full credit captured)' : '(settlement unknown)'}.\nVerify Robinhood settlement.${closePrice ? `\nQQQ close: $${closePrice.toFixed(2)}` : ''}`,
                                color: itm ? 0xEF4444 : 0x10B981,
                                footer: { text: `DTE5 Auto-Close \u2022 ${today}` },
                                timestamp: new Date().toISOString(),
                            }],
                        }),
                    });
                }
            }
            console.log(`[DTE5] Auto-closed ${expiredDTE5.length} expired position(s)`);
        }
    } catch (expErr) {
        console.warn('[DTE5] Expiration auto-close failed:', expErr.message);
    }

    // Time stop monitoring (strategy-aware: shortTerm=1 DTE, swing=3 DTE, dte5=hold-to-expiry)
    try {
        const breached = await checkTimeStopBreaches();
        if (breached.length > 0) {
            console.log(`[signal-scan] ${breached.length} position(s) breached time stop`);
            await sendTimeStopAlert(breached);
        }
    } catch (tsErr) {
        console.warn('[signal-scan] Time stop check failed:', tsErr.message);
    }

    const dte5Fired = Array.isArray(dte5Result) ? dte5Result.filter(r => r.fired) : [];
    console.log(`[signal-scan] Done: swing ${scanned}/${signals.length}, ST ${stResult.scanned}/${stResult.signals.length}, DTE5 ${dte5Fired.length} fired, errors ${errors.length}`);

    return res.status(200).json({
        ok: true,
        date: today,
        scanned,
        signals: signals.map(s => ({ ticker: s.ticker, score: s.score, direction: s.direction, setup: s.setup, confidence: s.confidence })),
        shortTerm: {
            scanned: stResult.scanned,
            signals: stResult.signals.map(s => ({ ticker: s.ticker, score: s.score, direction: s.direction, setup: s.setup })),
        },
        dte5: dte5Result,
        errors: errors.length > 0 ? errors : undefined,
        topUp130M,
    });
}
