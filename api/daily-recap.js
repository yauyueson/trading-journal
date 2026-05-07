/**
 * Daily Recap：每日汇总所有 Active 持仓，发一条 Discord 消息。
 * Triggered externally via cronjobs.org (21:30 UTC / 4:30 PM ET daily).
 *
 * 直接调用 CBOE 延迟行情 API 获取当前价，不再自引用 /api/option-price。
 *
 * 环境变量：
 *   CRON_SECRET, DISCORD_WEBHOOK_URL, SUPABASE_URL, SUPABASE_ANON_KEY
 */

import { DATA_SOURCE } from '../lib/_shared/config.js';
import { supabaseQuery } from '../lib/_shared/supabase-rest.js';

function sendJson(res, status, obj) {
  try {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  } catch (_) {
    try {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal error');
    } catch (__) { }
  }
}

import { generateOCCSymbol, findOptionMid } from '../lib/_shared/utils.js';

export default async function handler(req, res) {
  if (!res || typeof res.writeHead !== 'function') return;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const secret = (req.query && req.query.secret) || (req.headers && req.headers['authorization'] && String(req.headers['authorization']).replace('Bearer ', ''));
  const expectedSecret = process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;
  if (!expectedSecret || secret !== expectedSecret) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    sendJson(res, 500, { error: 'DISCORD_WEBHOOK_URL not set' });
    return;
  }

  try {
    const positionsRaw = await supabaseQuery('positions', 'status=eq.active&select=*');
    const positions = Array.isArray(positionsRaw) ? positionsRaw : [];
    const positionIds = positions.map(function (p) { return p.id; }).filter(Boolean);
    const transactionsRaw = positionIds.length > 0
      ? await supabaseQuery('transactions', 'position_id=in.(' + positionIds.join(',') + ')&select=*')
      : [];
    const transactions = Array.isArray(transactionsRaw) ? transactionsRaw : [];

    const txnsByPos = transactions.reduce(function (acc, t) {
      if (t && t.position_id) {
        if (!acc[t.position_id]) acc[t.position_id] = [];
        acc[t.position_id].push(t);
      }
      return acc;
    }, {});

    // --- Fetch option chains once per unique ticker ---
    const uniqueTickers = [...new Set(positions.map(function (p) { return (p.ticker || '').toUpperCase(); }).filter(Boolean))];
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
          await Promise.all(uniqueTickers.map(async function (ticker) {
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

    if (dataSource === 'CBOE' || Object.keys(optionChains).length === 0) {
      await Promise.all(uniqueTickers.map(async function (ticker) {
        try {
          const cboeUrl = 'https://cdn.cboe.com/api/global/delayed_quotes/options/' + ticker + '.json';
          const resp = await fetch(cboeUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          });
          if (resp.ok) {
            const data = await resp.json();
            optionChains[ticker] = (data && data.data && data.data.options) || [];
          }
        } catch (e) {
          console.warn('CBOE fetch failed for', ticker, e.message);
        }
      }));
    }

    // --- Helpers ---
    const maxFields = 25;
    const MAX_FIELD_NAME = 256;
    const MAX_FIELD_VALUE = 1024;
    function truncate(s, max) {
      var str = s != null ? String(s) : '';
      return str.length > max ? str.slice(0, max - 3) + '...' : str;
    }

    function formatExp(exp) {
      if (exp == null) return '';
      var s = typeof exp === 'string' ? exp.slice(0, 10) : '';
      if (!s || s.length < 10) return '';
      var d = new Date(s);
      if (Number.isNaN(d.getTime())) return s;
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
    }

    function parseLegs(legs) {
      if (Array.isArray(legs)) return legs;
      if (typeof legs === 'string') {
        try { var p = JSON.parse(legs); return Array.isArray(p) ? p : []; } catch (_) { return []; }
      }
      return [];
    }

    // --- Process each position ---
    const rows = [];
    let totalPnl = 0;

    for (const pos of positions) {
      if (!pos || typeof pos !== 'object') continue;
      try {
        const ticker = (pos.ticker || '').toUpperCase();
        const chain = optionChains[ticker] || [];
        const legs = parseLegs(pos.legs);
        const posTxns = txnsByPos[pos.id] || [];
        const firstBuy = posTxns.find(function (t) { return t.quantity > 0; });
        const entryPrice = firstBuy ? Math.abs(firstBuy.price) : 0;

        // PMCC rolls insert paired Take-Profit txns whose net cash flow is
        // already captured on position.legs (closedCost / openedCredit). Skip
        // them so they don't decrement quantity twice or trip the
        // taken-profit heuristic for stop calc.
        const isRollTxn = function (t) {
          return t && typeof t.note === 'string' && t.note.startsWith('PMCC roll:');
        };
        const accountingTxns = posTxns.filter(function (t) { return !isRollTxn(t); });

        // Compute remaining quantity
        let quantity = 0;
        for (const t of accountingTxns) {
          if (t.type === 'Open' || t.type === 'Size Up') quantity += t.quantity;
          else if (t.type === 'Size Down' || t.type === 'Take Profit' || t.type === 'Close') quantity -= Math.abs(t.quantity);
        }
        if (quantity <= 0 && !entryPrice) continue;
        const qty = quantity || 1;

        // Determine if credit strategy
        const isCredit = (pos.type && (pos.type.includes('Credit') || pos.type.includes('Short'))) || false;

        // Stop price: manual > calculated fallback
        const hasTakenProfit = accountingTxns.some(function (t) { return t.type === 'Take Profit'; });
        const calculatedStop = isCredit
          ? entryPrice * 1.5
          : (hasTakenProfit ? entryPrice * 0.75 : entryPrice * 0.5);
        const stopPrice = pos.stop_price != null ? pos.stop_price : calculatedStop;

        // Expiration string
        const expStr = typeof pos.expiration === 'string'
          ? pos.expiration.slice(0, 10)
          : '';

        // --- Current price lookup ---
        let currentPrice = null;

        if (legs.length >= 2) {
          // Multi-leg: compute net value from individual leg prices
          let netValue = 0;
          let allFound = true;
          for (const leg of legs) {
            if (!leg || leg.strike == null) { allFound = false; break; }
            const legExp = leg.expiration ? String(leg.expiration).slice(0, 10) : expStr;
            const legType = leg.type || 'Call';
            const legPrice = findOptionMid(chain, ticker, legExp, leg.strike, legType);
            if (legPrice == null) { allFound = false; break; }
            // long leg = positive value, short leg = negative value
            const side = (leg.side || 'long').toLowerCase();
            netValue += side === 'short' ? -legPrice : legPrice;
          }
          if (allFound) {
            // For display: show absolute net value as "current price"
            currentPrice = Math.abs(netValue);
            // P&L: credit = entry + netValue (net is negative for credit), debit = netValue - entry
            const pnlPerShare = isCredit ? (entryPrice + netValue) : (netValue - entryPrice);
            const pnl = pnlPerShare * qty;
            totalPnl += pnl;
            rows.push(buildRow(pos, legs, qty, entryPrice, currentPrice, pnl, stopPrice, expStr, formatExp));
          } else {
            // Couldn't get all leg prices
            rows.push(buildRow(pos, legs, qty, entryPrice, null, 0, stopPrice, expStr, formatExp));
          }
        } else {
          // Single-leg
          if (pos.ticker && expStr && pos.strike != null) {
            currentPrice = findOptionMid(chain, ticker, expStr, pos.strike, pos.type || 'Call');
          }
          const pnlPerContract = (currentPrice != null && entryPrice)
            ? (isCredit ? entryPrice - currentPrice : currentPrice - entryPrice)
            : 0;
          const pnl = pnlPerContract * qty;
          if (currentPrice != null && entryPrice) totalPnl += pnl;
          rows.push(buildRow(pos, legs, qty, entryPrice, currentPrice, pnl, stopPrice, expStr, formatExp));
        }
      } catch (posErr) {
        console.warn('daily-recap skip position', pos.id || pos.ticker, posErr.message || posErr);
        rows.push({
          name: (pos.ticker || '?') + ' (error)',
          value: 'Could not load: ' + (posErr.message || 'unknown'),
          pnl: 0,
        });
      }
    }

    // --- Build Discord embed ---
    const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    const totalPnlStr = totalPnl >= 0 ? '+$' + Number(totalPnl).toFixed(2) : '-$' + Number(Math.abs(totalPnl)).toFixed(2);
    const color = totalPnl >= 0 ? 0x22c55e : 0xef4444;

    let embed;
    if (rows.length === 0) {
      embed = {
        title: '📋 Daily Position Recap',
        description: '**' + dateStr + '**\n\nNo active positions.',
        color: 0x64748b,
        footer: { text: 'Trading Journal' },
        timestamp: new Date().toISOString(),
      };
    } else {
      const fields = rows.slice(0, maxFields).map(function (r) {
        return {
          name: truncate(r.name, MAX_FIELD_NAME),
          value: truncate(r.value, MAX_FIELD_VALUE),
          inline: false,
        };
      });
      if (rows.length > maxFields) {
        fields.push({ name: '—', value: '*... and ' + (rows.length - maxFields) + ' more positions*', inline: false });
      }
      embed = {
        title: '📋 Daily Position Recap · ' + dateStr,
        description: truncate('**Total P&L: ' + totalPnlStr + '** · ' + rows.length + ' position(s)', 4096),
        color: color,
        fields: fields,
        footer: { text: 'Trading Journal' },
        timestamp: new Date().toISOString(),
      };
    }

    const discordRes = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: null, embeds: [embed] }),
    });

    if (!discordRes.ok) {
      await discordRes.text().catch(function () { });
      sendJson(res, 502, { error: 'Discord send failed', status: discordRes.status });
      return;
    }

    sendJson(res, 200, { ok: true, positions: rows.length, totalPnl: totalPnl, sent: true });
  } catch (err) {
    const msg = (err && (err.message || String(err))) || 'Unknown error';
    sendJson(res, 500, { error: 'Internal error', message: String(msg).slice(0, 500) });
  }
}

