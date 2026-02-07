// api/underlying-rv.js
// 获取底层资产的 20 日历史年化波动率 (Realized Volatility)

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
        // 获取过去 45 天的数据，以确保有足够的交易日 (20+ 个)
        const toDate = new Date();
        const fromDate = new Date();
        fromDate.setDate(toDate.getDate() - 45);

        const toStr = toDate.toISOString().split('T')[0];
        const fromStr = fromDate.toISOString().split('T')[0];

        // Nasdaq Historical API
        const url = `https://api.nasdaq.com/api/quote/${upperTicker}/historical?assetclass=stocks&fromdate=${fromStr}&todate=${toStr}&limit=40`;

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });

        if (!response.ok) {
            throw new Error(`Nasdaq API failed with status ${response.status}`);
        }

        const data = await response.json();
        const rows = data?.data?.tradesTable?.rows || [];

        if (rows.length < 2) {
            return res.status(200).json({
                success: true,
                ticker: upperTicker,
                rv20: null,
                error: 'Not enough historical data'
            });
        }

        // 提取收盘价 (Nasdaq 返回的是字符串 like "$123.45")
        const prices = rows
            .map(row => parseFloat(row.close.replace('$', '').replace(',', '')))
            .filter(price => !isNaN(price))
            .reverse(); // 从旧到新

        if (prices.length < 5) {
            return res.status(200).json({
                success: true,
                ticker: upperTicker,
                rv20: null,
                error: 'Too few valid prices'
            });
        }

        // 计算每日对数收益率
        // r_i = ln(P_i / P_{i-1})
        const returns = [];
        for (let i = 1; i < prices.length; i++) {
            returns.push(Math.log(prices[i] / prices[i - 1]));
        }

        // 取最近 20 个收益率 (RV20)
        const recentReturns = returns.slice(-20);

        // 计算标准差
        const mean = recentReturns.reduce((a, b) => a + b, 0) / recentReturns.length;
        const variance = recentReturns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (recentReturns.length - 1);
        const stdDev = Math.sqrt(variance);

        // 年化 RV (Standard Deviation * sqrt(252))
        const annualizedRV = stdDev * Math.sqrt(252) * 100;

        return res.status(200).json({
            success: true,
            ticker: upperTicker,
            rv20: Number(annualizedRV.toFixed(2)),
            daysProcessed: recentReturns.length,
            lastClose: prices[prices.length - 1]
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
