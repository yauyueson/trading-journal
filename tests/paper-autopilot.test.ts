import { describe, expect, it } from 'vitest';

import {
  buildAutopilotPlan,
  buildBcdPaperPosition,
  buildPmccPaperPosition,
  chooseBcdCandidate,
  choosePmccCandidate,
} from '../lib/_shared/paper-autopilot.js';

const bcdChain = [
  { type: 'Call', expiration: '2026-06-19', dte: 43, strike: 430, delta: 0.51, bid: 12, ask: 12.4, mid: 12.2, openInterest: 100, volume: 10 },
  { type: 'Call', expiration: '2026-06-19', dte: 43, strike: 460, delta: 0.21, bid: 3.1, ask: 3.3, mid: 3.2, openInterest: 100, volume: 10 },
  { type: 'Call', expiration: '2026-06-19', dte: 43, strike: 470, delta: 0.12, bid: 1.4, ask: 1.6, mid: 1.5, openInterest: 100, volume: 10 },
];

const pmccLongChain = [
  { type: 'Call', expiration: '2027-02-19', dte: 287, strike: 390, delta: 0.76, bid: 82, ask: 84, mid: 83, openInterest: 100, volume: 10 },
  { type: 'Call', expiration: '2027-02-19', dte: 287, strike: 420, delta: 0.60, bid: 62, ask: 64, mid: 63, openInterest: 100, volume: 10 },
];

const pmccShortChain = [
  { type: 'Call', expiration: '2026-06-19', dte: 43, strike: 460, delta: 0.26, bid: 3.1, ask: 3.3, mid: 3.2, openInterest: 100, volume: 10 },
  { type: 'Call', expiration: '2026-06-19', dte: 43, strike: 380, delta: 0.72, bid: 38, ask: 39, mid: 38.5, openInterest: 100, volume: 10 },
];

describe('paper autopilot planning', () => {
  it('runs only on weekdays inside the one-month experiment window', () => {
    expect(buildAutopilotPlan({
      now: new Date('2026-05-09T14:00:00-04:00'),
      positions: [],
    }).run).toBe(false);
    expect(buildAutopilotPlan({
      now: new Date('2026-06-08T14:00:00-04:00'),
      positions: [],
    }).run).toBe(false);
    expect(buildAutopilotPlan({
      now: new Date('2026-05-11T14:00:00-04:00'),
      positions: [],
    }).run).toBe(true);
  });

  it('plans PMCC when flat and BCD only when cadence allows it', () => {
    const plan = buildAutopilotPlan({
      now: new Date('2026-05-18T14:00:00-04:00'),
      positions: [
        { id: 'old-bcd', strategy_type: 'bcd', ticker: 'QQQ', status: 'closed', created_at: '2026-05-07T14:00:00.000Z', is_paper: true },
      ],
    });

    expect(plan.attempts.map(a => a.strategyType)).toEqual(['bcd', 'pmcc']);
    expect(plan.attempts.every(a => a.mode === 'paper')).toBe(true);
  });

  it('skips active strategies and BCD cadence violations', () => {
    const plan = buildAutopilotPlan({
      now: new Date('2026-05-12T14:00:00-04:00'),
      positions: [
        { id: 'active-pmcc', strategy_type: 'pmcc', ticker: 'QQQ', status: 'active', created_at: '2026-05-10T14:00:00.000Z', is_paper: true },
        { id: 'recent-bcd', strategy_type: 'bcd', ticker: 'QQQ', status: 'closed', created_at: '2026-05-07T14:00:00.000Z', is_paper: true },
      ],
    });

    expect(plan.attempts).toEqual([]);
    expect(plan.skips).toContainEqual(expect.objectContaining({ strategyType: 'pmcc', reason: 'already_active' }));
    expect(plan.skips).toContainEqual(expect.objectContaining({ strategyType: 'bcd', reason: 'cadence_wait' }));
  });
});

describe('paper autopilot candidate selection', () => {
  it('selects governed BCD legs and builds a direct-add paper position', () => {
    const candidate = chooseBcdCandidate(bcdChain);
    expect(candidate).toMatchObject({
      longLeg: expect.objectContaining({ strike: 430 }),
      shortLeg: expect.objectContaining({ strike: 460 }),
    });

    const item = buildBcdPaperPosition(candidate!, '2026-05-11T14:00:00.000Z');
    expect(item).toMatchObject({
      ticker: 'QQQ',
      strategy_type: 'bcd',
      is_paper: true,
      quantity: 1,
      entry_price: 9.3,
      max_risk_entry: 930,
    });
  });

  it('selects governed PMCC legs and builds a direct-add paper position', () => {
    const candidate = choosePmccCandidate(pmccLongChain, pmccShortChain);
    expect(candidate).toMatchObject({
      longLeg: expect.objectContaining({ strike: 390 }),
      shortLeg: expect.objectContaining({ strike: 460 }),
    });

    const item = buildPmccPaperPosition(candidate!, '2026-05-11T14:00:00.000Z');
    expect(item).toMatchObject({
      ticker: 'QQQ',
      strategy_type: 'pmcc',
      is_paper: true,
      quantity: 1,
      entry_price: 80.9,
      max_risk_entry: 8400,
    });
  });
});
