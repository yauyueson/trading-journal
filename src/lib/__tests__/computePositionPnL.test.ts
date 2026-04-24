import { describe, it, expect } from 'vitest';
import { computePositionPnL, isCreditStrategy, getStrategyKind, CONTRACT_MULTIPLIER } from '../utils';

describe('isCreditStrategy', () => {
  it('identifies credit spreads', () => {
    expect(isCreditStrategy('Credit Put Spread')).toBe(true);
    expect(isCreditStrategy('Credit Call Spread')).toBe(true);
  });
  it('identifies short positions', () => {
    expect(isCreditStrategy('Short Put')).toBe(true);
    expect(isCreditStrategy('Short Call')).toBe(true);
  });
  it('rejects debit strategies', () => {
    expect(isCreditStrategy('Debit Put Spread')).toBe(false);
    expect(isCreditStrategy('Long Call')).toBe(false);
    expect(isCreditStrategy('Put Spread')).toBe(false);
  });
});

describe('computePositionPnL', () => {
  // Credit spread: open receives credit (qty > 0, price = credit per share)
  // Close pays debit (qty < 0, price = cost to close per share)
  // P&L = credit_received - debit_paid

  it('credit spread: full profit (expire worthless)', () => {
    const txns = [
      { quantity: 1, price: 0.50 },   // Open: receive $0.50 credit
      { quantity: -1, price: 0.00 },   // Close: pay $0.00 (expired OTM)
    ];
    // cost = 1 * 0.50 * 100 = $50, proceeds = 1 * 0.00 * 100 = $0
    // credit P&L = cost - proceeds = $50
    expect(computePositionPnL(txns, true)).toBe(50);
  });

  it('credit spread: partial profit', () => {
    const txns = [
      { quantity: 1, price: 0.50 },   // Open: receive $0.50 credit
      { quantity: -1, price: 0.20 },   // Close: pay $0.20
    ];
    // cost = $50, proceeds = $20
    // credit P&L = $50 - $20 = $30
    expect(computePositionPnL(txns, true)).toBe(30);
  });

  it('credit spread: loss (SL hit)', () => {
    const txns = [
      { quantity: 1, price: 0.50 },   // Open: receive $0.50 credit
      { quantity: -1, price: 1.25 },   // Close: pay $1.25 (2.5x SL)
    ];
    // cost = $50, proceeds = $125
    // credit P&L = $50 - $125 = -$75
    expect(computePositionPnL(txns, true)).toBe(-75);
  });

  it('credit spread: multi-contract', () => {
    const txns = [
      { quantity: 3, price: 0.40 },   // Open 3 contracts
      { quantity: -3, price: 0.15 },  // Close 3 contracts
    ];
    // cost = 3 * 0.40 * 100 = $120, proceeds = 3 * 0.15 * 100 = $45
    // credit P&L = $120 - $45 = $75
    expect(computePositionPnL(txns, true)).toBe(75);
  });

  it('debit spread: profit', () => {
    const txns = [
      { quantity: 1, price: 2.00 },   // Open: pay $2.00 debit
      { quantity: -1, price: 3.50 },   // Close: receive $3.50
    ];
    // cost = $200, proceeds = $350
    // debit P&L = proceeds - cost = $150
    expect(computePositionPnL(txns, false)).toBe(150);
  });

  it('debit spread: loss', () => {
    const txns = [
      { quantity: 1, price: 2.00 },
      { quantity: -1, price: 0.50 },
    ];
    // cost = $200, proceeds = $50
    // debit P&L = $50 - $200 = -$150
    expect(computePositionPnL(txns, false)).toBe(-150);
  });

  it('handles empty transactions', () => {
    expect(computePositionPnL([], true)).toBe(0);
    expect(computePositionPnL([], false)).toBe(0);
  });

  it('handles open-only (no close yet)', () => {
    const txns = [{ quantity: 1, price: 0.50 }];
    // credit: cost = $50, proceeds = $0 → P&L = $50 (unrealized credit)
    expect(computePositionPnL(txns, true)).toBe(50);
    // debit: cost = $50, proceeds = $0 → P&L = -$50 (unrealized loss)
    expect(computePositionPnL(txns, false)).toBe(-50);
  });

  it('handles partial close', () => {
    const txns = [
      { quantity: 3, price: 0.50 },   // Open 3
      { quantity: -1, price: 0.10 },   // Close 1
    ];
    // cost = 3 * 50 = $150, proceeds = 1 * 10 = $10
    // credit P&L = $150 - $10 = $140
    expect(computePositionPnL(txns, true)).toBe(140);
  });

  it('defaults to debit when isCredit omitted', () => {
    const txns = [
      { quantity: 1, price: 1.00 },
      { quantity: -1, price: 1.50 },
    ];
    // debit P&L = $150 - $100 = $50
    expect(computePositionPnL(txns)).toBe(50);
  });

  it('CONTRACT_MULTIPLIER is 100', () => {
    expect(CONTRACT_MULTIPLIER).toBe(100);
  });
});

