-- Migration 006: Retrospective categorization fields for positions
-- These fields MUST be captured at trade entry — they cannot be reconstructed later.
-- Run in Supabase SQL Editor.

ALTER TABLE positions
ADD COLUMN IF NOT EXISTS market_state   VARCHAR(20)  NULL,
ADD COLUMN IF NOT EXISTS trade_profile  VARCHAR(30)  NULL,
ADD COLUMN IF NOT EXISTS iv_rank_entry  FLOAT        NULL,
ADD COLUMN IF NOT EXISTS iv_regime_entry VARCHAR(20) NULL;

COMMENT ON COLUMN positions.market_state    IS 'Pine Script market state at entry: TRENDING / EXPLOSIVE / RANGING / REVERTING';
COMMENT ON COLUMN positions.trade_profile   IS 'Trade profile at entry: Gamma Burst / Delta Trend / Theta Harvest / Vega Expansion / Vega Crush';
COMMENT ON COLUMN positions.iv_rank_entry   IS 'IV Rank percentile (0–1) at trade entry, fetched from ticker_iv_snapshots';
COMMENT ON COLUMN positions.iv_regime_entry IS 'IV regime at trade entry: contango / backwardation / flat';
