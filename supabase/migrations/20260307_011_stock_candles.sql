-- 011_stock_candles.sql
-- Persistent cache for daily stock candles (Tiingo source).
-- Used by backtester + future daily signal scanner.
-- Bulk-populated via scripts/download-candles.js, topped up by backtest-candles API.

CREATE TABLE IF NOT EXISTS stock_candles (
    ticker      TEXT        NOT NULL,
    date        DATE        NOT NULL,
    open        REAL        NOT NULL,
    high        REAL        NOT NULL,
    low         REAL        NOT NULL,
    close       REAL        NOT NULL,
    volume      BIGINT      NOT NULL DEFAULT 0,
    timeframe   TEXT        NOT NULL DEFAULT '1D',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (ticker, date, timeframe)
);

-- Fast lookups by ticker + date range (backtester query pattern)
CREATE INDEX IF NOT EXISTS idx_stock_candles_ticker_date
    ON stock_candles (ticker, date);

-- Allow upsert from bulk download + incremental top-up
-- (ON CONFLICT ... DO UPDATE handled in application code)

-- RLS: public read (no auth needed for candle data)
ALTER TABLE stock_candles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read access" ON stock_candles FOR SELECT USING (true);
CREATE POLICY "Service role insert/update" ON stock_candles FOR ALL USING (true);
