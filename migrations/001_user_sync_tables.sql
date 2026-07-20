-- MCP Data Sync Tables
-- Stores user analysis data synced from the browser for MCP server access.
-- All tables use JSONB for flexible schema and RLS for user isolation.

-- Analysis results (individual pricing calculations)
CREATE TABLE IF NOT EXISTS user_analysis_data (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  symbol VARCHAR(20) NOT NULL,
  model VARCHAR(50) NOT NULL,
  timestamp BIGINT NOT NULL,
  data JSONB NOT NULL,
  facts JSONB,
  artifacts JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_user_analysis UNIQUE(user_id, symbol, model, timestamp)
);
CREATE INDEX IF NOT EXISTS idx_ua_user_sym ON user_analysis_data(user_id, symbol, timestamp DESC);

-- GEX snapshots
CREATE TABLE IF NOT EXISTS user_gex_snapshots (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  symbol VARCHAR(20) NOT NULL,
  timestamp BIGINT NOT NULL,
  data JSONB NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_user_gex UNIQUE(user_id, symbol, timestamp)
);
CREATE INDEX IF NOT EXISTS idx_ugex_user_sym ON user_gex_snapshots(user_id, symbol, timestamp DESC);

-- Portfolio snapshots
CREATE TABLE IF NOT EXISTS user_portfolio_snapshots (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  timestamp BIGINT NOT NULL,
  data JSONB NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_user_portfolio UNIQUE(user_id, timestamp)
);
CREATE INDEX IF NOT EXISTS idx_uport_user ON user_portfolio_snapshots(user_id, timestamp DESC);

-- Risk snapshots
-- data JSONB shape:
--   var95 / var99 / cvar95 / maxDrawdown / volatility: PERCENT units (e.g.,
--     2.5 = 2.5%); volatility annualized; var/cvar/maxDrawdown are POSITIVE
--     loss magnitudes (var95=2.5 means a 2.5% loss).
--   sharpeRatio / beta / correlation: dimensionless.
--   timestamp: epoch ms (matches the timestamp column).
-- See apps/web/src/services/db.ts RiskSnapshotRecord for the canonical
-- TypeScript-side description.
CREATE TABLE IF NOT EXISTS user_risk_snapshots (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  timestamp BIGINT NOT NULL,
  data JSONB NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_user_risk UNIQUE(user_id, timestamp)
);
CREATE INDEX IF NOT EXISTS idx_urisk_user ON user_risk_snapshots(user_id, timestamp DESC);

-- Analysis rollups (day/week aggregates)
CREATE TABLE IF NOT EXISTS user_analysis_rollups (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  key VARCHAR(100) NOT NULL,
  symbol VARCHAR(20) NOT NULL,
  period VARCHAR(10) NOT NULL,
  period_start BIGINT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_user_rollup UNIQUE(user_id, key)
);
CREATE INDEX IF NOT EXISTS idx_urollup_user_sym ON user_analysis_rollups(user_id, symbol, period_start DESC);
CREATE INDEX IF NOT EXISTS idx_urollup_user_period ON user_analysis_rollups(user_id, period, period_start DESC);

-- Row Level Security (users can only access their own data)
ALTER TABLE user_analysis_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_gex_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_portfolio_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_risk_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_analysis_rollups ENABLE ROW LEVEL SECURITY;

-- RLS policies (service role bypasses, authenticated users see own data)
DO $$ BEGIN
  CREATE POLICY "users_own_data" ON user_analysis_data FOR ALL USING (user_id = (current_setting('request.jwt.claims', true)::json->>'userId')::integer);
  CREATE POLICY "users_own_data" ON user_gex_snapshots FOR ALL USING (user_id = (current_setting('request.jwt.claims', true)::json->>'userId')::integer);
  CREATE POLICY "users_own_data" ON user_portfolio_snapshots FOR ALL USING (user_id = (current_setting('request.jwt.claims', true)::json->>'userId')::integer);
  CREATE POLICY "users_own_data" ON user_risk_snapshots FOR ALL USING (user_id = (current_setting('request.jwt.claims', true)::json->>'userId')::integer);
  CREATE POLICY "users_own_data" ON user_analysis_rollups FOR ALL USING (user_id = (current_setting('request.jwt.claims', true)::json->>'userId')::integer);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
