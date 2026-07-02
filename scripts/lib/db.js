import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  row_hash TEXT UNIQUE NOT NULL,
  ts TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  event TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL,
  result_summary TEXT,
  duration_ms INTEGER,
  channel TEXT,
  user_id TEXT,
  product_id TEXT,
  error_code TEXT,
  error_message TEXT,
  tags TEXT,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events(ts);
CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_audit_tool ON audit_events(tool_name);
CREATE INDEX IF NOT EXISTS idx_audit_trace ON audit_events(trace_id);
CREATE INDEX IF NOT EXISTS idx_audit_span ON audit_events(span_id);
CREATE INDEX IF NOT EXISTS idx_audit_status ON audit_events(status);
CREATE INDEX IF NOT EXISTS idx_audit_product ON audit_events(product_id);
`;

import crypto from 'crypto';

function hashRow(rawJson) {
  return crypto.createHash('sha256').update(rawJson).digest('hex').slice(0, 16);
}

export function openDb(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export function insertEvents(db, events) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO audit_events
      (row_hash, ts, agent_id, trace_id, span_id, parent_span_id, event, tool_name, status,
       result_summary, duration_ms, channel, user_id, product_id,
       error_code, error_message, tags, raw_json)
    VALUES
      (@row_hash, @ts, @agent_id, @trace_id, @span_id, @parent_span_id, @event, @tool_name, @status,
       @result_summary, @duration_ms, @channel, @user_id, @product_id,
       @error_code, @error_message, @tags, @raw_json)
  `);

  const insertMany = db.transaction((rows) => {
    let count = 0;
    for (const row of rows) {
      const rowHash = hashRow(row.raw_json);
      const info = stmt.run({ ...row, row_hash: rowHash });
      if (info.changes > 0) count++;
    }
    return count;
  });

  return insertMany(events);
}

export function queryEvents(db, filters = {}) {
  const conditions = [];
  const params = {};

  if (filters.agent_id) {
    conditions.push('agent_id = @agent_id');
    params.agent_id = filters.agent_id;
  }
  if (filters.tool_name) {
    if (filters.tool_name.includes('%')) {
      conditions.push('tool_name LIKE @tool_name');
    } else {
      conditions.push('tool_name = @tool_name');
    }
    params.tool_name = filters.tool_name;
  }
  if (filters.status) {
    conditions.push('status = @status');
    params.status = filters.status;
  }
  if (filters.event) {
    conditions.push('event = @event');
    params.event = filters.event;
  }
  if (filters.from) {
    conditions.push('ts >= @from');
    params.from = filters.from;
  }
  if (filters.to) {
    conditions.push('ts <= @to');
    params.to = filters.to;
  }
  if (filters.trace_id) {
    conditions.push('trace_id = @trace_id');
    params.trace_id = filters.trace_id;
  }
  if (filters.product_id) {
    conditions.push('product_id = @product_id');
    params.product_id = filters.product_id;
  }
  if (filters.channel) {
    conditions.push('channel = @channel');
    params.channel = filters.channel;
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const limit = filters.limit || 100;
  const offset = filters.offset || 0;

  const sql = `SELECT * FROM audit_events ${where} ORDER BY ts DESC LIMIT @limit OFFSET @offset`;
  params.limit = limit;
  params.offset = offset;

  return db.prepare(sql).all(params);
}

export function dailySummary(db, date, agentId) {
  const where = ['date(ts) = @date'];
  const params = { date };
  if (agentId) { where.push('agent_id = @agentId'); params.agentId = agentId; }
  return db.prepare(`
    SELECT agent_id, tool_name, status, COUNT(*) as count
    FROM audit_events
    WHERE ${where.join(' AND ')}
    GROUP BY agent_id, tool_name, status
    ORDER BY agent_id, tool_name, status
  `).all(params);
}

export function errorReport(db, from, to, agentId) {
  const where = ['status = \'error\'', 'ts >= @from', 'ts <= @to'];
  const params = { from, to };
  if (agentId) { where.push('agent_id = @agentId'); params.agentId = agentId; }
  return db.prepare(`
    SELECT ts, agent_id, tool_name, error_code, error_message, result_summary, trace_id
    FROM audit_events
    WHERE ${where.join(' AND ')}
    ORDER BY ts DESC
  `).all(params);
}

export function toolUsageStats(db, from, to, agentId) {
  const where = ['event IN (\'tool.end\', \'tool.error\')', 'ts >= @from', 'ts <= @to'];
  const params = { from, to };
  if (agentId) { where.push('agent_id = @agentId'); params.agentId = agentId; }
  return db.prepare(`
    SELECT
      agent_id,
      tool_name,
      COUNT(*) as total,
      SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) as ok_count,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
      ROUND(AVG(duration_ms), 0) as avg_duration_ms,
      MAX(duration_ms) as max_duration_ms
    FROM audit_events
    WHERE ${where.join(' AND ')}
    GROUP BY agent_id, tool_name
    ORDER BY total DESC
  `).all(params);
}
