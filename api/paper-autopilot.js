// api/paper-autopilot.js
// One-month BCD/PMCC paper-autopilot. Paper only: no broker API and no live
// orders. Every attempted trade writes an execution_tickets row before any
// paper position can be inserted.

import { createClient } from '@supabase/supabase-js';
import {
  PAPER_AUTOPILOT,
  buildAutopilotPlan,
  buildBcdPaperPosition,
  buildPmccPaperPosition,
  chooseBcdCandidate,
  choosePmccCandidate,
} from '../lib/_shared/paper-autopilot.js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

function authOk(req) {
  const secret = req.query.secret || req.headers.authorization?.replace('Bearer ', '');
  const expected = process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;
  return Boolean(expected && secret === expected);
}

function ticketId(date, strategyType) {
  return `autopilot-${date}-${strategyType}`;
}

function ticketEvaluation(item, activePositions) {
  const strategy = item.strategy_type;
  const cap = strategy === 'bcd'
    ? PAPER_AUTOPILOT.bcd.capital * (PAPER_AUTOPILOT.bcd.riskPct / 100)
    : PAPER_AUTOPILOT.pmcc.capital * (PAPER_AUTOPILOT.pmcc.riskPct / 100);
  const blocks = [];
  const warnings = [];
  const maxRisk = (item.max_risk_entry ?? 0) * item.quantity;

  if (!item.is_paper) blocks.push('paper autopilot cannot create live tickets');
  if ((item.ticker || '').toUpperCase() !== PAPER_AUTOPILOT.ticker) blocks.push('strategy is governed for QQQ only');
  if (!Number.isInteger(item.quantity) || item.quantity <= 0) blocks.push('quantity must be a positive integer');
  if (maxRisk <= 0) blocks.push('max risk per contract must be positive');
  if (maxRisk > cap) blocks.push(`risk $${maxRisk.toFixed(2)} exceeds strategy tier cap $${cap.toFixed(2)}`);

  const sameActive = activePositions.filter(position =>
    position.status === 'active' &&
    position.strategy_type === strategy &&
    (position.ticker || '').toUpperCase() === PAPER_AUTOPILOT.ticker,
  );
  if (sameActive.length > 0) blocks.push(`strategy already has ${sameActive.length} active position(s); max is 1`);

  const otherQqq = activePositions.some(position =>
    position.status === 'active' &&
    position.strategy_type !== strategy &&
    ['bcd', 'pmcc'].includes(position.strategy_type) &&
    (position.ticker || '').toUpperCase() === PAPER_AUTOPILOT.ticker,
  );
  if (otherQqq) warnings.push('another QQQ directional strategy is already active; review aggregate delta and drawdown manually');

  return {
    decision: blocks.length > 0 ? 'blocked' : 'approved',
    status: blocks.length > 0 ? 'blocked' : 'risk_approved',
    blocks,
    warnings,
    maxRisk,
    cap,
  };
}

function buildTicketRow({ date, item, evaluation, activePositions }) {
  const strategyType = item.strategy_type;
  const strategyLabel = strategyType === 'bcd' ? 'BCD QQQ wide' : 'PMCC QQQ pt60';
  return {
    ticket_id: ticketId(date, strategyType),
    status: evaluation.status,
    decision: evaluation.decision,
    strategy_type: strategyType,
    strategy_label: strategyLabel,
    requested_mode: 'paper',
    ticker: PAPER_AUTOPILOT.ticker,
    quantity: item.quantity,
    max_risk_per_contract: item.max_risk_entry ?? 0,
    max_risk_dollars: evaluation.maxRisk,
    risk_cap_dollars: evaluation.cap,
    account_size: item.execution_account_size ?? 0,
    evidence_path: PAPER_AUTOPILOT.evidencePath,
    governance_version: 1,
    required_approval_roles: ['trader', 'risk-manager'],
    approvals: evaluation.decision === 'approved'
      ? { trader: 'approved', riskManager: 'approved', source: 'paper-autopilot' }
      : { trader: 'pending', riskManager: 'pending', source: 'paper-autopilot' },
    blocks: evaluation.blocks,
    warnings: evaluation.warnings,
    active_positions_snapshot: activePositions.map(position => ({
      id: position.id,
      ticker: position.ticker,
      status: position.status,
      strategy_type: position.strategy_type,
      is_paper: position.is_paper,
      max_risk_entry: position.max_risk_entry,
      created_at: position.created_at,
    })),
    input_snapshot: {
      setup: item.setup,
      type: item.type,
      expiration: item.expiration,
      strike: item.strike,
      entry_price: item.entry_price,
      legs: item.legs,
      source: 'paper-autopilot',
    },
  };
}

async function insertBlockedTicket(supabase, date, strategyType, blockReason, activePositions) {
  const item = {
    ticker: PAPER_AUTOPILOT.ticker,
    strategy_type: strategyType,
    is_paper: true,
    quantity: 1,
    max_risk_entry: 0,
    execution_account_size: strategyType === 'bcd' ? PAPER_AUTOPILOT.bcd.capital : PAPER_AUTOPILOT.pmcc.capital,
    setup: `${strategyType.toUpperCase()} paper autopilot blocked`,
    type: 'Paper Autopilot Block',
    expiration: date,
    strike: 0,
    entry_price: 0,
    legs: [],
  };
  const evaluation = ticketEvaluation(item, activePositions);
  evaluation.blocks = [blockReason];
  evaluation.decision = 'blocked';
  evaluation.status = 'blocked';
  const row = buildTicketRow({ date, item, evaluation, activePositions });
  const { error } = await supabase.from('execution_tickets').upsert(row, { onConflict: 'ticket_id' });
  if (error) throw new Error(`execution_tickets blocked insert failed: ${error.message}`);
  return { strategyType, decision: 'blocked', blocks: evaluation.blocks };
}

