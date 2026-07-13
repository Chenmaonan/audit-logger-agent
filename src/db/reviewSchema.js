// src/db/reviewSchema.js
export const REVIEW_TABLES = `
CREATE TABLE IF NOT EXISTS audit_review_runs (
  review_id TEXT PRIMARY KEY,
  window_from TEXT NOT NULL,
  window_to TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  interval_minutes INTEGER,
  scanned_files INTEGER NOT NULL DEFAULT 0,
  inserted_events INTEGER NOT NULL DEFAULT 0,
  parse_error_count INTEGER NOT NULL DEFAULT 0,
  candidate_event_count INTEGER NOT NULL DEFAULT 0,
  finding_count INTEGER NOT NULL DEFAULT 0,
  llm_model TEXT,
  risk_policy_version TEXT NOT NULL,
  prompt_version TEXT,
  reviewer_version TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_review_findings (
  finding_id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL,
  finding_hash TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  agent_id TEXT,
  tool_name TEXT,
  trace_id TEXT,
  entity_type TEXT,
  entity_id TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  recommendation TEXT,
  requires_action INTEGER NOT NULL DEFAULT 0,
  evidence_event_ids_json TEXT NOT NULL,
  evidence_json TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_notified_at TEXT,
  resolved_at TEXT,
  snoozed_until TEXT,
  acknowledged_at TEXT,
  acknowledged_by TEXT,
  llm_analysis_json TEXT,
  analysis_generated_at TEXT,
  risk_policy_version TEXT NOT NULL,
  prompt_version TEXT,
  reviewer_version TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_llm_usage (
  day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0,
  est_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_review_locks (
  lock_name TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_ingest_cursors (
  agent_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_mtime_ms INTEGER NOT NULL,
  file_size_bytes INTEGER NOT NULL,
  offset_bytes INTEGER NOT NULL DEFAULT 0,
  last_ingested_at TEXT NOT NULL,
  last_error TEXT,
  PRIMARY KEY (agent_id, file_path)
);

CREATE TABLE IF NOT EXISTS dashboard_magic_links (
  token_hash TEXT PRIMARY KEY,
  allowed_agent_ids_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dashboard_sessions (
  session_hash TEXT PRIMARY KEY,
  allowed_agent_ids_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_dashboard_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL,
  agent_id TEXT,
  generated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  file_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  title TEXT,
  status TEXT,
  finding_count INTEGER,
  severity_counts_json TEXT
);

CREATE TABLE IF NOT EXISTS audit_log_batches (
  batch_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  locked_at TEXT,
  review_id TEXT,
  snapshot_id TEXT,
  raw_deleted_at TEXT
);
`;

export const REVIEW_INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_review_findings_hash
ON audit_review_findings(finding_hash);

CREATE INDEX IF NOT EXISTS idx_audit_review_findings_review
ON audit_review_findings(review_id);

CREATE INDEX IF NOT EXISTS idx_audit_review_findings_severity
ON audit_review_findings(severity, created_at);

CREATE INDEX IF NOT EXISTS idx_dashboard_magic_links_expires
ON dashboard_magic_links(expires_at);

CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_expires
ON dashboard_sessions(expires_at);

CREATE INDEX IF NOT EXISTS idx_audit_dashboard_snapshots_review
ON audit_dashboard_snapshots(review_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_audit_dashboard_snapshots_agent
ON audit_dashboard_snapshots(agent_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_audit_log_batches_agent_status
ON audit_log_batches(agent_id, status, opened_at);
`;

function tableExists(db, tableName) {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tableName) != null;
}

function tableColumns(db, tableName) {
  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name));
}

function addColumnIfMissing(db, tableName, columnName, definition) {
  if (!tableExists(db, tableName)) return;
  const columns = tableColumns(db, tableName);
  if (!columns.has(columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

export function ensureReviewSchema(db) {
  db.exec(REVIEW_TABLES);
  addColumnIfMissing(db, 'audit_review_findings', 'entity_type', 'TEXT');
  addColumnIfMissing(db, 'audit_review_findings', 'entity_id', 'TEXT');
  addColumnIfMissing(db, 'audit_review_findings', 'llm_analysis_json', 'TEXT');
  addColumnIfMissing(db, 'audit_review_findings', 'analysis_generated_at', 'TEXT');
  addColumnIfMissing(db, 'audit_events', 'batch_id', 'TEXT');
  db.exec(REVIEW_INDEXES);
}
