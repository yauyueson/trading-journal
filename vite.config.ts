import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// ---------------------------------------------------------
// Local API Plugin - handles /api routes in development
// ---------------------------------------------------------

// === Scoring Helper Functions ===

// 1. IV Sigmoid Phase Transition
const getIVRiskFactor = (ratio: number): number => {
  const k = 12;
  const x0 = 1.10;
  const raw = 1 / (1 + Math.exp(-k * (ratio - x0)));
  return 0.9 + raw * 0.4;
};

// 2. IV Adjustment
const getIVAdjustment = (ivRatio: number, strategy: string): number => {
  const riskFactor = getIVRiskFactor(ivRatio);
  if (strategy === 'long') {
    return (1 - riskFactor) * 5;
  } else {
    return (riskFactor - 1) * 5;
  }
};

// 3. Lambda Soft Compression
const compressLambda = (lambda: number): number => {
  const threshold = 20;
  const decayRate = 0.1;
  if (lambda <= threshold) return lambda;
  return threshold + (lambda - threshold) * decayRate;
};

// 4. Theta Pain Curve (Exponential Penalty)
const getThetaPenalty = (thetaBurn: number): number => {
  const SAFE_ZONE = 0.005;
  if (thetaBurn <= SAFE_ZONE) return 0;
  const excess = thetaBurn - SAFE_ZONE;
  return Math.min(Math.pow(excess * 100, 2) * 0.5, 10); // Cap penalty at 10 (was 50) to prevent deep negative scores
};

// 5. Delta Bonus
const getDeltaBonus = (delta: number): number => {
  const absDelta = Math.abs(delta);
  const lerp = (x: number, x1: number, x2: number, y1: number, y2: number) =>
    y1 + (y2 - y1) * ((x - x1) / (x2 - x1));

  if (absDelta < 0.15) return -2.0;
  if (absDelta < 0.30) return lerp(absDelta, 0.15, 0.30, -2.0, -0.5);
  if (absDelta < 0.50) return lerp(absDelta, 0.30, 0.50, -0.5, 1.0);
  if (absDelta < 0.70) return lerp(absDelta, 0.50, 0.70, 1.0, 0.5);
  if (absDelta <= 1.0) return lerp(absDelta, 0.70, 1.0, 0.5, 0);
  return 0;
};

// 6. LOQ Raw Score Calculation
const calculateLOQRaw = (
  zLambda: number,
  zGammaEff: number,
  zThetaBurn: number,
  ivAdjustment: number,
  deltaBonus: number,
  thetaPenalty: number
): number => {
  return (
    0.40 * zLambda +
    0.30 * zGammaEff -
    0.15 * zThetaBurn +
    0.15 * deltaBonus +
    ivAdjustment -
    thetaPenalty
  );
};

// 7. Normalize Score
const normalizeScoreTo100 = (rawScore: number): number => {
  const scaled = 50 + rawScore * 12.5;
  return Math.max(1, Math.min(100, Math.round(scaled))); // Min 1 to distinguish from "No Data"
};

