-- 014_trade_outcomes.sql
-- MFE/MAE tracking for closed real trades.
-- Populated by api/cron-trade-outcomes.js after market close.

CREATE TABLE IF NOT EXISTS trade_outcomes (
    id              BIGSERIAL   PRIMARY KEY,
    position_id     UUID        NOT NULL REFERENCES positions(id),
    ticker          TEXT        NOT NULL,
    entry_date      DATE        NOT NULL,
    exit_date       DATE,
    entry_price     REAL        NOT NULL,
    direction       TEXT        NOT NULL,  -- 'long' or 'short'
    mfe_pct         REAL,                  -- max favorable excursion %
    mae_pct         REAL,                  -- max adverse excursion %
    mfe_bars        INT,                   -- bars to MFE
    mae_bars        INT,                   -- bars to MAE
    final_pct       REAL,                  -- actual P&L %
    computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (position_id)
);

CREATE INDEX IF NOT EXISTS idx_trade_outcomes_ticker
    ON trade_outcomes (ticker);

ALTER TABLE trade_outcomes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read access" ON trade_outcomes FOR SELECT USING (true);
CREATE POLICY "Service role write" ON trade_outcomes FOR ALL USING (true);
