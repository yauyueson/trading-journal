/**
 * 定时检查：Active 持仓是否触及止损或目标价，触及则发 Discord 提醒。
 * 由 Vercel Cron 或外部 Cron 定期调用（如每 15 分钟）。
 *
 * 直接调用 CBOE 延迟行情 API 获取当前价，不再自引用 /api/option-price。
 *
 * 环境变量：
 *   CRON_SECRET, DISCORD_WEBHOOK_URL, SUPABASE_URL, SUPABASE_ANON_KEY
 */

import { generateOCCSymbol, findOptionMid } from '../lib/_shared/utils.js';
import { DATA_SOURCE } from '../lib/_shared/config.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // --- Market Hours Check ---
  // US Market: Mon-Fri, 09:30 - 16:00 ET
  const nyDate = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = nyDate.getDay(); // 0 (Sun) to 6 (Sat)
  const hour = nyDate.getHours();
  const min = nyDate.getMinutes();

  const isWeekend = day === 0 || day === 6;
  const isBeforeOpen = (hour < 9) || (hour === 9 && min < 30);
  const isAfterClose = (hour >= 16);

  if (isWeekend || isBeforeOpen || isAfterClose) {
    return res.status(200).json({
      ok: true,
      message: 'Market is closed (EST/EDT). Skipping alerts.',
      time: nyDate.toLocaleString(),
      isWeekend,
      isBeforeOpen,
      isAfterClose
    });
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

    const positionIds = positions.map(p => p.id).filter(Boolean);
    const transactions = positionIds.length > 0
      ? await supabaseQuery('transactions', `position_id=in.(${positionIds.join(',')})&select=*`)
      : [];

    const txnsByPos = (transactions || []).reduce((acc, t) => {
      if (!acc[t.position_id]) acc[t.position_id] = [];
      acc[t.position_id].push(t);
      return acc;
    }, {});

    // Fetch option chains once per unique ticker
    const uniqueTickers = [...new Set(positions.map(p => (p.ticker || '').toUpperCase()).filter(Boolean))];
    const dataSource = DATA_SOURCE;
    const optionChains = {};

    if (dataSource === 'POLYGON' || dataSource === 'ORATS') {
      try {
        const { getOptionChain } = await import('../lib/orats-client.js');
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
              console.warn('ORATS fetch failed for', ticker, e.message);
              optionChains[ticker] = [];
            }
          }
        } else {
          await Promise.all(uniqueTickers.map(async (ticker) => {
            try {
              const chain = await getOptionChain(ticker, {});
              optionChains[ticker] = chain || [];
            } catch (e) {
              console.warn('ORATS fetch failed for', ticker, e.message);
              optionChains[ticker] = [];
            }
          }));
        }
      } catch (importErr) {
        console.error('Failed to import orats-client (lib):', importErr);
      }
    }

    // CBOE fallback if ORATS not configured or failed
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
      const legs = pos.legs || [];

      // Handle 2-leg spreads (credit and debit)
      if (legs.length === 2) {
        const posTxns = txnsByPos[pos.id] || [];
        const netTxn = posTxns.find(t => t.price != null);
        const entryNet = netTxn ? Math.abs(netTxn.price) : 0;
        if (!entryNet) continue;

        const ticker = (pos.ticker || '').toUpperCase();
        const chain = optionChains[ticker] || [];

        // Determine short leg (sold) and long leg (bought)
        // Legs store side: "short"/"long", not quantity
        const shortLegDef = legs.find(l => l.side === 'short') || legs.find(l => (l.quantity || 0) < 0) || legs[0];
        const longLegDef = legs.find(l => l.side === 'long') || legs.find(l => (l.quantity || 0) > 0) || legs[1];

        const shortMid = findOptionMid(chain, ticker,
          (shortLegDef.expiration || '').slice(0, 10), shortLegDef.strike, shortLegDef.type || 'Put');
        const longMid = findOptionMid(chain, ticker,
          (longLegDef.expiration || '').slice(0, 10), longLegDef.strike, longLegDef.type || 'Put');

        if (shortMid == null || longMid == null) continue;

        // Determine strategy direction from position type (not strategy_type which is swing/shortTerm)
        const posType = (pos.type || '').toLowerCase();
        const isCreditSpread = posType.includes('credit') || (netTxn && netTxn.price < 0);

        let spreadTriggered = null;
        let spreadDesc = '';
        if (isCreditSpread) {
          const costToClose = shortMid - longMid;
          if (costToClose > entryNet * 1.5) {
            spreadTriggered = 'stop';
            spreadDesc = `Cost-to-close **$${costToClose.toFixed(2)}** is >1.5x entry credit **$${entryNet.toFixed(2)}**`;
          } else if (costToClose < entryNet * 0.5) {
            spreadTriggered = 'target';
            spreadDesc = `Cost-to-close **$${costToClose.toFixed(2)}** is <0.5x entry credit **$${entryNet.toFixed(2)}** — 50% profit captured`;
          }
        } else {
          const currentValue = longMid - shortMid;
          if (currentValue < entryNet * 0.5) {
            spreadTriggered = 'stop';
            spreadDesc = `Current value **$${currentValue.toFixed(2)}** is <0.5x entry debit **$${entryNet.toFixed(2)}**`;
          } else if (currentValue > entryNet * 1.5) {
            spreadTriggered = 'target';
            spreadDesc = `Current value **$${currentValue.toFixed(2)}** is >1.5x entry debit **$${entryNet.toFixed(2)}** — 50%+ gain`;
          }
        }

        if (!spreadTriggered) continue;

        const spreadTitle = spreadTriggered === 'stop' ? '🛑 Spread Stop Hit' : '🎯 Spread Target Hit';
        const spreadColor = spreadTriggered === 'stop' ? 0xef4444 : 0x22c55e;
        const spreadBody = {
          content: null,
          embeds: [{
            title: spreadTitle,
            description: `**${ticker}** ${isCreditSpread ? 'Credit' : 'Debit'} Spread · ${spreadDesc}`,
            color: spreadColor,
            fields: [
              { name: 'Short Leg', value: `${shortLegDef.strike} ${shortLegDef.type || 'P'} @ $${shortMid.toFixed(2)}`, inline: true },
              { name: 'Long Leg', value: `${longLegDef.strike} ${longLegDef.type || 'P'} @ $${longMid.toFixed(2)}`, inline: true },
            ],
            footer: { text: 'Trading Journal' },
            timestamp: new Date().toISOString(),
          }],
        };
        try {
          await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(spreadBody),
          });
          sent++;
        } catch (discordErr) {
          console.warn('Discord spread alert failed:', discordErr.message);
        }
        continue;
      }

      // Skip 4-leg or other complex positions
      if (legs.length > 2) continue;

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

    // ── Time Stop Alerts ───────────────────────────────────────────
    // Alert when DTE <= threshold (3 for swing, 1 for shortTerm).
    // Uses DB expiration + strategy_type, no API call needed.
    for (const pos of positions) {
      const expiration = pos.expiration;
      if (!expiration) continue;

      const expDate = new Date(typeof expiration === 'string' ? expiration.slice(0, 10) + 'T16:00:00-04:00' : expiration);
      const now = new Date();
      const dte = Math.round((expDate.getTime() - now.getTime()) / 86400000);

      const stratType = pos.strategy_type || '';
      const threshold = stratType === 'shortTerm' ? 1 : 3;
      if (dte > threshold || dte < 0) continue;

      const ticker = (pos.ticker || '').toUpperCase();
      const legs = pos.legs || [];
      const spreadDesc = legs.length === 2
        ? `$${legs.find(l => l.side === 'short')?.strike || ''}/$${legs.find(l => l.side === 'long')?.strike || ''}${legs[0]?.type?.charAt(0) || 'P'}`
        : `${pos.strike || ''} ${pos.type || ''}`;

      const body = {
        content: null,
        embeds: [{
          title: '⏰ Time Stop',
          description: `**${ticker}** ${spreadDesc} — **DTE ${dte}**\nClose per ${stratType === 'shortTerm' ? 'short-term' : 'swing'} rules (threshold: DTE ≤ ${threshold}).`,
          color: 0xef4444, // red
          footer: { text: 'Trading Journal · Time Stop' },
          timestamp: new Date().toISOString(),
        }],
      };

      try {
        const discordRes = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (discordRes.ok) sent++;
        else console.warn('Discord time-stop alert failed', discordRes.status);
      } catch (e) {
        console.warn('Discord time-stop alert error:', e.message);
      }
    }

    return res.status(200).json({ ok: true, checked: positions.length, sent });
  } catch (err) {
    console.error('check-alerts error:', err);
    return res.status(500).json({ error: 'Internal error', message: err.message });
  }
}
