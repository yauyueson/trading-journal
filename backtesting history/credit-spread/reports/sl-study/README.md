# Stop-Loss WFA Study — Credit Spread Strategies

Generated: 2026-03-23

## Executive Summary

This study evaluates 4 stop-loss mechanisms across Swing (45-65 DTE) and Short-Term (7-21 DTE 130M) credit spread strategies.
Methodology: Rolling WFA with IS/OOS selection windows + holdout validation.

### Baseline (No SL)
- **short**: OOS Sharpe 2.23, Holdout 1.85, WR 76.4%, Grade B

### Best SL Config: `sl15x` (short)
- Mechanism: credit_multiple
- OOS Sharpe: 2.23, Holdout: 1.85
- WR: 76.4%, MaxDD: 3.9%
- Grade: B

## Short-Term Results

| Label | Mechanism | IS Sharpe | OOS Sharpe | Holdout | WR% | MaxDD | Trades | WFE | Grade |
|-------|-----------|-----------|------------|---------|-----|-------|--------|-----|-------|
| baseline | baseline | 1.99 | 2.23 | 1.85 | 76.4% | 3.9% | 296 | 1.12 | B |
| sl15x | credit_multiple | 1.99 | 2.23 | 1.85 | 76.4% | 3.9% | 296 | 1.12 | B |
| sl10x | credit_multiple | 1.99 | 2.23 | 1.85 | 76.0% | 3.9% | 296 | 1.12 | B |
| sl7x | credit_multiple | 1.92 | 2.11 | 1.85 | 73.9% | 5.4% | 299 | 1.10 | B |
| tl75-50 | trailing_lock | 1.76 | 1.78 | 1.64 | 56.1% | 6.8% | 319 | 1.02 | B |
| tl75-25 | trailing_lock | 1.76 | 1.78 | 1.64 | 56.1% | 6.8% | 319 | 1.02 | B |
| sl5x | credit_multiple | 1.61 | 1.76 | 1.54 | 70.1% | 8.2% | 314 | 1.09 | C |
| tl50-50 | trailing_lock | 1.67 | 1.67 | 1.50 | 47.3% | 6.5% | 349 | 1.00 | B |
| tl50-25 | trailing_lock | 1.67 | 1.67 | 1.50 | 47.0% | 6.5% | 349 | 1.00 | B |
| ds80 | delta_stop | 0.76 | 1.15 | 1.53 | 65.5% | 12.1% | 313 | 1.52 | C |
| sl4x | credit_multiple | 1.06 | 0.94 | 1.35 | 55.4% | 21.8% | 341 | 0.88 | C |
| ds75 | delta_stop | 0.26 | 0.80 | 1.43 | 64.2% | 21.9% | 318 | 3.05 | C |
| ds70 | delta_stop | -0.20 | 0.50 | 1.35 | 60.9% | 25.2% | 327 | 0.00 | F |
| ds65 | delta_stop | -0.93 | -0.03 | 0.27 | 56.5% | 34.9% | 336 | 0.00 | F |
| ds60 | delta_stop | -2.39 | -1.09 | -1.10 | 50.8% | 64.8% | 354 | 0.00 | F |
| ml50 | max_loss_pct | -2.82 | -1.48 | -0.24 | 35.4% | 118.5% | 384 | 0.00 | F |
| sl2x | credit_multiple | -2.87 | -1.63 | -0.95 | 24.5% | 113.1% | 392 | 0.00 | F |
| ds50 | delta_stop | -2.53 | -1.67 | -0.92 | 49.7% | 56.8% | 358 | 0.00 | F |
| ds55 | delta_stop | -2.63 | -1.73 | -0.99 | 50.1% | 65.0% | 355 | 0.00 | F |
| ml75 | max_loss_pct | -1.43 | -1.90 | -0.22 | 37.8% | 107.6% | 381 | 0.00 | F |
| sl3x | credit_multiple | -0.87 | -1.99 | -0.25 | 39.0% | 81.5% | 372 | 0.00 | F |
| ml25 | max_loss_pct | -3.37 | -2.27 | -3.35 | 20.4% | 133.5% | 412 | 0.00 | F |
| ml90 | max_loss_pct | -1.11 | -2.34 | -0.22 | 38.7% | 96.7% | 382 | 0.00 | F |

## Methodology

### SL Mechanisms Tested
1. **Credit Multiple** (2×-15×): Close when spread cost reaches N× entry credit
2. **Delta Stop** (0.50-0.80): Close when |short delta| exceeds threshold
3. **Max Loss %** (25%-90%): Close when unrealized loss reaches X% of max possible loss
4. **Trailing Lock**: Once profit hits activation %, set floor; close on retrace below floor

### Overfitting Grade Rubric
| Grade | Criteria |
|-------|----------|
| A | 6/6 checks pass |
| B | 5/6 |
| C | 4/6 |
| D | 3/6 |
| F | <3/6 |

Checks: IS→OOS retention ≥40%, OOS Sharpe StdDev <1.0, all windows positive, sufficient trades, no extreme IS, OOS Sharpe >0.5
