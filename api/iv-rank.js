// GET /api/iv-rank?ticker=QQQ
// Returns IV Rank and IV Percentile for a ticker (from ticker_iv_snapshots).
// Requires Supabase table ticker_iv_snapshots. See docs/04_数据库设计.md.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { getIVRank } = require('../lib/_shared/ivHistory.cjs');

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { ticker } = req.query;
    if (!ticker) {
        return res.status(400).json({ error: 'Missing ticker parameter' });
    }

    try {
        const result = await getIVRank((ticker || '').toUpperCase());
        return res.status(200).json({
            success: true,
            ticker: (ticker || '').toUpperCase(),
            ivRank: result.ivRank,
            ivPercentile: result.ivPercentile,
            currentIv30: result.currentIv30 != null ? Number((result.currentIv30 * 100).toFixed(2)) : null,
            minIv: result.minIv != null ? Number((result.minIv * 100).toFixed(2)) : null,
            maxIv: result.maxIv != null ? Number((result.maxIv * 100).toFixed(2)) : null,
            sampleDays: result.sampleDays,
        });
    } catch (e) {
        console.error('IV Rank API Error:', e.message);
        return res.status(500).json({ error: 'Internal Server Error', message: e.message });
    }
}
