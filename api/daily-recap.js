/**
 * Daily Recap：每日汇总所有 Active 持仓，发一条 Discord 消息。
 * 由 Vercel Cron 每天调用一次（vercel.json 中 schedule: "30 21 * * *" = 21:30 UTC = 美东 16:30）。
 *
 * 环境变量：与 check-alerts 相同
 *   CRON_SECRET, DISCORD_WEBHOOK_URL, SUPABASE_*, VERCEL_URL
 */

export default async function handler(req, res) {
  const safeJson = (obj) => {
    try {
      res.setHeader('Content-Type', 'application/json');
      return res.status(500).json(obj);
    } catch (_) {
      try { res.status(500).end('Internal error'); } catch (__) {}
    }
  };

  try {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = (req.query && req.query.secret) || (req.headers && req.headers['authorization'] && String(req.headers['authorization']).replace('Bearer ', ''));
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

  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : (process.env.BASE_URL || 'http://localhost:3000');

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
    const positionsRaw = await supabaseQuery('positions', 'status=eq.active&select=*');
    const positions = Array.isArray(positionsRaw) ? positionsRaw : [];
    const transactionsRaw = await supabaseQuery('transactions', 'select=*');
    const transactions = Array.isArray(transactionsRaw) ? transactionsRaw : [];

    const txnsByPos = transactions.reduce((acc, t) => {
      if (t && t.position_id) {
        if (!acc[t.position_id]) acc[t.position_id] = [];
        acc[t.position_id].push(t);
      }
      return acc;
    }, {});

    const rows = [];
    let totalPnl = 0;
    const maxFields = 25;
    const MAX_FIELD_NAME = 256;
    const MAX_FIELD_VALUE = 1024;
    function truncate(s, max) {
      const str = s != null ? String(s) : '';
      return str.length > max ? str.slice(0, max - 3) + '...' : str;
    }

    function formatExp(exp) {
      if (exp == null) return '';
      let s = '';
      if (typeof exp === 'string') s = exp.slice(0, 10);
      else if (exp && typeof exp.toISOString === 'function') s = exp.toISOString().slice(0, 10);
      if (!s || s.length < 10) return '';
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) return s;
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
    }

    function parseLegs(legs) {
      if (Array.isArray(legs)) return legs;
      if (typeof legs === 'string') {
        try {
          const parsed = JSON.parse(legs);
          return Array.isArray(parsed) ? parsed : [];
        } catch (_) {
          return [];
        }
      }
      return [];
    }

    for (const pos of positions) {
      if (!pos || typeof pos !== 'object') continue;
      try {
      const legs = parseLegs(pos.legs);
      if (legs.length >= 2) {
        const stopPrice = pos.stop_price;
        const tgtPrice = pos.target_price;
        const setup = (pos.setup != null && pos.setup !== '') ? String(pos.setup) : '—';
        const legsSummary = legs.map(l => {
          if (!l || typeof l !== 'object') return '?';
          const t = (l.type != null ? String(l.type) : 'Call').toUpperCase().slice(0, 1);
          const s = (l.side != null ? String(l.side) : 'long').toLowerCase().slice(0, 1);
          const strike = l.strike != null ? l.strike : '?';
          return `${strike}${t}${s}`;
        }).join(' / ');
        const stopStr = stopPrice != null ? `$${Number(stopPrice).toFixed(2)}` : '—';
        const tgtStr = tgtPrice != null ? `$${Number(tgtPrice).toFixed(2)}` : '—';
        const value = `Setup: ${setup}\nLegs: ${legsSummary}\nStop ${stopStr} · Target ${tgtStr}`;
        rows.push({
          name: `${pos.ticker || '?'} (多腿 · ${legs.length} legs)`,
          value,
          pnl: 0,
        });
        continue;
      }

      const posTxns = txnsByPos[pos.id] || [];
      const firstBuy = posTxns.find(t => t.quantity > 0);
      const entryPrice = firstBuy ? Math.abs(firstBuy.price) : 0;

      let quantity = 0;
      for (const t of posTxns) {
        if (t.type === 'Open' || t.type === 'Size Up') quantity += t.quantity;
        else if (t.type === 'Size Down' || t.type === 'Take Profit' || t.type === 'Close') quantity -= Math.abs(t.quantity);
      }
      if (quantity <= 0 && !entryPrice) continue;

      const hasTakenProfit = posTxns.some(t => t.type === 'Take Profit');
      const isCreditStrategy = legs.length >= 2;
      const calculatedStopLoss = isCreditStrategy
        ? entryPrice * 1.5
        : (hasTakenProfit ? entryPrice * 0.75 : entryPrice * 0.5);
      const currentStopLoss = pos.stop_price ?? calculatedStopLoss;
      const targetPrice = pos.target_price || (isCreditStrategy ? entryPrice * 0.5 : entryPrice * 1.25);

      let currentPrice = null;
      const expStr = pos.expiration ? (typeof pos.expiration === 'string' ? pos.expiration : pos.expiration.toISOString?.()?.slice(0, 10) : '') : '';
      if (pos.ticker && expStr && pos.strike != null) {
        try {
          const optionPriceUrl = `${baseUrl}/api/option-price?ticker=${encodeURIComponent(pos.ticker)}&expiration=${encodeURIComponent(expStr)}&strike=${pos.strike}&type=${encodeURIComponent(pos.type || 'Call')}`;
          const priceRes = await fetch(optionPriceUrl);
          if (priceRes.ok) {
            const priceData = await priceRes.json();
            currentPrice = priceData.price ?? priceData.mid ?? null;
          }
        } catch (e) {
          console.warn('option-price fetch failed for', pos.ticker, pos.strike, e.message);
        }
      }

      const ticker = pos.ticker || '';
      const strike = pos.strike || '';
      const typeChar = (pos.type || 'Call').toUpperCase().slice(0, 1);
      const qty = quantity || 1;
      const pnlPerContract = currentPrice != null && entryPrice
        ? (isCreditStrategy ? entryPrice - currentPrice : currentPrice - entryPrice)
        : 0;
      const pnl = pnlPerContract * qty;
      totalPnl += pnl;

      const entryStr = entryPrice ? `$${Number(entryPrice).toFixed(2)}` : '—';
      const nowStr = currentPrice != null ? `$${Number(currentPrice).toFixed(2)}` : '— (price unavailable)';
      const pnlStr = currentPrice != null && entryPrice
        ? `${pnl >= 0 ? '+' : ''}$${Number(pnl).toFixed(2)} (${qty} contract${qty !== 1 ? 's' : ''})`
        : '—';
      const stopStr = `Stop $${Number(currentStopLoss).toFixed(2)} · Target $${Number(targetPrice).toFixed(2)}`;
      const expLabel = formatExp(pos.expiration) ? ` · ${formatExp(pos.expiration)}` : '';

      rows.push({
        name: `${ticker} ${strike}${typeChar}${expLabel}${qty !== 1 ? ` ×${qty}` : ''}`,
        value: `Entry ${entryStr} → Now ${nowStr}\nP&L ${pnlStr}\n${stopStr}`,
        pnl,
      });
      } catch (posErr) {
        console.warn('daily-recap skip position', pos?.id || pos?.ticker, posErr?.message || posErr);
        rows.push({
          name: `${pos?.ticker || '?'} (error)`,
          value: `Could not load: ${posErr?.message || 'unknown'}`,
          pnl: 0,
        });
      }
    }

    const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    const totalPnlStr = totalPnl >= 0 ? `+$${Number(totalPnl).toFixed(2)}` : `-$${Number(Math.abs(totalPnl)).toFixed(2)}`;
    const color = totalPnl >= 0 ? 0x22c55e : 0xef4444;

    let embed;
    if (rows.length === 0) {
      embed = {
        title: '📋 Daily Position Recap',
        description: `**${dateStr}**\n\nNo active positions.`,
        color: 0x64748b,
        footer: { text: 'Trading Journal' },
        timestamp: new Date().toISOString(),
      };
    } else {
      const fields = rows.slice(0, maxFields).map(r => ({
        name: truncate(r.name, MAX_FIELD_NAME),
        value: truncate(r.value, MAX_FIELD_VALUE),
        inline: false,
      }));
      if (rows.length > maxFields) {
        fields.push({
          name: '—',
          value: `*... and ${rows.length - maxFields} more positions*`,
          inline: false,
        });
      }
      embed = {
        title: `📋 Daily Position Recap · ${dateStr}`,
        description: truncate(`**Total P&L: ${totalPnlStr}** · ${rows.length} position(s)`, 4096),
        color,
        fields,
        footer: { text: 'Trading Journal' },
        timestamp: new Date().toISOString(),
      };
    }

    const discordRes = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: null,
        embeds: [embed],
      }),
    });

    if (!discordRes.ok) {
      console.warn('Discord webhook failed', discordRes.status, await discordRes.text());
      return res.status(502).json({ error: 'Discord send failed', status: discordRes.status });
    }

    return res.status(200).json({
      ok: true,
      positions: rows.length,
      totalPnl,
      sent: true,
    });
  } catch (err) {
    const msg = err && (err.message || (typeof err.toString === 'function' ? err.toString() : String(err))) || 'Unknown error';
    try {
      return res.status(500).json({ error: 'Internal error', message: String(msg).slice(0, 500) });
    } catch (_) {
      try { res.status(500).end('Internal error'); } catch (__) {}
    }
  }
  } catch (topErr) {
    const msg = topErr && (topErr.message || (typeof topErr.toString === 'function' ? topErr.toString() : String(topErr))) || 'Unknown error';
    safeJson({ error: 'Internal error', message: String(msg).slice(0, 500) });
  }
}
