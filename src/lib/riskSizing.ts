/**
 * Portfolio-based risk sizing for options strategies.
 * Risk is defined as stop-out level (e.g. 50% loss), not full max loss.
 * Survival-first: maxRiskPerTrade = portfolioTotal * riskPct, contracts_cap = floor(maxRiskPerTrade / riskPerContractAtStopOut).
 * Optional: 0.25 Kelly as advantage cap; maxContracts = min(contracts_cap, contracts_kelly).
 */

import type { SpreadRecommendation, SingleLegRecommendation, Recommendation } from './types';
import type { Position, Transaction } from './types';
import { CONTRACT_MULTIPLIER } from './utils';

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
        // Guard: credit should never exceed width; clamp to prevent negative max loss
        return Math.max(0, width - entryPricePerShare) * CONTRACT_MULTIPLIER * totalQty;
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
    // Single leg: proper Kelly using TP/SL ratios, not leverage (F5.1 fix)
    // b = TP_pct / SL_pct (reward/risk ratio at target exit levels)
    // p = |delta| as POP proxy with 5% haircut for slippage + fees
    //
    // Delta-adjusted TP (F9 — Forensic Audit v1.1):
    // OTM options (|delta|<0.30) have asymmetric payoff: low P(ITM) but high reward when correct.
    // Fixed TP=50%/SL=50% → b=1.0 always, ignoring this asymmetry.
    // Fix: OTM → tpPct=1.00 (b=2.0); moderate → 0.75 (b=1.5); ATM → 0.50 (b=1.0).
    if (options?.useKelly && contractsKelly == null && 'price' in rec && 'delta' in rec) {
        const single = rec as SingleLegRecommendation;
        const costPerShare = single.price ?? 0;
        if (costPerShare > 0) {
            const absDelta = Math.abs(single.delta ?? 0);
            const slPct = 0.50; // stop loss at -50% (constant)
            // Delta-adjusted TP: OTM options have higher reward targets
            const tpPct = absDelta < 0.30 ? 1.00 : absDelta < 0.50 ? 0.75 : 0.50;
            const winPerContract = costPerShare * tpPct * CONTRACT_MULTIPLIER;
            const lossPerContract = costPerShare * slPct * CONTRACT_MULTIPLIER;
            // POP proxy: |delta| gives rough P(ITM); haircut 5% for transaction costs
            const pop = Math.max(0, (absDelta - 0.05)) * 100;
            contractsKelly = getKellyContracts(winPerContract, lossPerContract, pop, portfolioTotal, 0.25);
        }
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

export interface ConcentrationWarning {
    type: 'ticker' | 'expiration_week';
    label: string;
    pct: number;
    limit: number;
}

export interface PortfolioGreeksResult {
    netDelta: number;
    netGamma: number;
    netTheta: number;
    netVega: number;
    positionsWithData: number;
    largestRiskPct: number;
    largestRiskTicker: string;
    concentrationWarnings: ConcentrationWarning[];
}

/**
 * Aggregate net portfolio Greeks from live bulk data.
 * Each Greek is scaled by contract quantity × 100 shares/contract.
 * Returns null if no positions have live data.
 */
export function aggregatePortfolioGreeks(
    positions: Position[],
    transactions: Transaction[],
    bulkData: Record<string, any>,
    portfolioTotal: number,
    stopOutFraction: number = STOP_OUT_PCT
): PortfolioGreeksResult | null {
    let netDelta = 0, netGamma = 0, netTheta = 0, netVega = 0;
    let positionsWithData = 0;
    let largestRiskPct = 0;
    let largestRiskTicker = '';

    // Concentration tracking: risk$ per ticker and per expiration week
    const riskByTicker: Record<string, number> = {};
    const riskByExpWeek: Record<string, number> = {};

    positions.forEach(pos => {
        const legData = bulkData[pos.id];
        if (!legData || legData.length === 0) return;

        const posTxns = transactions.filter(t => t.position_id === pos.id);
        let qtyBought = 0, qtySold = 0, totalCostBasis = 0;
        posTxns.forEach(t => {
            if (t.quantity > 0) {
                qtyBought += t.quantity;
                totalCostBasis += t.quantity * Math.abs(t.price);
            } else {
                qtySold += Math.abs(t.quantity);
            }
        });
        const qty = qtyBought - qtySold;
        if (qty <= 0) return;
        const avgPrice = qtyBought > 0 ? totalCostBasis / qtyBought : 0;

        let posNetDelta = 0, posNetGamma = 0, posNetTheta = 0, posNetVega = 0;
        let hasData = false;

        if (pos.legs && pos.legs.length > 0) {
            pos.legs.forEach(leg => {
                const legResult = (legData as any[]).find((d: any) =>
                    d.expiration === leg.expiration &&
                    String(d.strike) === String(leg.strike) &&
                    d.type === leg.type
                );
                const data = legResult?.data;
                if (!data) return;
                const mult = leg.side === 'short' ? -1 : 1;
                posNetDelta += (data.delta || 0) * mult;
                posNetGamma += (data.gamma || 0) * mult;
                posNetTheta += (data.theta || 0) * mult;
                posNetVega += (data.vega || 0) * mult;
                hasData = true;
            });
        } else {
            const item = (legData as any[])[0];
            const data = item?.data || item;
            if (data && (data.delta != null || data.theta != null)) {
                posNetDelta = data.delta || 0;
                posNetGamma = data.gamma || 0;
                posNetTheta = data.theta || 0;
                posNetVega = data.vega || 0;
                hasData = true;
            }
        }

        if (!hasData) return;
        positionsWithData++;

        netDelta += posNetDelta * qty * CONTRACT_MULTIPLIER;
        netGamma += posNetGamma * qty * CONTRACT_MULTIPLIER;
        netTheta += posNetTheta * qty * CONTRACT_MULTIPLIER;
        netVega += posNetVega * qty * CONTRACT_MULTIPLIER;

        if (portfolioTotal > 0) {
            const riskDollars = getPositionRiskAtStopOutDollars(pos, qty, avgPrice, stopOutFraction);
            const riskPctPos = (riskDollars / portfolioTotal) * 100;
            if (riskPctPos > largestRiskPct) {
                largestRiskPct = riskPctPos;
                largestRiskTicker = pos.ticker;
            }

            // Accumulate risk by ticker
            riskByTicker[pos.ticker] = (riskByTicker[pos.ticker] || 0) + riskDollars;

            // Accumulate risk by expiration week (ISO week of nearest expiration)
            const expDate = pos.legs?.[0]?.expiration || pos.expiration;
            if (expDate) {
                const d = new Date(expDate);
                // Get ISO week start (Monday) as a key
                const day = d.getDay();
                const diff = d.getDate() - day + (day === 0 ? -6 : 1);
                const weekStart = new Date(d);
                weekStart.setDate(diff);
                const weekKey = weekStart.toISOString().split('T')[0];
                riskByExpWeek[weekKey] = (riskByExpWeek[weekKey] || 0) + riskDollars;
            }
        }
    });

    if (positionsWithData === 0) return null;

    // F5.2: Concentration warnings
    const TICKER_LIMIT = 25; // max 25% of portfolio in one underlying
    const EXP_WEEK_LIMIT = 30; // max 30% expiring same week
    const concentrationWarnings: ConcentrationWarning[] = [];

    if (portfolioTotal > 0) {
        for (const [ticker, risk] of Object.entries(riskByTicker)) {
            const pct = (risk / portfolioTotal) * 100;
            if (pct > TICKER_LIMIT) {
                concentrationWarnings.push({ type: 'ticker', label: ticker, pct: Math.round(pct * 10) / 10, limit: TICKER_LIMIT });
            }
        }
        for (const [week, risk] of Object.entries(riskByExpWeek)) {
            const pct = (risk / portfolioTotal) * 100;
            if (pct > EXP_WEEK_LIMIT) {
                concentrationWarnings.push({ type: 'expiration_week', label: `Week of ${week}`, pct: Math.round(pct * 10) / 10, limit: EXP_WEEK_LIMIT });
            }
        }
    }

    return { netDelta, netGamma, netTheta, netVega, positionsWithData, largestRiskPct, largestRiskTicker, concentrationWarnings };
}

/**
 * DTE5 strategy sizing — 10% of capital per trade at $10K base.
 * Returns max contracts and risk warning if max loss exceeds 50% of capital.
 */
export function getDTE5Sizing(
    capitalBase: number,
    maxRiskPerContract: number,
    riskPct = 0.10,
): { maxContracts: number; riskDollars: number; riskPct: number; warning: string | null } {
    const riskBudget = capitalBase * riskPct;
    const contracts = maxRiskPerContract > 0 ? Math.floor(riskBudget / maxRiskPerContract) : 0;
    const riskDollars = maxRiskPerContract * contracts;
    const actualRiskPct = capitalBase > 0 ? (riskDollars / capitalBase) * 100 : 0;
    const warning = contracts === 0
        ? `Risk per contract ($${maxRiskPerContract.toFixed(0)}) exceeds budget ($${riskBudget.toFixed(0)}) — skip this trade`
        : actualRiskPct > 50 ? `${actualRiskPct.toFixed(0)}% of capital at risk per trade` : null;
    return { maxContracts: contracts, riskDollars, riskPct: actualRiskPct, warning };
}
