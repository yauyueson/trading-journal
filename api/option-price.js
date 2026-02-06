// api/option-price.js
// 使用 CBOE 免费延迟数据 API (15分钟延迟)

// ---------------------------------------------------------
// 🛠️ 辅助：生成 OCC 代码
// ---------------------------------------------------------
function generateOCCSymbol(symbol, expiration, type, strike) {
  try {
    const paddedSymbol = symbol.toUpperCase().padEnd(6, ' ');
    const parts = expiration.split('-');
    if (parts.length !== 3) throw new Error('Invalid date format');

    const yy = parts[0].slice(2);
    const mm = parts[1].padStart(2, '0');
    const dd = parts[2].padStart(2, '0');
    const dateStr = `${yy}${mm}${dd}`;

    const typeCode = type.toLowerCase().startsWith('c') ? 'C' : 'P';
    const strikeNum = Math.round(parseFloat(strike) * 1000);
    const strikeStr = strikeNum.toString().padStart(8, '0');

    return `${paddedSymbol}${dateStr}${typeCode}${strikeStr}`;
  } catch (e) {
    console.error("OCC Generation Error:", e);
    return null;
  }
}

// ---------------------------------------------------------
// 🚀 Main Handler
// ---------------------------------------------------------
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { ticker, expiration, strike, type } = req.query;

  if (!ticker || !expiration || !strike || !type) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  const upperTicker = ticker.toUpperCase();
  const occSymbol = generateOCCSymbol(upperTicker, expiration, type, strike);

  // CBOE 格式的 symbol (无空格)
  const cboeSymbol = occSymbol.replace(/\s/g, '');

  console.log(`🔍 Looking for: ${cboeSymbol}`);

  try {
    // 使用 CBOE 免费 API
    const cboeUrl = `https://cdn.cboe.com/api/global/delayed_quotes/options/${upperTicker}.json`;

    const response = await fetch(cboeUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!response.ok) {
      console.log(`❌ CBOE API error: ${response.status}`);
      return res.status(response.status).json({
        error: 'CBOE API error',
        status: response.status
      });
    }

    const data = await response.json();

    if (!data.data || !data.data.options) {
      return res.status(404).json({ error: 'No options data found' });
    }

    // 在期权链中查找匹配的合约
    const options = data.data.options;
    const targetOption = options.find(opt => opt.option === cboeSymbol);

    if (!targetOption) {
      // 尝试模糊匹配
      const expDateStr = expiration.replace(/-/g, '').slice(2); // "260220"
      const typeChar = type.toUpperCase().charAt(0);
      const strikeStr = (parseFloat(strike) * 1000).toString().padStart(8, '0');

      const fuzzyMatch = options.find(opt => {
        return opt.option &&
          opt.option.includes(expDateStr) &&
          opt.option.includes(typeChar) &&
          opt.option.endsWith(strikeStr);
      });

      if (!fuzzyMatch) {
        console.log(`❌ Option not found: ${cboeSymbol}`);
        return res.status(404).json({
          error: 'Option contract not found',
          symbol: cboeSymbol,
          ticker: upperTicker
        });
      }

      return formatResponse(res, fuzzyMatch, occSymbol, data.data.current_price, data.timestamp);
    }

    return formatResponse(res, targetOption, occSymbol, data.data.current_price, data.timestamp);

  } catch (error) {
    console.error('🚨 API Error:', error.message);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: error.message
    });
  }
}

function formatResponse(res, option, occSymbol, underlyingPrice, cboeTimestamp) {
  let price = option.last_trade_price;
  let source = 'last';

  if (option.bid > 0 && option.ask > 0) {
    price = (option.bid + option.ask) / 2;
    source = 'mid';
  }

  return res.status(200).json({
    success: true,
    symbol: occSymbol,
    price: parseFloat(price?.toFixed(2) || 0),
    priceSource: source,
    bid: option.bid || null,
    ask: option.ask || null,
    lastPrice: option.last_trade_price || null,
    iv: option.iv || null,
    delta: option.delta || null,
    gamma: option.gamma || null,
    theta: option.theta || null,
    vega: option.vega || null,
    rho: option.rho || null,
    volume: option.volume || null,
    openInterest: option.open_interest || null,
    underlyingPrice: underlyingPrice || null,
    dataSource: 'CBOE',
    timestamp: Date.now(),
    dataTimestamp: option.last_trade_time || null,
    cboeTimestamp: cboeTimestamp || null,
    // Debug: Show all available fields
    availableFields: Object.keys(option),
    rawGreeks: {
      delta: option.delta,
      gamma: option.gamma,
      theta: option.theta,
      vega: option.vega,
      rho: option.rho,
      iv: option.iv
    }
  });
}
