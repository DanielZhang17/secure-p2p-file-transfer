CREATE TABLE IF NOT EXISTS stats_daily_rollups (
  date TEXT PRIMARY KEY,
  captured_at TEXT NOT NULL,
  r2_payload_bytes INTEGER NOT NULL,
  r2_metadata_bytes INTEGER NOT NULL,
  r2_object_count INTEGER NOT NULL,
  r2_class_a_requests INTEGER NOT NULL,
  r2_class_b_requests INTEGER NOT NULL,
  turn_ingress_bytes INTEGER NOT NULL,
  turn_egress_bytes INTEGER NOT NULL,
  turn_average_concurrent_connections REAL NOT NULL,
  estimated_r2_cost_usd REAL NOT NULL,
  estimated_turn_cost_usd REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stats_daily_rollups_captured_at
  ON stats_daily_rollups (captured_at);
