// api/underlying-rv.js
// Proxies to shared market-data utility to get RV metrics
const { fetchVolatilityMetrics } = require('./_shared/market-data.js');

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const { ticker } = req.query;

    if (!ticker) {
        return res.status(400).json({ error: 'Missing ticker parameter' });
    }

    const upperTicker = ticker.toUpperCase();

    try {
        const metrics = await fetchVolatilityMetrics(upperTicker);

        if (!metrics) {
            return res.status(200).json({
                success: true,
                ticker: upperTicker,
                rv30: null,
                error: 'Not enough historical data'
            });
        }

        return res.status(200).json({
            success: true,
            ticker: upperTicker,
            rv30: metrics.rv30,
            rvRank: metrics.rvRank,
            rvPercentile: metrics.rvPercentile,
            minRV: metrics.minRV,
            maxRV: metrics.maxRV,
            daysProcessed: metrics.historyCount,
            lastClose: metrics.currentPrice
        });

    } catch (error) {
        console.error('🚨 RV API Error:', error.message);
        return res.status(200).json({
            success: false,
            ticker: upperTicker,
            error: error.message
        });
    }
}
