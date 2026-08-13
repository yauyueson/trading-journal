/**
 * Live per-leg marks for a multi-leg position.
 *
 * The bulk option-price endpoint returns one quote per requested contract with
 * no positional guarantee, so quotes are matched back onto `position.legs` by
 * (expiration, strike, type). Closed legs are never requested — they expire out
 * of the chain and would 404 — and stay `undefined` in the mark array, which is
 * what computeNetSpreadPrice / computeLegBasedPnL already expect for them.
 */
import type { Position } from './types';

export interface OptionQuote {
    expiration?: string;
    strike?: number | string;
    type?: string;
    bid?: number;
    ask?: number;
    price?: number;
    success?: boolean;
}

export interface LegQuoteRequest {
    ticker: string;
    expiration: string;
    strike: number;
    type: string;
    id: string;
}

/** YYYY-MM-DD, so an ISO timestamp from the API still matches a date-only leg. */
const day = (value: string | undefined): string => (value ?? '').slice(0, 10);

/**
 * Per-share mark for one quote: the bid/ask midpoint when both sides are
 * quoted, otherwise the broker price. Mirrors PositionCard's per-leg marks so
 * the strategy summary and the position card can never disagree.
 */
export function quoteMark(quote: OptionQuote | undefined): number | undefined {
    if (!quote || quote.success === false) return undefined;
    const { bid, ask } = quote;
    if (typeof bid === 'number' && typeof ask === 'number' && ask > 0) return (bid + ask) / 2;
    return typeof quote.price === 'number' ? Math.abs(quote.price) : undefined;
}

/** Contracts worth quoting for a position: its OPEN legs only. */
export function openLegRequests(position: Position): LegQuoteRequest[] {
    return (position.legs ?? [])
        .filter(leg => !leg.closedAt)
        .map(leg => ({
            ticker: position.ticker,
            expiration: leg.expiration,
            strike: leg.strike,
            type: leg.type,
            id: position.id,
        }));
}

/** Marks indexed to match `position.legs`; closed or unquoted legs are undefined. */
export function legMarksFromQuotes(
    position: Position,
    quotes: OptionQuote[],
): Array<number | undefined> {
    return (position.legs ?? []).map(leg => {
        if (leg.closedAt) return undefined;
        const match = quotes.find(q =>
            day(q.expiration) === day(leg.expiration) &&
            Number(q.strike) === Number(leg.strike) &&
            q.type === leg.type
        );
        return quoteMark(match);
    });
}
