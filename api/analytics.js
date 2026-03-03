/**
 * GET /api/analytics?type=score-validation
 * GET /api/analytics?type=execution-quality
 *
 * Combined analytics endpoint (Vercel Hobby plan: 12-function limit).
 */

// ── Shared helpers ──────────────────────────────────────────────────────────
function sbConfig() {
    const sbUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const sbKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
    return { sbUrl, sbKey };
}

function sbHeaders(sbKey) {
    return { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` };
}

// ── Score Validation ────────────────────────────────────────────────────────
async function handleScoreValidation(req, res) {
    const { sbUrl, sbKey } = sbConfig();
    if (!sbUrl || !sbKey) return res.status(503).json({ error: 'Supabase not configured' });

    const headers = sbHeaders(sbKey);

    // Fetch candidate_snapshots that have a linked position_id
    const snapParams = new URLSearchParams({
        position_id: 'not.is.null',
        select: 'id,ticker,strategy_type,strategy_category,unified_score,ev_risk_ratio,pop,regime_mode,iv_rank,direction,entry_mid,position_id',
        limit: '1000',
    });
    const snapRes = await fetch(`${sbUrl}/rest/v1/candidate_snapshots?${snapParams}`, { headers });
    if (!snapRes.ok) {
        return res.status(502).json({ error: 'Failed to fetch candidate_snapshots', detail: await snapRes.text() });
    }
    const snapshots = await snapRes.json();

    if (!snapshots || snapshots.length === 0) {
        return res.status(200).json({
            success: true,
            message: 'No linked candidates yet. Enter trades from recommendations to populate.',
            buckets: [], totalLinked: 0,
        });
    }

    // Fetch closed positions that match linked position_ids
    const positionIds = [...new Set(snapshots.map(s => s.position_id))];
    const posParams = new URLSearchParams({
        id: `in.(${positionIds.join(',')})`,
        status: 'eq.closed',
        select: 'id,ticker,closed_at',
        limit: '1000',
    });
    const posRes = await fetch(`${sbUrl}/rest/v1/positions?${posParams}`, { headers });
    if (!posRes.ok) {
        return res.status(502).json({ error: 'Failed to fetch positions', detail: await posRes.text() });
    }
    const closedPositions = await posRes.json();
    const closedIds = new Set(closedPositions.map(p => p.id));

    if (closedIds.size === 0) {
        return res.status(200).json({
            success: true,
            message: 'No closed positions linked to candidates yet.',
            buckets: [], totalLinked: snapshots.length, totalClosed: 0,
        });
    }

    // Fetch transactions to compute realized P&L
    const txParams = new URLSearchParams({
        position_id: `in.(${[...closedIds].join(',')})`,
        select: 'position_id,type,quantity,price',
        limit: '5000',
    });
    const txRes = await fetch(`${sbUrl}/rest/v1/transactions?${txParams}`, { headers });
    if (!txRes.ok) {
        return res.status(502).json({ error: 'Failed to fetch transactions', detail: await txRes.text() });
    }
    const transactions = await txRes.json();

    const pnlByPosition = {};
    for (const tx of transactions) {
        if (!pnlByPosition[tx.position_id]) pnlByPosition[tx.position_id] = 0;
        pnlByPosition[tx.position_id] += -tx.quantity * tx.price * 100;
    }

    const BUCKETS = [
        { label: '0-30', min: 0, max: 30 },
        { label: '30-50', min: 30, max: 50 },
        { label: '50-70', min: 50, max: 70 },
        { label: '70-100', min: 70, max: 100 },
    ];

    const bucketStats = BUCKETS.map(b => ({ ...b, count: 0, closedCount: 0, winCount: 0, totalPnl: 0 }));

    for (const snap of snapshots) {
        const score = snap.unified_score;
        if (score == null) continue;
        const bucket = bucketStats.find(b => score >= b.min && score < b.max)
            ?? (score >= 100 ? bucketStats[3] : null);
        if (!bucket) continue;
        bucket.count++;
        if (!closedIds.has(snap.position_id)) continue;
        const pnl = pnlByPosition[snap.position_id] ?? null;
        if (pnl == null) continue;
        bucket.closedCount++;
        bucket.totalPnl += pnl;
        if (pnl > 0) bucket.winCount++;
    }

    return res.status(200).json({
        success: true,
        totalLinked: snapshots.length,
        totalClosed: closedIds.size,
        buckets: bucketStats.map(b => ({
            label: b.label,
            scoreRange: [b.min, b.max],
            candidateCount: b.count,
            closedCount: b.closedCount,
            hitRate: b.closedCount > 0 ? Math.round((b.winCount / b.closedCount) * 1000) / 10 : null,
            avgPnl: b.closedCount > 0 ? Math.round(b.totalPnl / b.closedCount) : null,
            totalPnl: Math.round(b.totalPnl),
        })),
    });
}

// ── Execution Quality ───────────────────────────────────────────────────────
async function handleExecutionQuality(req, res) {
    const { sbUrl, sbKey } = sbConfig();
    if (!sbUrl || !sbKey) return res.status(503).json({ error: 'Supabase not configured' });

    const headers = sbHeaders(sbKey);

    const posParams = new URLSearchParams({
        status: 'eq.closed',
        select: 'id,ticker,type,expiration,closed_at',
        limit: '500',
    });
    const posRes = await fetch(`${sbUrl}/rest/v1/positions?${posParams}`, { headers });
    if (!posRes.ok) return res.status(502).json({ error: 'Failed to fetch positions' });
    const positions = await posRes.json();
    if (!positions || positions.length === 0) {
        return res.status(200).json({ success: true, positions: [], summary: { earlyPct: null, latePct: null, atMarketPct: null, total: 0 } });
    }

    const positionIds = positions.map(p => p.id);

    const txParams = new URLSearchParams({
        position_id: `in.(${positionIds.join(',')})`,
        select: 'position_id,type,quantity,price,date',
        order: 'date.asc',
        limit: '2000',
    });
    const txRes = await fetch(`${sbUrl}/rest/v1/transactions?${txParams}`, { headers });
    if (!txRes.ok) return res.status(502).json({ error: 'Failed to fetch transactions' });
    const transactions = await txRes.json();

    const entryByPos = {};
    for (const tx of transactions) {
        if (tx.quantity > 0 && !entryByPos[tx.position_id]) {
            entryByPos[tx.position_id] = { price: tx.price, date: tx.date };
        }
    }

    const ghParams = new URLSearchParams({
        position_id: `in.(${positionIds.join(',')})`,
        select: 'position_id,recorded_at,iv,delta',
        order: 'recorded_at.asc',
        limit: '10000',
    });
    const ghRes = await fetch(`${sbUrl}/rest/v1/greeks_history?${ghParams}`, { headers });
    if (!ghRes.ok) return res.status(502).json({ error: 'Failed to fetch greeks_history' });
    const greeksHistory = await ghRes.json();

    const histByPos = {};
    for (const row of greeksHistory) {
        if (!histByPos[row.position_id]) histByPos[row.position_id] = [];
        histByPos[row.position_id].push(row);
    }

    const WINDOW_DAYS = 5;
    const EARLY_THRESHOLD = 0.30;
    const LATE_THRESHOLD = 0.30;

    const positionResults = [];
    let earlyCount = 0, lateCount = 0, atMarketCount = 0, classifiableCount = 0;

    for (const pos of positions) {
        const entry = entryByPos[pos.id];
        const history = histByPos[pos.id] || [];
        if (!entry || history.length === 0) {
            positionResults.push({ positionId: pos.id, ticker: pos.ticker, type: pos.type, entryPrice: entry?.price ?? null, classification: 'insufficient_data' });
            continue;
        }

        const entryDate = new Date(entry.date);
        const windowEnd = new Date(entryDate);
        windowEnd.setDate(windowEnd.getDate() + WINDOW_DAYS);

        const windowRows = history.filter(r => { const d = new Date(r.recorded_at); return d >= entryDate && d <= windowEnd; });
        if (windowRows.length === 0) {
            positionResults.push({ positionId: pos.id, ticker: pos.ticker, type: pos.type, entryPrice: entry.price, classification: 'insufficient_data' });
            continue;
        }

        const deltas = windowRows.map(r => Math.abs(r.delta || 0)).filter(d => d > 0);
        if (deltas.length === 0) {
            positionResults.push({ positionId: pos.id, ticker: pos.ticker, type: pos.type, entryPrice: entry.price, classification: 'insufficient_data' });
            continue;
        }

        const isCredit = pos.type?.toLowerCase().includes('credit') || pos.type?.toLowerCase().includes('short');
        const bestDelta = isCredit ? Math.min(...deltas) : Math.max(...deltas);
        const worstDelta = isCredit ? Math.max(...deltas) : Math.min(...deltas);
        const entryDelta = Math.abs(windowRows[0].delta || 0);
        const range = Math.abs(bestDelta - worstDelta);

        if (range < 0.001) {
            positionResults.push({ positionId: pos.id, ticker: pos.ticker, type: pos.type, entryPrice: entry.price, entryDelta, bestDelta, worstDelta, classification: 'at-market' });
            atMarketCount++; classifiableCount++;
            continue;
        }

        const distFromBest = Math.abs(entryDelta - bestDelta) / range;
        const distFromWorst = Math.abs(entryDelta - worstDelta) / range;
        let classification;
        if (distFromBest <= EARLY_THRESHOLD) { classification = 'early'; earlyCount++; }
        else if (distFromWorst <= LATE_THRESHOLD) { classification = 'late'; lateCount++; }
        else { classification = 'at-market'; atMarketCount++; }
        classifiableCount++;

        positionResults.push({
            positionId: pos.id, ticker: pos.ticker, type: pos.type, entryPrice: entry.price,
            entryDelta: Math.round(entryDelta * 1000) / 1000,
            bestDelta: Math.round(bestDelta * 1000) / 1000,
            worstDelta: Math.round(worstDelta * 1000) / 1000,
            distFromBest: Math.round(distFromBest * 1000) / 1000,
            classification,
        });
    }

    return res.status(200).json({
        success: true,
        summary: {
            total: positions.length, classifiable: classifiableCount,
            earlyCount, lateCount, atMarketCount,
            earlyPct: classifiableCount > 0 ? Math.round((earlyCount / classifiableCount) * 1000) / 10 : null,
            latePct: classifiableCount > 0 ? Math.round((lateCount / classifiableCount) * 1000) / 10 : null,
            atMarketPct: classifiableCount > 0 ? Math.round((atMarketCount / classifiableCount) * 1000) / 10 : null,
        },
        positions: positionResults,
    });
}

// ── Router ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

    const { type } = req.query;

    try {
        switch (type) {
            case 'score-validation':
                return await handleScoreValidation(req, res);
            case 'execution-quality':
                return await handleExecutionQuality(req, res);
            default:
                return res.status(400).json({
                    error: 'Missing or invalid type parameter',
                    usage: '?type=score-validation or ?type=execution-quality',
                });
        }
    } catch (err) {
        console.error(`[Analytics/${type}] Error:`, err.message);
        return res.status(500).json({ error: 'Internal Server Error', message: err.message });
    }
}
