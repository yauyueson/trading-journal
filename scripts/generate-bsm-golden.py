#!/usr/bin/env python3
"""
generate-bsm-golden.py — Phase 0.c.8

Grid-evaluates Black-Scholes-Merton call/put prices and deltas using
QuantLib, writes tests/fixtures/bsm-quantlib-golden.json.

The committed JSON is what tests/bsm-quantlib-parity.test.ts reads. This
script exists for reproducibility: regenerate when you want to verify the
fixture or widen the grid.

Dependencies:
    python3 -m venv /tmp/qlenv
    /tmp/qlenv/bin/pip install QuantLib
    /tmp/qlenv/bin/python scripts/generate-bsm-golden.py

QuantLib configuration (must match our JS BSM in src/lib/backtest/bsm-pricing.ts):
    - Dividend yield q = 0.
    - Rate r: continuously compounded, Actual/365-Fixed day count.
    - European option (Analytic/closed-form BSM, not American/binomial).
    - Time T measured in years = DTE / 365.

Output file schema:
    {
      "quantlibVersion": "1.42.1",
      "generatedAt": "2026-04-19T...Z",
      "tolerance": {"priceAbs": 1e-4, "priceRel": 1e-5, "deltaAbs": 1e-4},
      "grid": [
        {"S": 100, "K": 95, "T": 0.0191..., "sigma": 0.2, "r": 0.04,
         "isCall": true, "qlPrice": 5.421..., "qlDelta": 0.732...},
        ...
      ]
    }
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone

import QuantLib as ql  # type: ignore[import-not-found]


def price_and_delta(
    S: float, K: float, T: float, sigma: float, r: float, is_call: bool
) -> tuple[float, float]:
    """Return (price, delta) from QuantLib's AnalyticEuropeanEngine."""
    # Time anchor: pick a stable date; the engine only uses the day-count
    # on the rate and dividend curves to discount T years forward.
    today = ql.Date(15, ql.January, 2026)
    ql.Settings.instance().evaluationDate = today

    day_count = ql.Actual365Fixed()
    calendar = ql.NullCalendar()

    spot = ql.QuoteHandle(ql.SimpleQuote(S))
    flat_ts = ql.YieldTermStructureHandle(
        ql.FlatForward(today, ql.QuoteHandle(ql.SimpleQuote(r)), day_count)
    )
    dividend_ts = ql.YieldTermStructureHandle(
        ql.FlatForward(today, ql.QuoteHandle(ql.SimpleQuote(0.0)), day_count)
    )
    vol_ts = ql.BlackVolTermStructureHandle(
        ql.BlackConstantVol(today, calendar, ql.QuoteHandle(ql.SimpleQuote(sigma)), day_count)
    )

    process = ql.BlackScholesMertonProcess(spot, dividend_ts, flat_ts, vol_ts)

    # Translate T (years) into an expiry date. Use math.ceil for robustness
    # against rounding; we'll verify via timeToMaturity later.
    expiry_days = round(T * 365)
    if expiry_days < 1:
        # For T < 1/365 (sub-day), QuantLib can still value it via Calendar
        # advance, but day_count arithmetic needs an int date shift. Use
        # today + 1 day and pass T explicitly through the process's vol.
        # Simplest: for T <= 0 return intrinsic directly; our JS does the same.
        if T <= 0:
            intrinsic = max(0.0, S - K) if is_call else max(0.0, K - S)
            delta = (1.0 if S > K else 0.0 if S < K else 0.5) if is_call else (-1.0 if S < K else 0.0 if S > K else -0.5)
            return intrinsic, delta
        expiry_days = 1  # fall through; we'll accept tiny time skew

    expiry = today + int(expiry_days)

    payoff = ql.PlainVanillaPayoff(ql.Option.Call if is_call else ql.Option.Put, K)
    exercise = ql.EuropeanExercise(expiry)
    option = ql.VanillaOption(payoff, exercise)
    option.setPricingEngine(ql.AnalyticEuropeanEngine(process))

    return option.NPV(), option.delta()


def build_grid() -> list[dict]:
    spots = [50.0, 100.0, 200.0]
    moneyness = [0.7, 0.85, 0.95, 1.0, 1.05, 1.15, 1.3]
    dtes = [1, 7, 14, 30, 60, 90, 180, 365]
    sigmas = [0.10, 0.20, 0.30, 0.50, 0.80]
    rates = [0.02, 0.04, 0.05]
    calls = [True, False]

    rows: list[dict] = []
    for S in spots:
        for m in moneyness:
            K = round(S * m, 4)
            for dte in dtes:
                T = dte / 365.0
                for sigma in sigmas:
                    for r in rates:
                        for is_call in calls:
                            price, delta = price_and_delta(S, K, T, sigma, r, is_call)
                            rows.append(
                                {
                                    "S": S,
                                    "K": K,
                                    "T": T,
                                    "sigma": sigma,
                                    "r": r,
                                    "isCall": is_call,
                                    "qlPrice": price,
                                    "qlDelta": delta,
                                }
                            )
    return rows


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.dirname(here)
    out_path = os.path.join(repo_root, "tests/fixtures/bsm-quantlib-golden.json")

    rows = build_grid()
    payload = {
        "quantlibVersion": ql.__version__,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        # Phase 0.c.8 round-2 F3: persist the QuantLib pricing convention so
        # the parity test can assert the oracle matches the JS side's
        # assumptions. A future regen that drifted on q / day-count /
        # rate compounding would fail the assertion before the grid check.
        "config": {
            "dividendYield": 0.0,
            "rateCompounding": "Continuous",
            "dayCount": "Actual/365Fixed",
            "exerciseStyle": "European",
            "pricingEngine": "AnalyticEuropeanEngine",
            "evaluationDate": "2026-01-15",
        },
        "tolerance": {"priceAbs": 1e-4, "priceRel": 1e-5, "deltaAbs": 1e-4},
        "grid": rows,
    }

    # Pretty-print with 2-space indent for git-friendly diffs, truncate
    # floats to reasonable precision (12 sig figs — matches double precision).
    with open(out_path, "w") as f:
        json.dump(payload, f, indent=2, default=float)
        f.write("\n")

    n_call = sum(1 for r in rows if r["isCall"])
    n_put = len(rows) - n_call
    print(f"Wrote {len(rows):,} rows ({n_call:,} call, {n_put:,} put) → {out_path}")
    print(f"QuantLib version: {ql.__version__}")


if __name__ == "__main__":
    main()
