/**
 * Portfolio-based risk sizing for options strategies.
 * Risk is defined as stop-out level (e.g. 50% loss), not full max loss.
 * Survival-first: maxRiskPerTrade = portfolioTotal * riskPct, contracts_cap = floor(maxRiskPerTrade / riskPerContractAtStopOut).
 * Optional: 0.25 Kelly as advantage cap; maxContracts = min(contracts_cap, contracts_kelly).
 */

import type { SpreadRecommendation, SingleLegRecommendation, Recommendation } from './types';
import type { Position } from './types';

const CONTRACT_MULTIPLIER = 100;

/** Stop-out level: we size and display risk as "lose this much then stop" (e.g. 50% of max loss). */
export const STOP_OUT_PCT = 0.5;

/**
 * Estimate max loss in dollars for an existing position (for risk % display).
 * Single leg: cost at risk = entryPrice * 100 * qty.
 * Credit spread: (width - credit) * 100 * qty; debit spread: debit * 100 * qty.
 */
export function getPositionMaxLossDollars(
    position: Position,
    totalQty: number,
    entryPricePerShare: number
): number {
    if (totalQty <= 0) return 0;
    const isSpread = !!position.legs && position.legs.length >= 2;
    const isCredit = position.type?.includes('Credit') || position.type?.includes('Short');

    if (!isSpread) {
        return entryPricePerShare * CONTRACT_MULTIPLIER * totalQty;
    }
    const shortLeg = position.legs!.find(l => l.side === 'short');
    const longLeg = position.legs!.find(l => l.side === 'long');
    const width = shortLeg && longLeg
        ? Math.abs(shortLeg.strike - longLeg.strike)
        : 0;
    if (isCredit && width > 0) {
        return (width - entryPricePerShare) * CONTRACT_MULTIPLIER * totalQty;
    }
    return entryPricePerShare * CONTRACT_MULTIPLIER * totalQty;
}

/** Risk in dollars at stop-out for an existing position.
 *  If the position has a manual stop_price, risk = |entryPrice - stopPrice| × 100 × qty.
 *  Otherwise falls back to stopOutFraction of max loss (default 50%). */
export function getPositionRiskAtStopOutDollars(
    position: Position,
    totalQty: number,
    entryPricePerShare: number,
    stopOutFraction: number = STOP_OUT_PCT
): number {
    if (totalQty <= 0) return 0;
    if (position.stop_price != null && entryPricePerShare > 0) {
        const lossPerShare = Math.abs(entryPricePerShare - position.stop_price);
        return lossPerShare * CONTRACT_MULTIPLIER * totalQty;
    }
    return getPositionMaxLossDollars(position, totalQty, entryPricePerShare) * stopOutFraction;
}

/** Max loss in dollars per contract (at expiration / defined risk). */
export function getMaxLossPerContractDollars(rec: Recommendation): number {
    if ('shortLeg' in rec && 'longLeg' in rec && 'maxRisk' in rec) {
        // Credit/Debit spread: maxRisk is per-share (width - credit or debit)
        return (rec as SpreadRecommendation).maxRisk * CONTRACT_MULTIPLIER;
    }
    // Single leg (long): cost = max loss
    const single = rec as SingleLegRecommendation;
    const costPerShare = single.price ?? 0;
    return costPerShare * CONTRACT_MULTIPLIER;
}

/** 0.25 Kelly fraction: f = (b*p - q) / b, then 0.25*f. b = win/loss ratio (reward/risk), p = POP (0..1), q = 1-p. */
export function getKellyContracts(
    winPerContract: number,
    lossPerContract: number,
    pop: number,
    portfolioTotal: number,
    kellyFraction: number = 0.25
): number | null {
    if (lossPerContract <= 0 || portfolioTotal <= 0) return null;
    const p = Math.max(0, Math.min(1, pop / 100));
    const q = 1 - p;
    const b = winPerContract / lossPerContract; // reward/risk ratio
    const kelly = (b * p - q) / b;
    if (kelly <= 0 || !Number.isFinite(kelly)) return null;
    const fraction = kelly * kellyFraction;
    const maxCapitalForTrade = portfolioTotal * fraction;
    const contracts = Math.floor(maxCapitalForTrade / lossPerContract);
    return Math.max(0, contracts);
}

export interface SuggestedSizeResult {
    suggestedContracts: number;
    riskCapDollars: number;
    maxLossPerContractDollars: number;
    /** Risk per contract at stop-out (STOP_OUT_PCT of max loss). Used for sizing. */
    riskPerContractAtStopOutDollars: number;
    contractsCap: number;
    contractsKelly: number | null;
}

/**
 * Survival-first: maxRiskPerTrade = portfolioTotal * (riskPct/100).
 * Risk per contract = stop-out level (stopOutFraction of max loss), not full loss.
 * contracts_cap = floor(maxRiskPerTrade / riskPerContractAtStopOut).
 * If useKelly, maxContracts = min(contracts_cap, contracts_kelly); else use contracts_cap.
 */
export function getSuggestedContracts(
    rec: Recommendation,
    portfolioTotal: number,
    riskPct: number,
    options?: { useKelly?: boolean; stopOutFraction?: number }
): SuggestedSizeResult {
    const stopOutFraction = options?.stopOutFraction ?? STOP_OUT_PCT;
    const maxLossPerContractDollars = getMaxLossPerContractDollars(rec);
    const riskPerContractAtStopOutDollars = maxLossPerContractDollars * stopOutFraction;
    const riskCapDollars = (portfolioTotal * riskPct) / 100;
    const contractsCap = riskPerContractAtStopOutDollars > 0
        ? Math.floor(riskCapDollars / riskPerContractAtStopOutDollars)
        : 0;

    let contractsKelly: number | null = null;
    if (options?.useKelly && 'maxProfit' in rec && 'maxRisk' in rec && 'pop' in rec) {
        const spread = rec as SpreadRecommendation;
        const winPerContract = (spread.maxProfit ?? 0) * CONTRACT_MULTIPLIER;
        const lossPerContract = (spread.maxRisk ?? 0) * CONTRACT_MULTIPLIER;
        if (lossPerContract > 0 && spread.pop != null) {
            contractsKelly = getKellyContracts(
                winPerContract,
                lossPerContract,
                spread.pop,
                portfolioTotal,
                0.25
            );
        }
    }
    // Single leg: we could use a rough win/loss from delta (e.g. POP ~ delta), but skip Kelly for simplicity
    if (options?.useKelly && contractsKelly == null && 'price' in rec && 'delta' in rec) {
        const single = rec as SingleLegRecommendation;
        const lossPerContract = (single.price ?? 0) * CONTRACT_MULTIPLIER;
        const winPerContract = lossPerContract * 1.5; // assume 1.5:1 reward if ITM
        const pop = (Math.abs(single.delta ?? 0) - 0.05) * 100;
        contractsKelly = getKellyContracts(winPerContract, lossPerContract, pop, portfolioTotal, 0.25);
    }

    const suggestedContracts = contractsKelly != null && contractsKelly >= 0
        ? Math.min(contractsCap, contractsKelly)
        : contractsCap;

    return {
        suggestedContracts: Math.max(0, suggestedContracts),
        riskCapDollars,
        maxLossPerContractDollars,
        riskPerContractAtStopOutDollars,
        contractsCap,
        contractsKelly,
    };
}
