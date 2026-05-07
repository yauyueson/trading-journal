import governanceRegistry from '../../config/strategy-governance.json';
import type { StrategyType } from './strategyProfiles';
import type { DirectAddItem, Position } from './types';

export type ExecutionMode = 'paper' | 'live';
export type TicketStatus = 'draft' | 'risk_approved' | 'blocked';
export type TicketDecision = 'approved' | 'blocked';
export type ActiveTicketStrategy = Extract<StrategyType, 'bcd' | 'pmcc'>;

export interface ActiveStrategyPosition {
  id: string;
  ticker: string;
  strategyType: StrategyType | null;
  isPaper: boolean;
  maxRiskDollars: number;
}

export interface ExecutionTicketInput {
  strategyType: ActiveTicketStrategy;
  requestedMode: ExecutionMode;
  ticker: string;
  quantity: number;
  maxRiskPerContract: number;
  accountSize: number;
  openedAt: string;
  candidateEvidencePath: string;
  activePositions: ActiveStrategyPosition[];
}

export interface ExecutionGateEvaluation {
  decision: TicketDecision;
  blocks: string[];
  warnings: string[];
  maxRiskDollars: number;
  tierRiskCapDollars: number;
  requiredApprovalRoles: string[];
}

export interface ExecutionTicket {
  id: string;
  status: TicketStatus;
  strategyType: ActiveTicketStrategy;
  strategyLabel: string;
  requestedMode: ExecutionMode;
  ticker: string;
  quantity: number;
  maxRiskPerContract: number;
  maxRiskDollars: number;
  riskCapDollars: number;
  openedAt: string;
  approvals: {
    trader: 'pending' | 'approved';
    riskManager: 'pending' | 'approved';
  };
  gate: ExecutionGateEvaluation;
  audit: {
    evidencePath: string;
    governanceVersion: number;
    liveRequires: string[];
  };
}

export interface ExecutionTicketAuditRow {
  ticket_id: string;
  status: TicketStatus;
  decision: TicketDecision;
  strategy_type: ActiveTicketStrategy;
  strategy_label: string;
  requested_mode: ExecutionMode;
  ticker: string;
  quantity: number;
  max_risk_per_contract: number;
  max_risk_dollars: number;
  risk_cap_dollars: number;
  account_size: number;
  evidence_path: string;
  governance_version: number;
  required_approval_roles: string[];
  approvals: ExecutionTicket['approvals'];
  blocks: string[];
  warnings: string[];
  active_positions_snapshot: ActiveStrategyPosition[];
  input_snapshot: Record<string, unknown>;
  position_id?: string | null;
}

type StrategyGovernanceEntry = {
  label: string;
  status: string;
  permission: {
    paper: boolean;
    live: boolean;
    liveRequires?: string[];
  };
  capitalTier: {
    startingCapital: number;
    riskPctPerTrade: number;
    maxConcurrentPositions: number;
  };
  riskPolicy: {
    underlying: string;
    maxConcurrentPositions: number;
    aggregateQqqExposureGroup?: string;
  };
};

type GovernanceRegistry = {
  version: number;
  strategies: Record<ActiveTicketStrategy, StrategyGovernanceEntry>;
};

const GOVERNANCE = governanceRegistry as GovernanceRegistry;
const CONTRACT_STRATEGY_ROLES = ['trader', 'risk-manager'];
const CLEAN_SHEET_EVIDENCE_PATH = 'docs/wfa/QQQ-CLEAN-SHEET-VALIDATION-RESULTS-2026-05-07.md';

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

function stableTicketId(input: ExecutionTicketInput): string {
  const timestamp = input.openedAt.replace(/[:.]/g, '-');
  return [
    'ticket',
    timestamp,
    input.strategyType,
    input.requestedMode,
    input.ticker.toUpperCase(),
    input.quantity,
  ].join('-');
}

