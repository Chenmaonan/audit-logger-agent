import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { openDb } from '../../scripts/lib/db.js';
import { ensureRuntimeSchema } from '../../src/db/runtimeSchema.js';
import { createOutboxStore } from '../../src/agent/outboxStore.js';
import { createCallbackClient } from '../../src/adapters/bot/callbackClient.js';
import { createEventPublisher } from '../../src/agent/eventPublisher.js';

test('outbox event is delivered to callback url and marked delivered', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-outbox-'));
  const db = openDb(path.join(tmpDir, 'runtime.db'));
  ensureRuntimeSchema(db);
  const outboxStore = createOutboxStore(db);

  let receivedBody = null;
  const sink = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  await new Promise((resolve) => sink.listen(0, '127.0.0.1', resolve));
  const { port } = sink.address();
  const callbackUrl = `http://127.0.0.1:${port}/agent-events`;

  const callbackClient = createCallbackClient({ fetchImpl: fetch });
  const publisher = createEventPublisher({ outboxStore, callbackClient });

  publisher.enqueueRunEvent(
    { run_id: 'run_test', delivery_mode: 'callback', delivery_callback_url: callbackUrl },
    'progress_update',
    { type: 'progress_update', run_id: 'run_test', title: '处理中', summary: '已完成 1/3' },
  );

  const pendingBefore = outboxStore.listPending(10);
  assert.equal(pendingBefore.length, 1);

  await publisher.flushPending(10);

  const pendingAfter = outboxStore.listPending(10);
  assert.equal(pendingAfter.length, 0);
  assert.equal(receivedBody.type, 'progress_update');
  assert.equal(receivedBody.run_id, 'run_test');

  sink.close();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});