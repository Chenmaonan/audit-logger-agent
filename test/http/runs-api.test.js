import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../scripts/lib/db.js';
import { ensureRuntimeSchema } from '../../src/db/runtimeSchema.js';
import { createRunStore } from '../../src/agent/runStore.js';
import { createHttpApp } from '../../src/adapters/http/app.js';

test('POST /v1/runs creates a run and GET /v1/runs/:id returns it', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-http-'));
  const db = openDb(path.join(tmpDir, 'runtime.db'));
  ensureRuntimeSchema(db);
  const runStore = createRunStore(db);

  const server = createHttpApp({
    db,
    config: { dbPath: path.join(tmpDir, 'runtime.db'), agents: {} },
    runStore,
    runtime: {
      async startRun(input) {
        return runStore.createRun(input);
      },
      async getRun(runId) {
        return runStore.getRun(runId);
      },
    },
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const createResponse = await fetch(`${baseUrl}/v1/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      channel: 'feishu',
      conversation_id: 'oc_test',
      message_id: 'om_test',
      user: { open_id: 'ou_test', name: 'Alice' },
      request: { text: '帮我查询今天的异常任务并给出处理建议', attachments: [] },
      delivery: { mode: 'callback', callback_url: 'http://127.0.0.1:9999/agent-events' },
      metadata: { tenant_key: 'tenant_test' },
    }),
  });

  assert.equal(createResponse.status, 202);
  const created = await createResponse.json();
  assert.equal(created.status, 'created');
  assert.ok(created.run_id.startsWith('run_'));

  const readResponse = await fetch(`${baseUrl}/v1/runs/${created.run_id}`);
  assert.equal(readResponse.status, 200);
  const run = await readResponse.json();
  assert.equal(run.run_id, created.run_id);
  assert.equal(run.user_open_id, 'ou_test');

  server.close();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});