-- docs/migrations/005_app_settings.sql
CREATE TABLE IF NOT EXISTS app_settings (
  id         INTEGER PRIMARY KEY DEFAULT 1,
  settings   JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enforce exactly one row
CREATE UNIQUE INDEX IF NOT EXISTS app_settings_singleton ON app_settings ((true));

-- Seed with defaults matching current hardcoded values
INSERT INTO app_settings (id, settings)
VALUES (1, '{
  "portfolio": {
    "accountSize": 5700,
    "riskPct": 1,
    "stopOutPct": 50
  },
  "techScore": {
    "weights": {
      "w_mb": 30,
      "w_bxs": 30,
      "w_bxl": 15,
      "w_ema": 15,
      "w_mom": 10
    },
    "periods": {
      "sc_mb_len": 20,
      "sc_mb_smoothing": 7,
      "sc_osc_len": 7,
      "sc_bx_s1": 5,
      "sc_bx_s2": 20,
      "sc_bx_s3": 5,
      "sc_bx_l1": 20,
      "sc_bx_l2": 5
    }
  }
}'::jsonb)
ON CONFLICT (id) DO NOTHING;
