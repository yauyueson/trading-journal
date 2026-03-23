# Stop-Loss WFA Study — Credit Spread Strategies

Generated: 2026-03-23

## Executive Summary

This study evaluates 4 stop-loss mechanisms across Swing (45-65 DTE) and Short-Term (7-21 DTE 130M) credit spread strategies.
Methodology: Rolling WFA with IS/OOS selection windows + holdout validation.

### Baseline (No SL)
- **short**: OOS Sharpe 0.45, Holdout 0.33, WR 76.4%, Grade C

### Best SL Config: `sl15x` (short)
- Mechanism: credit_multiple
- OOS Sharpe: 0.45, Holdout: 0.33
- WR: 76.4%, MaxDD: 9.3%
- Grade: C

## Short-Term Results

| Label | Mechanism | IS Sharpe | OOS Sharpe | Holdout | WR% | MaxDD | Trades | WFE | Grade |
|-------|-----------|-----------|------------|---------|-----|-------|--------|-----|-------|
| baseline | baseline | 0.39 | 0.45 | 0.33 | 76.4% | 9.3% | 296 | 1.16 | C |
| sl15x | credit_multiple | 0.39 | 0.45 | 0.33 | 76.4% | 9.3% | 296 | 1.16 | C |
| sl10x | credit_multiple | 0.39 | 0.41 | 0.33 | 76.0% | 9.3% | 296 | 1.07 | D |
| sl7x | credit_multiple | 0.19 | 0.10 | 0.33 | 73.9% | 12.8% | 299 | 0.53 | F |
| sl5x | credit_multiple | -0.51 | -0.58 | -0.13 | 70.1% | 24.1% | 314 | 0.00 | F |
| ds80 | delta_stop | -1.07 | -0.64 | 0.05 | 65.5% | 28.0% | 313 | 0.00 | F |
| ds75 | delta_stop | -1.11 | -0.65 | 0.03 | 64.2% | 29.0% | 318 | 0.00 | F |
| ds70 | delta_stop | -1.18 | -0.74 | -0.16 | 60.9% | 32.9% | 327 | 0.00 | F |
| tl75-50 | trailing_lock | -0.46 | -1.10 | 0.04 | 56.1% | 33.5% | 319 | 0.00 | F |
| tl75-25 | trailing_lock | -0.46 | -1.10 | 0.04 | 56.1% | 33.5% | 319 | 0.00 | F |
| ds65 | delta_stop | -1.55 | -1.13 | -0.40 | 56.5% | 40.9% | 336 | 0.00 | F |
| sl2x | credit_multiple | -3.89 | -1.24 | -3.18 | 24.5% | 136.5% | 392 | 0.00 | F |
| sl3x | credit_multiple | -3.13 | -1.30 | -2.90 | 39.0% | 132.4% | 372 | 0.00 | F |
| ds50 | delta_stop | -2.53 | -1.67 | -0.92 | 49.7% | 56.8% | 358 | 0.00 | F |
| ml75 | max_loss_pct | -3.12 | -1.71 | -2.85 | 37.8% | 148.9% | 381 | 0.00 | F |
| ds55 | delta_stop | -2.63 | -1.73 | -0.99 | 50.1% | 65.0% | 355 | 0.00 | F |
| ds60 | delta_stop | -2.64 | -1.73 | -1.10 | 50.8% | 67.0% | 354 | 0.00 | F |
| tl50-50 | trailing_lock | -1.05 | -1.86 | -0.48 | 47.3% | 51.3% | 349 | 0.00 | F |
| tl50-25 | trailing_lock | -1.05 | -1.90 | -0.48 | 47.0% | 52.1% | 349 | 0.00 | F |
| ml25 | max_loss_pct | -3.37 | -2.27 | -3.35 | 20.4% | 133.5% | 412 | 0.00 | F |
| ml50 | max_loss_pct | -3.02 | -2.30 | -2.92 | 35.4% | 151.4% | 384 | 0.00 | F |
| ml90 | max_loss_pct | -3.21 | -2.33 | -2.85 | 38.7% | 146.5% | 382 | 0.00 | F |
| sl4x | credit_multiple | -1.98 | -2.78 | -0.88 | 55.4% | 70.8% | 341 | 0.00 | F |

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
