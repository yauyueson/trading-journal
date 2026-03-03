/**
 * GET /api/execution-quality
 * Analyzes entry timing vs realized price range in first 5 days after open.
 *
 * For each closed position:
 *   - Finds the min/max price in greeks_history within the first 5 trading days.
 *   - Classifies entry: 'early' (entry within 30% of best price achievable),
 *     'late' (entry within 30% of worst price achievable), or 'at-market'.
 *   - Returns per-position breakdown + summary stats.
 *
 * Requires: positions table, transactions table, greeks_history table.
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

    const headers = { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` };

    try {
        // 1. Fetch closed positions
        const posParams = new URLSearchParams({
            status: 'eq.closed',
            select: 'id,ticker,type,expiration,closed_at',
            limit: '500',
        });
        const posRes = await fetch(`${sbUrl}/rest/v1/positions?${posParams}`, { headers });
        if (!posRes.ok) {
            return res.status(502).json({ error: 'Failed to fetch positions' });
        }
        const positions = await posRes.json();
        if (!positions || positions.length === 0) {
            return res.status(200).json({ success: true, positions: [], summary: { earlyPct: null, latePct: null, atMarketPct: null, total: 0 } });
        }

        const positionIds = positions.map(p => p.id);

        // 2. Fetch open transactions (first Buy/Open per position) to get entry price + date
        const txParams = new URLSearchParams({
            position_id: `in.(${positionIds.join(',')})`,
            select: 'position_id,type,quantity,price,date',
            order: 'date.asc',
            limit: '2000',
        });
        const txRes = await fetch(`${sbUrl}/rest/v1/transactions?${txParams}`, { headers });
        if (!txRes.ok) {
            return res.status(502).json({ error: 'Failed to fetch transactions' });
        }
        const transactions = await txRes.json();

        // Build entry info per position (first buy transaction)
        const entryByPos = {};
        for (const tx of transactions) {
            if (tx.quantity > 0 && !entryByPos[tx.position_id]) {
                entryByPos[tx.position_id] = { price: tx.price, date: tx.date };
            }
        }

        // 3. Fetch greeks_history for all position IDs (price proxy via delta or iv for timing)
        // We use greeks_history.iv as a proxy for option price movement when direct price isn't stored.
        // If a 'price' column exists it would be preferred — this uses iv as proxy.
        const ghParams = new URLSearchParams({
            position_id: `in.(${positionIds.join(',')})`,
            select: 'position_id,recorded_at,iv,delta',
            order: 'recorded_at.asc',
            limit: '10000',
        });
        const ghRes = await fetch(`${sbUrl}/rest/v1/greeks_history?${ghParams}`, { headers });
        if (!ghRes.ok) {
            return res.status(502).json({ error: 'Failed to fetch greeks_history' });
        }
        const greeksHistory = await ghRes.json();

        // Group greeks_history by position_id
        const histByPos = {};
        for (const row of greeksHistory) {
            if (!histByPos[row.position_id]) histByPos[row.position_id] = [];
            histByPos[row.position_id].push(row);
        }

        // 4. Classify each closed position
        const CLASSIFICATION_WINDOW_DAYS = 5;
        const EARLY_THRESHOLD = 0.30;   // within 30% of best achievable = 'early'
        const LATE_THRESHOLD = 0.30;    // within 30% of worst achievable = 'late'

        const positionResults = [];
        let earlyCount = 0, lateCount = 0, atMarketCount = 0, classifiableCount = 0;

        for (const pos of positions) {
            const entry = entryByPos[pos.id];
            const history = histByPos[pos.id] || [];
            if (!entry || history.length === 0) {
                positionResults.push({
                    positionId: pos.id,
                    ticker: pos.ticker,
                    type: pos.type,
                    entryPrice: entry?.price ?? null,
                    classification: 'insufficient_data',
                    note: 'No entry transaction or greeks history found',
                });
                continue;
            }

            const entryDate = new Date(entry.date);
            const windowEnd = new Date(entryDate);
            windowEnd.setDate(windowEnd.getDate() + CLASSIFICATION_WINDOW_DAYS);

            // Filter greeks_history to first 5 days after entry
            const windowRows = history.filter(r => {
                const d = new Date(r.recorded_at);
                return d >= entryDate && d <= windowEnd;
            });

            if (windowRows.length === 0) {
                positionResults.push({
                    positionId: pos.id,
                    ticker: pos.ticker,
                    type: pos.type,
                    entryPrice: entry.price,
                    classification: 'insufficient_data',
                    note: 'No greeks_history in first 5 days window',
                });
                continue;
            }

            // Use |delta| as a proxy for option price level (higher |delta| = more ITM = higher price for long options)
            // For credit strategies, lower |delta| of short leg is better (farther OTM).
            // As a simple heuristic: we treat abs(delta) range as proxy for price range.
            const deltas = windowRows.map(r => Math.abs(r.delta || 0)).filter(d => d > 0);
            if (deltas.length === 0) {
                positionResults.push({
                    positionId: pos.id,
                    ticker: pos.ticker,
                    type: pos.type,
                    entryPrice: entry.price,
                    classification: 'insufficient_data',
                    note: 'All deltas are zero in window',
                });
                continue;
            }

            // For debit (long) options: higher delta = more valuable, so best = max delta
            // For credit options: lower |delta| on short leg = farther OTM = better entry
            const isCredit = pos.type?.toLowerCase().includes('credit') || pos.type?.toLowerCase().includes('short');
            const bestDelta = isCredit ? Math.min(...deltas) : Math.max(...deltas);
            const worstDelta = isCredit ? Math.max(...deltas) : Math.min(...deltas);

            // Entry delta from first window row
            const entryRow = windowRows[0];
            const entryDelta = Math.abs(entryRow.delta || 0);

            const range = Math.abs(bestDelta - worstDelta);
            if (range < 0.001) {
                // Negligible movement — classify as at-market
                positionResults.push({
                    positionId: pos.id,
                    ticker: pos.ticker,
                    type: pos.type,
                    entryPrice: entry.price,
                    entryDelta,
                    bestDelta,
                    worstDelta,
                    classification: 'at-market',
                    note: 'Negligible price range in first 5 days',
                });
                atMarketCount++;
                classifiableCount++;
                continue;
            }

            const distFromBest = Math.abs(entryDelta - bestDelta) / range;
            const distFromWorst = Math.abs(entryDelta - worstDelta) / range;

            let classification;
            if (distFromBest <= EARLY_THRESHOLD) {
                classification = 'early';
                earlyCount++;
            } else if (distFromWorst <= LATE_THRESHOLD) {
                classification = 'late';
                lateCount++;
            } else {
                classification = 'at-market';
                atMarketCount++;
            }
            classifiableCount++;

            positionResults.push({
                positionId: pos.id,
                ticker: pos.ticker,
                type: pos.type,
                entryPrice: entry.price,
                entryDelta: Math.round(entryDelta * 1000) / 1000,
                bestDelta: Math.round(bestDelta * 1000) / 1000,
                worstDelta: Math.round(worstDelta * 1000) / 1000,
                distFromBest: Math.round(distFromBest * 1000) / 1000,
                classification,
            });
        }

        const summary = {
            total: positions.length,
            classifiable: classifiableCount,
            earlyCount,
            lateCount,
            atMarketCount,
            earlyPct: classifiableCount > 0 ? Math.round((earlyCount / classifiableCount) * 1000) / 10 : null,
            latePct: classifiableCount > 0 ? Math.round((lateCount / classifiableCount) * 1000) / 10 : null,
            atMarketPct: classifiableCount > 0 ? Math.round((atMarketCount / classifiableCount) * 1000) / 10 : null,
        };

        return res.status(200).json({
            success: true,
            summary,
            positions: positionResults,
        });

    } catch (err) {
        console.error('[Execution Quality] Error:', err.message);
        return res.status(500).json({ error: 'Internal Server Error', message: err.message });
    }
}
