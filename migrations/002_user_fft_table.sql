CREATE TABLE IF NOT EXISTS user_fft_results (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  symbol TEXT NOT NULL DEFAULT '',
  timestamp BIGINT NOT NULL DEFAULT 0,
  data JSONB DEFAULT '{}',
  details JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, symbol, timestamp)
);

CREATE INDEX idx_user_fft_results_lookup ON user_fft_results(user_id, symbol, timestamp DESC);

ALTER TABLE user_fft_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_fft_results_user_policy ON user_fft_results
  FOR ALL USING (user_id = (current_setting('request.jwt.claims', true)::json->>'userId')::integer);
