# CHANGELOG - OSS Algorithm

## [2.4.0] - 2026-02-13

### 🔴 Critical Bug Fixes (P0)

#### Fixed
- **[P0-1]** Unified Score liquidity calculation using `price` instead of real `bid/ask`, causing systematic overestimation (spread=0 → score=100)
- **[P0-2]** ThetaBurn triple penalty (z-score + getThetaPenalty + G/T ratio), causing over-penalization of high theta contracts
- **[P0-3]** Lambda linear compression insufficient for extreme values (lambda=500 → 68 still dominates z-score)
- **[P0-4]** Inconsistent maxSpreadPct ceiling (0.30 in strategy-recommend vs 0.12 in scan-options)

### 🟡 Core Enhancements (P1)

#### Added
- **[P1-1]** RV30 calculation from Polygon candles API, replacing unstable Nasdaq scraping
- **[P1-2]** Debit Spread scoring expanded from 3 to 6 dimensions (added theta, breakeven, EV)
- **[P1-3]** Soft penalty layer for gradual penalization (liquidity, price, DTE, OI)
- **[P1-4]** Skew calculation fallback widening (layered tolerance: 0.08 → 0.15)
- **[P1-6]** GammaRiskPenalty now uses actual gamma exposure (gamma × spot / mid)

#### Changed
- LOQ_WEIGHTS: `thetaBurn` from -0.10 to 0, `breakevenPenalty` from 0.10 to 0.15
- LOQ_DT_WEIGHTS: `thetaBurn` from -0.05 to 0
- `compressLambda`: linear decay → log2 compression
- `calculateSkew`: minimum chain length from 10 to 6
- Debit Spread weights: lambda(40%→25%), R:R(35%→25%), delta(25%→15%), +EV(20%), +BE(10%), +theta(-5%)

### 📁 Files Modified

**Core Scoring**:
- `lib/_shared/scoring.cjs` (9 functions modified, 2 added)
- `src/lib/oss-core.ts` (3 functions modified)

**Strategy Engine**:
- `api/strategy-recommend.js` (RV calculation, Debit Spread scoring, spread filters)

### 🔄 Migration Notes

All changes are backward compatible. Optional parameters added to `getGammaRiskPenalty` default to legacy behavior.

### 📊 Expected Impact

- **Liquidity accuracy**: From systematic overestimation → true reflection
- **Lambda balance**: Extreme values compressed from dominating → reasonable range
- **Theta penalty**: From triple → single absolute penalty
- **Debit Spread**: From 3D → 6D comprehensive scoring
- **RV stability**: From Nasdaq scraping → Polygon candles API
- **Data consistency**: IV and RV both from Polygon

---

## [2.3.0] - 2026-02-XX

### Added
- Skew bonus for credit spreads
- Slippage modeling
- Gamma risk penalty

---

## [2.2.0] - 2026-02-XX

### Added
- Gamma/Theta ratio (G/T) metric
- Breakeven penalty with DTE adjustment
- DTE-continuous weights (smooth transition from day-trade to standard)

---

## [2.1.0] - 2026-01-XX

### Added
- Theta pain curve with cap at 10
- DTE bucket z-score normalization

---

## [2.0.0] - 2026-01-XX

### Added
- Unified cross-strategy scoring system
- EV/Risk, POP, Regime, Liquidity dimensions
