import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TOOL_TAXONOMY,
  createToolSemanticMapper,
} from '../../src/auditReview/toolSemanticMapper.js';

function event(overrides = {}) {
  return {
    id: 1,
    ts: '2026-07-08T09:59:00.000Z',
    agent_id: 'agent-test',
    trace_id: 'trace-1',
    span_id: 'span-1',
    event: 'tool.end',
    tool_name: 'db.delete',
    status: 'OK',
    result_summary: 'deleted rows',
    ...overrides,
  };
}

test('tool semantic mapper maps obvious tool names locally without LLM', async () => {
  let calls = 0;
  const mapper = createToolSemanticMapper({
    llmClient: {
      async createStructuredResponse() {
        calls += 1;
        return { tool_type: 'read', reason: 'should not be called' };
      },
    },
    model: 'test-model',
  });

  const result = await mapper.mapEvent(event({ tool_name: 'db.delete' }));

  assert.equal(result.mapped_tool_type, 'delete');
  assert.equal(result.mapping_status, 'mapped');
  assert.equal(result.mapping_source, 'rule');
  assert.equal(calls, 0);
});

test('tool semantic mapper asks LLM when local rules cannot classify tool semantics', async () => {
  const mapper = createToolSemanticMapper({
    llmClient: {
      async createStructuredResponse({ input }) {
        const user = input.find((message) => message.role === 'user');
        const payload = JSON.parse(user.content);
        assert.deepEqual(payload.allowed_tool_types, DEFAULT_TOOL_TAXONOMY);
        assert.equal(payload.event.tool_name, 'publicTraffic.metrics');
        assert.equal(payload.event.result_summary, 'Read public traffic summary');
        return { tool_type: 'read', reason: 'report query reads traffic data' };
      },
    },
    model: 'test-model',
  });

  const result = await mapper.mapEvent(event({
    tool_name: 'publicTraffic.metrics',
    result_summary: 'Read public traffic summary',
  }));

  assert.equal(result.mapped_tool_type, 'read');
  assert.equal(result.mapping_status, 'mapped');
  assert.equal(result.mapping_source, 'llm');
  assert.match(result.mapping_reason, /traffic/);
});

test('tool semantic mapper falls back to unknown when LLM returns an unsupported type', async () => {
  const mapper = createToolSemanticMapper({
    llmClient: {
      async createStructuredResponse() {
        return { tool_type: 'made_up_type', reason: 'bad type' };
      },
    },
    model: 'test-model',
  });

  const result = await mapper.mapEvent(event({ tool_name: 'custom.agentAction' }));

  assert.equal(result.mapped_tool_type, 'unknown');
  assert.equal(result.mapping_status, 'unknown');
  assert.equal(result.mapping_source, 'fallback');
});
