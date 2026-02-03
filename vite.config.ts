import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// ---------------------------------------------------------
// Local API Plugin - handles /api routes in development
// ---------------------------------------------------------
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
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
          });

          if (!response.ok) {
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

          res.statusCode = 200;
          res.end(JSON.stringify({
            success: true,
            symbol: cboeSymbol,
            price: parseFloat(price?.toFixed(2) || '0'),
            priceSource,
            bid: targetOption.bid || null,
            ask: targetOption.ask || null,
            lastPrice: targetOption.last_trade_price || null,
            iv: targetOption.iv || null,
            delta: targetOption.delta || null,
            volume: targetOption.volume || null,
            openInterest: targetOption.open_interest || null,
            underlyingPrice: data.data.current_price || null,
            dataSource: 'CBOE',
            timestamp: Date.now()
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
