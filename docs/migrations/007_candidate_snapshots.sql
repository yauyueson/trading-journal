-- Migration 007: Candidate Snapshots for Score→P&L Validation
-- Captures top-N strategy candidates at recommendation time for empirical backtest.
-- position_id (nullable FK) is linked once a user actually enters the trade.

CREATE TABLE IF NOT EXISTS candidate_snapshots (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticker              TEXT NOT NULL,
    snapshot_date       DATE NOT NULL DEFAULT CURRENT_DATE,
    strategy_type       TEXT NOT NULL,           -- e.g. 'CREDIT_PUT_SPREAD', 'LONG_CALL'
    strategy_category   TEXT NOT NULL,           -- 'CREDIT_SPREAD' | 'DEBIT_SPREAD' | 'SINGLE_LEG'
    unified_score       REAL,
    ev_risk_ratio       REAL,
    pop                 REAL,
    regime_mode         TEXT,                    -- 'CREDIT' | 'DEBIT' | 'NEUTRAL'
    iv_rank             REAL,
    direction           TEXT,                    -- 'BULL' | 'BEAR'
    short_strike        REAL,
    long_strike         REAL,
    expiration          TEXT,
    entry_mid           REAL,
    -- Linked position (set when user enters the trade)
    position_id         UUID REFERENCES positions(id) ON DELETE SET NULL,
    -- Outcome fields (filled after close)
    actual_pnl          REAL,
    actual_return_pct   REAL,
    closed_date         DATE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for joining to positions and querying by ticker/date
CREATE INDEX IF NOT EXISTS idx_candidate_snapshots_ticker_date
    ON candidate_snapshots (ticker, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_candidate_snapshots_position_id
    ON candidate_snapshots (position_id)
    WHERE position_id IS NOT NULL;

COMMENT ON TABLE candidate_snapshots IS
    'Top-N strategy candidates captured at recommendation time for Score→P&L empirical validation.';
