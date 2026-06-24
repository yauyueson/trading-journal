import { describe, it, expect } from 'vitest';
import { evaluateExitProximity } from '../exitProximity';
import { STRATEGY_PROFILES } from '../strategyProfiles';
import type { Position } from '../types';

/** Local YYYY-MM-DD exactly n days from today (daysUntil → n). */
function isoDaysFromNow(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const bcdBase = {
  id: 'b1', ticker: 'QQQ', strike: 741, type: 'Call',
  status: 'active', setup: 'BCD', entry_score: 0, current_score: 0,
  strategy_type: 'bcd' as const,
  // entry net debit 13.75 (18.48 − 4.73), width 39 → max profit 25.25,
  // +50% target net value = 26.375.
  legs: [
    { strike: 741, type: 'Call' as const, side: 'long' as const, expiration: '2026-07-02', openedDebit: 18.48, cycleQty: 1 },
    { strike: 780, type: 'Call' as const, side: 'short' as const, expiration: '2026-07-02', openedCredit: 4.73, cycleQty: 1 },
  ],
};

function bcd(overrides: Partial<Position>): Position {
  return { ...bcdBase, expiration: isoDaysFromNow(40), current_price: 0, ...overrides } as Position;
}

describe('evaluateExitProximity — BCD', () => {
  it('none when far from the time stop and not near TP', () => {
    expect(evaluateExitProximity(bcd({ expiration: isoDaysFromNow(40), current_price: 3.95 }), STRATEGY_PROFILES.bcd).level).toBe('none');
  });

  it('time stop MET at DTE ≤ 7', () => {
    const r = evaluateExitProximity(bcd({ expiration: isoDaysFromNow(5), current_price: 3.95 }), STRATEGY_PROFILES.bcd);
    expect(r).toMatchObject({ level: 'met', reason: 'time' });
    expect(r.label).toContain('TIME STOP');
  });

  it('time stop CLOSE inside the buffer — DTE 9 → "EXIT IN 2d"', () => {
    const r = evaluateExitProximity(bcd({ expiration: isoDaysFromNow(9), current_price: 3.95 }), STRATEGY_PROFILES.bcd);
    expect(r).toMatchObject({ level: 'close', reason: 'time', label: 'EXIT IN 2d' });
  });

  it('TP READY when the net price reaches +50% of max profit (26.375)', () => {
    const r = evaluateExitProximity(bcd({ expiration: isoDaysFromNow(40), current_price: 26.375 }), STRATEGY_PROFILES.bcd);
    expect(r).toMatchObject({ level: 'met', reason: 'tp', label: 'TP READY' });
  });

  it('TP near (close) just below the target', () => {
    const r = evaluateExitProximity(bcd({ expiration: isoDaysFromNow(40), current_price: 25.0 }), STRATEGY_PROFILES.bcd);
    expect(r.level).toBe('close');
    expect(r.reason).toBe('tp');
    expect(r.label).toMatch(/^TP \d+%$/);
  });

  it('a MET time stop outranks a CLOSE take-profit', () => {
    const r = evaluateExitProximity(bcd({ expiration: isoDaysFromNow(5), current_price: 25.0 }), STRATEGY_PROFILES.bcd);
    expect(r.level).toBe('met');
  });
});

describe('evaluateExitProximity — PMCC returns none (exit signals stay on the card)', () => {
  it('PMCC has no time stop and TP needs leg marks → none', () => {
    const pmcc: Position = {
      id: 'p1', ticker: 'QQQ', strike: 630, type: 'Call', expiration: isoDaysFromNow(5),
      status: 'active', setup: 'PMCC', entry_score: 0, current_score: 0,
      strategy_type: 'pmcc', current_price: 100,
      legs: [
        { strike: 630, type: 'Call', side: 'long', expiration: '2027-01-15', openedDebit: 105.28, cycleQty: 1 },
        { strike: 756, type: 'Call', side: 'short', expiration: '2026-07-17', openedCredit: 7.32, cycleQty: 1 },
      ],
    } as Position;
    expect(evaluateExitProximity(pmcc, STRATEGY_PROFILES.pmcc).level).toBe('none');
  });
});
