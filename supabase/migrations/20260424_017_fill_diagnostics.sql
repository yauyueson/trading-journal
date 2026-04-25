-- 017_fill_diagnostics.sql
-- Fill-quality logging for manual BCD/PMCC entries.
-- On trade entry we snapshot each leg's bid/mid/ask/OI/delta from the
-- chain query that populated the suggestion, compute the slippage model's
-- prediction, and persist alongside the user's actual fill price.
-- After several live trades this lets us calibrate src/lib/backtest/slippage.ts
-- against reality instead of against its own defaults.

CREATE TABLE IF NOT EXISTS fill_diagnostics (
    id                  BIGSERIAL   PRIMARY KEY,
    position_id         UUID        NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
    captured_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    chain_fetched_at    TIMESTAMPTZ,
    strategy_type       TEXT,                               -- 'bcd' | 'pmcc'
    quantity            INT         NOT NULL,
    -- User-reported fill prices (per share, not per contract)
    actual_net_debit    REAL,                               -- BCD net debit or PMCC (long_debit − short_credit)
    actual_long_debit   REAL,                               -- PMCC long leg; BCD leaves null
    actual_short_credit REAL,                               -- PMCC short leg; BCD leaves null
    -- Per-leg snapshots and model predictions: JSONB array of
    -- { role, side, strike, type, expiration, dte, bid, mid, ask, delta, iv,
    --   openInterest, volume, predictedFill, predictedSlippage }
    legs                JSONB       NOT NULL,
    -- Spread-level prediction from applySpreadFill (BCD) or sum of per-leg
    -- applyFill (PMCC). Positive slippage_delta_abs = user filled WORSE than
    -- the model predicted; negative = user filled BETTER.
    predicted_net_debit REAL,
    predicted_slippage  REAL,
    slippage_delta_abs  REAL,                               -- actual_net_debit − predicted_net_debit
    notes               TEXT,
    UNIQUE (position_id)
);

CREATE INDEX IF NOT EXISTS idx_fill_diagnostics_captured_at
    ON fill_diagnostics (captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_fill_diagnostics_strategy_type
    ON fill_diagnostics (strategy_type);

ALTER TABLE fill_diagnostics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read access" ON fill_diagnostics FOR SELECT USING (true);
CREATE POLICY "Service role write" ON fill_diagnostics FOR ALL USING (true);