export function evaluateExecutionTicket(input: ExecutionTicketInput): ExecutionGateEvaluation {
  const entry = GOVERNANCE.strategies[input.strategyType];
  const blocks: string[] = [];
  const warnings: string[] = [];
  const ticker = input.ticker.toUpperCase();
  const maxRiskDollars = input.maxRiskPerContract * input.quantity;
  const tierRiskCapDollars = entry.capitalTier.startingCapital * (entry.capitalTier.riskPctPerTrade / 100);

  if (entry.status !== 'paper-approved' && entry.status !== 'live-adopted') {
    blocks.push(`strategy status ${entry.status} is not tradable`);
  }
  if (input.requestedMode === 'paper' && !entry.permission.paper) {
    blocks.push('paper trading is blocked by strategy governance');
  }
  if (input.requestedMode === 'live' && !entry.permission.live) {
    blocks.push('live trading is blocked by strategy governance');
  }
  if (ticker !== entry.riskPolicy.underlying) {
    blocks.push(`strategy is governed for ${entry.riskPolicy.underlying} only`);
  }
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    blocks.push('quantity must be a positive integer');
  }
  if (!Number.isFinite(input.maxRiskPerContract) || input.maxRiskPerContract <= 0) {
    blocks.push('max risk per contract must be positive');
  }
  if (maxRiskDollars > tierRiskCapDollars) {
    blocks.push(`risk ${money(maxRiskDollars)} exceeds strategy tier cap ${money(tierRiskCapDollars)}`);
  }
  if (input.accountSize < entry.capitalTier.startingCapital) {
    blocks.push(`account size ${money(input.accountSize)} is below strategy capital tier ${money(entry.capitalTier.startingCapital)}`);
  }

  const sameStrategyActive = input.activePositions.filter(position =>
    position.strategyType === input.strategyType && position.ticker.toUpperCase() === ticker,
  );
  const maxConcurrent = entry.riskPolicy.maxConcurrentPositions ?? entry.capitalTier.maxConcurrentPositions;
  if (sameStrategyActive.length >= maxConcurrent) {
    blocks.push(`strategy already has ${sameStrategyActive.length} active position(s); max is ${maxConcurrent}`);
  }

  const otherQqqDirectional = input.activePositions.some(position =>
    position.strategyType !== input.strategyType &&
    position.ticker.toUpperCase() === entry.riskPolicy.underlying &&
    position.strategyType != null &&
    ['bcd', 'pmcc'].includes(position.strategyType),
  );
  if (otherQqqDirectional) {
    warnings.push('another QQQ directional strategy is already active; review aggregate delta and drawdown manually');
  }

  return {
    decision: blocks.length > 0 ? 'blocked' : 'approved',
    blocks,
    warnings,
    maxRiskDollars,
    tierRiskCapDollars,
    requiredApprovalRoles: [...CONTRACT_STRATEGY_ROLES],
  };
}

export function isGovernedDirectAddStrategy(
  strategyType: DirectAddItem['strategy_type'] | null | undefined,
): strategyType is ActiveTicketStrategy {
  return strategyType === 'bcd' || strategyType === 'pmcc';
}

function activePositionsFromPositions(positions: Position[]): ActiveStrategyPosition[] {
  return positions
    .filter(position => position.status === 'active')
    .map(position => ({
      id: position.id,
      ticker: position.ticker,
      strategyType: position.strategy_type ?? null,
      isPaper: position.is_paper ?? false,
      maxRiskDollars: position.max_risk_entry ?? 0,
    }));
}

export function buildExecutionTicketInputFromDirectAdd(
  item: DirectAddItem,
  activePositions: Position[],
  openedAt = new Date().toISOString(),
): ExecutionTicketInput | null {
  if (!isGovernedDirectAddStrategy(item.strategy_type)) return null;

  return {
    strategyType: item.strategy_type,
    requestedMode: item.is_paper === false ? 'live' : 'paper',
    ticker: item.ticker,
    quantity: item.quantity,
    maxRiskPerContract: item.max_risk_entry ?? 0,
    accountSize: item.execution_account_size ?? 0,
    openedAt,
    candidateEvidencePath: CLEAN_SHEET_EVIDENCE_PATH,
    activePositions: activePositionsFromPositions(activePositions),
  };
}

