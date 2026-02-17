
import { createClient } from '@supabase/supabase-js';
import { calculateTechScore } from '../lib/tech-analysis.js';
import { getCandles } from '../lib/polygon-client.js';
import { getAppSettings } from './_shared/getAppSettings.js';

// Initialize Supabase Client
// function getSupabase() {
//     const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
//     const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
//     if (!url || !key) throw new Error("Missing Supabase credentials");
//     return createClient(url, key);
// }

export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST' && req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { scope = 'active', limit = 50 } = req.body || req.query || {};
    // scope: 'active' (open positions), 'watchlist', 'all'

    try {
        const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

        if (!url || !key) {
            return res.status(500).json({ error: 'Server configuration error: Missing DB credentials' });
        }

        const supabase = createClient(url, key);
        const appSettings = await getAppSettings(supabase);
        const techScoreOptions = {
            ...appSettings.techScore.weights,
            ...appSettings.techScore.periods,
        };

        let positions = [];

        if (scope === 'active' || scope === 'all') {
            // Fetch Open Positions
            // Assuming 'positions' table has 'status' column.
            // Or trigger for all rows if status not closed?
            // Need to check schema for status. Assuming 'isOpen' or 'status'.
            // Based on generic schema, usually 'status' = 'OPEN'.
            // Let's check what I know. 'positions' table exists.
            // I'll assume 'status' column exists or I fetch all.
            // Better to fetch 'symbol' from distinct positions?
            // Wait, PositionCard displays *positions*.
            // I should update rows in `positions` table.

            const { data, error } = await supabase
                .from('positions')
                .select('id, ticker, status, tech_score_source, tech_score_updated_at')
                .eq('status', 'active'); // Only active positions (same as Portfolio page)

            if (error) throw error;
            if (data) positions = data;
        }

        if (positions.length === 0) {
            return res.status(200).json({ message: 'No positions to update.', processed: 0 });
        }

        console.log(`Processing ${positions.length} positions for Tech Score...`);

        const results = [];
        const errors = [];

        // Group by ticker to avoid duplicate API calls if user has multiple positions on same ticker
        const tickerMap = new Map(); // ticker -> [positionIds...]
        positions.forEach(p => {
            const t = p.ticker ? p.ticker.toUpperCase() : null;
            if (t) {
                if (!tickerMap.has(t)) tickerMap.set(t, []);
                tickerMap.get(t).push(p);
            }
        });

        const uniqueTickers = Array.from(tickerMap.keys()).slice(0, Number(limit));
        const forceUpdate = (req.body && req.body.force === true) || (req.query && req.query.force === 'true');
        const delayMs = Number(process.env.BATCH_REFRESH_DELAY_MS || 0);

        let firstInLoop = true;
        for (const ticker of uniqueTickers) {
            try {
                if (!firstInLoop && delayMs > 0) {
                    await new Promise(r => setTimeout(r, delayMs));
                }
                firstInLoop = false;
                const positionList = tickerMap.get(ticker);

                // Staleness Check: If NOT forced, check if already updated today (NY Time)
                if (!forceUpdate) {
                    const lastUpdate = positionList[0].tech_score_updated_at; // Check first one
                    if (lastUpdate) {
                        const timeZone = 'America/New_York';
                        const nowNY = new Date().toLocaleDateString('en-US', { timeZone });
                        const lastUpdateNY = new Date(lastUpdate).toLocaleDateString('en-US', { timeZone });

                        // If updated today (NY Time), skip
                        if (nowNY === lastUpdateNY) {
                            continue;
                        }
                    }
                }

                // Fetch Candles
                const toDate = new Date().toISOString().split('T')[0];
                const fromDateObj = new Date();
                fromDateObj.setDate(fromDateObj.getDate() - 600); // ~1.5 years to be safe for 400 candles
                const fromDate = fromDateObj.toISOString().split('T')[0];

                const candles = await getCandles(ticker, fromDate, toDate, 'day');

                if (!candles || candles.length < 50) {
                    errors.push({ ticker, error: 'Insufficient candle data' });
                    continue; // Skip update
                }

                const lastCandle = candles[candles.length - 1];
                const lastPrice = lastCandle.close;

                // Calculate Score
                const scoreResult = calculateTechScore(candles, techScoreOptions);

                // Prepare Update
                // We update ALL positions with this ticker
                // const positionList = tickerMap.get(ticker); // Already declared above

                for (const pos of positionList) {
                    const updates = {
                        tech_score_auto: scoreResult.techScore,
                        tech_score_updated_at: new Date().toISOString()
                    };
                    // Only include columns that exist in your schema; omit tech_last_price/tech_data if not migrated

                    // Logic: If Manual Override is NOT set, update the main tech_score
                    if (pos.tech_score_source !== 'manual') {
                        updates.tech_score = scoreResult.techScore;
                        updates.tech_score_source = 'auto';
                    }

                    if (req.body && req.body.dryRun) {
                        results.push({ id: pos.id, ticker, updates, dryRun: true });
                        continue;
                    }

                    const { error: updateError } = await supabase
                        .from('positions')
                        .update(updates)
                        .eq('id', pos.id);

                    if (updateError) {
                        console.error(`Failed update for pos ${pos.id}:`, updateError);
                        errors.push({ id: pos.id, ticker, error: updateError.message });
                    } else {
                        results.push({ id: pos.id, ticker, score: scoreResult.techScore });
                    }
                }

            } catch (err) {
                console.error(`Error processing ${ticker}:`, err);
                errors.push({ ticker, error: err.message });
            }
        }

        return res.status(200).json({
            message: 'Batch Tech Score Refresh Completed',
            processed: results.length,
            errors: errors.length,
            details: results,
            errorList: errors
        });

    } catch (e) {
        console.error("Batch API Error:", e);
        return res.status(500).json({ error: e.message });
    }
}
