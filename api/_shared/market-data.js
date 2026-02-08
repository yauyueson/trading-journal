
// api/_shared/market-data.js
// Shared market data utilities (Nasdaq, CBOE, etc.)

/**
 * Fetches historical price data from Nasdaq and calculates Realized Volatility (RV) metrics.
 * Returns: { rv30, rvRank, rvPercentile, currentPrice, priceHistory }
 */
async function fetchVolatilityMetrics(ticker) {
    try {
        // Fetch 400 days to ensure full year of data + buffer for rolling window
        const toDate = new Date();
        const fromDate = new Date();
        fromDate.setDate(toDate.getDate() - 400);

        const toStr = toDate.toISOString().split('T')[0];
        const fromStr = fromDate.toISOString().split('T')[0];

        const url = `https://api.nasdaq.com/api/quote/${ticker.toUpperCase()}/historical?assetclass=stocks&fromdate=${fromStr}&todate=${toStr}&limit=400`;

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        if (!response.ok) return null;

        const data = await response.json();
        const rows = data?.data?.tradesTable?.rows || [];

        if (rows.length < 30) return null; // Need at least 30 days for one RV point

        // Parse prices (Newest first)
        const prices = rows
            .map(row => parseFloat(row.close.replace('$', '').replace(',', '')))
            .filter(price => !isNaN(price));

        // Reverse to Oldest -> Newest for calculation
        const pricesAsc = [...prices].reverse();

        // Calculate Daily Log Returns
        const returns = [];
        for (let i = 1; i < pricesAsc.length; i++) {
            returns.push(Math.log(pricesAsc[i] / pricesAsc[i - 1]));
        }

        // Calculate Rolling 30-day Annualized Volatility
        const windowSize = 30;
        const rvHistory = [];

        for (let i = windowSize; i <= returns.length; i++) {
            const windowReturns = returns.slice(i - windowSize, i);

            // Population Standard Deviation
            const mean = windowReturns.reduce((a, b) => a + b, 0) / windowReturns.length;
            const variance = windowReturns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / windowReturns.length;
            const stdDev = Math.sqrt(variance);
            const annualizedRV = stdDev * Math.sqrt(252) * 100; // Annualized %

            rvHistory.push(annualizedRV);
        }

        if (rvHistory.length === 0) return null;

        const currentRV = rvHistory[rvHistory.length - 1];

        // 52-Week High/Low (using available history, up to ~1 year)
        // We might have less than 252 points if market holidays or short history, but that's fine.
        let minRV = Infinity;
        let maxRV = -Infinity;
        let countLow = 0;

        for (const rv of rvHistory) {
            if (rv < minRV) minRV = rv;
            if (rv > maxRV) maxRV = rv;
            if (rv < currentRV) countLow++;
        }

        const rvRank = maxRV > minRV ? ((currentRV - minRV) / (maxRV - minRV)) * 100 : 50;
        const rvPercentile = (countLow / rvHistory.length) * 100;

        return {
            rv30: Number(currentRV.toFixed(2)),
            rvRank: Number(rvRank.toFixed(1)),
            rvPercentile: Number(rvPercentile.toFixed(1)),
            minRV: Number(minRV.toFixed(2)),
            maxRV: Number(maxRV.toFixed(2)),
            historyCount: rvHistory.length,
            currentPrice: pricesAsc[pricesAsc.length - 1]
        };

    } catch (e) {
        console.error("Metric Fetch Error:", e);
        return null;
    }
}

/**
 * Fetches Earnings Date Days Remaining
 */
async function fetchEarningsDate(ticker) {
    try {
        const url = `https://api.nasdaq.com/api/quote/${ticker.toUpperCase()}/info?assetclass=stocks`;
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        if (!response.ok) return null;
        const data = await response.json();
        const notifications = data?.data?.notifications || [];

        for (const notif of notifications) {
            const eventTypes = notif?.eventTypes || [];
            for (const event of eventTypes) {
                if (event.eventName === 'Earnings Date' || event.id === 'upcoming_events') {
                    const message = event.message || '';
                    const match = message.match(/Earnings Date\s*:\s*(.+)/i);
                    if (match) {
                        const dateStr = match[1].trim();
                        const parsedDate = new Date(dateStr);
                        if (!isNaN(parsedDate.getTime())) {
                            const today = new Date();
                            today.setHours(0, 0, 0, 0);
                            return Math.ceil((parsedDate - today) / (1000 * 60 * 60 * 24));
                        }
                    }
                }
            }
        }
        return null;
    } catch (e) {
        return null;
    }
}

module.exports = {
    fetchVolatilityMetrics,
    fetchEarningsDate
};
