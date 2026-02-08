-- Add optional stop_price to positions (manual stop loss level per position)
-- Run in Supabase SQL Editor if your positions table doesn't have this column yet.

ALTER TABLE positions
ADD COLUMN IF NOT EXISTS stop_price DECIMAL(10,2) NULL;

COMMENT ON COLUMN positions.stop_price IS 'Manual stop loss price per contract; overrides calculated stop when set.';
