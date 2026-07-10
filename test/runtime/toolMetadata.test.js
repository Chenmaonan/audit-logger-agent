import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry } from '../../src/tools/registry.js';
import { buildAuditQueryTool } from '../../src/tools/auditQueryTool.js';
import { buildReportTool } from '../../src/tools/reportTool.js';

test('tool registry exposes metadata for LLM planning prompts', () => {
  const registry = createToolRegistry();
  registry.register(buildAuditQueryTool({ db: {} }));
  registry.register(buildReportTool({ db: {} }));

  const tools = registry.describeTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['audit.queryEvents', 'report.errorSummary']);
  assert.ok(tools.every((tool) => typeof tool.description === 'string' && tool.description.length > 10));
  assert.ok(tools.every((tool) => tool.inputSchema && tool.inputSchema.type === 'object'));
});
