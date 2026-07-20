CREATE TABLE IF NOT EXISTS user_annotations (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  symbol TEXT NOT NULL DEFAULT '',
  timestamp BIGINT NOT NULL DEFAULT 0,
  type TEXT NOT NULL DEFAULT 'note',
  data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, symbol, timestamp)
);

CREATE INDEX idx_user_annotations_lookup ON user_annotations(user_id, symbol, timestamp DESC);

ALTER TABLE user_annotations ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_annotations_user_policy ON user_annotations
  FOR ALL USING (user_id = (current_setting('request.jwt.claims', true)::json->>'userId')::integer);
