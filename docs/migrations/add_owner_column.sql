-- Add owner column to positions table
-- Allows tagging each position with its portfolio owner (Yuchen or Annie)
ALTER TABLE positions ADD COLUMN owner VARCHAR(20) DEFAULT NULL;