/** Build a Discord embed field row for a position. */
function buildRow(pos, legs, qty, entryPrice, currentPrice, pnl, stopPrice, expStr, formatExp) {
  const ticker = pos.ticker || '?';
  const expLabel = formatExp(expStr);

  // Title: "AAPL 150C · Mar 20, 26 ×2" or "SPY (2 legs) · Mar 20, 26"
  let name;
  if (legs.length >= 2) {
    const legsSummary = legs.map(function (l) {
      if (!l) return '?';
      var t = ((l.type || 'Call') + '').toUpperCase().slice(0, 1);
      var s = ((l.side || 'long') + '').toLowerCase().slice(0, 1);
      return (l.strike || '?') + t + s;
    }).join('/');
    name = ticker + ' ' + legsSummary;
  } else {
    var strike = pos.strike || '';
    var typeChar = (pos.type || 'Call').toUpperCase().slice(0, 1);
    name = ticker + ' ' + strike + typeChar;
  }
  if (expLabel) name += ' · ' + expLabel;
  if (qty !== 1) name += ' ×' + qty;

  // Value: Entry → Now | P&L | Stop
  var entryStr = entryPrice ? '$' + Number(entryPrice).toFixed(2) : '—';
  var nowStr = currentPrice != null ? '$' + Number(currentPrice).toFixed(2) : 'N/A';
  var pnlStr = (currentPrice != null && entryPrice)
    ? (pnl >= 0 ? '+' : '') + '$' + Number(pnl).toFixed(2)
    : '—';
  var stopStr = stopPrice != null ? '$' + Number(stopPrice).toFixed(2) : '—';

  var value = 'Entry ' + entryStr + ' → Now ' + nowStr
    + '\nP&L ' + pnlStr + ' (' + qty + ' contract' + (qty !== 1 ? 's' : '') + ')'
    + '\nStop ' + stopStr;

  return { name: name, value: value, pnl: pnl };
}
