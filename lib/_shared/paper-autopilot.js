export const PAPER_AUTOPILOT = {
  startDate: '2026-05-08',
  endDate: '2026-06-07',
  ticker: 'QQQ',
  evidencePath: 'docs/wfa/QQQ-CLEAN-SHEET-VALIDATION-RESULTS-2026-05-07.md',
  bcd: {
    capital: 5000,
    riskPct: 30,
    cadenceDays: 10,
  },
  pmcc: {
    capital: 20000,
    riskPct: 75,
  },
};

function isoDateInNewYork(now) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function weekdayInNewYork(now) {
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
  }).format(now);
  return !['Sat', 'Sun'].includes(day);
}

function daysBetween(startIso, endIso) {
  const start = new Date(`${startIso.slice(0, 10)}T00:00:00Z`);
  const end = new Date(`${endIso.slice(0, 10)}T00:00:00Z`);
  return Math.floor((end.getTime() - start.getTime()) / 86400000);
}

function activeForStrategy(positions, strategyType) {
  return positions.some(position =>
    position.status === 'active' &&
    position.strategy_type === strategyType &&
    (position.ticker || '').toUpperCase() === PAPER_AUTOPILOT.ticker,
  );
}

function latestStrategyEntryDate(positions, strategyType) {
  const entries = positions
    .filter(position => position.strategy_type === strategyType && (position.ticker || '').toUpperCase() === PAPER_AUTOPILOT.ticker)
    .map(position => position.created_at)
    .filter(Boolean)
    .sort();
  return entries[entries.length - 1] ?? null;
}

export function buildAutopilotPlan({ now = new Date(), positions = [] } = {}) {
  const date = isoDateInNewYork(now);
  const skips = [];
  const attempts = [];

  if (date < PAPER_AUTOPILOT.startDate || date > PAPER_AUTOPILOT.endDate) {
    return { run: false, date, attempts, skips: [{ strategyType: 'all', reason: 'outside_experiment_window' }] };
  }
  if (!weekdayInNewYork(now)) {
    return { run: false, date, attempts, skips: [{ strategyType: 'all', reason: 'market_weekend' }] };
  }

  if (activeForStrategy(positions, 'bcd')) {
    skips.push({ strategyType: 'bcd', reason: 'already_active' });
  } else {
    const latestBcd = latestStrategyEntryDate(positions, 'bcd');
    const daysSinceBcd = latestBcd ? daysBetween(latestBcd, date) : Number.POSITIVE_INFINITY;
    if (daysSinceBcd < PAPER_AUTOPILOT.bcd.cadenceDays) {
      skips.push({ strategyType: 'bcd', reason: 'cadence_wait', daysSinceLastEntry: daysSinceBcd });
    } else {
      attempts.push({ strategyType: 'bcd', mode: 'paper', ticker: PAPER_AUTOPILOT.ticker });
    }
  }

  if (activeForStrategy(positions, 'pmcc')) {
    skips.push({ strategyType: 'pmcc', reason: 'already_active' });
  } else {
    attempts.push({ strategyType: 'pmcc', mode: 'paper', ticker: PAPER_AUTOPILOT.ticker });
  }

  return { run: true, date, attempts, skips };
}

function priceMid(option) {
  if (Number.isFinite(option.mid) && option.mid > 0) return option.mid;
  if (Number.isFinite(option.bid) && Number.isFinite(option.ask) && option.bid >= 0 && option.ask > 0) {
    return (option.bid + option.ask) / 2;
  }
  return 0;
}

function buyPrice(option) {
  return Number.isFinite(option.ask) && option.ask > 0 ? option.ask : priceMid(option);
}

function sellPrice(option) {
  return Number.isFinite(option.bid) && option.bid > 0 ? option.bid : priceMid(option);
}

function scoreOption(option, targetDelta, targetDte) {
  return Math.abs(Math.abs(option.delta ?? 0) - targetDelta) * 100 + Math.abs((option.dte ?? targetDte) - targetDte);
}

function sortByScore(options, targetDelta, targetDte) {
  return [...options].sort((a, b) =>
    scoreOption(a, targetDelta, targetDte) - scoreOption(b, targetDelta, targetDte) ||
    (b.openInterest ?? 0) - (a.openInterest ?? 0) ||
    (b.volume ?? 0) - (a.volume ?? 0),
  );
}

