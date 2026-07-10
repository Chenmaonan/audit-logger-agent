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

test('plannerPrompt source keeps key strings intact', () => {
  const plannerPromptSource = readSource('src/agent/plannerPrompt.js');

  assert.ok(plannerPromptSource.includes('audit-log agent'));
  assert.ok(!plannerPromptSource.includes('�'));
});

test('payload source keeps key Chinese strings intact', () => {
  const payloadsSource = readSource('src/agent/payloads.js');

  assert.ok(payloadsSource.includes('任务执行中'));
  assert.ok(!payloadsSource.includes('�'));
});
