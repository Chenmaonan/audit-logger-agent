import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readSource(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf-8');
}

test('planner source keeps key Chinese strings intact', () => {
  const plannerSource = readSource('src/agent/planner.js');

  assert.ok(plannerSource.includes('需要确认处理范围'));
  assert.ok(plannerSource.includes('异常任务分析已完成'));
  assert.ok(!plannerSource.includes('�'));
});

test('payload source keeps key Chinese strings intact', () => {
  const payloadsSource = readSource('src/agent/payloads.js');

  assert.ok(payloadsSource.includes('任务执行中'));
  assert.ok(!payloadsSource.includes('�'));
});