export function chooseBcdCandidate(chain) {
  const calls = (chain ?? []).filter(option =>
    option.type === 'Call' &&
    option.dte >= 30 &&
    option.dte <= 60 &&
    option.strike > 0 &&
    buyPrice(option) > 0,
  );
  const longLeg = sortByScore(calls.filter(option => option.delta >= 0.40 && option.delta <= 0.60), 0.50, 45)[0];
  if (!longLeg) return null;
  const shortLeg = sortByScore(
    calls.filter(option =>
      option.expiration === longLeg.expiration &&
      option.strike > longLeg.strike &&
      option.delta >= 0.10 &&
      option.delta <= 0.30 &&
      sellPrice(option) > 0,
    ),
    0.20,
    longLeg.dte,
  )[0];
  if (!shortLeg) return null;
  const longDebit = Number(buyPrice(longLeg).toFixed(2));
  const shortCredit = Number(sellPrice(shortLeg).toFixed(2));
  const netDebit = Number((longDebit - shortCredit).toFixed(2));
  if (netDebit <= 0) return null;
  return {
    strategyType: 'bcd',
    longLeg,
    shortLeg,
    longDebit,
    shortCredit,
    netDebit,
    maxRiskPerContract: Number((netDebit * 100).toFixed(2)),
  };
}

export function choosePmccCandidate(longChain, shortChain) {
  const longLeg = sortByScore((longChain ?? []).filter(option =>
    option.type === 'Call' &&
    option.dte >= 240 &&
    option.dte <= 300 &&
    option.delta >= 0.70 &&
    option.delta <= 0.80 &&
    buyPrice(option) > 0,
  ), 0.75, 270)[0];
  if (!longLeg) return null;

  const shortLeg = sortByScore((shortChain ?? []).filter(option =>
    option.type === 'Call' &&
    option.dte >= 30 &&
    option.dte <= 45 &&
    option.delta >= 0.20 &&
    option.delta <= 0.30 &&
    option.strike > longLeg.strike &&
    sellPrice(option) > 0,
  ), 0.25, 37)[0];
  if (!shortLeg) return null;

  const shortCredit = Number(sellPrice(shortLeg).toFixed(2));
  const netDebit = Number((buyPrice(longLeg) - shortCredit).toFixed(2));
  if (netDebit <= 0) return null;
  return {
    strategyType: 'pmcc',
    longLeg,
    shortLeg,
    shortCredit,
    netDebit,
    maxRiskPerContract: Number((buyPrice(longLeg) * 100).toFixed(2)),
  };
}

export function buildBcdPaperPosition(candidate, openedAt = new Date().toISOString()) {
  return {
    ticker: PAPER_AUTOPILOT.ticker,
    strike: candidate.longLeg.strike,
    type: 'Debit Call Spread',
    expiration: candidate.longLeg.expiration,
    setup: 'BCD QQQ wide F1 · paper autopilot',
    strategy: 'Bull Call Debit Spread',
    strategy_type: 'bcd',
    direction: 'BULL',
    entry_score: 0,
    entry_price: candidate.netDebit,
    quantity: 1,
    spread_width: Number((candidate.shortLeg.strike - candidate.longLeg.strike).toFixed(2)),
    max_risk_entry: candidate.maxRiskPerContract,
    trade_profile: 'debit_spread',
    is_paper: true,
    execution_account_size: PAPER_AUTOPILOT.bcd.capital,
    target_price: 0.50,
    opened_at: openedAt,
    legs: [
      { strike: candidate.longLeg.strike, type: 'Call', side: 'long', expiration: candidate.longLeg.expiration, openedDebit: candidate.longDebit, cycleQty: 1 },
      { strike: candidate.shortLeg.strike, type: 'Call', side: 'short', expiration: candidate.shortLeg.expiration, openedCredit: candidate.shortCredit, cycleQty: 1 },
    ],
  };
}

export function buildPmccPaperPosition(candidate, openedAt = new Date().toISOString()) {
  return {
    ticker: PAPER_AUTOPILOT.ticker,
    strike: candidate.longLeg.strike,
    type: 'PMCC Diagonal',
    expiration: candidate.longLeg.expiration,
    setup: 'PMCC QQQ pt60 F1 · paper autopilot',
    strategy: 'PMCC Diagonal',
    strategy_type: 'pmcc',
    direction: 'BULL',
    entry_score: 0,
    entry_price: candidate.netDebit,
    quantity: 1,
    max_risk_entry: candidate.maxRiskPerContract,
    trade_profile: 'diagonal',
    is_paper: true,
    execution_account_size: PAPER_AUTOPILOT.pmcc.capital,
    target_price: 0.60,
    opened_at: openedAt,
    legs: [
      { strike: candidate.longLeg.strike, type: 'Call', side: 'long', expiration: candidate.longLeg.expiration, openedDebit: Number(buyPrice(candidate.longLeg).toFixed(2)), cycleQty: 1 },
      { strike: candidate.shortLeg.strike, type: 'Call', side: 'short', expiration: candidate.shortLeg.expiration, openedCredit: candidate.shortCredit, cycleQty: 1 },
    ],
  };
}
