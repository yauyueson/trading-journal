-- ============================================================================
-- Migration 009: Add source column to ticker_iv_snapshots
-- ============================================================================
-- Forensic Audit v1.1 — IV Rank was comparing live IV against backfilled RV.
--
-- The backfill stored Realized Volatility as iv30, but getIVRank() treated all
-- rows as Implied Volatility. Since RV < IV (volatility risk premium), IV Rank
-- was systematically inflated to ~100% for most tickers.
--
-- Fix: Add a source column to distinguish live IV from RV proxy, and filter
-- getIVRank() to only use live_iv rows.
-- ============================================================================

-- Add source column with default 'live_iv' for new rows
ALTER TABLE ticker_iv_snapshots
    ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'live_iv';

-- Mark existing backfill rows: they have iv90 = NULL (backfill never sets iv90)
-- and were inserted before this migration. Live cron/scan rows always have iv90.
UPDATE ticker_iv_snapshots
    SET source = 'rv_proxy'
    WHERE iv90 IS NULL AND source IS DISTINCT FROM 'rv_proxy';

-- Index for efficient filtering
CREATE INDEX IF NOT EXISTS idx_ticker_iv_snapshots_source
    ON ticker_iv_snapshots (ticker, recorded_date DESC, source);
