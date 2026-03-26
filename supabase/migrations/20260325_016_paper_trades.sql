-- Add paper trading support to positions table
ALTER TABLE positions ADD COLUMN IF NOT EXISTS is_paper BOOLEAN DEFAULT FALSE;

-- Index for filtering paper vs real trades
CREATE INDEX IF NOT EXISTS idx_positions_is_paper ON positions (is_paper) WHERE is_paper = TRUE;
