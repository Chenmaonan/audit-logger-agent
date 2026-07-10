import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../scripts/lib/db.js';
import { ensureRuntimeSchema } from '../../src/db/runtimeSchema.js';
import { createRunStore } from '../../src/agent/runStore.js';
import { createOutboxStore } from '../../src/agent/outboxStore.js';
import { createWaitStore } from '../../src/agent/waitStore.js';
import { createEventPublisher } from '../../src/agent/eventPublisher.js';
import { createPlanner } from '../../src/agent/planner.js';
import { createRuntime } from '../../src/agent/runtime.js';
import { createToolRegistry } from '../../src/tools/registry.js';

function dayRange(nowIso) {
  const date = nowIso.slice(0, 10);
  return {
    from: `${date}T00:00:00.000+08:00`,
    to: `${date}T23:59:59.999+08:00`,
  };
}

function stubLlmClient(nowIso) {
  let call = 0;

  return {
    async createStructuredResponse({ input, schema }) {
      call += 1;

      if (schema?.name === 'audit_agent_final_result') {
        const payload = JSON.parse(input[1].content);
        const errorRows = payload.toolResults.find((item) => item.stepName === 'load-errors')?.result ?? [];
        const summaryRows = payload.toolResults.find((item) => item.stepName === 'summarize-errors')?.result ?? [];
        const urgentCount = errorRows.slice(0, 5).length;

        return {
          type: 'final_result',
          status: 'completed',
          title: '异常任务分析已完成',
          summary: `共发现 ${errorRows.length} 条异常，建议优先处理前 ${urgentCount} 条。`,
          details_markdown: summaryRows.length === 0
            ? '未查询到异常记录。'
            : summaryRows.map((row, index) => `${index + 1}. ${row.tool_name} | ${row.result_summary}`).join('\n'),
          actions: [{ id: 'view_trace', label: '查看执行轨迹' }],
        };
      }

      const payload = JSON.parse(input[1].content);
      const range = dayRange(nowIso);
      const selected = payload.metadata?.decisionResponse?.selected_option;

      if (selected === 'today_only') {
        return {
          type: 'plan',
          plan: {
            steps: [
              {
                stepName: 'load-errors',
                toolName: 'audit.queryEvents',
                input: { status: 'INTERNAL', from: range.from, to: range.to, limit: 100 },
              },
              {
                stepName: 'summarize-errors',
                toolName: 'report.errorSummary',
                input: { from: range.from, to: range.to, agentId: undefined },
              },
            ],
          },
          decision: null,
        };
      }

      if (selected === 'all_errors') {
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
                input: { from: '1970-01-01', to: '2099-12-31', agentId: undefined },
              },
            ],
          },
          decision: null,
        };
      }

      if (payload.requestText === '帮我处理异常任务') {
        return {
          type: 'decision_request',
          plan: null,
          decision: {
            title: '需要确认处理范围',
            summary: '当前请求未明确范围，请先选择处理今天的异常，还是处理全部异常。',
            options: [
              { id: 'today_only', label: '只处理今天', description: '优先处理当天问题' },
              { id: 'all_errors', label: '处理全部异常', description: '覆盖全部历史异常' },
            ],
            formSchema: [],
            submitLabel: '继续执行',
          },
        };
      }

      throw new Error(`Unexpected planner input on call ${call}`);
    },
  };
}

function waitFor(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    function poll() {
      try {
        const value = check();
        if (value) {
          resolve(value);
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }

      if (Date.now() >= deadline) {
        reject(new Error('Timed out waiting for runtime state'));
        return;
      }

      setTimeout(poll, 10);
    }

    poll();
  });
}

test('runtime pauses for user decision and resumes to final result', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-'));
  const db = openDb(path.join(tmpDir, 'runtime.db'));
  ensureRuntimeSchema(db);

  const runStore = createRunStore(db);
  const outboxStore = createOutboxStore(db);
  const waitStore = createWaitStore(db);
  const eventPublisher = createEventPublisher({
    outboxStore,
    callbackClient: { async send() {} },
  });

  const registry = createToolRegistry();
  registry.register({
    name: 'audit.queryEvents',
    async execute() {
      return [{ tool_name: 'demo.tool', result_summary: 'demo failed' }];
    },
  });
  registry.register({
    name: 'report.errorSummary',
    async execute() {
      return [{ tool_name: 'demo.tool', result_summary: 'demo failed' }];
    },
  });

  const nowIso = '2026-07-02T09:00:00.000+08:00';
  const runtime = createRuntime({
    runStore,
    outboxStore,
    waitStore,
    planner: createPlanner({
      llmClient: stubLlmClient(nowIso),
      model: 'test-model',
      registry,
      now: () => nowIso,
    }),
    registry,
    eventPublisher,
    auditLogger: { async log() {} },
  });

  const created = await runtime.startRun({
    sourceType: 'manual',
    sessionId: 'session_test',
    messageId: 'om_test',
    requesterId: 'user_test',
    requestText: '帮我处理异常任务',
    deliveryMode: 'callback',
    deliveryTargetUrl: 'http://127.0.0.1:9999/agent-events',
    metadata: {},
  });

  const waitingRun = await waitFor(() => {
    const run = runtime.getRun(created.run_id);
    return run?.status === 'waiting_user' ? run : null;
  });
  assert.equal(waitingRun.status, 'waiting_user');

  const decisionEvent = await waitFor(() => outboxStore.listPending(10).find((event) => event.type === 'decision_request'));
  assert.ok(decisionEvent);

  await runtime.resumeRun(created.run_id, {
    decision_id: decisionEvent.payload_json.decision_id,
    user: { open_id: 'ou_test' },
    response: { selected_option: 'today_only', form_data: {} },
  });

  const completedRun = await waitFor(() => {
    const run = runtime.getRun(created.run_id);
    return run?.status === 'completed' ? run : null;
  });
  assert.equal(completedRun.status, 'completed');

  const finalEvent = await waitFor(() => outboxStore.listPending(10).find((event) => event.type === 'final_result'));
  assert.ok(finalEvent);

  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