async function loadActivePositions(supabase) {
  const { data, error } = await supabase
    .from('positions')
    .select('id,ticker,status,created_at,strategy_type,is_paper,max_risk_entry')
    .in('strategy_type', ['bcd', 'pmcc'])
    .eq('ticker', PAPER_AUTOPILOT.ticker)
    .order('created_at', { ascending: false })
    .limit(25);
  if (error) throw new Error(`positions query failed: ${error.message}`);
  return data ?? [];
}

async function openPaperPosition(supabase, item) {
  const { data, error } = await supabase.from('positions').insert([{
    ticker: item.ticker,
    strike: item.strike,
    type: item.type,
    expiration: item.expiration,
    setup: item.setup,
    strategy: item.strategy,
    status: 'active',
    entry_score: item.entry_score,
    current_score: item.entry_score,
    score_updated_at: new Date().toISOString(),
    notes: `${item.ticker} ${item.type} · paper autopilot`,
    legs: item.legs,
    direction: item.direction,
    max_risk_entry: item.max_risk_entry,
    trade_profile: item.trade_profile,
    spread_width: item.spread_width ?? null,
    strategy_type: item.strategy_type,
    is_paper: true,
    target_price: item.target_price,
  }]).select('id');
  if (error) throw new Error(`position insert failed: ${error.message}`);
  const position = data?.[0];
  if (!position?.id) throw new Error('position insert returned no id');

  const tx = await supabase.from('transactions').insert([{
    position_id: position.id,
    type: 'Open',
    quantity: item.quantity,
    price: item.entry_price,
    note: 'Paper autopilot entry',
  }]);
  if (tx.error) throw new Error(`transaction insert failed: ${tx.error.message}`);
  return position.id;
}

async function executeAttempt({ supabase, date, attempt, activePositions }) {
  const existing = await supabase
    .from('execution_tickets')
    .select('ticket_id,decision,position_id')
    .eq('ticket_id', ticketId(date, attempt.strategyType))
    .maybeSingle();
  if (existing.error) throw new Error(`ticket duplicate check failed: ${existing.error.message}`);
  if (existing.data) {
    return { strategyType: attempt.strategyType, decision: 'skipped', reason: 'ticket_exists', ticketId: existing.data.ticket_id };
  }

  const { getOptionChain } = await import('../lib/orats-client.js');
  let item = null;

  if (attempt.strategyType === 'bcd') {
    const chain = await getOptionChain(PAPER_AUTOPILOT.ticker, { minDte: 30, maxDte: 60, side: 'call' });
    const candidate = chooseBcdCandidate(chain);
    if (!candidate) return insertBlockedTicket(supabase, date, 'bcd', 'no valid BCD option candidate found', activePositions);
    item = buildBcdPaperPosition(candidate);
  } else {
    const longChain = await getOptionChain(PAPER_AUTOPILOT.ticker, { minDte: 240, maxDte: 300, side: 'call' });
    const shortChain = await getOptionChain(PAPER_AUTOPILOT.ticker, { minDte: 30, maxDte: 45, side: 'call' });
    const candidate = choosePmccCandidate(longChain, shortChain);
    if (!candidate) return insertBlockedTicket(supabase, date, 'pmcc', 'no valid PMCC option candidate found', activePositions);
    item = buildPmccPaperPosition(candidate);
  }

  const evaluation = ticketEvaluation(item, activePositions);
  const row = buildTicketRow({ date, item, evaluation, activePositions });
  const { error: ticketError } = await supabase.from('execution_tickets').insert([row]);
  if (ticketError) throw new Error(`execution_tickets insert failed: ${ticketError.message}`);

  if (evaluation.decision === 'blocked') {
    return { strategyType: attempt.strategyType, decision: 'blocked', blocks: evaluation.blocks, ticketId: row.ticket_id };
  }

  const positionId = await openPaperPosition(supabase, item);
  const { error: updateError } = await supabase
    .from('execution_tickets')
    .update({ position_id: positionId })
    .eq('ticket_id', row.ticket_id);
  if (updateError) throw new Error(`execution_tickets position link failed: ${updateError.message}`);
  activePositions.push({
    id: positionId,
    ticker: item.ticker,
    status: 'active',
    created_at: new Date().toISOString(),
    strategy_type: item.strategy_type,
    is_paper: true,
    max_risk_entry: item.max_risk_entry,
  });

  return { strategyType: attempt.strategyType, decision: 'opened', positionId, ticketId: row.ticket_id };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase env not set' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const now = req.query.date ? new Date(`${req.query.date}T14:00:00-04:00`) : new Date();

  try {
    const activePositions = await loadActivePositions(supabase);
    const plan = buildAutopilotPlan({ now, positions: activePositions });
    if (!plan.run) return res.status(200).json({ ok: true, plan, results: [] });

    const results = [];
    for (const attempt of plan.attempts) {
      results.push(await executeAttempt({ supabase, date: plan.date, attempt, activePositions }));
    }
    return res.status(200).json({ ok: true, plan, results });
  } catch (error) {
    console.error('[paper-autopilot]', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
}
