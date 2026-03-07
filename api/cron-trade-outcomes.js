// api/cron-trade-outcomes.js
// Computes MFE/MAE for closed trades using underlying stock candles.
// Runs daily after market close (21:35 UTC / 4:35 PM ET).
// MFE = max favorable excursion of the underlying from entry to exit.
// MAE = max adverse excursion of the underlying from entry to exit.

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function supabaseQuery(table, queryParams) {
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
        console.warn(`[trade-outcomes] Upsert ${table} failed: ${res.status} ${text}`);
    }
}

function computeMFEMAE(candles, entryPrice, direction) {
    let mfePct = 0, maePct = 0, mfeBars = 0, maeBars = 0;

    for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        // Use high/low for intra-bar excursion
        const highPct = ((c.high - entryPrice) / entryPrice) * 100;
        const lowPct = ((c.low - entryPrice) / entryPrice) * 100;

        if (direction === 'long') {
            if (highPct > mfePct) { mfePct = highPct; mfeBars = i + 1; }
            if (lowPct < maePct) { maePct = lowPct; maeBars = i + 1; }
        } else {
            // Short: favorable = price going down, adverse = price going up
            if (-lowPct > mfePct) { mfePct = -lowPct; mfeBars = i + 1; }
            if (-highPct < maePct) { maePct = -highPct; maeBars = i + 1; }
        }
    }

    const finalClose = candles.length > 0 ? candles[candles.length - 1].close : entryPrice;
    const finalPct = direction === 'long'
        ? ((finalClose - entryPrice) / entryPrice) * 100
        : ((entryPrice - finalClose) / entryPrice) * 100;

    return { mfePct, maePct, mfeBars, maeBars, finalPct };
}

export default async function handler(req, res) {
    const secret = req.query.secret || req.headers['authorization']?.replace('Bearer ', '');
    const expectedSecret = process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;
    if (!expectedSecret || secret !== expectedSecret) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    console.log('[trade-outcomes] Starting MFE/MAE computation');

    try {
        // 1. Get closed positions that don't have trade_outcomes yet
        // LEFT JOIN via NOT IN subquery isn't possible with REST — use two queries
        const closedPositions = await supabaseQuery('positions',
            'select=id,ticker,created_at,closed_at,direction,type&status=eq.closed&order=closed_at.desc&limit=100'
        );
        if (!closedPositions || closedPositions.length === 0) {
            console.log('[trade-outcomes] No closed positions found');
            return res.status(200).json({ computed: 0 });
        }

        const existingOutcomes = await supabaseQuery('trade_outcomes',
            `select=position_id&position_id=in.(${closedPositions.map(p => p.id).join(',')})`
        );
        const existingIds = new Set((existingOutcomes || []).map(o => o.position_id));

        const needsCompute = closedPositions.filter(p => !existingIds.has(p.id));
        console.log(`[trade-outcomes] ${needsCompute.length} positions need MFE/MAE (${existingIds.size} already computed)`);

        if (needsCompute.length === 0) {
            return res.status(200).json({ computed: 0 });
        }

        const results = [];
        for (const pos of needsCompute) {
            try {
                const entryDate = (pos.created_at || '').split('T')[0];
                const exitDate = (pos.closed_at || '').split('T')[0];
                if (!entryDate || !exitDate) continue;

                // Fetch candles from stock_candles cache
                const candles = await supabaseQuery('stock_candles',
                    `select=date,open,high,low,close,volume&ticker=eq.${pos.ticker}&timeframe=eq.1D&date=gte.${entryDate}&date=lte.${exitDate}&order=date.asc`
                );
                if (!candles || candles.length < 2) {
                    console.warn(`[trade-outcomes] ${pos.ticker}: insufficient candles (${candles?.length || 0})`);
                    continue;
                }

                const entryPrice = Number(candles[0].close);
                // Direction: BULL/CALL → long, BEAR/PUT → short
                const direction = (pos.direction === 'BEAR' || pos.type === 'PUT') ? 'short' : 'long';

                const { mfePct, maePct, mfeBars, maeBars, finalPct } = computeMFEMAE(
                    candles.slice(1).map(c => ({ high: Number(c.high), low: Number(c.low), close: Number(c.close) })),
                    entryPrice,
                    direction
                );

                results.push({
                    position_id: pos.id,
                    ticker: pos.ticker,
                    entry_date: entryDate,
                    exit_date: exitDate,
                    entry_price: entryPrice,
                    direction,
                    mfe_pct: Number(mfePct.toFixed(2)),
                    mae_pct: Number(maePct.toFixed(2)),
                    mfe_bars: mfeBars,
                    mae_bars: maeBars,
                    final_pct: Number(finalPct.toFixed(2)),
                });

                console.log(`[trade-outcomes] ${pos.ticker}: MFE=${mfePct.toFixed(1)}%, MAE=${maePct.toFixed(1)}%, Final=${finalPct.toFixed(1)}%`);
            } catch (err) {
                console.error(`[trade-outcomes] ${pos.ticker}: ${err.message}`);
            }
        }

        if (results.length > 0) {
            await supabaseUpsert('trade_outcomes', results, 'position_id');
        }

        console.log(`[trade-outcomes] Computed ${results.length} trade outcomes`);
        return res.status(200).json({ computed: results.length });
    } catch (err) {
        console.error('[trade-outcomes] Error:', err.message);
        return res.status(500).json({ error: err.message });
    }
}
