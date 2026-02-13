// api/option-price.js
// 使用 CBOE 免费延迟数据 API (15分钟延迟)

// ---------------------------------------------------------
// 🛠️ 辅助：生成 OCC 代码
// ---------------------------------------------------------
import { generateOCCSymbol } from './_shared/utils.js';

// ---------------------------------------------------------
// 🛠️ 辅助：生成 OCC 代码
// ---------------------------------------------------------
// REFACTORED: Now using shared utility


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
  const dataSource = process.env.DATA_SOURCE || 'CBOE';

  // Try MarketData first if configured
  if (dataSource === 'MARKET_DATA') {
    try {
      const { getOptionChain } = await import('./market-data-client.js');

      // Fetch specific expiration chain
      const chainData = await getOptionChain(upperTicker, { expiration });

      if (chainData && chainData.length > 0) {
        // Find exact match
        const targetStrike = parseFloat(strike);
        const targetType = type.toLowerCase().includes('call') ? 'Call' : 'Put';

        const match = chainData.find(opt =>
          Math.abs(opt.strike - targetStrike) < 0.01 &&
          opt.type === targetType
        );

        if (match) {
          const price = (match.bid > 0 && match.ask > 0)
            ? (match.bid + match.ask) / 2
            : match.last || 0;

          return res.status(200).json({
            success: true,
            symbol: match.symbol,
            price: parseFloat(price.toFixed(2)),
            priceSource: (match.bid > 0 && match.ask > 0) ? 'mid' : 'last',
            bid: match.bid || null,
            ask: match.ask || null,
            lastPrice: match.last || null,
            iv: match.iv || null,
            delta: match.delta || null,
            gamma: match.gamma || null,
            theta: match.theta || null,
            vega: match.vega || null,
            rho: null, // MarketData doesn't provide rho
            volume: match.volume || null,
            openInterest: match.openInterest || null,
            underlyingPrice: match.underlyingPrice || null,
            dataSource: 'MarketData.app',
            timestamp: Date.now(),
            rawGreeks: {
              delta: match.delta,
              gamma: match.gamma,
              theta: match.theta,
              vega: match.vega,
              iv: match.iv
            }
          });
        }
      }

      console.log(`MarketData: No match found for ${upperTicker} ${strike}${type}, falling back to CBOE`);
    } catch (err) {
      console.error('MarketData fetch failed:', err.message);
      // Fall through to CBOE
    }
  }

  // CBOE fallback (original logic)
  const occSymbol = generateOCCSymbol(upperTicker, expiration, type, strike);
  const cboeSymbol = occSymbol.replace(/\s/g, '');

  console.log(`🔍 Looking for: ${cboeSymbol}`);

  try {
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
      // 尝试模糊匹配：必须严格匹配 Call(C) 或 Put(P)，避免把 PUT 当成 CALL 返回
      const expDateStr = expiration.replace(/-/g, '').slice(2); // "260320"
      const typeCode = (type.toLowerCase().includes('call') || type.toLowerCase() === 'c') ? 'C' : 'P';
      const strikeStr = Math.round(parseFloat(strike) * 1000).toString().padStart(8, '0');
      // OCC: 6 char symbol + 6 char YYMMDD + 1 char C/P + 8 char strike → type 在 index 12
      const fuzzyMatch = options.find(opt => {
        if (!opt.option) return false;
        const sym = opt.option.replace(/\s/g, '');
        const typeAt12 = sym.charAt(12);
        return sym.includes(expDateStr) && typeAt12 === typeCode && sym.endsWith(strikeStr);
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
