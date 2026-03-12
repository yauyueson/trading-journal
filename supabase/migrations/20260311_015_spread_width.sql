-- 015: Add spread_width to positions
ALTER TABLE positions ADD COLUMN IF NOT EXISTS spread_width numeric(8,2);
