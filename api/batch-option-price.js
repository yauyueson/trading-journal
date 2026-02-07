// api/batch-option-price.js
// Batch CBOE Data Fetcher - Solves N+1 Problem

function generateOCCSymbol(symbol, expiration, type, strike) {
    try {
        const paddedSymbol = symbol.toUpperCase().padEnd(6, ' ');
        const parts = expiration.split('-');
        if (parts.length !== 3) throw new Error('Invalid date format');

        const yy = parts[0].slice(2);
        const mm = parts[1].padStart(2, '0');
        const dd = parts[2].padStart(2, '0');
        const dateStr = `${yy}${mm}${dd}`;

        const loweredType = type.toLowerCase();
        const typeCode = (loweredType.includes('call') || loweredType === 'c') ? 'C' : 'P';
        const strikeNum = Math.round(parseFloat(strike) * 1000);
        const strikeStr = strikeNum.toString().padStart(8, '0');

        return `${paddedSymbol}${dateStr}${typeCode}${strikeStr}`;
    } catch (e) {
        return null;
    }
}

function formatOptionData(option, underlyingPrice, cboeTimestamp) {
    let price = option.last_trade_price;
    let source = 'last';

    if (option.bid > 0 && option.ask > 0) {
        price = (option.bid + option.ask) / 2;
        source = 'mid';
    }

    return {
        price: parseFloat(price?.toFixed(2) || 0),
        priceSource: source,
        bid: option.bid || null,
        ask: option.ask || null,
        iv: option.iv || null,
        delta: option.delta || null,
        gamma: option.gamma || null,
        theta: option.theta || null,
        vega: option.vega || null,
        underlyingPrice: underlyingPrice || null,
        cboeTimestamp: cboeTimestamp || null,
        isDayTrade: false, // Default
        ivRatio: 1.0 // Default
    };
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { items } = req.body; // Expecting [{ id, ticker, strike, type, expiration }]

    if (!items || !Array.isArray(items)) {
        return res.status(400).json({ error: 'Invalid body, expected items array' });
    }

    // Group by ticker
    const grouped = {};
    items.forEach(item => {
        const ticker = item.ticker.toUpperCase();
        if (!grouped[ticker]) grouped[ticker] = [];
        grouped[ticker].push(item);
    });

    const results = {};

    // Process each ticker in parallel
    await Promise.all(Object.keys(grouped).map(async (ticker) => {
        try {
            const cboeUrl = `https://cdn.cboe.com/api/global/delayed_quotes/options/${ticker}.json`;
            const response = await fetch(cboeUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
            });

            if (!response.ok) {
                // Mark all items for this ticker as error
                grouped[ticker].forEach(item => {
                    results[item.id] = { error: `CBOE Error ${response.status}` };
                });
                return;
            }

            const data = await response.json();
            if (!data.data || !data.data.options) {
                grouped[ticker].forEach(item => {
                    results[item.id] = { error: 'No data found' };
                });
                return;
            }

            const options = data.data.options;
            const currentPrice = data.data.current_price;
            const timestamp = data.timestamp;

            // Match items
            grouped[ticker].forEach(item => {
                const occSymbol = generateOCCSymbol(ticker, item.expiration, item.type, item.strike);
                const cboeSymbol = occSymbol.replace(/\s/g, '');

                let targetOption = options.find(opt => opt.option === cboeSymbol);

                // Fuzzy match fallack
                if (!targetOption) {
                    const expDateStr = item.expiration.replace(/-/g, '').slice(2);
                    const typeChar = item.type.toLowerCase().includes('call') ? 'C' : 'P';
                    const strikeStr = (parseFloat(item.strike) * 1000).toString().padStart(8, '0');

                    targetOption = options.find(opt =>
                        opt.option &&
                        opt.option.includes(expDateStr) &&
                        opt.option.includes(typeChar) &&
                        opt.option.endsWith(strikeStr)
                    );
                }

                if (targetOption) {
                    results[item.id] = formatOptionData(targetOption, currentPrice, timestamp);
                } else {
                    results[item.id] = { error: 'Not found' };
                }
            });

        } catch (error) {
            grouped[ticker].forEach(item => {
                results[item.id] = { error: error.message };
            });
        }
    }));

    return res.status(200).json({ results });
}
