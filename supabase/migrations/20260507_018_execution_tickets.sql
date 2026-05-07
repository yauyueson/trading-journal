-- 018_execution_tickets.sql
-- Durable audit trail for governed BCD/PMCC paper execution tickets.
-- The app writes one row before inserting a governed paper position. Blocked
-- rows are retained so risk vetoes are visible instead of disappearing as UI
-- errors; approved rows are later linked to the inserted position_id.

CREATE TABLE IF NOT EXISTS execution_tickets (
    id                         BIGSERIAL   PRIMARY KEY,
    ticket_id                  TEXT        NOT NULL UNIQUE,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    status                     TEXT        NOT NULL CHECK (status IN ('draft', 'risk_approved', 'blocked')),
    decision                   TEXT        NOT NULL CHECK (decision IN ('approved', 'blocked')),
    strategy_type              TEXT        NOT NULL CHECK (strategy_type IN ('bcd', 'pmcc')),
    strategy_label             TEXT        NOT NULL,
    requested_mode             TEXT        NOT NULL CHECK (requested_mode IN ('paper', 'live')),
    ticker                     TEXT        NOT NULL,
    quantity                   INT         NOT NULL CHECK (quantity > 0),
    max_risk_per_contract      REAL        NOT NULL CHECK (max_risk_per_contract >= 0),
    max_risk_dollars           REAL        NOT NULL CHECK (max_risk_dollars >= 0),
    risk_cap_dollars           REAL        NOT NULL CHECK (risk_cap_dollars >= 0),
    account_size               REAL        NOT NULL CHECK (account_size >= 0),
    evidence_path              TEXT        NOT NULL,
    governance_version         INT         NOT NULL,
    required_approval_roles    JSONB       NOT NULL DEFAULT '[]'::jsonb,
    approvals                  JSONB       NOT NULL DEFAULT '{}'::jsonb,
    blocks                     JSONB       NOT NULL DEFAULT '[]'::jsonb,
    warnings                   JSONB       NOT NULL DEFAULT '[]'::jsonb,
    active_positions_snapshot  JSONB       NOT NULL DEFAULT '[]'::jsonb,
    input_snapshot             JSONB       NOT NULL DEFAULT '{}'::jsonb,
    position_id                UUID        REFERENCES positions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_execution_tickets_created_at
    ON execution_tickets (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_execution_tickets_strategy_type
    ON execution_tickets (strategy_type);
CREATE INDEX IF NOT EXISTS idx_execution_tickets_decision
    ON execution_tickets (decision);
CREATE INDEX IF NOT EXISTS idx_execution_tickets_position_id
    ON execution_tickets (position_id);

ALTER TABLE execution_tickets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read access" ON execution_tickets FOR SELECT USING (true);
CREATE POLICY "Service role write" ON execution_tickets FOR ALL USING (true);
