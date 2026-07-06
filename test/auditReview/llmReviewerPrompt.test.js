import test from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_PROMPT } from '../../src/auditReview/llmReviewer.js';

test('SYSTEM_PROMPT requires narrative review and finding fields to use Simplified Chinese', () => {
  assert.match(SYSTEM_PROMPT, /summary\.title/);
  assert.match(SYSTEM_PROMPT, /summary\.overview/);
  assert.match(SYSTEM_PROMPT, /finding\.title/);
  assert.match(SYSTEM_PROMPT, /finding\.summary/);
  assert.match(SYSTEM_PROMPT, /finding\.recommendation/);
  assert.match(SYSTEM_PROMPT, /叙述性字段/);
  assert.match(SYSTEM_PROMPT, /简体中文/);
  assert.match(SYSTEM_PROMPT, /evidence|tool|ID/);
});