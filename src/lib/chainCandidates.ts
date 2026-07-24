/**
 * Chain candidate fetching + delta-matching helpers for the BCD and PMCC
 * entry modals. Queries `/api/scan-options` for a ticker × DTE × delta range,
 * then groups the returned contracts into spread / leg candidates the user
 * can pick from.
 *
 * The entry modals were originally shipped as manual-input forms
 * (see BCDEntryModal / PMCCEntryModal headers). This module adds the
 * "platform suggests candidates" layer the F1 plan's Phase C called for.
 */

export interface ChainOption {
    strike: number;
    type: 'Call' | 'Put';
    expiration: string;
    dte: number;
    price: number;
    greeks: {
        delta: number;
        gamma: number;
        theta: number;
        vega: number;
        iv: number;
    };
    liquidity: {
        volume: number;
        openInterest: number;
        bid: number;
        ask: number;
    };
}

export interface ScanOptionsResponse {
    success: boolean;
    results: ChainOption[];
    context?: {
        ticker?: string;
        currentPrice?: number;
        note?: string;
    };
}

export interface ScanOptionsQuery {
    ticker: string;
    direction: 'call' | 'put';
    /** 'long' returns the richer long-side shape; we use this for both legs. */
    strategy?: 'long' | 'short';
    dteMin: number;
    dteMax: number;
    minDelta: number;
    maxDelta: number;
    /** ± fraction of spot to bound strike range. Defaults to 0.25 server-side. */
    strikeRange?: number;
    /** Extra knobs for liquidity-sensitive LEAP scans. */
    minVolume?: number;
    maxSpreadPct?: number;
}

export async function fetchChainCandidates(q: ScanOptionsQuery): Promise<ChainOption[]> {
    const params = new URLSearchParams({
        ticker: q.ticker,
        direction: q.direction,
        strategy: q.strategy ?? 'long',
        dteMin: String(q.dteMin),
        dteMax: String(q.dteMax),
        minDelta: String(q.minDelta),
        maxDelta: String(q.maxDelta),
    });
    if (q.strikeRange != null) params.set('strikeRange', String(q.strikeRange));
    if (q.minVolume != null) params.set('minVolume', String(q.minVolume));
    if (q.maxSpreadPct != null) params.set('maxSpreadPct', String(q.maxSpreadPct));

    const res = await fetch(`/api/scan-options?${params.toString()}`);
    if (!res.ok) {
        throw new Error(`scan-options ${res.status}: ${await res.text().catch(() => 'unknown')}`);
    }
    const data: ScanOptionsResponse = await res.json();
    if (!data.success || !Array.isArray(data.results)) return [];
    return data.results;
}

/** Find the contract whose |delta| is closest to `target`, optionally filtered. */
export function findClosestDelta(
    options: ChainOption[],
    target: number,
    predicate?: (o: ChainOption) => boolean,
): ChainOption | null {
    let best: ChainOption | null = null;
    let bestDiff = Infinity;
    for (const opt of options) {
        if (predicate && !predicate(opt)) continue;
        const diff = Math.abs(Math.abs(opt.greeks.delta) - target);
        if (diff < bestDiff) {
            best = opt;
            bestDiff = diff;
        }
    }
    return best;
}

export interface BCDCandidate {
    expiration: string;
    dte: number;
    long: ChainOption;
    short: ChainOption;
    /** Net debit per share (so × 100 for per-contract dollars). */
    netDebit: number;
    /** Spread width in strike units. */
    width: number;
    /** Max profit per share (width − debit). */
    maxProfit: number;
    /** Breakeven = long strike + debit. */
    breakeven: number;
}

/**
 * Pair a fetched call-chain into BCD spread candidates — one per expiration
 * that has both a long (δ ≈ 0.50) and a short (δ ≈ 0.20) with short.strike
 * strictly above long.strike.
 */
export function buildBCDCandidates(
    options: ChainOption[],
    longDeltaTarget = 0.50,
    shortDeltaTarget = 0.20,
): BCDCandidate[] {
    const byExpiry = new Map<string, ChainOption[]>();
    for (const opt of options) {
        if (opt.type !== 'Call') continue;
        const list = byExpiry.get(opt.expiration) ?? [];
        list.push(opt);
        byExpiry.set(opt.expiration, list);
    }
    const candidates: BCDCandidate[] = [];
    for (const [expiration, expiryOpts] of byExpiry) {
        const long = findClosestDelta(expiryOpts, longDeltaTarget);
        if (!long) continue;
        const short = findClosestDelta(
            expiryOpts,
            shortDeltaTarget,
            o => o.strike > long.strike,
        );
        if (!short) continue;
        const netDebit = long.price - short.price;
        if (netDebit <= 0) continue;
        const width = short.strike - long.strike;
        candidates.push({
            expiration,
            dte: long.dte,
            long,
            short,
            netDebit,
            width,
            maxProfit: width - netDebit,
            breakeven: long.strike + netDebit,
        });
    }
    candidates.sort((a, b) => a.dte - b.dte);
    return candidates;
}

/** LEAP candidates: returned as-is, sorted by δ proximity to target. */
export function buildPMCCLeapCandidates(
    options: ChainOption[],
    targetDelta = 0.75,
): ChainOption[] {
    return options
        .filter(o => o.type === 'Call')
        .slice()
        .sort((a, b) => {
            const da = Math.abs(Math.abs(a.greeks.delta) - targetDelta);
            const db = Math.abs(Math.abs(b.greeks.delta) - targetDelta);
            return da - db;
        });
}

/** Short-leg candidates for a PMCC, keeping only contracts above the chosen LEAP strike. */
export function buildPMCCShortCandidates(
    options: ChainOption[],
    leapStrike: number,
    targetDelta = 0.25,
): ChainOption[] {
    return options
        .filter(o => o.type === 'Call' && o.strike > leapStrike)
        .slice()
        .sort((a, b) => {
            const da = Math.abs(Math.abs(a.greeks.delta) - targetDelta);
            const db = Math.abs(Math.abs(b.greeks.delta) - targetDelta);
            return da - db;
        });
}

export interface PMCCRollShortCandidateParams {
    leapStrike: number;
    currentShortStrike: number;
    currentShortExpiration?: string;
    targetDelta?: number;
}

/**
 * Roll-short candidates for a PMCC. Prefer an up-and-out roll. If the old
 * strike is now above every contract in the target delta band (common after an
 * OTM short expires), fall back to the best later-dated short above the LEAP
 * strike instead of returning an empty, fully manual ticket.
 */
export function buildPMCCRollShortCandidates(
    options: ChainOption[],
    params: PMCCRollShortCandidateParams,
): ChainOption[] {
    const laterDated = buildPMCCShortCandidates(
        options,
        params.leapStrike,
        params.targetDelta ?? 0.25,
    ).filter(option => (
        !params.currentShortExpiration
        || option.expiration > params.currentShortExpiration
    ));
    const upAndOut = laterDated.filter(option => option.strike > params.currentShortStrike);
    return upAndOut.length > 0 ? upAndOut : laterDated;
}