function localApiPlugin(): Plugin {

  return {
    name: 'local-api',
    configureServer(server) {
      // Handle /api/option-price
      server.middlewares.use('/api/option-price', async (req, res) => {
        const url = new URL(req.url || '', `http://${req.headers.host}`);
        const ticker = url.searchParams.get('ticker');
        const expiration = url.searchParams.get('expiration');
        const strike = url.searchParams.get('strike');
        const type = url.searchParams.get('type');

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');

        if (!ticker || !expiration || !strike || !type) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Missing parameters' }));
          return;
        }

        try {
          const upperTicker = ticker.toUpperCase();
          const cboeUrl = `https://cdn.cboe.com/api/global/delayed_quotes/options/${upperTicker}.json`;

          const response = await fetch(cboeUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Referer': 'https://www.cboe.com/',
              'Origin': 'https://www.cboe.com'
            }
          });

          if (!response.ok) {
            console.error(`❌ CBOE API Error [${upperTicker}]: ${response.status} ${response.statusText}`);
            res.statusCode = response.status;
            res.end(JSON.stringify({ error: 'CBOE API error', status: response.status }));
            return;
          }

          const data = await response.json();

          if (!data.data || !data.data.options) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'No options data found' }));
            return;
          }

          // Generate OCC symbol
          const paddedSymbol = upperTicker.padEnd(6, ' ');
          const parts = expiration.split('-');
          const yy = parts[0].slice(2);
          const mm = parts[1].padStart(2, '0');
          const dd = parts[2].padStart(2, '0');
          const dateStr = `${yy}${mm}${dd}`;
          const typeCode = type.toLowerCase().startsWith('c') ? 'C' : 'P';
          const strikeNum = Math.round(parseFloat(strike) * 1000);
          const strikeStr = strikeNum.toString().padStart(8, '0');
          const cboeSymbol = `${paddedSymbol}${dateStr}${typeCode}${strikeStr}`.replace(/\s/g, '');

          // Find matching option
          const options = data.data.options;
          let targetOption = options.find((opt: any) => opt.option === cboeSymbol);

          // Fuzzy match if not found
          if (!targetOption) {
            const expDateStr = expiration.replace(/-/g, '').slice(2);
            const typeChar = type.toUpperCase().charAt(0);
            targetOption = options.find((opt: any) => {
              return opt.option &&
                opt.option.includes(expDateStr) &&
                opt.option.includes(typeChar) &&
                opt.option.endsWith(strikeStr);
            });
          }

          if (!targetOption) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'Option contract not found', symbol: cboeSymbol }));
            return;
          }

          // Format response
          let price = targetOption.last_trade_price;
          let priceSource = 'last';
          if (targetOption.bid > 0 && targetOption.ask > 0) {
            price = (targetOption.bid + targetOption.ask) / 2;
            priceSource = 'mid';
          }

          // Calculate Score (Baselines)
          // Calculate Score (Baselines)
          const currentStockPrice = data.data.current_price;
          let score = 0;
          let metrics = {};

          // Calculate IV Ratio (4-Card Method) - Copied from Scanner
          const getATMIV = (targetDTE: number): number | null => {
            const chain = data.data.options;
            const now = new Date();
            now.setHours(0, 0, 0, 0);

            // Helper to get DTE
            const getDte = (opt: any) => {
              const symbol = opt.option || '';
              const dateMatch = symbol.match(/(\d{6})[CP]/);
              if (dateMatch) {
                const dateStr = dateMatch[1];
                const yy = parseInt(dateStr.slice(0, 2));
                const mm = parseInt(dateStr.slice(2, 4));
                const dd = parseInt(dateStr.slice(4, 6));
                const expDate = new Date(2000 + yy, mm - 1, dd);
                return Math.ceil((expDate.getTime() - now.getTime()) / 86400000);
              }
              return 30;
            };

            const candidates = chain.filter((opt: any) => {
              const dte = getDte(opt);
              const type = opt.option?.includes('C') && opt.option?.match(/\d{6}C/) ? 'Call' : 'Put';
              return type === 'Call' && Math.abs(dte - targetDTE) <= 10;
            });

            if (candidates.length < 2) return null;

            // Parse strikes
            const candidatesWithStrike = candidates.map((opt: any) => {
              const strikeMatch = opt.option.match(/[CP](\d{8})$/);
              const strike = strikeMatch ? parseInt(strikeMatch[1]) / 1000 : 0;
              return { ...opt, strike };
            });

            candidatesWithStrike.sort((a: any, b: any) => a.strike - b.strike);

            for (let i = 0; i < candidatesWithStrike.length - 1; i++) {
              if (candidatesWithStrike[i].strike <= currentStockPrice && candidatesWithStrike[i + 1].strike >= currentStockPrice) {
                return (candidatesWithStrike[i].iv + candidatesWithStrike[i + 1].iv) / 2;
              }
            }
            return candidatesWithStrike[0].iv;
          };

          const iv30 = getATMIV(30);
          const iv90 = getATMIV(90);
          const ivRatio = (iv30 && iv90 && iv90 > 0) ? iv30 / iv90 : 1.0;


          if (targetOption.delta && targetOption.gamma && targetOption.theta && price > 0 && currentStockPrice > 0) {
            // 1. Raw Metrics
            const lambda = Math.abs(targetOption.delta) * (currentStockPrice / price);
            const gammaEff = targetOption.gamma / price;
            const thetaBurn = Math.abs(targetOption.theta) / price;

            // 2. Normalize (using baselines from scoring.ts)
            // Baselines: Lambda=8(std4), Gamma=0.02(std0.015), Theta=0.03(std0.02)
            const zLambda = (lambda - 8) / 4;
            const zGamma = (gammaEff - 0.02) / 0.015;
            const zTheta = (thetaBurn - 0.03) / 0.02;

            // 3. Modifiers
            // const ivRatio = 1.0; // Replaced with calculated ivRatio above
            const ivAdjustment = getIVAdjustment(ivRatio, 'long'); // Defaults to contango bonus approx
            const deltaBonus = getDeltaBonus(targetOption.delta);
            const thetaPenalty = getThetaPenalty(thetaBurn);

            // 4. Calculate DTE for Context Awareness
            const today = new Date();
            const expDate = new Date(expiration);
            const diffTime = expDate.getTime() - today.getTime();
            const dte = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

            // 5. Score Calculation with Context Awareness
            // User Rule: Portfolio always checks DTE <= 5 for Day Trade Mode.
            // Scanner checks DTE <= 5 ONLY if maxDte <= 14 (passed via query param context, or implicitly handled here? 
            // Since this is the SINGLE option endpoint, we treat it as "Portfolio Mode" which matches User Rule 1).
            const isDayTrade = dte <= 5;

            let wLambda = 0.40;
            let wGamma = 0.30;
            let wTheta = 0.15;
            let penaltyMultiplier = 1.0;

            if (isDayTrade) {
              // "Day Trade Mode" - Ignore time decay, focus on gamma sprint
              wTheta = 0.05;      // Reduced from 0.15
              wGamma = 0.50;      // Increased from 0.30
              penaltyMultiplier = 0.2; // Significantly reduce the detailed "Theta Pain" penalty
            }

            const rawScore = (
              wLambda * zLambda +
              wGamma * zGamma -
              wTheta * zTheta + // Note: zTheta is traditionally "bad", so we subtract it. Coefficient is smaller now.
              0.15 * deltaBonus +
              ivAdjustment -
              (thetaPenalty * penaltyMultiplier)
            );

            score = normalizeScoreTo100(rawScore);

            metrics = { lambda, gammaEff, thetaBurn, isDayTrade, ivRatio };
          }

          res.statusCode = 200;
          res.end(JSON.stringify({
            success: true,
            symbol: cboeSymbol,
            price: parseFloat(price?.toFixed(2) || '0'),
            score,
            metrics,
            priceSource,
            bid: targetOption.bid || null,
            ask: targetOption.ask || null,
            lastPrice: targetOption.last_trade_price || null,
            iv: targetOption.iv || null,
            delta: targetOption.delta || null,
            gamma: targetOption.gamma || null,
            theta: targetOption.theta || null,
            vega: targetOption.vega || null,
            rho: targetOption.rho || null,
            volume: targetOption.volume || null,
            openInterest: targetOption.open_interest || null,
            underlyingPrice: data.data.current_price || null,
            dataSource: 'CBOE',
            timestamp: Date.now(),
            // Debug: Show all available fields from CBOE
            availableFields: Object.keys(targetOption),
            rawGreeks: {
              delta: targetOption.delta,
              gamma: targetOption.gamma,
              theta: targetOption.theta,
              vega: targetOption.vega,
              rho: targetOption.rho,
              iv: targetOption.iv
            }
          }));
        } catch (error: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'Internal Server Error', message: error.message }));
        }
      });

      // Handle /api/earnings
      server.middlewares.use('/api/earnings', async (req, res) => {
        const url = new URL(req.url || '', `http://${req.headers.host}`);
        const symbol = url.searchParams.get('symbol');

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');

        if (!symbol) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Missing symbol parameter' }));
          return;
        }

        const upperSymbol = symbol.toUpperCase();

        try {
          const nasdaqUrl = `https://api.nasdaq.com/api/quote/${upperSymbol}/info?assetclass=stocks`;

          const response = await fetch(nasdaqUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'application/json, text/plain, */*',
              'Accept-Language': 'en-US,en;q=0.9'
            }
          });

          if (!response.ok) {
            res.statusCode = 200;
            res.end(JSON.stringify({
              success: true,
              symbol: upperSymbol,
              hasUpcomingEarnings: false,
              earningsDate: null,
              daysUntilEarnings: null
            }));
            return;
          }

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
                    const diffDays = Math.ceil((parsedDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

                    res.statusCode = 200;
                    res.end(JSON.stringify({
                      success: true,
                      symbol: upperSymbol,
                      hasUpcomingEarnings: diffDays >= 0 && diffDays <= 30,
                      earningsDate: parsedDate.toISOString().split('T')[0],
                      daysUntilEarnings: diffDays,
                      source: 'nasdaq'
                    }));
                    return;
                  }
                }
              }
            }
          }

          res.statusCode = 200;
          res.end(JSON.stringify({
            success: true,
            symbol: upperSymbol,
            hasUpcomingEarnings: false,
            earningsDate: null,
            daysUntilEarnings: null
          }));
        } catch (error: any) {
          res.statusCode = 200;
          res.end(JSON.stringify({
            success: true,
            symbol: upperSymbol,
            hasUpcomingEarnings: false,
            earningsDate: null,
            daysUntilEarnings: null,
            debug: { error: error.message }
          }));
        }
      });

      // Handle /api/scan-options - OSS v2.1 Scanner
      server.middlewares.use('/api/scan-options', async (req, res) => {
        const url = new URL(req.url || '', `http://${req.headers.host}`);
        const ticker = url.searchParams.get('ticker');
        const strategy = url.searchParams.get('strategy') || 'long';
        const dteMin = parseInt(url.searchParams.get('dteMin') || '20');
        const dteMax = parseInt(url.searchParams.get('dteMax') || '60');
        const strikeRange = parseFloat(url.searchParams.get('strikeRange') || '0.25');
        const minVolume = parseInt(url.searchParams.get('minVolume') || '50');
        const maxSpreadPct = parseFloat(url.searchParams.get('maxSpreadPct') || '0.10');
        // NEW: Delta filter at API level
        const minDelta = parseFloat(url.searchParams.get('minDelta') || '0');
        const maxDelta = parseFloat(url.searchParams.get('maxDelta') || '1');
        const direction = url.searchParams.get('direction') || 'all'; // 'all', 'call', 'put'
        const isDayTradeMode = url.searchParams.get('dayTrade') === 'true';

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');

        if (!ticker) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Missing ticker parameter' }));
          return;
        }

        try {
          const upperTicker = ticker.toUpperCase();
          const cboeUrl = `https://cdn.cboe.com/api/global/delayed_quotes/options/${upperTicker}.json`;

          const response = await fetch(cboeUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Referer': 'https://www.cboe.com/',
              'Origin': 'https://www.cboe.com'
            }
          });

          if (!response.ok) {
            console.error(`❌ CBOE API Error [${upperTicker}]: ${response.status} ${response.statusText}`);
            res.statusCode = response.status;
            res.end(JSON.stringify({ error: 'CBOE API error', status: response.status }));
            return;
          }

          const data = await response.json();

          if (!data.data || !data.data.options) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'No options data found' }));
            return;
          }

          const currentPrice = data.data.current_price;
          const options = data.data.options;

          // Calculate DTE for each option
          const today = new Date();
          today.setHours(0, 0, 0, 0);

          const chain = options.map((opt: any) => {
            // Parse expiration from OCC symbol (e.g., "SPY   260220C00600000")
            const symbol = opt.option || '';
            const dateMatch = symbol.match(/(\d{6})[CP]/);
            let dte = 30; // default
            let expiration = '';

            if (dateMatch) {
              const dateStr = dateMatch[1];
              const yy = parseInt(dateStr.slice(0, 2));
              const mm = parseInt(dateStr.slice(2, 4));
              const dd = parseInt(dateStr.slice(4, 6));
              const expDate = new Date(2000 + yy, mm - 1, dd);
              dte = Math.ceil((expDate.getTime() - today.getTime()) / 86400000);
              expiration = `${2000 + yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
            }

            // Parse strike from OCC symbol
            const strikeMatch = symbol.match(/[CP](\d{8})$/);
            const strike = strikeMatch ? parseInt(strikeMatch[1]) / 1000 : 0;

            // Parse type
            const type = symbol.includes('C') && symbol.match(/\d{6}C/) ? 'Call' : 'Put';

            return {
              symbol,
              strike,
              type,
              expiration,
              dte,
              bid: opt.bid || 0,
              ask: opt.ask || 0,
              delta: opt.delta || 0,
              gamma: opt.gamma || 0,
              theta: opt.theta || 0,
              vega: opt.vega || 0,
              iv: opt.iv || 0,
              volume: opt.volume || 0,
              openInterest: opt.open_interest || 0
            };
          });

          // Hard filters
          const minStrike = currentPrice * (1 - strikeRange);
          const maxStrike = currentPrice * (1 + strikeRange);

          const filtered = chain.filter((opt: any) => {
            const mid = (opt.bid + opt.ask) / 2;
            const spreadPct = mid > 0 ? (opt.ask - opt.bid) / mid : 1;
            const absDelta = Math.abs(opt.delta);

            // Direction filter
            if (direction === 'call' && opt.type !== 'Call') return false;
            if (direction === 'put' && opt.type !== 'Put') return false;

            return (
              opt.dte >= dteMin &&
              opt.dte <= dteMax &&
              opt.strike >= minStrike &&
              opt.strike <= maxStrike &&
              opt.volume >= minVolume &&
              spreadPct <= maxSpreadPct &&
              mid > 0 &&
              // NEW: Delta filter at API level
              absDelta >= minDelta &&
              absDelta <= maxDelta
            );
          });

          if (filtered.length === 0) {
            res.statusCode = 200;
            res.end(JSON.stringify({
              success: true,
              context: {
                ticker: upperTicker,
                currentPrice,
                ivRatio: 1.0,
                ivStatus: 'neutral',
                strategy,
                totalOptions: options.length,
                filteredCount: 0
              },
              results: []
            }));
            return;
          }

          // Calculate IV Ratio (4-Card Method)
          const getATMIV = (targetDTE: number): number | null => {
            const candidates = chain.filter((opt: any) =>
              opt.type === 'Call' && Math.abs(opt.dte - targetDTE) <= 10
            );
            if (candidates.length < 2) return null;
            candidates.sort((a: any, b: any) => a.strike - b.strike);
            for (let i = 0; i < candidates.length - 1; i++) {
              if (candidates[i].strike <= currentPrice && candidates[i + 1].strike >= currentPrice) {
                return (candidates[i].iv + candidates[i + 1].iv) / 2;
              }
            }
            return candidates[0].iv;
          };

          const iv30 = getATMIV(30);
          const iv90 = getATMIV(90);
          const ivRatio = (iv30 && iv90 && iv90 > 0) ? iv30 / iv90 : 1.0;
          const ivStatus = ivRatio < 0.95 ? 'contango' : ivRatio > 1.05 ? 'backwardation' : 'neutral';


          // IV Adjustment using Sigmoid (smooth phase transition)
          const ivAdjustment = getIVAdjustment(ivRatio, strategy);


          // Calculate metrics
          const processed = filtered.map((opt: any) => {
            const mid = (opt.bid + opt.ask) / 2;
            const spreadPct = (opt.ask - opt.bid) / mid;

            if (strategy === 'long') {
              const lambda = Math.abs(opt.delta) * (currentPrice / mid);
              const gammaEff = opt.gamma / mid;
              const thetaBurn = Math.abs(opt.theta) / mid;
              return { opt, mid, spreadPct, lambda, gammaEff, thetaBurn };
            } else {
              const pop = 1 - Math.abs(opt.delta);
              const edge = pop * mid;
              return { opt, mid, spreadPct, pop, edge };
            }
          });

          // Z-Score normalization
          const zScores = (values: number[]): number[] => {
            const n = values.length;
            if (n < 2) return values.map(() => 0);
            const mean = values.reduce((s, v) => s + v, 0) / n;
            const std = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / n) || 1;
            return values.map(v => (v - mean) / std);
          };


          let results: any[];

          if (strategy === 'long') {
            // Apply soft compression to lambdas before Z-Score
            const compressedLambdas = processed.map((p: any) => compressLambda(p.lambda));
            const gammas = processed.map((p: any) => p.gammaEff);
            const thetas = processed.map((p: any) => p.thetaBurn);
            const zL = zScores(compressedLambdas);  // Z-Score on compressed values
            const zG = zScores(gammas);
            const zT = zScores(thetas);

            results = processed.map((p: any, i: number) => {
              const deltaBonus = getDeltaBonus(p.opt.delta);
              const thetaPenalty = getThetaPenalty(p.thetaBurn);

              // Dynamic Weights for Day Trade Mode
              let wLambda = 0.40;
              let wGamma = 0.30;
              let wTheta = 0.15;
              let penaltyMultiplier = 1.0;

              if (isDayTradeMode) {
                wLambda = 0.40;
                wGamma = 0.50; // Sprint speed matter most
                wTheta = 0.05; // Time mismatch less relevant for <1 day holds
                penaltyMultiplier = 0.2;
              }

              // Custom calculation instead of fixed calculateLOQRaw
              // 0.15 * deltaBonus + ivAdjustment are constant additions
              // zTheta is "bad", so we subtract wTheta * zTheta
              const rawScore = (
                wLambda * zL[i] +
                wGamma * zG[i] -
                wTheta * zT[i] +
                0.15 * deltaBonus +
                ivAdjustment -
                (thetaPenalty * penaltyMultiplier)
              );

              const score = Math.max(0, Math.min(100, Math.round(50 + rawScore * 12.5)));
              return {
                symbol: p.opt.symbol,
                strike: p.opt.strike,
                type: p.opt.type,
                expiration: p.opt.expiration,
                dte: p.opt.dte,

                price: Math.round(p.mid * 100) / 100,
                score,
                metrics: {
                  lambda: Math.round(p.lambda * 100) / 100,
                  gammaEff: Math.round(p.gammaEff * 10000) / 10000,
                  thetaBurn: Math.round(p.thetaBurn * 10000) / 10000,
                  spreadPct: Math.round(p.spreadPct * 1000) / 1000
                },
                greeks: {
                  delta: p.opt.delta,
                  gamma: p.opt.gamma,
                  theta: p.opt.theta,
                  vega: p.opt.vega,
                  iv: p.opt.iv
                },
                liquidity: {
                  volume: p.opt.volume,
                  openInterest: p.opt.openInterest,
                  bid: p.opt.bid,
                  ask: p.opt.ask
                }
              };
            });
          } else {
            const edges = processed.map((p: any) => p.edge);
            const pops = processed.map((p: any) => p.pop);
            const spreads = processed.map((p: any) => p.spreadPct);
            const zE = zScores(edges);
            const zP = zScores(pops);
            const zS = zScores(spreads);

            results = processed.map((p: any, i: number) => {
              const rawScore = 0.50 * zE[i] + 0.30 * zP[i] - 0.20 * zS[i] + ivAdjustment;
              const score = Math.max(0, Math.min(100, Math.round(50 + rawScore * 12.5)));
              return {
                symbol: p.opt.symbol,
                strike: p.opt.strike,
                type: p.opt.type,
                expiration: p.opt.expiration,
                dte: p.opt.dte,
                price: Math.round(p.mid * 100) / 100,
                score,
                metrics: {
                  pop: Math.round(p.pop * 1000) / 1000,
                  edge: Math.round(p.edge * 100) / 100,
                  spreadPct: Math.round(p.spreadPct * 1000) / 1000
                },
                greeks: {
                  delta: p.opt.delta,
                  gamma: p.opt.gamma,
                  theta: p.opt.theta,
                  vega: p.opt.vega,
                  iv: p.opt.iv
                },
                liquidity: {
                  volume: p.opt.volume,
                  openInterest: p.opt.openInterest,
                  bid: p.opt.bid,
                  ask: p.opt.ask
                }
              };
            });
          }

          // Sort by score descending, take top 20
          results.sort((a, b) => b.score - a.score);
          results = results.slice(0, 20);

          res.statusCode = 200;
          res.end(JSON.stringify({
            success: true,
            context: {
              ticker: upperTicker,
              currentPrice,
              ivRatio: Math.round(ivRatio * 1000) / 1000,
              iv30: iv30 ? Math.round(iv30 * 1000) / 1000 : null,
              iv90: iv90 ? Math.round(iv90 * 1000) / 1000 : null,
              ivStatus,
              strategy,
              totalOptions: options.length,
              filteredCount: filtered.length
            },
            results
          }));

        } catch (error: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'Internal Server Error', message: error.message }));
        }
      });

      // Handle /api/strategy-recommend - Intelligent Strategy Recommender
      server.middlewares.use('/api/strategy-recommend', async (req, res) => {
        const url = new URL(req.url || '', `http://${req.headers.host}`);
        const ticker = url.searchParams.get('ticker');
        const direction = url.searchParams.get('direction') || 'BULL';
        const targetDteParam = url.searchParams.get('targetDte');
        const targetDte = targetDteParam ? parseInt(targetDteParam) : 30;

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');

        if (!ticker) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Missing ticker parameter' }));
          return;
        }

        const upperTicker = ticker.toUpperCase();
        const isBull = direction.toUpperCase() === 'BULL';

        try {
          // Fetch full chain from CBOE
          const cboeUrl = `https://cdn.cboe.com/api/global/delayed_quotes/options/${upperTicker}.json`;
          const response = await fetch(cboeUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Referer': 'https://www.cboe.com/',
              'Origin': 'https://www.cboe.com'
            }
          });

          if (!response.ok) {
            console.error(`❌ CBOE API Error [${upperTicker}]: ${response.status} ${response.statusText}`);
            res.statusCode = response.status;
            res.end(JSON.stringify({ error: 'CBOE API error', status: response.status }));
            return;
          }

          const data = await response.json();
          if (!data.data || !data.data.options) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'No options data found' }));
            return;
          }

          const currentPrice = data.data.current_price;
          const allOptions = data.data.options;

          // Parse chain helper
          const today = new Date();
          today.setHours(0, 0, 0, 0);

          const parseChain = (options: any[], targetDTE: number | null) => {
            return options.map((opt: any) => {
              const symbol = opt.option || '';
              const dateMatch = symbol.match(/(\d{6})[CP]/);
              let dte = 30;
              let expiration = '';

              if (dateMatch) {
                const dateStr = dateMatch[1];
                const yy = parseInt(dateStr.slice(0, 2));
                const mm = parseInt(dateStr.slice(2, 4));
                const dd = parseInt(dateStr.slice(4, 6));
                const expDate = new Date(2000 + yy, mm - 1, dd);
                dte = Math.ceil((expDate.getTime() - today.getTime()) / 86400000);
                expiration = `${2000 + yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
              }

              const strikeMatch = symbol.match(/[CP](\d{8})$/);
              const strike = strikeMatch ? parseInt(strikeMatch[1]) / 1000 : 0;
              const type = symbol.includes('C') && symbol.match(/\d{6}C/) ? 'Call' : 'Put';

              return {
                symbol, strike, type, expiration, dte,
                bid: opt.bid || 0, ask: opt.ask || 0, delta: opt.delta || 0,
                gamma: opt.gamma || 0, theta: opt.theta || 0, vega: opt.vega || 0,
                iv: opt.iv || 0, volume: opt.volume || 0, openInterest: opt.open_interest || 0
              };
            }).filter((opt: any) => {
              const minStrike = currentPrice * 0.85;
              const maxStrike = currentPrice * 1.15;
              if (opt.strike < minStrike || opt.strike > maxStrike) return false;
              if (targetDTE !== null) {
                if (targetDTE < 30) return opt.dte >= 14 && opt.dte < 30; // Short: 14-30
                if (targetDTE < 45) return opt.dte >= 30 && opt.dte < 45; // Med: 30-45
                if (targetDTE < 90) return opt.dte >= 45 && opt.dte < 90; // Long: 45-90
                return opt.dte >= 90; // Leaps: 90+
              }
              return opt.dte > 0 && opt.dte <= 730;
            });
          };

          const chain30 = parseChain(allOptions, 30);
          const chain90 = parseChain(allOptions, 90);
          // NEW: Filter full chain by targetDte for strategy building
          const strategyChain = parseChain(allOptions, targetDte);

          // Detect Regime
          const getATMIV = (chain: any[]) => {
            const calls = chain.filter((opt: any) => opt.type === 'Call');
            if (calls.length < 2) return null;
            calls.sort((a: any, b: any) => a.strike - b.strike);
            for (let i = 0; i < calls.length - 1; i++) {
              if (calls[i].strike <= currentPrice && calls[i + 1].strike >= currentPrice) {
                return (calls[i].iv + calls[i + 1].iv) / 2;
              }
            }
            return calls[0].iv;
          };

          const iv30 = getATMIV(chain30);
          const iv90 = getATMIV(chain90);
          let ivRatio = 1.0;
          let regimeMode = 'NEUTRAL';
          let advice = '⚖️ Neutral IV: Either strategy viable';

          if (iv30 && iv90 && iv90 > 0) {
            ivRatio = iv30 / iv90;
            if (ivRatio < 0.95) {
              regimeMode = 'DEBIT';
              advice = '🟢 Contango (Cheap IV): Buy Debit Spreads / Long Options';
            } else if (ivRatio > 1.05) {
              regimeMode = 'CREDIT';
              advice = '🔴 Backwardation (Expensive IV): Sell Credit Spreads';
            }
          }

          // Build Spreads
          const buildCreditSpreads = (chain: any[], spreadType: string) => {
            const results: any[] = [];
            const widths = [5, 10];
            const shorts = chain.filter((o: any) => o.type === spreadType && Math.abs(o.delta) >= 0.20 && Math.abs(o.delta) <= 0.40);

            for (const shortLeg of shorts) {
              for (const width of widths) {
                const longStrike = spreadType === 'Put' ? shortLeg.strike - width : shortLeg.strike + width;
                const longLeg = chain.find((o: any) => o.type === spreadType && o.expiration === shortLeg.expiration && Math.abs(o.strike - longStrike) < 0.1);
                if (!longLeg) continue;

                const credit = shortLeg.bid - longLeg.ask;
                const maxRisk = width - credit;
                if (credit < 0.15 || maxRisk <= 0) continue;

                const roi = (credit / maxRisk) * 100;
                const pop = 1 - Math.abs(shortLeg.delta);
                const distance = Math.abs(currentPrice - shortLeg.strike) / currentPrice;
                const spreadPct = ((shortLeg.ask - shortLeg.bid) / ((shortLeg.ask + shortLeg.bid) / 2));

                // Expected Value
                const expectedValue = (credit * pop) - (maxRisk * (1 - pop));

                if (roi < 15 || spreadPct > 0.10) continue;

                const score = Math.round(0.4 * Math.min(roi * 4, 100) + 0.4 * pop * 100 + 0.2 * Math.min(distance * 1000, 100));
                const whyThis = `${roi.toFixed(0)}% ROI with ${(pop * 100).toFixed(0)}% win rate`;

                results.push({
                  type: spreadType === 'Put' ? 'Credit Put Spread' : 'Credit Call Spread',
                  shortLeg: { strike: shortLeg.strike, expiration: shortLeg.expiration, dte: shortLeg.dte, price: shortLeg.bid, delta: shortLeg.delta, iv: shortLeg.iv, volume: shortLeg.volume, openInterest: shortLeg.openInterest },
                  longLeg: { strike: longLeg.strike, expiration: longLeg.expiration, price: longLeg.ask, delta: longLeg.delta, volume: longLeg.volume, openInterest: longLeg.openInterest },
                  width, netCredit: +credit.toFixed(2), maxRisk: +maxRisk.toFixed(2), maxProfit: +credit.toFixed(2),
                  roi: +roi.toFixed(1), pop: +(pop * 100).toFixed(1), distance: +(distance * 100).toFixed(1),
                  expectedValue: +expectedValue.toFixed(2),
                  breakeven: spreadType === 'Put' ? shortLeg.strike - credit : shortLeg.strike + credit,
                  score: Math.min(100, Math.max(0, score)), whyThis
                });
              }
            }
            return results.sort((a, b) => b.score - a.score).slice(0, 5);
          };

          const buildDebitSpreads = (chain: any[], spreadType: string) => {
            const results: any[] = [];
            const widths = [2.5, 5];

            // Relaxed Delta Filter
            const longs = chain.filter((o: any) => o.type === spreadType && Math.abs(o.delta) >= 0.40 && Math.abs(o.delta) <= 0.70);

            for (const longLeg of longs) {
              for (const width of widths) {
                const shortStrike = spreadType === 'Call' ? longLeg.strike + width : longLeg.strike - width;
                const shortLeg = chain.find((o: any) => o.type === spreadType && o.expiration === longLeg.expiration && Math.abs(o.strike - shortStrike) < 0.1);
                if (!shortLeg) continue;

                const debit = longLeg.ask - shortLeg.bid;
                const maxProfit = width - debit;
                const riskReward = maxProfit / debit;
                const spreadPct = ((longLeg.ask - longLeg.bid) / ((longLeg.ask + longLeg.bid) / 2));

                // Relaxed Filters
                if (debit <= 0 || debit >= width * 0.50) continue;
                if (riskReward < 1.0) continue;
                if (spreadPct > 0.10) continue;

                const mid = (longLeg.bid + longLeg.ask) / 2;
                const lambda = Math.abs(longLeg.delta) * (currentPrice / mid);
                const deltaBonus = getDeltaBonus(longLeg.delta);

                // POP & EV
                const pop = Math.abs(longLeg.delta) - 0.05;
                const expectedValue = (maxProfit * pop) - (debit * (1 - pop));

                const lambdaScore = Math.min((compressLambda(lambda) / 20) * 100, 100);
                const rrScore = Math.min((riskReward / 3) * 100, 100);
                const deltaBonusScore = 50 + deltaBonus * 12.5;
                const score = Math.round(0.4 * lambdaScore + 0.35 * rrScore + 0.25 * deltaBonusScore);
                const whyThis = `${riskReward.toFixed(1)}:1 reward-to-risk, λ=${lambda.toFixed(1)}`;

                results.push({
                  type: spreadType === 'Call' ? 'Debit Call Spread' : 'Debit Put Spread',
                  longLeg: { strike: longLeg.strike, expiration: longLeg.expiration, dte: longLeg.dte, price: longLeg.ask, delta: longLeg.delta, iv: longLeg.iv, volume: longLeg.volume, openInterest: longLeg.openInterest },
                  shortLeg: { strike: shortLeg.strike, expiration: shortLeg.expiration, price: shortLeg.bid, delta: shortLeg.delta, volume: shortLeg.volume, openInterest: shortLeg.openInterest },
                  width, netDebit: +debit.toFixed(2), maxRisk: +debit.toFixed(2), maxProfit: +maxProfit.toFixed(2),
                  riskReward: +riskReward.toFixed(2), lambda: +lambda.toFixed(1),
                  pop: +(pop * 100).toFixed(1), expectedValue: +expectedValue.toFixed(2),
                  breakeven: spreadType === 'Call' ? longLeg.strike + debit : longLeg.strike - debit,
                  score: Math.min(100, Math.max(0, score)), whyThis
                });
              }
            }
            return results.sort((a, b) => b.score - a.score).slice(0, 5);
          };

          const scoreSingleLegs = (chain: any[], legType: string) => {
            const filtered = chain.filter((o: any) => o.type === legType && Math.abs(o.delta) >= 0.25 && Math.abs(o.delta) <= 0.60);
            if (filtered.length === 0) return [];

            const processed = filtered.map((opt: any) => {
              const mid = (opt.bid + opt.ask) / 2;
              const lambda = Math.abs(opt.delta) * (currentPrice / mid);
              const gammaEff = opt.gamma / mid;
              const thetaBurn = Math.abs(opt.theta) / mid;
              return { opt, mid, lambda, gammaEff, thetaBurn };
            });

            // Z-Score Helper (Local)
            const calculateZScores = (values: number[]) => {
              const n = values.length;
              if (n < 2) return values.map(() => 0);
              const mean = values.reduce((s, v) => s + v, 0) / n;
              const std = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / n) || 1;
              return values.map(v => (v - mean) / std);
            };

            const compressedLambdas = processed.map((p: any) => compressLambda(p.lambda));
            const gammas = processed.map((p: any) => p.gammaEff);
            const thetas = processed.map((p: any) => p.thetaBurn);

            const zL = calculateZScores(compressedLambdas);
            const zG = calculateZScores(gammas);
            const zT = calculateZScores(thetas);

            const ivAdj = (1 - getIVRiskFactor(ivRatio)) * 5;

            return processed.map((p: any, i: number) => {
              const deltaBonus = getDeltaBonus(p.opt.delta);
              const thetaPenalty = getThetaPenalty(p.thetaBurn);

              // Formula: 0.4*zL + 0.3*zG - 0.15*zT + 0.15*Bonus + Adj - ThetaPenalty
              const rawScore = 0.40 * zL[i] + 0.30 * zG[i] - 0.15 * zT[i] + 0.15 * deltaBonus + ivAdj - thetaPenalty;

              const score = Math.max(0, Math.min(100, Math.round(50 + rawScore * 12.5)));

              return {
                type: `Long ${legType}`, strike: p.opt.strike, expiration: p.opt.expiration, dte: p.opt.dte,
                price: +p.mid.toFixed(2), delta: p.opt.delta, iv: p.opt.iv, lambda: +p.lambda.toFixed(1),
                gamma: p.opt.gamma, theta: p.opt.theta, vega: p.opt.vega, volume: p.opt.volume, openInterest: p.opt.openInterest,
                gammaEff: +p.gammaEff.toFixed(4), thetaBurn: +p.thetaBurn.toFixed(4), score,
                whyThis: `λ=${p.lambda.toFixed(1)} leverage, Δ=${Math.abs(p.opt.delta).toFixed(2)}`
              };
            }).sort((a: any, b: any) => b.score - a.score).slice(0, 5);
          };

          // Generate ALL recommendations
          const creditStrat = isBull ? 'Put' : 'Call';
          const debitStrat = isBull ? 'Call' : 'Put';
          const legStrat = isBull ? 'Call' : 'Put';

          const creditSpreads = buildCreditSpreads(strategyChain, creditStrat);
          const debitSpreads = buildDebitSpreads(strategyChain, debitStrat);
          const singleLegs = scoreSingleLegs(strategyChain, legStrat);

          // Determine Recommended Strategy
          let recommendedStrategy = 'CREDIT_SPREAD';
          if (regimeMode === 'DEBIT') {
            recommendedStrategy = 'DEBIT_SPREAD';
          } else if (regimeMode === 'NEUTRAL') {
            // Tie-breaker: Check scores
            const topCredit = creditSpreads[0]?.score || 0;
            const topDebit = debitSpreads[0]?.score || 0;
            if (topDebit > topCredit) recommendedStrategy = 'DEBIT_SPREAD';
          }

          // Validation: If recommended has no results, fallback
          if (recommendedStrategy === 'CREDIT_SPREAD' && creditSpreads.length === 0) recommendedStrategy = 'DEBIT_SPREAD';
          if (recommendedStrategy === 'DEBIT_SPREAD' && debitSpreads.length === 0) recommendedStrategy = 'SINGLE_LEG';
          if (recommendedStrategy === 'SINGLE_LEG' && singleLegs.length === 0 && creditSpreads.length > 0) recommendedStrategy = 'CREDIT_SPREAD';

          res.statusCode = 200;
          res.end(JSON.stringify({
            success: true,
            context: { ticker: upperTicker, currentPrice, direction: isBull ? 'BULL' : 'BEAR', targetDte },
            regime: { ivRatio: +ivRatio.toFixed(3), iv30: iv30 ? +(iv30 * 100).toFixed(1) : null, iv90: iv90 ? +(iv90 * 100).toFixed(1) : null, mode: regimeMode, advice },
            recommendedStrategy,
            strategies: {
              CREDIT_SPREAD: creditSpreads,
              DEBIT_SPREAD: debitSpreads,
              SINGLE_LEG: singleLegs
            }
          }));

        } catch (error: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'Internal Server Error', message: error.message }));
        }
      });
    }
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), localApiPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  }
})
