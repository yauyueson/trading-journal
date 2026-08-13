import { describe, it, expect } from 'vitest';
import { quoteMark, openLegRequests, legMarksFromQuotes } from '../optionMarks';
import type { Position } from '../types';

/** Real active PMCC (2026-08-12): open LEAP + open short + three rolled-off shorts. */
const pmcc: Position = {
    id: 'bdfe7c5e', ticker: 'QQQ', strike: 630, type: 'Call', expiration: '2027-01-15',
    status: 'active', setup: 'PMCC', entry_score: 0, current_score: 0, strategy_type: 'pmcc',
    legs: [
        { strike: 630, type: 'Call', side: 'long', expiration: '2027-01-15', openedDebit: 105.28, cycleQty: 1 },
        { strike: 732, type: 'Call', side: 'short', expiration: '2026-08-31', openedCredit: 6.46, cycleQty: 1 },
        { strike: 725, type: 'Call', side: 'short', expiration: '2026-06-12', openedCredit: 6.1, closedCost: 4.35, closedAt: '2026-06-05T18:18:26.866Z', cycleQty: 1 },
    ],
};

describe('quoteMark', () => {
    it('uses the bid/ask midpoint when both sides are quoted', () => {
        expect(quoteMark({ bid: 3.42, ask: 3.48, price: 99 })).toBeCloseTo(3.45, 6);
    });

    it('accepts a zero bid — a worthless short leg still has a real mark', () => {
        expect(quoteMark({ bid: 0, ask: 0.02, price: 0.01 })).toBeCloseTo(0.01, 6);
    });

    it('falls back to |price| when the spread is missing', () => {
        expect(quoteMark({ price: -2.5 })).toBe(2.5);
    });

    it('returns undefined for a failed or absent quote', () => {
        expect(quoteMark(undefined)).toBeUndefined();
        expect(quoteMark({ success: false, price: 3 })).toBeUndefined();
        expect(quoteMark({})).toBeUndefined();
    });
});

describe('openLegRequests', () => {
    it('requests open legs only — expired rolled-off shorts would 404', () => {
        const reqs = openLegRequests(pmcc);
        expect(reqs.map(r => r.strike)).toEqual([630, 732]);
        expect(reqs.every(r => r.ticker === 'QQQ' && r.id === 'bdfe7c5e')).toBe(true);
    });
});

describe('legMarksFromQuotes', () => {
    it('maps quotes back onto leg indices, leaving closed legs undefined', () => {
        const marks = legMarksFromQuotes(pmcc, [
            // Deliberately out of leg order — the bulk endpoint gives no ordering guarantee.
            { expiration: '2026-08-31', strike: 732, type: 'Call', bid: 7.98, ask: 8.13 },
            { expiration: '2027-01-15', strike: 630, type: 'Call', bid: 114.52, ask: 117.76 },
        ]);
        expect(marks[0]).toBeCloseTo(116.14, 6);
        expect(marks[1]).toBeCloseTo(8.055, 6);
        expect(marks[2]).toBeUndefined();
    });

    it('matches a string strike and an ISO-timestamp expiration', () => {
        const marks = legMarksFromQuotes(pmcc, [
            { expiration: '2027-01-15T00:00:00Z', strike: '630', type: 'Call', bid: 114.52, ask: 117.76 },
        ]);
        expect(marks[0]).toBeCloseTo(116.14, 6);
    });

    it('leaves an open leg undefined when its quote is missing or failed', () => {
        const marks = legMarksFromQuotes(pmcc, [
            { expiration: '2027-01-15', strike: 630, type: 'Call', success: false },
        ]);
        expect(marks[0]).toBeUndefined();
        expect(marks[1]).toBeUndefined();
    });

    it('does not match a same-strike put against a call leg', () => {
        const marks = legMarksFromQuotes(pmcc, [
            { expiration: '2027-01-15', strike: 630, type: 'Put', bid: 1, ask: 2 },
        ]);
        expect(marks[0]).toBeUndefined();
    });
});
