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
  reviewer_version TEXT NOT NULL,
  first_review_id TEXT,
  last_review_id TEXT,
  max_severity TEXT,
  state_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS audit_review_finding_occurrences (
  occurrence_id TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  recommendation TEXT,
  evidence_event_ids_json TEXT NOT NULL,
  evidence_json TEXT,
  observed_at TEXT NOT NULL,
  is_new INTEGER NOT NULL DEFAULT 0,
  severity_escalated INTEGER NOT NULL DEFAULT 0,
  reopened INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (finding_id) REFERENCES audit_review_findings(finding_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_finding_actions (
  action_id TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  actor TEXT NOT NULL,
  note TEXT,
  snoozed_until TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (finding_id) REFERENCES audit_review_findings(finding_id) ON DELETE CASCADE
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

CREATE TABLE IF NOT EXISTS audit_notification_digest_slots (
  slot_key TEXT PRIMARY KEY,
  report_date TEXT NOT NULL,
  slot_hour INTEGER NOT NULL,
  scheduled_for TEXT NOT NULL,
  timezone_offset_minutes INTEGER NOT NULL,
  trigger_type TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  enqueued_count INTEGER NOT NULL DEFAULT 0,
  owner_id TEXT,
  lease_expires_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  last_error TEXT
);
`;

export const REVIEW_INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_review_findings_hash
ON audit_review_findings(finding_hash);

CREATE INDEX IF NOT EXISTS idx_audit_review_findings_review
ON audit_review_findings(review_id);

CREATE INDEX IF NOT EXISTS idx_audit_review_findings_severity
ON audit_review_findings(severity, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_review_occurrences_review_finding
ON audit_review_finding_occurrences(review_id, finding_id);

CREATE INDEX IF NOT EXISTS idx_audit_review_occurrences_finding_observed
ON audit_review_finding_occurrences(finding_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_review_occurrences_review_severity
ON audit_review_finding_occurrences(review_id, severity);

CREATE INDEX IF NOT EXISTS idx_audit_finding_actions_finding_created
ON audit_finding_actions(finding_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_notification_digest_slots_scheduled
ON audit_notification_digest_slots(scheduled_for DESC);

CREATE INDEX IF NOT EXISTS idx_audit_notification_digest_slots_status_lease
ON audit_notification_digest_slots(status, lease_expires_at);
`;

function tableColumns(db, tableName) {
  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name));
}

function addColumnIfMissing(db, tableName, columnName, definition) {
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
  addColumnIfMissing(db, 'audit_review_findings', 'first_review_id', 'TEXT');
  addColumnIfMissing(db, 'audit_review_findings', 'last_review_id', 'TEXT');
  addColumnIfMissing(db, 'audit_review_findings', 'max_severity', 'TEXT');
  addColumnIfMissing(db, 'audit_review_findings', 'state_version', 'INTEGER NOT NULL DEFAULT 1');
  db.exec(`
    UPDATE audit_review_findings
    SET first_review_id = COALESCE(first_review_id, review_id),
        last_review_id = COALESCE(last_review_id, review_id),
        max_severity = COALESCE(max_severity, severity),
        state_version = COALESCE(state_version, 1);

    INSERT OR IGNORE INTO audit_review_finding_occurrences (
      occurrence_id, finding_id, review_id, severity, title, summary, recommendation,
      evidence_event_ids_json, evidence_json, observed_at,
      is_new, severity_escalated, reopened, created_at
    )
    SELECT
      'occ_' || finding_id,
      finding_id,
      review_id,
      severity,
      title,
      summary,
      recommendation,
      evidence_event_ids_json,
      evidence_json,
      last_seen_at,
      1,
      0,
      0,
      created_at
    FROM audit_review_findings;
  `);
  db.exec(REVIEW_INDEXES);
  db.pragma('foreign_keys = ON');
}
