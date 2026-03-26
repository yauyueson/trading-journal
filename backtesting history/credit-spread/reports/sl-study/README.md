# Stop-Loss WFA Study — Credit Spread Strategies

Generated: 2026-03-24

## Executive Summary

This study evaluates 4 stop-loss mechanisms across Swing (45-65 DTE) and Short-Term (7-21 DTE 130M) credit spread strategies.
Methodology: Rolling WFA with IS/OOS selection windows + holdout validation.

### Baseline (No SL)
- **short**: OOS Sharpe 0.90, Holdout 0.37, WR 72.0%, Grade A

### Best SL Config: `sl10x` (short)
- Mechanism: credit_multiple
- OOS Sharpe: 0.90, Holdout: 0.37
- WR: 71.4%, MaxDD: 39.9%
- Grade: A

## Short-Term Results

| Label | Mechanism | IS Sharpe | OOS Sharpe | Holdout | WR% | MaxDD | Trades | WFE | Grade |
|-------|-----------|-----------|------------|---------|-----|-------|--------|-----|-------|
| baseline | baseline | 1.58 | 0.90 | 0.37 | 72.0% | 41.7% | 2830 | 0.57 | A |
| sl10x | credit_multiple | 1.55 | 0.90 | 0.37 | 71.4% | 39.9% | 2865 | 0.58 | A |
| sl15x | credit_multiple | 1.57 | 0.90 | 0.37 | 72.0% | 42.8% | 2832 | 0.57 | A |
| tl75-50 | trailing_lock | 1.59 | 0.89 | 0.31 | 54.9% | 41.7% | 3117 | 0.56 | B |
| tl75-25 | trailing_lock | 1.59 | 0.89 | 0.31 | 54.8% | 41.7% | 3117 | 0.56 | B |
| sl7x | credit_multiple | 1.55 | 0.89 | 0.36 | 69.2% | 43.3% | 3033 | 0.57 | A |
| tl50-25 | trailing_lock | 1.48 | 0.85 | 0.32 | 43.3% | 50.3% | 3463 | 0.57 | C |
| tl50-50 | trailing_lock | 1.48 | 0.83 | 0.32 | 43.4% | 59.2% | 3464 | 0.56 | C |
| sl5x | credit_multiple | 1.40 | 0.83 | 0.29 | 59.3% | 44.1% | 3491 | 0.59 | C |
| sl4x | credit_multiple | 1.08 | 0.78 | 0.28 | 49.6% | 62.5% | 3902 | 0.72 | C |
| ds80 | delta_stop | 1.27 | 0.78 | 0.32 | 63.4% | 73.5% | 2970 | 0.62 | B |
| ds70 | delta_stop | 1.26 | 0.78 | 0.30 | 59.9% | 87.8% | 3171 | 0.62 | B |
| ds75 | delta_stop | 1.31 | 0.77 | 0.32 | 62.5% | 75.0% | 3035 | 0.59 | B |
| sl3x | credit_multiple | 0.12 | 0.44 | -0.29 | 37.4% | 127.6% | 4433 | 3.55 | F |
| ds65 | delta_stop | 0.66 | 0.06 | 0.18 | 54.1% | 253.7% | 3435 | 0.10 | C |
| ml50 | max_loss_pct | -1.72 | -0.10 | -0.32 | 32.1% | 772.4% | 4506 | 0.00 | F |
| sl2x | credit_multiple | -1.96 | -0.23 | -0.69 | 21.0% | 747.1% | 5060 | 0.00 | F |
| ml90 | max_loss_pct | -0.13 | -0.42 | -0.31 | 39.2% | 112.2% | 4127 | 0.00 | F |
| ds60 | delta_stop | -0.85 | -0.43 | 0.24 | 46.7% | 4362.7% | 3813 | 0.00 | F |
| ds55 | delta_stop | -0.79 | -0.45 | 0.38 | 45.2% | 4576.5% | 3847 | 0.00 | F |
| ds50 | delta_stop | -1.06 | -0.45 | 0.24 | 43.4% | 4228.8% | 3924 | 0.00 | F |
| ml25 | max_loss_pct | -3.09 | -0.93 | -1.89 | 16.9% | 1752.8% | 5216 | 0.00 | F |
| ml75 | max_loss_pct | -0.68 | -1.15 | -0.31 | 37.5% | 187.2% | 4242 | 0.00 | F |

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
