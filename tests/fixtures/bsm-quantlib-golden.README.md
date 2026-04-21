# BSM–QuantLib golden fixture

This directory holds `bsm-quantlib-golden.json`, a 5,040-row grid of
Black-Scholes-Merton call/put prices and deltas computed by QuantLib's
`AnalyticEuropeanEngine`. It is read by
[tests/bsm-quantlib-parity.test.ts](../bsm-quantlib-parity.test.ts) to
anchor our JS BSM implementation in `src/lib/backtest/bsm-pricing.ts`
against an external reference.

## Grid

| Axis | Values |
|---|---|
| Underlying spot `S` | 50, 100, 200 |
| Moneyness `K/S` | 0.7, 0.85, 0.95, 1.0, 1.05, 1.15, 1.3 |
| DTE | 1, 7, 14, 30, 60, 90, 180, 365 days |
| Vol `σ` | 0.10, 0.20, 0.30, 0.50, 0.80 |
| Rate `r` | 0.02, 0.04, 0.05 (continuously compounded) |
| Call / put | both |

3 × 7 × 8 × 5 × 3 × 2 = **5,040 combinations**. The grid is deliberately
wide: deep ITM/OTM moneyness (0.7 / 1.3) stresses the normCDF tails; 1-DTE
exercises the short-time-to-expiry numerical edge; 80% vol stresses the
`d1` scaling. Intentional gaps: no zero-DTE (handled by intrinsic-value
shortcut both sides) and no negative rates (current market convention
for our strategies).

## QuantLib configuration

Fixed to match our JS BSM:

- Dividend yield `q = 0`.
- Rate `r`: continuously compounded, Actual/365-Fixed day count.
- European exercise (closed-form BSM, not American/binomial).
- Time in years = DTE / 365.
- Evaluation date: 2026-01-15 (arbitrary anchor; only the relative offset matters).

QuantLib version at fixture generation: **1.42.1**.

## Tolerance

The test asserts per-row:

- `|ourPrice - qlPrice| < max(1e-4, 1e-5 * qlPrice)`
- `|ourDelta - qlDelta| < 1e-4`

The absolute floor of 1e-4 on price accounts for our `normCDF`
implementation's Abramowitz–Stegun approximation (max error 7.5e-8 on
each CDF call; the BSM formula compounds two CDF calls). The relative
component (1e-5) loosens the floor for deep-ITM options where price can
exceed $100 and absolute tolerance becomes impractical. Delta tolerance
of 1e-4 is tighter because delta involves only one CDF call.

If tests fail: a real regression has appeared, or QuantLib's behavior
changed in a later version. Investigate the failing rows before touching
tolerances.

## Regenerating

```bash
python3 -m venv /tmp/qlenv
/tmp/qlenv/bin/pip install QuantLib
/tmp/qlenv/bin/python scripts/generate-bsm-golden.py
```

The script is deterministic (modulo QuantLib version). Commit the new
fixture + re-run the parity test.

## When to regenerate

- QuantLib upgrade: optional, but nice to refresh.
- Grid expansion: edit `build_grid()` in the script.
- Bug fix in our JS BSM: tolerances may tighten.

Do NOT regenerate to "make tests pass" without understanding why the
previous fixture failed. The fixture is ground truth; our code is what
moves.
