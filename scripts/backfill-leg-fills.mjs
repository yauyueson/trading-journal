// One-off: backfill openedDebit/openedCredit on existing autopilot-opened
// paper positions using current ORATS chain mid for the exact contracts.
// Values are APPROXIMATE — chain has drifted since the position was opened.
// fill_diagnostics row clearly notes this in `notes`.
import { createClient } from '@supabase/supabase-js';
import { getOptionChain } from '../lib/orats-client.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function midForContract(ticker, expiration, strike, type) {
  const chain = await getOptionChain(ticker, { side: type.toLowerCase() });
  const match = chain.find(c =>
    c.expiration === expiration && Number(c.strike) === Number(strike) && c.type === type
  );
  if (!match) return null;
  const bid = Number(match.bid);
  const ask = Number(match.ask);
  if (Number.isFinite(bid) && Number.isFinite(ask) && ask > 0) return { bid, ask, mid: (bid + ask) / 2 };
  return Number.isFinite(match.mid) ? { bid, ask, mid: match.mid } : null;
}

const { data: positions, error } = await supabase
  .from('positions')
  .select('id, ticker, strike, expiration, type, strategy_type, legs, status')
  .in('strategy_type', ['bcd', 'pmcc'])
  .eq('status', 'active');
if (error) { console.error(error); process.exit(1); }

async function netDebitFromTxns(positionId) {
  const { data } = await supabase
    .from('transactions')
    .select('type, price')
    .eq('position_id', positionId)
    .eq('type', 'Open')
    .order('date', { ascending: true })
    .limit(1);
  return data?.[0]?.price ?? null;
}

for (const pos of positions ?? []) {
  const netDebit = await netDebitFromTxns(pos.id);
  console.log(`\n[${pos.strategy_type.toUpperCase()}] ${pos.id} K=${pos.strike} netDebit=${netDebit != null ? '$' + netDebit : '—'}`);
  const legs = pos.legs ?? [];
  let touched = false;
  let totalLongDebit = null;
  let totalShortCredit = null;
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (leg.closedAt) continue;
    if (leg.openedCredit != null || leg.openedDebit != null) {
      console.log(`  leg[${i}] ${leg.side} K=${leg.strike} already populated — skip`);
      continue;
    }
    const quote = await midForContract(pos.ticker, leg.expiration, leg.strike, leg.type);
    if (!quote || !Number.isFinite(quote.mid)) {
      console.log(`  leg[${i}] ${leg.side} K=${leg.strike} no chain quote — skip`);
      continue;
    }
    const fill = Number(quote.mid.toFixed(2));
    if (leg.side === 'long') {
      legs[i] = { ...leg, openedDebit: fill, cycleQty: leg.cycleQty ?? 1 };
      totalLongDebit = fill;
      console.log(`  leg[${i}] long  K=${leg.strike}: openedDebit~$${fill} (mid bid=$${quote.bid} ask=$${quote.ask})`);
    } else {
      legs[i] = { ...leg, openedCredit: fill, cycleQty: leg.cycleQty ?? 1 };
      totalShortCredit = fill;
      console.log(`  leg[${i}] short K=${leg.strike}: openedCredit~$${fill} (mid bid=$${quote.bid} ask=$${quote.ask})`);
    }
    touched = true;
  }
  if (touched) {
    const upd = await supabase.from('positions').update({ legs }).eq('id', pos.id);
    if (upd.error) { console.error(`  position update failed: ${upd.error.message}`); continue; }
    console.log(`  position legs updated`);
    const fillRow = {
      position_id: pos.id,
      strategy_type: pos.strategy_type,
      quantity: 1,
      actual_net_debit: netDebit,
      actual_long_debit: totalLongDebit,
      actual_short_credit: totalShortCredit,
      legs: legs.map(l => ({
        side: l.side, strike: l.strike, type: l.type, expiration: l.expiration,
        fill: l.side === 'long' ? l.openedDebit : l.openedCredit,
      })),
      notes: 'APPROXIMATE backfill from chain mid at 2026-05-07T20:43Z — positions were autopilot-opened earlier same day; original entry fills were not captured. Numbers represent chain mid at backfill time, NOT actual fill prices.',
    };
    const fd = await supabase.from('fill_diagnostics').insert([fillRow]);
    if (fd.error) console.warn(`  fill_diagnostics insert failed: ${fd.error.message}`);
    else console.log(`  fill_diagnostics row inserted (approximation flagged in notes)`);
  }
}

console.log('\nDone.');
