-- Migration 010: Add exit_type to positions
-- Tracks how a position was closed: TP (take profit), SL (stop loss),
-- TIME (expired), MANUAL (discretionary close), ROLL (rolled to new position)
ALTER TABLE positions ADD COLUMN IF NOT EXISTS exit_type VARCHAR(10) NULL;
