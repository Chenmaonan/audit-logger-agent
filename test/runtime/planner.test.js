import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb, insertEvents } from '../../scripts/lib/db.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import { buildAuditQueryTool } from '../../src/tools/auditQueryTool.js';
import { buildReportTool } from '../../src/tools/reportTool.js';
import { createPlanner } from '../../src/agent/planner.js';

test('planner asks for decision when request scope is ambiguous', async () => {
  const planner = createPlanner({ now: () => '2026-07-02T09:00:00.000+08:00' });
  const result = await planner.createInitialPlan({
    requestText: '帮我处理异常任务',
    metadata: {},
  });

  assert.equal(result.type, 'decision_request');
  assert.equal(result.decision.options.length, 2);
});

test('planner returns executable plan for today error analysis request', async () => {
  const planner = createPlanner({ now: () => '2026-07-02T09:00:00.000+08:00' });
  const result = await planner.createInitialPlan({
    requestText: '帮我查询今天的异常任务并给出处理建议',
    metadata: {},
  });

  assert.equal(result.type, 'plan');
  assert.equal(result.plan.steps[0].toolName, 'audit.queryEvents');
  assert.equal(result.plan.steps[1].toolName, 'report.errorSummary');
});

test('tool registry executes registered audit tool', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tools-'));
  const db = openDb(path.join(tmpDir, 'runtime.db'));
  insertEvents(db, [{
    ts: '2026-07-02T08:00:00.000+08:00',
    agent_id: 'feishu-agent',
    trace_id: 't1',
    span_id: 's1',
    parent_span_id: null,
    event: 'tool.error',
    tool_name: 'demo.tool',
    status: 'error',
    result_summary: 'demo failed',
    duration_ms: 12,
    channel: 'feishu',
    user_id: 'ou_test',
    product_id: null,
    error_code: 'DEMO',
    error_message: 'demo error',
    tags: null,
    raw_json: JSON.stringify({
      ts: '2026-07-02T08:00:00.000+08:00',
      agent_id: 'feishu-agent',
      trace_id: 't1',
      span_id: 's1',
      event: 'tool.error',
      tool_name: 'demo.tool',
      status: 'error',
      result_summary: 'demo failed'
    }),
  }]);

  const registry = createToolRegistry();
  registry.register(buildAuditQueryTool({ db }));
  registry.register(buildReportTool({ db }));

  const rows = await registry.execute('audit.queryEvents', { status: 'error' }, {});
  assert.equal(rows.length, 1);

  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});