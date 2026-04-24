import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export const formatDate = (d: string | null | undefined): string => {
    if (!d) return '—';
    // Handle YYYY-MM-DD string
    if (typeof d === 'string' && d.match(/^\d{4}-\d{2}-\d{2}$/)) {
        const [year, month, day] = d.split('-');
        const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

export const formatCurrency = (n: number | string): string => {
    const num = Number(n);
    if (isNaN(num)) return '$0.00';
    if (num >= 1000) return '$' + (num / 1000).toFixed(1) + 'K';
    return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

export const formatPrice = (n: number | string): string => '$' + Number(n).toFixed(2);

export const formatPercent = (n: number | string): string => {
    const num = Number(n);
    return (num >= 0 ? '+' : '') + num.toFixed(2) + '%';
};

export const daysUntil = (d: string): number => {
    if (!d) return 999;
    const [year, month, day] = d.split('-').map(Number);
    const target = new Date(year, month - 1, day);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.ceil((target.getTime() - today.getTime()) / 86400000);
};


// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _env = (import.meta as any).env ?? {};
export const SUPABASE_URL: string = _env.VITE_SUPABASE_URL ?? '';
export const SUPABASE_KEY: string = _env.VITE_SUPABASE_ANON_KEY ?? '';
export const CONTRACT_MULTIPLIER = 100;


import { STRATEGY_PROFILES, type StrategyType } from './strategyProfiles';

/**
 * Structural P&L kind for a position. Determines the sign convention
 * used by computePositionPnL and max-loss formulas in riskSizing.
 *
 *   credit   — entry is a credit (proceeds), exit is a debit (cost). P&L = cost - proceeds.
 *   debit    — entry is a debit (cost), exit is a credit (proceeds). P&L = proceeds - cost.
 *   diagonal — two legs with different expiries. Entry pays a net debit
 *              (long LEAP debit minus short-leg credit). Short legs roll over
 *              time. Treated like a debit for P&L sign (entry = net cost).
 *   single   — single-leg option (long). P&L = proceeds - cost.
 */
export type PositionPnLKind = 'credit' | 'debit' | 'diagonal' | 'single';

interface StrategyTypedPosition {
    strategy_type?: StrategyType | null;
    type?: string;
    legs?: unknown[];
}

/**
 * Determine the P&L/sign kind of a position.
 *
 * Priority:
 *   1. If strategy_type is set AND present in STRATEGY_PROFILES, map its
 *      `kind` field to a PnL kind (credit_spread → 'credit', etc.).
 *   2. Otherwise fall back to position.type string inspection (legacy path;
 *      e.g. "Put Credit Spread" → 'credit', single option → 'single').
 */
export function getStrategyKind(position: StrategyTypedPosition | null | undefined): PositionPnLKind {
    if (!position) return 'single';
    const st = position.strategy_type;
    if (st && STRATEGY_PROFILES[st]) {
        const profileKind = STRATEGY_PROFILES[st].kind;
        if (profileKind === 'credit_spread') return 'credit';
        if (profileKind === 'debit_spread') return 'debit';
        if (profileKind === 'diagonal') return 'diagonal';
    }
    // Legacy path: no strategy_type (or unknown) — infer from position.type.
    const posType = position.type ?? '';
    if (posType.includes('Credit') || posType.includes('Short')) return 'credit';
    if (posType.includes('Debit') || posType.includes('Spread')) {
        // "Put Spread" / "Call Spread" without "Credit" treated as debit.
        return posType.includes('Credit') ? 'credit' : 'debit';
    }
    return 'single';
}

/** Check if a position type is a credit strategy (Credit spreads, Short positions).
 *  Back-compat wrapper — new code should prefer getStrategyKind(position). */
export function isCreditStrategy(positionType: string): boolean {
    return positionType.includes('Credit') || positionType.includes('Short');
}

/** Compute realized P&L for a position from its transactions.
 *
 *  kind argument controls the sign convention:
 *    - 'credit': entry is a credit received, close is a debit paid. P&L = cost - proceeds.
 *    - 'debit' | 'diagonal' | 'single' (default): entry is a cost, close is a proceed. P&L = proceeds - cost.
 *
 *  The `boolean` overload is preserved for back-compat with existing callers that
 *  pass `isCreditStrategy(...)` directly.
 */
export function computePositionPnL(
    transactions: { quantity: number; price: number }[],
    kindOrIsCredit: PositionPnLKind | boolean = false,
): number {
    let cost = 0, proceeds = 0;
    transactions.forEach(t => {
        const dollars = t.price * CONTRACT_MULTIPLIER;
        if (t.quantity > 0) cost += t.quantity * dollars;
        else proceeds += Math.abs(t.quantity) * dollars;
    });
    const isCredit = typeof kindOrIsCredit === 'boolean' ? kindOrIsCredit : kindOrIsCredit === 'credit';
    return isCredit ? cost - proceeds : proceeds - cost;
}
