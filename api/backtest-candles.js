// api/backtest-candles.js
// Fetch extended candle history for backtesting.
// Supports daily and 4H timeframes.

import { getCandles } from '../lib/polygon-client.js';

export default async function handler(req, res) {
  try {
    const { ticker, from, to, timeframe } = req.query;

    if (!ticker) {
      return res.status(400).json({ error: 'Missing ticker parameter' });
    }

    const endDate = to || new Date().toISOString().split('T')[0];
    const startDate = from || (() => {
      const d = new Date();
      d.setFullYear(d.getFullYear() - 2);
      d.setMonth(d.getMonth() - 6);
      return d.toISOString().split('T')[0];
    })();

    // 4H = 4-hour bars, 1D = daily bars
    const timespan = timeframe === '4H' ? 'hour' : 'day';
    const multiplier = timeframe === '4H' ? 4 : 1;

    const candles = await getCandles(ticker.toUpperCase(), startDate, endDate, timespan, multiplier);

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
    return res.status(200).json({
      success: true,
      ticker: ticker.toUpperCase(),
      from: startDate,
      to: endDate,
      timeframe: timeframe || '1D',
      count: candles.length,
      candles,
    });
  } catch (err) {
    console.error('[backtest-candles]', err);
    return res.status(500).json({ error: err.message || 'Failed to fetch candles' });
  }
}
