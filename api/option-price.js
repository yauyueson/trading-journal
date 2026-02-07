// api/option-price.js
// 使用 CBOE 免费延迟数据 API (15分钟延迟)
// 包含 OSS v2.2.1 Scoring Engine

const BASELINES = {
  long: {
    lambda: { mean: 8, std: 4 },
    gammaEff: { mean: 0.02, std: 0.015 },
    thetaBurn: { mean: 0.03, std: 0.02 }
  }
};

const getDeltaBonus = (delta) => {
  const absDelta = Math.abs(delta);
  const lerp = (x, x1, x2, y1, y2) => y1 + (y2 - y1) * ((x - x1) / (x2 - x1));
  if (absDelta < 0.15) return -2.0;
  if (absDelta < 0.30) return lerp(absDelta, 0.15, 0.30, -2.0, -0.5);
  if (absDelta < 0.50) return lerp(absDelta, 0.30, 0.50, -0.5, 1.0);
  if (absDelta < 0.70) return lerp(absDelta, 0.50, 0.70, 1.0, 0.5);
  if (absDelta <= 1.0) return lerp(absDelta, 0.70, 1.0, 0.5, 0);
  return 0;
};

const getThetaPenalty = (thetaBurn) => {
  const SAFE_ZONE = 0.005;
  if (thetaBurn <= SAFE_ZONE) return 0;
  const excess = thetaBurn - SAFE_ZONE;
  return Math.min(Math.pow(excess * 100, 2) * 0.5, 10);
};

const compressLambda = (lambda) => {
  const threshold = 20;
  const decayRate = 0.1;
  if (lambda <= threshold) return lambda;
  return threshold + (lambda - threshold) * decayRate;
};

const getCleanATM_IV = (chain, currentPrice) => {
  if (!chain || chain.length === 0) return null;
  const strikes = {};
  chain.forEach(opt => {
    if (!strikes[opt.strike]) strikes[opt.strike] = {};
    strikes[opt.strike][opt.type] = opt;
  });
  let bestStrike = null;
  let minDiff = Infinity;
  Object.keys(strikes).forEach(strikeStr => {
    const strike = parseFloat(strikeStr);
    if (strikes[strike].Call && strikes[strike].Put) {
      const diff = Math.abs(strike - currentPrice);
      if (diff < minDiff) { minDiff = diff; bestStrike = strike; }
    }
  });
  if (bestStrike === null) return null;
  const atmCall = strikes[bestStrike].Call;
  const atmPut = strikes[bestStrike].Put;
  if (!atmCall.iv || !atmPut.iv) return null;
  return (atmCall.iv + atmPut.iv) / 2;
};

const calculateTargetIV = (allOptions, targetDTE, currentPrice) => {
  const dtes = [...new Set(allOptions.map(o => o.dte))].sort((a, b) => a - b);
  if (dtes.length === 0) return null;
  if (dtes.includes(targetDTE)) {
    const chain = allOptions.filter(o => o.dte === targetDTE);
    return getCleanATM_IV(chain, currentPrice);
  }
  let nearDTE = null; let farDTE = null;
  for (const dte of dtes) {
    if (dte < targetDTE) nearDTE = dte;
    if (dte > targetDTE) { farDTE = dte; break; }
  }
  if (nearDTE === null || farDTE === null) return null;
  const ivNear = getCleanATM_IV(allOptions.filter(o => o.dte === nearDTE), currentPrice);
  const ivFar = getCleanATM_IV(allOptions.filter(o => o.dte === farDTE), currentPrice);
  if (ivNear === null || ivFar === null) return null;
  return ivNear + (ivFar - ivNear) * ((targetDTE - nearDTE) / (farDTE - nearDTE));
};

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

    const loweredType = type.toLowerCase();
    const typeCode = (loweredType.includes('call') || loweredType === 'c') ? 'C' : 'P';
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
      // Need to re-derive typeCode here as it's not in scope
      const loweredType = type.toLowerCase();
      const typeChar = (loweredType.includes('call') || loweredType === 'c') ? 'C' : 'P';
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

    // Calculate IV Ratio
    const processedChain = options.map(opt => {
      const symbol = opt.option || '';
      const dateMatch = symbol.match(/(\d{6})[CP]/);
      let dte = 30;
      if (dateMatch) {
        const dateStr = dateMatch[1];
        const yy = parseInt(dateStr.slice(0, 2));
        const mm = parseInt(dateStr.slice(2, 4));
        const dd = parseInt(dateStr.slice(4, 6));
        const expDate = new Date(2000 + yy, mm - 1, dd);
        dte = Math.ceil((expDate.getTime() - Date.now()) / 86400000);
      }
      return { strike: opt.strike, type: symbol.includes('C') ? 'Call' : 'Put', iv: opt.iv, dte };
    });

    const iv30 = calculateTargetIV(processedChain, 30, data.data.current_price);
    const iv90 = calculateTargetIV(processedChain, 90, data.data.current_price);
    const ivRatio = (iv30 && iv90) ? iv30 / iv90 : 1.0;

    return formatResponse(res, targetOption, occSymbol, data.data.current_price, data.timestamp, ivRatio);
  } catch (error) {
    console.error('🚨 API Error:', error.message);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: error.message
    });
  }
}

function calculateScore(option, underlyingPrice, ivRatio) {
  const mid = (option.bid + option.ask) / 2 || option.last_trade_price;
  if (!mid || mid <= 0) return 0;

  const lambda = Math.abs(option.delta) * (underlyingPrice / mid);
  const gammaEff = option.gamma / mid;
  const thetaBurn = Math.abs(option.theta) / mid;

  const zL = (compressLambda(lambda) - BASELINES.long.lambda.mean) / BASELINES.long.lambda.std;
  const zG = (gammaEff - BASELINES.long.gammaEff.mean) / BASELINES.long.gammaEff.std;
  const zT = (thetaBurn - BASELINES.long.thetaBurn.mean) / BASELINES.long.thetaBurn.std;

  const deltaBonus = getDeltaBonus(option.delta);
  const thetaPenalty = getThetaPenalty(thetaBurn);
  const ivAdj = (1 - (1 / (1 + Math.exp(-12 * (ivRatio - 1.10)))) * 0.4 - 0.9) * 5; // Simplified long adj

  const raw = 0.40 * zL + 0.30 * zG - 0.15 * zT + 0.15 * deltaBonus + ivAdj - thetaPenalty;
  return Math.max(0, Math.min(100, Math.round(50 + raw * 12.5)));
}

function formatResponse(res, option, occSymbol, underlyingPrice, cboeTimestamp, ivRatio) {
  let price = option.last_trade_price;
  let source = 'last';

  if (option.bid > 0 && option.ask > 0) {
    price = (option.bid + option.ask) / 2;
    source = 'mid';
  }

  const score = calculateScore(option, underlyingPrice, ivRatio);

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
    score: score,
    ivRatio: ivRatio,
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
