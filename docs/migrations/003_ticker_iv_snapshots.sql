-- Migration 003: IV Rank 历史表 (ticker_iv_snapshots)
-- 日期: 2026-02-08
-- 用途: 按标的存储每日 ATM IV 快照，用于 IV Rank / IV Percentile 计算

CREATE TABLE IF NOT EXISTS ticker_iv_snapshots (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    ticker VARCHAR(20) NOT NULL,
    recorded_date DATE NOT NULL,
    iv30 DECIMAL(8,6) NOT NULL,
    iv90 DECIMAL(8,6),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(ticker, recorded_date)
);

CREATE INDEX IF NOT EXISTS idx_ticker_iv_snapshots_ticker_date
ON ticker_iv_snapshots(ticker, recorded_date DESC);

ALTER TABLE ticker_iv_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all on ticker_iv_snapshots" ON ticker_iv_snapshots;
CREATE POLICY "Allow all on ticker_iv_snapshots"
ON ticker_iv_snapshots FOR ALL USING (true) WITH CHECK (true);
