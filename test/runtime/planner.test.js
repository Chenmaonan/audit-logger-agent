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

function createRegistry() {
  const registry = createToolRegistry();
  registry.register({
    name: 'audit.queryEvents',
    description: 'Query audit events',
    inputSchema: { type: 'object' },
    async execute() {
      return [];
    },
  });
  registry.register({
    name: 'report.errorSummary',
    description: 'Summarize audit errors',
    inputSchema: { type: 'object' },
    async execute() {
      return [];
    },
  });
  return registry;
}

function createStubPlanner() {
  const registry = createRegistry();
  const planner = createPlanner({
    llmClient: {
      async createStructuredResponse({ input }) {
        const payload = JSON.parse(input[1].content);
        if (payload.requestText === 'Handle anomalous tasks') {
          return {
            type: 'decision_request',
            plan: null,
            decision: {
              title: 'Need scope confirmation',
              summary: 'Choose whether to review today only or all history.',
              options: [
                { id: 'today_only', label: 'Today only', description: 'Prioritize today' },
                { id: 'all_errors', label: 'All history', description: 'Review all errors' },
              ],
              formSchema: [],
              submitLabel: 'Continue',
            },
          };
        }

        return {
          type: 'plan',
          plan: {
            steps: [
              {
                stepName: 'load-errors',
                toolName: 'audit.queryEvents',
                input: { status: 'INTERNAL', limit: 100 },
              },
              {
                stepName: 'summarize-errors',
                toolName: 'report.errorSummary',
                input: { from: '2026-07-02T00:00:00.000+08:00', to: '2026-07-02T23:59:59.999+08:00' },
              },
            ],
          },
          decision: null,
        };
      },
    },
    model: 'test-model',
    registry,
    now: () => '2026-07-02T09:00:00.000+08:00',
  });
  return { planner, registry };
}

test('planner asks for decision when request scope is ambiguous', async () => {
  const { planner } = createStubPlanner();
  const result = await planner.createInitialPlan({
    requestText: 'Handle anomalous tasks',
    metadata: {},
  });

  assert.equal(result.type, 'decision_request');
  assert.equal(result.decision.options.length, 2);
  assert.deepEqual(result.decision.options.map((option) => option.id), ['today_only', 'all_errors']);
});

test('planner returns executable plan for a today-only error analysis request', async () => {
  const { planner } = createStubPlanner();
  const result = await planner.createInitialPlan({
    requestText: 'Analyze today audit errors and suggest next actions.',
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
    status: 'INTERNAL',
    result_summary: 'demo failed',
    duration_ms: 12,
    channel: 'feishu',
    user_id: 'ou_test',
    entity_type: 'tool',
    entity_id: 'demo.tool',
    llm_intent_json: null,
    error_message: 'demo error',
    tags: null,
    raw_json: JSON.stringify({
      ts: '2026-07-02T08:00:00.000+08:00',
      agent_id: 'feishu-agent',
      trace_id: 't1',
      span_id: 's1',
      event: 'tool.error',
      tool_name: 'demo.tool',
      status: 'INTERNAL',
      result_summary: 'demo failed',
    }),
  }]);

  const registry = createToolRegistry();
  registry.register(buildAuditQueryTool({ db }));
  registry.register(buildReportTool({ db }));

  const result = await registry.execute('audit.queryEvents', { status: 'INTERNAL' }, {});
  const rows = result.ok ? result.data : [];
  assert.equal(rows.length, 1);

  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
