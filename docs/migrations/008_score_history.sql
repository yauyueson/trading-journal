-- ============================================================================
-- Migration 008: Score History Audit Trail
-- ============================================================================
-- Forensic Audit v1.1, Finding F10.
--
-- Tracks every score computation for drift analysis and model validation.
-- Populated by fire-and-forget INSERT in strategy-recommend.js.
-- Partitioned by captured_at (monthly) if volume grows past ~100k rows.
-- ============================================================================

CREATE TABLE IF NOT EXISTS score_history (
    id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    ticker      TEXT NOT NULL,
    expiration  TEXT,               -- YYYY-MM-DD
    strike      NUMERIC,
    option_type TEXT,               -- 'Call' | 'Put' | null for spreads
    score       NUMERIC NOT NULL,   -- unified_score (0-100)
    score_type  TEXT NOT NULL,       -- 'LOQ' | 'CSQ' | 'UNIFIED' | 'CREDIT_SPREAD' | 'DEBIT_SPREAD'
    factors     JSONB,              -- score factor breakdown for explainability
    regime_mode TEXT,               -- 'CREDIT' | 'DEBIT' | 'NEUTRAL'
    iv_rank     NUMERIC,
    data_source TEXT,               -- 'POLYGON' | 'CBOE'
    captured_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for time-series queries (drift analysis: same ticker over time)
CREATE INDEX IF NOT EXISTS idx_score_history_ticker_time
    ON score_history (ticker, captured_at DESC);

-- Index for model validation (bucket scores and check outcomes)
CREATE INDEX IF NOT EXISTS idx_score_history_score
    ON score_history (score, captured_at DESC);

-- RLS: open access (single-user system; tighten if multi-tenant)
ALTER TABLE score_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to score_history"
    ON score_history FOR ALL USING (true);
