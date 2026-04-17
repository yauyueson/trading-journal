---
name: strategy-audit
description: Audit all 8 strategy-related files for consistency when strategy parameters change (EMA gate, SL, TL, tickers, deltas, DTE). Use after any strategy config change or before deploying.
user-invocable: true
allowed-tools: Read Grep Bash
---

# Strategy Config Consistency Audit

When invoked via `/strategy-audit`, check all 8 strategy files for parameter consistency. This audit exists because the EMA34→EMA55 migration required a dedicated consistency commit — parameters drifted across files.

## The 8 Files (always check all)

1. `data/strategy-config.json` — runtime config loaded by API routes
2. `src/lib/strategyProfiles.ts` — TypeScript strategy profiles (StrategyProfile interface)
3. `api/cron-signal-scan.js` — daily signal scanner (EMA gate, tickers, direction)
4. `api/check-alerts.js` — position alert system (SL multiple, TL params)
5. `src/pages/Signals.tsx` — signal display page (criteria, labels, tickers)
6. `src/pages/Dashboard.tsx` — dashboard (DTE5_TICKERS, spread config)
7. `lib/_shared/strategyConfig.js` — shared fallback config for API routes
8. `CLAUDE.md` — documentation (Active Strategy section)

## Parameters to Cross-Check

For each parameter, read the value from ALL 8 files and flag mismatches:

| Parameter | Config Key | What to grep |
|-----------|-----------|-------------|
| EMA gate period | `trendEMA`, `ema`, `EMA55`/`EMA34` | grep for `ema55`, `ema34`, `e55`, `e34`, `trendEMA` |
| Stop Loss multiple | `stopLossMultiple`, `SL 2.5x` | grep for `stopLoss`, `2.5`, `slMultiple` |
| Trailing Lock activate | `trailingActivatePct`, `TL 50` | grep for `trailing`, `0.50`, `50%` |
| Trailing Lock floor | `trailingFloorPct` | grep for `trailingFloor` |
| Tickers | `tickers`, `DTE5_TICKERS`, `WATCHLIST` | grep for `['QQQ']`, ticker arrays |
| Direction | `direction`, `bull`/`bear` | grep for `direction`, `bull`, `bear` |
| Short delta | `defaultDelta`, `creditShortDelta`, `sp30/20` | grep for `0.30`, `sp30`, `delta` |
| Long delta | `creditLongDelta`, `sp30/20` | grep for `0.20`, `longDelta` |
| DTE range | `dteMin`, `dteMax` | grep for `dteMin`, `dteMax`, `DTE` |
| Profit target | `profitTarget` | grep for `profitTarget`, `hold-to-expiry` |
| Max positions | `maxPositions`, `maxPerTicker` | grep for `maxPos`, `maxPerTicker` |

## Output Format

```
## Strategy Audit Report

### Current Production Config (from strategy-config.json)
EMA Gate: 55 | SL: 2.5x | TL: 50/50 | Tickers: [QQQ] | Direction: bull
Delta: sp30/20 | DTE: 2-7 | TP: hold-to-expiry | MaxPos: 1

### File-by-File Check
✓ data/strategy-config.json — EMA55, SL 2.5x, TL 50/50, QQQ bull
✓ src/lib/strategyProfiles.ts — matches
✗ api/cron-signal-scan.js — MISMATCH: still references EMA34
...

### Mismatches Found: N
[list each mismatch with file, line, expected vs actual]
```

## Rules

- Read data/strategy-config.json FIRST as the source of truth
- Report ALL 8 files even if they match — explicit confirmation prevents false confidence
- If $ARGUMENTS contains a parameter name (e.g., `/strategy-audit ema`), focus on that parameter but still check all files
- After reporting, suggest the exact edits needed to fix any mismatches
- Do NOT make edits — only report. The user decides whether to fix.

## Known Pitfalls (from project history)

- `api/cron-signal-scan.js` uses variable names like `bullEmaPeriod`, `bullEma` — check the logic, not just string literals
- `lib/_shared/strategyConfig.js` is a fallback — it should match but is often forgotten
- `CLAUDE.md` Active Strategy section has prose descriptions — check the actual numbers in the text
- `src/lib/types/settings.ts` has `DEFAULT_APP_SETTINGS` with `creditSpread.defaultDelta` — also check this
