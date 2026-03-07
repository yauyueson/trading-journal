-- 012_signal_history.sql
-- Daily signal scan results from tech analysis.
-- Populated by api/cron-signal-scan.js after market close.

CREATE TABLE IF NOT EXISTS signal_history (
    id          BIGSERIAL   PRIMARY KEY,
    ticker      TEXT        NOT NULL,
    date        DATE        NOT NULL,
    score       REAL        NOT NULL,
    direction   TEXT        NOT NULL,
    setup       TEXT,
    confidence  INT         DEFAULT 0,
    components  JSONB,
    debug       JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (ticker, date)
);

CREATE INDEX IF NOT EXISTS idx_signal_history_date
    ON signal_history (date DESC);

ALTER TABLE signal_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read access" ON signal_history FOR SELECT USING (true);
CREATE POLICY "Service role write" ON signal_history FOR ALL USING (true);