describe('getStrategyKind', () => {
  it('maps BCD strategy_type to debit kind (via profile lookup)', () => {
    expect(getStrategyKind({ strategy_type: 'bcd', type: 'Call Spread' })).toBe('debit');
  });

  it('maps PMCC strategy_type to diagonal kind (via profile lookup)', () => {
    expect(getStrategyKind({ strategy_type: 'pmcc', type: 'Call Spread' })).toBe('diagonal');
  });

  it('maps retired DTE5 strategy_type to credit kind (via profile lookup)', () => {
    expect(getStrategyKind({ strategy_type: 'dte5', type: 'Put Credit Spread' })).toBe('credit');
  });

  it('falls back to type-string inspection when strategy_type is absent', () => {
    expect(getStrategyKind({ type: 'Put Credit Spread' })).toBe('credit');
    expect(getStrategyKind({ type: 'Short Call' })).toBe('credit');
    expect(getStrategyKind({ type: 'Long Call' })).toBe('single');
  });

  it('returns "single" when neither strategy_type nor type signals a spread', () => {
    expect(getStrategyKind({})).toBe('single');
    expect(getStrategyKind(null)).toBe('single');
    expect(getStrategyKind(undefined)).toBe('single');
  });
});

describe('computePositionPnL with kind argument (Phase A — revamp generalization)', () => {
  it('kind="credit" matches the legacy boolean `true` signature', () => {
    const txns = [
      { quantity: 1, price: 0.50 },
      { quantity: -1, price: 0.20 },
    ];
    expect(computePositionPnL(txns, 'credit')).toBe(computePositionPnL(txns, true));
    expect(computePositionPnL(txns, 'credit')).toBe(30);
  });

  it('kind="debit" matches the legacy boolean `false` signature', () => {
    const txns = [
      { quantity: 1, price: 2.00 },
      { quantity: -1, price: 3.50 },
    ];
    expect(computePositionPnL(txns, 'debit')).toBe(computePositionPnL(txns, false));
    expect(computePositionPnL(txns, 'debit')).toBe(150);
  });

  it('kind="diagonal" uses proceeds - cost (same sign as debit)', () => {
    // PMCC open: pay LEAP debit $10.00, receive short credit $1.50, net debit $8.50
    // Close LEAP later: receive $12.00, close short: pay $0.20
    // cost = (1 * 10.00 + 1 * 0.20) * 100 = $1020
    // proceeds = (1 * 1.50 + 1 * 12.00) * 100 = $1350
    // P&L = proceeds - cost = $330
    const txns = [
      { quantity: 1, price: 10.00 },   // open LEAP
      { quantity: -1, price: 1.50 },   // open short (credit received)
      { quantity: 1, price: 0.20 },    // close short (buy-to-close)
      { quantity: -1, price: 12.00 },  // close LEAP (sell-to-close)
    ];
    expect(computePositionPnL(txns, 'diagonal')).toBe(330);
  });

  it('kind="single" uses proceeds - cost (long-option convention)', () => {
    const txns = [
      { quantity: 1, price: 3.00 },
      { quantity: -1, price: 5.50 },
    ];
    expect(computePositionPnL(txns, 'single')).toBe(250);
  });
});
