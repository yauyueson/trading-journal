// api/backtest-candles.js
// Fetch extended daily candle history for backtesting.
// Returns 2+ years of OHLCV data from Polygon.

import { getCandles } from '../lib/polygon-client.js';

export default async function handler(req, res) {
  try {
    const { ticker, from, to } = req.query;

    if (!ticker) {
      return res.status(400).json({ error: 'Missing ticker parameter' });
    }

    // Default: 2.5 years of history (need ~320 bars lookback + trading period)
    const endDate = to || new Date().toISOString().split('T')[0];
    const startDate = from || (() => {
      const d = new Date();
      d.setFullYear(d.getFullYear() - 2);
      d.setMonth(d.getMonth() - 6);
      return d.toISOString().split('T')[0];
    })();

    const candles = await getCandles(ticker.toUpperCase(), startDate, endDate, 'day');

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
    return res.status(200).json({
      success: true,
      ticker: ticker.toUpperCase(),
      from: startDate,
      to: endDate,
      count: candles.length,
      candles,
    });
  } catch (err) {
    console.error('[backtest-candles]', err);
    return res.status(500).json({ error: err.message || 'Failed to fetch candles' });
  }
}
