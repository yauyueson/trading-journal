/**
 * 定时检查：Active 持仓是否触及止损或目标价，触及则发 Discord 提醒。
 * 由 Vercel Cron 或外部 Cron 定期调用（如每 15 分钟）。
 *
 * 直接调用 CBOE 延迟行情 API 获取当前价，不再自引用 /api/option-price。
 *
 * 环境变量：
 *   CRON_SECRET, DISCORD_WEBHOOK_URL, SUPABASE_URL, SUPABASE_ANON_KEY
 */

/** Generate OCC symbol for CBOE lookup. */
function generateOCCSymbol(symbol, expiration, type, strike) {
  try {
    const paddedSymbol = symbol.toUpperCase().padEnd(6, ' ');
    const parts = expiration.split('-');
    if (parts.length !== 3) return null;
    const dateStr = parts[0].slice(2) + parts[1].padStart(2, '0') + parts[2].padStart(2, '0');
    const typeCode = (type.toLowerCase().includes('call') || type.toLowerCase() === 'c') ? 'C' : 'P';
    const strikeStr = Math.round(parseFloat(strike) * 1000).toString().padStart(8, '0');
    return paddedSymbol + dateStr + typeCode + strikeStr;
  } catch (_) {
    return null;
  }
}

/** Find an option's mid price from an options array (CBOE or Polygon format). Returns number | null. */
function findOptionMid(options, ticker, expiration, strike, type) {
  if (!options || !Array.isArray(options) || options.length === 0) return null;

  // Detect format
  const isPolygon = options.length > 0 && options[0].symbol !== undefined && options[0].strike !== undefined;

  if (isPolygon) {
    // Polygon format: direct field matching
    const targetStrike = parseFloat(strike);
    const targetType = (type || 'Call').toLowerCase().includes('call') ? 'Call' : 'Put';
    const expStr = expiration.slice(0, 10); // YYYY-MM-DD

    const match = options.find(opt =>
      Math.abs(opt.strike - targetStrike) < 0.01 &&
      opt.type === targetType &&
      opt.expiration === expStr
    );

    if (!match) return null;
    if (match.bid > 0 && match.ask > 0) return (match.bid + match.ask) / 2;
    if (match.last > 0) return match.last;
    return null;
  }

  // CBOE format: OCC symbol matching
  const occ = generateOCCSymbol(ticker, expiration, type || 'Call', strike);
  if (!occ) return null;
  const cboeSymbol = occ.replace(/\s/g, '');

  let match = options.find(o => o.option === cboeSymbol);

  if (!match) {
    const expDateStr = expiration.replace(/-/g, '').slice(2);
    const typeCode = (type || 'Call').toLowerCase().includes('call') ? 'C' : 'P';
    const strikeStr = Math.round(parseFloat(strike) * 1000).toString().padStart(8, '0');
    match = options.find(o => {
      if (!o.option) return false;
      const sym = o.option.replace(/\s/g, '');
      return sym.includes(expDateStr) && sym.charAt(12) === typeCode && sym.endsWith(strikeStr);
    });
  }

  if (!match) return null;
  if (match.bid > 0 && match.ask > 0) return (match.bid + match.ask) / 2;
  if (match.last_trade_price > 0) return match.last_trade_price;
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = req.query.secret || req.headers['authorization']?.replace('Bearer ', '');
  const expectedSecret = process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;
  if (!expectedSecret || secret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    return res.status(500).json({ error: 'DISCORD_WEBHOOK_URL not set' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Supabase env not set' });
  }

  async function supabaseQuery(table, queryParams = '') {
    const url = `${supabaseUrl}/rest/v1/${table}${queryParams ? '?' + queryParams : ''}`;
    const resp = await fetch(url, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Supabase ${table} query failed: ${resp.status} ${text}`);
    }
    return resp.json();
  }

  try {
    const positions = await supabaseQuery('positions', 'status=eq.active&select=*');

    if (!positions || positions.length === 0) {
      return res.status(200).json({ ok: true, message: 'No active positions', sent: 0 });
    }

    const transactions = await supabaseQuery('transactions', 'select=*');

    const txnsByPos = (transactions || []).reduce((acc, t) => {
      if (!acc[t.position_id]) acc[t.position_id] = [];
      acc[t.position_id].push(t);
      return acc;
    }, {});

    // Fetch option chains once per unique ticker
    const uniqueTickers = [...new Set(positions.map(p => (p.ticker || '').toUpperCase()).filter(Boolean))];
    const dataSource = process.env.DATA_SOURCE || 'CBOE';
    const optionChains = {};

    if (dataSource === 'POLYGON') {
      try {
        const { getOptionChain } = await import('../lib/polygon-client.js');
        const sequentialThreshold = Number(process.env.ALERT_CHAIN_SEQUENTIAL_THRESHOLD || 50);
        const delayMs = Number(process.env.ALERT_CHAIN_DELAY_MS || 100);

        if (uniqueTickers.length >= sequentialThreshold) {
          for (let i = 0; i < uniqueTickers.length; i++) {
            if (i > 0 && delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
            const ticker = uniqueTickers[i];
            try {
              const chain = await getOptionChain(ticker, {});
              optionChains[ticker] = chain || [];
            } catch (e) {
              console.warn('Polygon fetch failed for', ticker, e.message);
              optionChains[ticker] = [];
            }
          }
        } else {
          await Promise.all(uniqueTickers.map(async (ticker) => {
            try {
              const chain = await getOptionChain(ticker, {});
              optionChains[ticker] = chain || [];
            } catch (e) {
              console.warn('Polygon fetch failed for', ticker, e.message);
              optionChains[ticker] = [];
            }
          }));
        }
      } catch (importErr) {
        console.error('Failed to import polygon-client (lib):', importErr);
      }
    }

    // CBOE fallback if Polygon not configured or failed
    if (dataSource === 'CBOE' || Object.keys(optionChains).length === 0) {
      await Promise.all(uniqueTickers.map(async (ticker) => {
        try {
          const resp = await fetch(
            'https://cdn.cboe.com/api/global/delayed_quotes/options/' + ticker + '.json',
            { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }
          );
          if (resp.ok) {
            const data = await resp.json();
            optionChains[ticker] = (data && data.data && data.data.options) || [];
          }
        } catch (e) {
          console.warn('CBOE fetch failed for', ticker, e.message);
        }
      }));
    }

    let sent = 0;

    for (const pos of positions) {
      // Skip multi-leg for now (alerts for spreads can be added later)
      const legs = pos.legs || [];
      if (legs.length >= 2) continue;

      const posTxns = txnsByPos[pos.id] || [];
      const firstBuy = posTxns.find(t => t.quantity > 0);
      const entryPrice = firstBuy ? Math.abs(firstBuy.price) : 0;
      if (!entryPrice) continue;

      const hasTakenProfit = posTxns.some(t => t.type === 'Take Profit');
      const isCreditStrategy = legs.length >= 2;
      const calculatedStopLoss = isCreditStrategy
        ? entryPrice * 1.5
        : (hasTakenProfit ? entryPrice * 0.75 : entryPrice * 0.5);
      const currentStopLoss = pos.stop_price ?? calculatedStopLoss;
      const targetPrice = pos.target_price || (isCreditStrategy ? entryPrice * 0.5 : entryPrice * 1.25);

      // Look up current price from cached option chain
      const ticker = (pos.ticker || '').toUpperCase();
      const chain = optionChains[ticker] || [];
      const expStr = typeof pos.expiration === 'string' ? pos.expiration.slice(0, 10) : '';
      const currentPrice = findOptionMid(chain, ticker, expStr, pos.strike, pos.type || 'Call');

      if (currentPrice == null) continue;

      let triggered = null;

      if (isCreditStrategy) {
        if (currentPrice >= currentStopLoss) triggered = 'stop';
        else if (targetPrice != null && currentPrice <= targetPrice) triggered = 'target';
      } else {
        if (currentPrice <= currentStopLoss) triggered = 'stop';
        else if (targetPrice != null && currentPrice >= targetPrice) triggered = 'target';
      }

      if (!triggered) continue;

      const strike = pos.strike || '';
      const type = (pos.type || 'Call').toUpperCase().slice(0, 1);
      const title = triggered === 'stop' ? '🛑 Stop Hit' : '🎯 Target Hit';
      const color = triggered === 'stop' ? 0xef4444 : 0x22c55e;
      const level = triggered === 'stop' ? 'stop' : 'target';
      const levelPrice = triggered === 'stop' ? currentStopLoss : targetPrice;

      const body = {
        content: null,
        embeds: [{
          title,
          description: `${ticker} ${strike}${type} · Current **$${Number(currentPrice).toFixed(2)}** hit ${level} **$${Number(levelPrice).toFixed(2)}**`,
          color,
          footer: { text: 'Trading Journal' },
          timestamp: new Date().toISOString(),
        }],
      };

      const discordRes = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (discordRes.ok) {
        sent++;
      } else {
        console.warn('Discord webhook failed', discordRes.status, await discordRes.text());
      }
    }

    // ── Exit Score Signals ──────────────────────────────────────────
    // Alert when current_score < 40 OR score drops > 20 from entry.
    // Uses DB scores (current_score / entry_score), no API call needed.
    for (const pos of positions) {
      const currentScore = pos.current_score;
      const entryScore = pos.entry_score;
      if (currentScore == null || entryScore == null) continue;

      const scoreDrop = entryScore - currentScore;
      const isLowScore = currentScore < 40;
      const isLargeDrop = scoreDrop >= 20;
      if (!isLowScore && !isLargeDrop) continue;

      const ticker = (pos.ticker || '').toUpperCase();
      const reason = isLargeDrop
        ? `Score dropped **${scoreDrop} pts** (entry: ${entryScore} → now: ${currentScore})`
        : `Score is low (**${currentScore}**) — trade thesis may be degraded`;

      const body = {
        content: null,
        embeds: [{
          title: '⚠️ Exit Score Signal',
          description: `**${ticker}** ${pos.strike || ''} ${pos.type || ''}\n${reason}\nConsider reviewing or closing this position.`,
          color: 0xf59e0b, // amber
          footer: { text: 'Trading Journal · OSS Exit Signal' },
          timestamp: new Date().toISOString(),
        }],
      };

      const discordRes = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (discordRes.ok) {
        sent++;
      } else {
        console.warn('Discord webhook (score alert) failed', discordRes.status, await discordRes.text());
      }
    }

    return res.status(200).json({ ok: true, checked: positions.length, sent });
  } catch (err) {
    console.error('check-alerts error:', err);
    return res.status(500).json({ error: 'Internal error', message: err.message });
  }
}
