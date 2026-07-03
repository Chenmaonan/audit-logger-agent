import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const KNOWN_CATEGORIES = [
  'high_risk_permission',
  'anomalous_call',
  'repeated_call',
  'failed_call',
  'trace_integrity',
  'ingest_parse_error',
];

const REQUIRED_KEYS = [
  'name',
  'description',
  'candidates',
  'expected_categories',
  'expected_min_severity',
  'expected_max_severity',
  'title_must_contain',
  'title_must_not_contain',
  'max_false_positives',
];

const VALID_SEVERITIES = ['low', 'medium', 'high', 'critical'];

const EVAL_DIR = path.resolve(__dirname, '..', 'evals', 'auditReview');
const EXPECTED_FILES = [
  'high-risk-permission.jsonl',
  'repeated-failures.jsonl',
  'benign-retries.jsonl',
  'parse-errors.jsonl',
  'degraded-llm-fallback.jsonl',
];

function loadCases(file) {
  const filePath = path.join(EVAL_DIR, file);
  assert.ok(fs.existsSync(filePath), `eval file missing: ${filePath}`);
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  assert.ok(lines.length > 0, `eval file is empty: ${file}`);
  return lines.map((line, idx) => {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      assert.fail(`failed to JSON.parse line ${idx + 1} of ${file}: ${err.message}`);
    }
    return obj;
  });
}

test('every expected eval file exists and is non-empty', () => {
  for (const file of EXPECTED_FILES) {
    const cases = loadCases(file);
    assert.ok(cases.length >= 5, `${file} should have at least 5 cases, got ${cases.length}`);
    console.log(`  ${file}: ${cases.length} cases`);
  }
});

test('every eval case has the required keys', () => {
  for (const file of EXPECTED_FILES) {
    const cases = loadCases(file);
    for (const [idx, c] of cases.entries()) {
      for (const key of REQUIRED_KEYS) {
        assert.ok(key in c, `${file} case ${idx + 1} missing required key: ${key}`);
      }
      assert.ok(Array.isArray(c.candidates), `${file} case ${idx + 1} candidates must be an array`);
      assert.ok(c.candidates.length > 0, `${file} case ${idx + 1} must have at least one candidate`);
      assert.ok(Array.isArray(c.expected_categories), `${file} case ${idx + 1} expected_categories must be array`);
      assert.ok(Array.isArray(c.title_must_contain), `${file} case ${idx + 1} title_must_contain must be array`);
      assert.ok(Array.isArray(c.title_must_not_contain), `${file} case ${idx + 1} title_must_not_contain must be array`);
      assert.equal(typeof c.max_false_positives, 'number', `${file} case ${idx + 1} max_false_positives must be number`);
    }
  }
});

test('expected_categories are a subset of the known 6 categories', () => {
  for (const file of EXPECTED_FILES) {
    const cases = loadCases(file);
    for (const [idx, c] of cases.entries()) {
      for (const cat of c.expected_categories) {
        assert.ok(
          KNOWN_CATEGORIES.includes(cat),
          `${file} case ${idx + 1} has unknown category: ${cat}`,
        );
      }
    }
  }
});

test('severity values are within the valid enum', () => {
  for (const file of EXPECTED_FILES) {
    const cases = loadCases(file);
    for (const [idx, c] of cases.entries()) {
      assert.ok(
        VALID_SEVERITIES.includes(c.expected_min_severity),
        `${file} case ${idx + 1} invalid expected_min_severity: ${c.expected_min_severity}`,
      );
      assert.ok(
        VALID_SEVERITIES.includes(c.expected_max_severity),
        `${file} case ${idx + 1} invalid expected_max_severity: ${c.expected_max_severity}`,
      );
    }
  }
});

test('every candidate event has the expected audit-event fields', () => {
  const candidateKeys = [
    'event_id',
    'ts',
    'agent_id',
    'tool_name',
    'event',
    'status',
    'duration_ms',
    'trace_id',
    'span_id',
    'product_id',
    'error_code',
    'error_message',
    'result_summary',
  ];
  for (const file of EXPECTED_FILES) {
    const cases = loadCases(file);
    for (const [idx, c] of cases.entries()) {
      for (const [j, ev] of c.candidates.entries()) {
        for (const k of candidateKeys) {
          assert.ok(k in ev, `${file} case ${idx + 1} candidate ${j + 1} missing field: ${k}`);
        }
      }
    }
  }
});

test('degraded-llm-fallback cases carry degraded:true note', () => {
  const cases = loadCases('degraded-llm-fallback.jsonl');
  for (const [idx, c] of cases.entries()) {
    assert.equal(c.degraded, true, `degraded case ${idx + 1} must have degraded: true`);
  }
});

test('print case counts per file', () => {
  let total = 0;
  for (const file of EXPECTED_FILES) {
    const cases = loadCases(file);
    total += cases.length;
    console.log(`  ${file}: ${cases.length} cases`);
  }
  console.log(`  TOTAL: ${total} cases`);
  assert.ok(total >= 25, `expected at least 25 total cases, got ${total}`);
});