export function evaluateDirectAddExecutionGate(
  item: DirectAddItem,
  activePositions: Position[],
  openedAt = new Date().toISOString(),
): ExecutionGateEvaluation {
  const ticketInput = buildExecutionTicketInputFromDirectAdd(item, activePositions, openedAt);
  if (!ticketInput) {
    return {
      decision: 'approved',
      blocks: [],
      warnings: [],
      maxRiskDollars: 0,
      tierRiskCapDollars: 0,
      requiredApprovalRoles: [],
    };
  }
  return evaluateExecutionTicket(ticketInput);
}

export function assertDirectAddExecutionApproved(
  item: DirectAddItem,
  activePositions: Position[],
): ExecutionGateEvaluation {
  const gate = evaluateDirectAddExecutionGate(item, activePositions);
  if (gate.decision === 'blocked') {
    throw new Error(`Execution ticket blocked: ${gate.blocks.join('; ')}`);
  }
  return gate;
}

export function buildExecutionTicketAuditRowFromDirectAdd(
  item: DirectAddItem,
  activePositions: Position[],
  openedAt = new Date().toISOString(),
): ExecutionTicketAuditRow | null {
  const ticketInput = buildExecutionTicketInputFromDirectAdd(item, activePositions, openedAt);
  if (!ticketInput) return null;

  const ticket = buildExecutionTicket(ticketInput);
  const gate = ticket.gate;
  return {
    ticket_id: ticket.id,
    status: ticket.status,
    decision: gate.decision,
    strategy_type: ticket.strategyType,
    strategy_label: ticket.strategyLabel,
    requested_mode: ticket.requestedMode,
    ticker: ticket.ticker,
    quantity: ticket.quantity,
    max_risk_per_contract: ticket.maxRiskPerContract,
    max_risk_dollars: ticket.maxRiskDollars,
    risk_cap_dollars: ticket.riskCapDollars,
    account_size: ticketInput.accountSize,
    evidence_path: ticket.audit.evidencePath,
    governance_version: ticket.audit.governanceVersion,
    required_approval_roles: gate.requiredApprovalRoles,
    approvals: ticket.approvals,
    blocks: gate.blocks,
    warnings: gate.warnings,
    active_positions_snapshot: ticketInput.activePositions,
    input_snapshot: {
      ticker: item.ticker,
      strike: item.strike,
      type: item.type,
      expiration: item.expiration,
      setup: item.setup,
      strategy: item.strategy,
      entry_price: item.entry_price,
      max_risk_entry: item.max_risk_entry,
      spread_width: item.spread_width,
      is_paper: item.is_paper ?? false,
    },
    position_id: null,
  };
}

export function buildExecutionTicket(input: ExecutionTicketInput): ExecutionTicket {
  const entry = GOVERNANCE.strategies[input.strategyType];
  const gate = evaluateExecutionTicket(input);

  return {
    id: stableTicketId(input),
    status: gate.decision === 'approved' ? 'risk_approved' : 'blocked',
    strategyType: input.strategyType,
    strategyLabel: entry.label,
    requestedMode: input.requestedMode,
    ticker: input.ticker.toUpperCase(),
    quantity: input.quantity,
    maxRiskPerContract: input.maxRiskPerContract,
    maxRiskDollars: gate.maxRiskDollars,
    riskCapDollars: gate.tierRiskCapDollars,
    openedAt: input.openedAt,
    approvals: {
      trader: gate.decision === 'approved' ? 'approved' : 'pending',
      riskManager: gate.decision === 'approved' ? 'approved' : 'pending',
    },
    gate,
    audit: {
      evidencePath: input.candidateEvidencePath,
      governanceVersion: GOVERNANCE.version,
      liveRequires: entry.permission.liveRequires ?? [],
    },
  };
}
