/**
 * GET /api/score-validation
 * Score→P&L empirical validation.
 * Queries closed positions joined with candidate_snapshots, buckets by unified_score,
 * and returns hit rate + avg P&L per bucket.
 *
 * Buckets: 0-30, 30-50, 50-70, 70-100
 * Requires candidate_snapshots table (migration 007).
 */
export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const sbUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const sbKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
    if (!sbUrl || !sbKey) {
        return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
        // Fetch candidate_snapshots that have a linked position_id (i.e., user entered the trade)
        const snapParams = new URLSearchParams({
            position_id: 'not.is.null',
            select: 'id,ticker,strategy_type,strategy_category,unified_score,ev_risk_ratio,pop,regime_mode,iv_rank,direction,entry_mid,position_id',
            limit: '1000',
        });
        const snapRes = await fetch(`${sbUrl}/rest/v1/candidate_snapshots?${snapParams}`, {
            headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` },
        });
        if (!snapRes.ok) {
            const txt = await snapRes.text();
            return res.status(502).json({ error: 'Failed to fetch candidate_snapshots', detail: txt });
        }
        const snapshots = await snapRes.json();

        if (!snapshots || snapshots.length === 0) {
            return res.status(200).json({
                success: true,
                message: 'No linked candidates yet. Enter trades from recommendations to populate.',
                buckets: [],
                totalLinked: 0,
            });
        }

        // Fetch closed positions that match the linked position_ids
        const positionIds = [...new Set(snapshots.map(s => s.position_id))];
        const posParams = new URLSearchParams({
            id: `in.(${positionIds.join(',')})`,
            status: 'eq.closed',
            select: 'id,ticker,closed_at',
            limit: '1000',
        });
        const posRes = await fetch(`${sbUrl}/rest/v1/positions?${posParams}`, {
            headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` },
        });
        if (!posRes.ok) {
            const txt = await posRes.text();
            return res.status(502).json({ error: 'Failed to fetch positions', detail: txt });
        }
        const closedPositions = await posRes.json();
        const closedIds = new Set(closedPositions.map(p => p.id));

        // Fetch transactions to compute realized P&L for each closed position
        if (closedIds.size === 0) {
            return res.status(200).json({
                success: true,
                message: 'No closed positions linked to candidates yet.',
                buckets: [],
                totalLinked: snapshots.length,
                totalClosed: 0,
            });
        }

        const txParams = new URLSearchParams({
            position_id: `in.(${[...closedIds].join(',')})`,
            select: 'position_id,type,quantity,price',
            limit: '5000',
        });
        const txRes = await fetch(`${sbUrl}/rest/v1/transactions?${txParams}`, {
            headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` },
        });
        if (!txRes.ok) {
            const txt = await txRes.text();
            return res.status(502).json({ error: 'Failed to fetch transactions', detail: txt });
        }
        const transactions = await txRes.json();

        // Compute realized P&L per position (sum of signed cash flows × 100)
        const pnlByPosition = {};
        for (const tx of transactions) {
            if (!pnlByPosition[tx.position_id]) pnlByPosition[tx.position_id] = 0;
            // Open/Size Up → negative cash (paid), Close/Take Profit → positive cash (received)
            // quantity > 0 = bought, < 0 = sold
            const cashFlow = -tx.quantity * tx.price * 100;
            pnlByPosition[tx.position_id] += cashFlow;
        }

        // Join snapshots with P&L
        const BUCKETS = [
            { label: '0-30', min: 0, max: 30 },
            { label: '30-50', min: 30, max: 50 },
            { label: '50-70', min: 50, max: 70 },
            { label: '70-100', min: 70, max: 100 },
        ];

        const bucketStats = BUCKETS.map(b => ({
            ...b,
            count: 0,
            closedCount: 0,
            winCount: 0,
            totalPnl: 0,
            pnls: [],
        }));

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
            bucket.pnls.push(pnl);
            if (pnl > 0) bucket.winCount++;
        }

        const resultBuckets = bucketStats.map(b => ({
            label: b.label,
            scoreRange: [b.min, b.max],
            candidateCount: b.count,
            closedCount: b.closedCount,
            hitRate: b.closedCount > 0 ? Math.round((b.winCount / b.closedCount) * 1000) / 10 : null,
            avgPnl: b.closedCount > 0 ? Math.round(b.totalPnl / b.closedCount) : null,
            totalPnl: Math.round(b.totalPnl),
        }));

        return res.status(200).json({
            success: true,
            totalLinked: snapshots.length,
            totalClosed: closedIds.size,
            buckets: resultBuckets,
        });

    } catch (err) {
        console.error('[Score Validation] Error:', err.message);
        return res.status(500).json({ error: 'Internal Server Error', message: err.message });
    }
}
