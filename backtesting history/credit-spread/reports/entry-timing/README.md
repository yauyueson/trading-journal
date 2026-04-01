# Entry Timing Analysis — DTE5 Credit Spreads

**Date:** 2026-04-01
**Method:** Stock price open vs close as proxy for option credit change
**Formula:** credit_delta ≈ -short_delta × (close - open), where delta = 0.35
**Period:** 2019-06-01 to 2026-02-28

## Summary

| Metric | Value |
|--------|-------|
| Total bear signal days | 737 |
| Drop days (stock fell open→close) | 414 (56%) |
| Rally days | 304 (41%) |
| Avg intraday move | -0.219% |
| Avg |intraday move| | 1.329% |
| Avg credit impact (open vs close) | $0.23/share |
| Impact as % of typical credit | 15.4% |

## Per-Ticker

| Ticker | Signals | Drop% | Avg Move% | Avg|Move|% | Avg Credit Impact | Avg|Impact| |
|--------|---------|-------|-----------|------------|-------------------|------------|
| QQQ | 204 | 54% | -0.256% | 1.536% | $0.34 | $1.77 |
| SPY | 193 | 52% | -0.101% | 1.287% | $0.20 | $1.83 |
| IWM | 340 | 60% | -0.263% | 1.229% | $0.18 | $0.76 |

## Verdict

**SIGNIFICANT** — 15.4% of typical credit. Entry timing optimization is worth pursuing.
