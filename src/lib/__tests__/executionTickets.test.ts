import { describe, expect, it } from 'vitest';

import {
  buildExecutionTicket,
  buildExecutionTicketAuditRowFromDirectAdd,
  buildExecutionTicketInputFromDirectAdd,
  evaluateExecutionTicket,
  evaluateDirectAddExecutionGate,
  type ExecutionTicketInput,
} from '../executionTickets';
import type { DirectAddItem, Position } from '../types';

const baseInput: ExecutionTicketInput = {
  strategyType: 'bcd',
  requestedMode: 'paper',
  ticker: 'QQQ',
  quantity: 1,
  maxRiskPerContract: 250,
  accountSize: 25_000,
  openedAt: '2026-05-07T14:00:00.000Z',
  candidateEvidencePath: 'docs/wfa/QQQ-CLEAN-SHEET-VALIDATION-RESULTS-2026-05-07.md',
  activePositions: [],
};

describe('execution ticket risk gate', () => {
  it('approves a paper ticket when governance, sizing, and concentration checks pass', () => {
    const evaluation = evaluateExecutionTicket(baseInput);

    expect(evaluation.decision).toBe('approved');
    expect(evaluation.maxRiskDollars).toBe(250);
    expect(evaluation.requiredApprovalRoles).toEqual(['trader', 'risk-manager']);
    expect(evaluation.blocks).toEqual([]);

    const ticket = buildExecutionTicket(baseInput);
    expect(ticket.status).toBe('risk_approved');
    expect(ticket.strategyLabel).toBe('BCD QQQ wide');
    expect(ticket.audit.evidencePath).toBe(baseInput.candidateEvidencePath);
  });

  it('blocks live tickets while governance live permission is false', () => {
    const evaluation = evaluateExecutionTicket({ ...baseInput, requestedMode: 'live' });

    expect(evaluation.decision).toBe('blocked');
    expect(evaluation.blocks).toContain('live trading is blocked by strategy governance');
  });

  it('blocks tickets that exceed capital-tier risk or same-strategy concurrency', () => {
    const oversized = evaluateExecutionTicket({ ...baseInput, maxRiskPerContract: 350 });
    expect(oversized.decision).toBe('blocked');
    expect(oversized.blocks).toContain('risk $350.00 exceeds strategy tier cap $300.00');

    const duplicate = evaluateExecutionTicket({
      ...baseInput,
      activePositions: [{ id: 'p1', ticker: 'QQQ', strategyType: 'bcd', isPaper: true, maxRiskDollars: 200 }],
    });
    expect(duplicate.decision).toBe('blocked');
    expect(duplicate.blocks).toContain('strategy already has 1 active position(s); max is 1');
  });

  it('blocks wrong underlyings and warns on aggregate QQQ directional exposure', () => {
    const wrongTicker = evaluateExecutionTicket({ ...baseInput, ticker: 'SPY' });
    expect(wrongTicker.decision).toBe('blocked');
    expect(wrongTicker.blocks).toContain('strategy is governed for QQQ only');

    const withOtherQqqStrategy = evaluateExecutionTicket({
      ...baseInput,
      activePositions: [{ id: 'p2', ticker: 'QQQ', strategyType: 'pmcc', isPaper: true, maxRiskDollars: 4_000 }],
    });
    expect(withOtherQqqStrategy.decision).toBe('approved');
    expect(withOtherQqqStrategy.warnings).toContain('another QQQ directional strategy is already active; review aggregate delta and drawdown manually');
  });

  it('converts BCD/PMCC direct-add requests into governed paper tickets', () => {
    const item: DirectAddItem = {
      ticker: 'QQQ',
      strike: 430,
      type: 'Debit Call Spread',
      expiration: '2026-06-19',
      setup: 'BCD QQQ wide F1',
      strategy: 'Bull Call Debit Spread',
      entry_score: 0,
      quantity: 1,
      entry_price: 2.5,
      max_risk_entry: 250,
      strategy_type: 'bcd',
      is_paper: true,
      execution_account_size: 25_000,
    };

    const ticketInput = buildExecutionTicketInputFromDirectAdd(item, []);

    expect(ticketInput).toMatchObject({
      strategyType: 'bcd',
      requestedMode: 'paper',
      ticker: 'QQQ',
      maxRiskPerContract: 250,
      accountSize: 25_000,
    });
    expect(evaluateDirectAddExecutionGate(item, []).decision).toBe('approved');
  });

  it('blocks direct-add requests before persistence when active BCD/PMCC exposure violates the gate', () => {
    const item: DirectAddItem = {
      ticker: 'QQQ',
      strike: 430,
      type: 'Debit Call Spread',
      expiration: '2026-06-19',
      setup: 'BCD QQQ wide F1',
      entry_score: 0,
      quantity: 1,
      entry_price: 2.5,
      max_risk_entry: 250,
      strategy_type: 'bcd',
      is_paper: true,
      execution_account_size: 25_000,
    };
    const active: Position[] = [{
      id: 'p1',
      ticker: 'QQQ',
      strike: 430,
      type: 'Debit Call Spread',
      expiration: '2026-06-19',
      status: 'active',
      setup: 'BCD QQQ wide F1',
      entry_score: 0,
      current_score: 0,
      strategy_type: 'bcd',
      is_paper: true,
      max_risk_entry: 250,
    }];

    const result = evaluateDirectAddExecutionGate(item, active);

    expect(result.decision).toBe('blocked');
    expect(result.blocks).toContain('strategy already has 1 active position(s); max is 1');
  });

  it('builds durable audit rows for approved and blocked direct-add ticket decisions', () => {
    const item: DirectAddItem = {
      ticker: 'QQQ',
      strike: 430,
      type: 'Debit Call Spread',
      expiration: '2026-06-19',
      setup: 'BCD QQQ wide F1',
      entry_score: 0,
      quantity: 1,
      entry_price: 2.5,
      max_risk_entry: 250,
      strategy_type: 'bcd',
      is_paper: true,
      execution_account_size: 25_000,
    };
    const approved = buildExecutionTicketAuditRowFromDirectAdd(item, [], '2026-05-07T14:00:00.000Z');
    expect(approved).not.toBeNull();
    expect(approved).toMatchObject({
      ticket_id: 'ticket-2026-05-07T14-00-00-000Z-bcd-paper-QQQ-1',
      status: 'risk_approved',
      decision: 'approved',
      strategy_type: 'bcd',
      requested_mode: 'paper',
      ticker: 'QQQ',
      quantity: 1,
      max_risk_dollars: 250,
      risk_cap_dollars: 300,
      evidence_path: 'docs/wfa/QQQ-CLEAN-SHEET-VALIDATION-RESULTS-2026-05-07.md',
      governance_version: 1,
      blocks: [],
    });
    expect(approved!.input_snapshot).toMatchObject({ setup: 'BCD QQQ wide F1' });

    const blocked = buildExecutionTicketAuditRowFromDirectAdd(
      { ...item, is_paper: false },
      [],
      '2026-05-07T14:00:00.000Z',
    );
    expect(blocked?.status).toBe('blocked');
    expect(blocked?.decision).toBe('blocked');
    expect(blocked?.blocks).toContain('live trading is blocked by strategy governance');
  });

  it('uses timestamped ticket ids so repeat attempts are audit-safe', () => {
    const item: DirectAddItem = {
      ticker: 'QQQ',
      strike: 430,
      type: 'Debit Call Spread',
      expiration: '2026-06-19',
      setup: 'BCD QQQ wide F1',
      entry_score: 0,
      quantity: 1,
      entry_price: 2.5,
      max_risk_entry: 250,
      strategy_type: 'bcd',
      is_paper: true,
      execution_account_size: 25_000,
    };

    const first = buildExecutionTicketAuditRowFromDirectAdd(item, [], '2026-05-07T14:00:00.000Z');
    const second = buildExecutionTicketAuditRowFromDirectAdd(item, [], '2026-05-07T14:00:01.000Z');

    expect(first?.ticket_id).not.toBe(second?.ticket_id);
  });
});
