#!/usr/bin/env tsx
/**
 * Post-day-1 check for the paper-autopilot experiment (2026-05-08 → 2026-06-07).
 * Queries execution_tickets and active QQQ BCD/PMCC paper positions.
 *
 * Usage:
 *   vercel env pull .env.local --environment=production && \
 *     set -a && source .env.local && set +a && \
 *     npx tsx scripts/check-paper-autopilot.ts
 *   npx tsx scripts/check-paper-autopilot.ts --since 2026-05-08
 */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL and/or SUPABASE_*_KEY env vars.');
  console.error('Hint: vercel env pull .env.local --environment=production && set -a && source .env.local && set +a');
  process.exit(1);
}

function parseSinceArg(): string {
  const idx = process.argv.indexOf('--since');
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const d = new Date(Date.now() - 7 * 86_400_000);
  return d.toISOString().slice(0, 10);
}

const since = parseSinceArg();
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

interface TicketRow {
  ticket_id: string;
  created_at: string;
  status: string;
  decision: string;
  strategy_type: string;
  strategy_label: string;
  ticker: string;
  quantity: number;
  max_risk_dollars: number;
  blocks: string[];
  warnings: string[];
  position_id: string | null;
  approvals: { source?: string } & Record<string, unknown>;
}

interface PositionRow {
  id: string;
  ticker: string;
  strategy_type: string | null;
  is_paper: boolean | null;
  status: string;
  created_at: string | null;
  strike: number | null;
  type: string | null;
  expiration: string | null;
  setup: string | null;
  max_risk_entry: number | null;
}

async function loadTickets(): Promise<TicketRow[]> {
  const { data, error } = await supabase
    .from('execution_tickets')
    .select('ticket_id,created_at,status,decision,strategy_type,strategy_label,ticker,quantity,max_risk_dollars,blocks,warnings,position_id,approvals')
    .gte('created_at', `${since}T00:00:00Z`)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`tickets query failed: ${error.message}`);
  return (data ?? []) as TicketRow[];
}

async function loadActivePositions(): Promise<PositionRow[]> {
  const { data, error } = await supabase
    .from('positions')
    .select('id,ticker,strategy_type,is_paper,status,created_at,strike,type,expiration,setup,max_risk_entry')
    .in('strategy_type', ['bcd', 'pmcc'])
    .eq('ticker', 'QQQ')
    .eq('status', 'active')
    .order('created_at', { ascending: false });
  if (error) throw new Error(`positions query failed: ${error.message}`);
  return (data ?? []) as PositionRow[];
}

function fmtTicket(t: TicketRow): string {
  const stamp = t.created_at.replace('T', ' ').slice(0, 19);
  const decision = t.decision === 'approved' ? '[OK ] approved' : '[!!!] blocked ';
  const linked = t.position_id ? ` -> ${t.position_id.slice(0, 8)}` : '';
  const src = t.approvals?.source ? ` (${t.approvals.source})` : '';
  const blocks = (t.blocks ?? []).length > 0 ? `\n         blocks: ${t.blocks.join('; ')}` : '';
  return `  ${stamp}  ${t.strategy_type.padEnd(4)} qty=${t.quantity} risk=$${t.max_risk_dollars}  ${decision}${linked}${src}${blocks}`;
}

function fmtPosition(p: PositionRow): string {
  const stamp = (p.created_at ?? '').replace('T', ' ').slice(0, 19);
  return `  ${stamp}  ${(p.strategy_type ?? '?   ').padEnd(4)} ${p.type ?? '?'} K=${p.strike} exp=${p.expiration} risk=$${p.max_risk_entry ?? 0}  paper=${p.is_paper ? 'Y' : 'N'}`;
}

async function main() {
  const [tickets, positions] = await Promise.all([loadTickets(), loadActivePositions()]);

  console.log('Paper Autopilot Check');
  console.log(`since: ${since}`);
  console.log(`now:   ${new Date().toISOString()}`);
  console.log('');

  console.log(`execution_tickets (${tickets.length} since ${since}):`);
  if (tickets.length === 0) {
    console.log('  (none)');
  } else {
    for (const t of tickets) console.log(fmtTicket(t));
  }
  console.log('');

  const approved = tickets.filter(t => t.decision === 'approved');
  const blocked = tickets.filter(t => t.decision === 'blocked');
  const autopilot = tickets.filter(t => t.approvals?.source === 'paper-autopilot');
  console.log(`  ${approved.length} approved | ${blocked.length} blocked | ${autopilot.length} from paper-autopilot`);
  console.log('');

  console.log(`active QQQ BCD/PMCC paper positions (${positions.length}):`);
  if (positions.length === 0) {
    console.log('  (none)');
  } else {
    for (const p of positions) console.log(fmtPosition(p));
  }
  console.log('');

  const orphaned = approved.filter(t => !t.position_id);
  if (orphaned.length > 0) {
    console.log(`WARN: ${orphaned.length} approved ticket(s) without a linked position_id`);
    for (const t of orphaned) console.log(`  ${t.ticket_id}`);
    process.exit(2);
  }
  if (approved.length > 0) console.log('OK: every approved ticket is linked to a position');
}

main().catch(err => {
  console.error('check failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
