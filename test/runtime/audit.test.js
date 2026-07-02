import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb, queryEvents } from '../../scripts/lib/db.js';
import { ensureRuntimeSchema } from '../../src/db/runtimeSchema.js';
import { createRuntimeAuditLogger } from '../../src/observability/runtimeAudit.js';

test('runtime audit logger writes run lifecycle events into audit_events', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-audit-'));
  const db = openDb(path.join(tmpDir, 'runtime.db'));
  ensureRuntimeSchema(db);
  const auditLogger = createRuntimeAuditLogger(db, { agentId: 'feishu-independent-agent' });

  await auditLogger.log({
    runId: 'run_test',
    traceId: 'trace_test',
    event: 'run.start',
    status: 'ok',
    summary: 'Run created',
  });

  const rows = queryEvents(db, { agent_id: 'feishu-independent-agent' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, 'run.start');
  assert.equal(rows[0].result_summary, 'Run created');

  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});