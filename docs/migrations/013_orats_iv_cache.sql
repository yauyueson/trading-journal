-- 013_orats_iv_cache.sql
-- Cache for ORATS historical IV data used by backtest BSM repricing.
-- Populated by api/backtest-iv.js on first backtest run per ticker.

CREATE TABLE IF NOT EXISTS orats_iv_cache (
    ticker      TEXT    NOT NULL,
    date        DATE    NOT NULL,
    iv30d       REAL,
    iv60d       REAL,
    hv20d       REAL,
    hv30d       REAL,
    hv60d       REAL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (ticker, date)
);

CREATE INDEX IF NOT EXISTS idx_orats_iv_date
    ON orats_iv_cache (ticker, date DESC);

ALTER TABLE orats_iv_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read access" ON orats_iv_cache FOR SELECT USING (true);
CREATE POLICY "Service role write" ON orats_iv_cache FOR ALL USING (true);
