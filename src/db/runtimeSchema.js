// src/db/runtimeSchema.js
export const RUNTIME_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_runs (
  run_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_id TEXT,
  user_open_id TEXT NOT NULL,
  status TEXT NOT NULL,
  request_text TEXT NOT NULL,
  delivery_mode TEXT NOT NULL,
  delivery_callback_url TEXT,
  metadata_json TEXT,
  plan_json TEXT,
  current_step_index INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_run_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  status TEXT NOT NULL,
  tool_name TEXT,
  input_json TEXT,
  output_json TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_waiting_states (
  decision_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  schema_json TEXT NOT NULL,
  context_json TEXT NOT NULL,
  requested_by_step INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_outbox_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  delivery_mode TEXT NOT NULL,
  delivery_status TEXT NOT NULL,
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  callback_url TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);
CREATE INDEX IF NOT EXISTS idx_agent_runs_updated_at ON agent_runs(updated_at);
CREATE INDEX IF NOT EXISTS idx_agent_run_steps_run_id ON agent_run_steps(run_id, step_index);
CREATE INDEX IF NOT EXISTS idx_agent_waiting_states_run_id ON agent_waiting_states(run_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_outbox_events_status ON agent_outbox_events(delivery_status, created_at);
`;

export function ensureRuntimeSchema(db) {
  db.exec(RUNTIME_SCHEMA);
}