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
  confidence REAL,
  agent_id TEXT,
  tool_name TEXT,
  trace_id TEXT,
  product_id TEXT,
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
  risk_policy_version TEXT NOT NULL,
  prompt_version TEXT,
  reviewer_version TEXT NOT NULL
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
`;

export const REVIEW_INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_review_findings_hash
ON audit_review_findings(finding_hash);

CREATE INDEX IF NOT EXISTS idx_audit_review_findings_review
ON audit_review_findings(review_id);

CREATE INDEX IF NOT EXISTS idx_audit_review_findings_severity
ON audit_review_findings(severity, created_at);
`;

export function ensureReviewSchema(db) {
  db.exec(REVIEW_TABLES);
  db.exec(REVIEW_INDEXES);
}