/**
 * 定时检查：Active 持仓是否触及止损或目标价，触及则发 Discord 提醒。
 * 由 Vercel Cron 或外部 Cron 定期调用（如每 15 分钟）。
 *
 * 环境变量：
 *   CRON_SECRET          - 鉴权密钥，与请求 ?secret= 一致
 *   DISCORD_WEBHOOK_URL  - Discord Webhook URL
 *   SUPABASE_URL / VITE_SUPABASE_URL
 *   SUPABASE_ANON_KEY / VITE_SUPABASE_ANON_KEY
 *   VERCEL_URL           - 部署域名，用于内调 option-price（Vercel 自动注入）
 */

const { createClient } = require('@supabase/supabase-js');

const CONTRACT_MULTIPLIER = 100;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 1. 鉴权：仅允许带正确 secret 的调用（Cron 或你自己）
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

  const supabase = createClient(supabaseUrl, supabaseKey);
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : process.env.BASE_URL || 'http://localhost:3000';

  try {
    // 2. 拉取所有 Active 持仓
    const { data: positions, error: posErr } = await supabase
      .from('positions')
      .select('*')
      .eq('status', 'active');

    if (posErr) {
      console.error('Supabase positions error:', posErr);
      return res.status(500).json({ error: 'Failed to fetch positions' });
    }
    if (!positions || positions.length === 0) {
      return res.status(200).json({ ok: true, message: 'No active positions', sent: 0 });
    }

    // 3. 拉取所有 transactions（用于算入场价、是否部分止盈）
    const { data: transactions, error: txnErr } = await supabase
      .from('transactions')
      .select('*');

    if (txnErr) {
      console.error('Supabase transactions error:', txnErr);
      return res.status(500).json({ error: 'Failed to fetch transactions' });
    }
    const txnsByPos = (transactions || []).reduce((acc, t) => {
      if (!acc[t.position_id]) acc[t.position_id] = [];
      acc[t.position_id].push(t);
      return acc;
    }, {});

    let sent = 0;

    for (const pos of positions) {
      // 仅处理单腿仓位（价差后续可扩展）
      const legs = pos.legs || [];
      if (legs.length >= 2) continue;

      const posTxns = txnsByPos[pos.id] || [];
      const firstBuy = posTxns.find(t => t.quantity > 0);
      const entryPrice = firstBuy ? Math.abs(firstBuy.price) : 0;
      if (!entryPrice) continue;

      const hasTakenProfit = posTxns.some(t => t.type === 'Take Profit');
      const isCreditStrategy = legs.length >= 2; // 单腿视为 debit
      const currentStopLoss = isCreditStrategy
        ? entryPrice * 1.5
        : (hasTakenProfit ? entryPrice * 0.75 : entryPrice * 0.5);

      const targetPrice = pos.target_price || (isCreditStrategy ? entryPrice * 0.5 : entryPrice * 1.25);

      // 4. 获取当前价（调用自己的 option-price API）
      const optionPriceUrl = `${baseUrl}/api/option-price?ticker=${encodeURIComponent(pos.ticker)}&expiration=${encodeURIComponent(pos.expiration)}&strike=${pos.strike}&type=${encodeURIComponent(pos.type || 'Call')}`;
      let currentPrice = null;
      try {
        const priceRes = await fetch(optionPriceUrl);
        if (priceRes.ok) {
          const priceData = await priceRes.json();
          currentPrice = priceData.price ?? priceData.mid ?? null;
        }
      } catch (e) {
        console.warn('option-price fetch failed for', pos.ticker, pos.strike, e.message);
        continue;
      }

      if (currentPrice == null) continue;

      let triggered = null; // 'stop' | 'target'

      if (isCreditStrategy) {
        if (currentPrice >= currentStopLoss) triggered = 'stop';
        else if (targetPrice != null && currentPrice <= targetPrice) triggered = 'target';
      } else {
        if (currentPrice <= currentStopLoss) triggered = 'stop';
        else if (targetPrice != null && currentPrice >= targetPrice) triggered = 'target';
      }

      if (!triggered) continue;

      // 5. 发 Discord
      const ticker = pos.ticker || '';
      const strike = pos.strike || '';
      const type = (pos.type || 'Call').toUpperCase().slice(0, 1);
      const title = triggered === 'stop' ? '🛑 触及止损' : '🎯 触及目标价';
      const color = triggered === 'stop' ? 0xef4444 : 0x22c55e;
      const level = triggered === 'stop' ? '止损' : '目标';
      const levelPrice = triggered === 'stop' ? currentStopLoss : targetPrice;

      const body = {
        content: null,
        embeds: [{
          title,
          description: `${ticker} ${strike}${type} · 当前价 **$${Number(currentPrice).toFixed(2)}** 已触及${level} **$${Number(levelPrice).toFixed(2)}**`,
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

    return res.status(200).json({ ok: true, checked: positions.length, sent });
  } catch (err) {
    console.error('check-alerts error:', err);
    return res.status(500).json({ error: 'Internal error', message: err.message });
  }
}
