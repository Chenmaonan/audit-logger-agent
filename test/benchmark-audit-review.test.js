import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildBenchmarkWorkload,
  parseArgs,
  runBenchmark,
} from '../scripts/benchmark-audit-review.js';

test('benchmark workload contains representative audit scenarios', () => {
  const { events, scenarioCounts } = buildBenchmarkWorkload(20, new Date('2026-08-05T10:00:00.000Z'));

  assert.equal(events.length, 20);
  assert.ok(scenarioCounts.failed_call > 0);
  assert.ok(scenarioCounts.high_risk_delete > 0);
  assert.ok(scenarioCounts.slow_call > 0);
  assert.ok(scenarioCounts.repeated_call > 0);
  assert.ok(scenarioCounts.trace_integrity > 0);
  assert.ok(events.every((event) => event.agent_id === 'audit-benchmark-agent'));
});

test('benchmark runs the local audit pipeline and emits JSON plus CSV', async (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-review-benchmark-output-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

  const report = await runBenchmark({
    rounds: 2,
    warmupRounds: 0,
    eventsPerRound: 20,
    outDir,
  });

  assert.equal(report.mode.llm, 'mock');
  assert.equal(report.mode.external_network, 'disabled');
  assert.equal(report.rounds.length, 2);
  assert.equal(report.metrics.ingest_latency_ms.sample_count, 2);
  assert.equal(report.metrics.review_latency_ms.sample_count, 2);
  assert.ok(report.rounds.every((round) => round.ingest_accepted === 20));
  assert.ok(report.rounds.every((round) => round.ingest_rejected === 0));
  assert.ok(report.rounds.every((round) => round.persisted_event_count === 20));
  assert.ok(report.rounds.every((round) => round.candidate_event_count > 0));
  assert.ok(report.rounds.every((round) => round.finding_count > 0));
  assert.ok(fs.existsSync(report.artifacts.json));
  assert.ok(fs.existsSync(report.artifacts.csv));

  const jsonReport = JSON.parse(fs.readFileSync(report.artifacts.json, 'utf8'));
  assert.equal(jsonReport.rounds.length, 2);
  assert.match(fs.readFileSync(report.artifacts.csv, 'utf8'), /candidate_event_count/);
});

test('benchmark CLI options validate the local workload size', () => {
  assert.deepEqual(parseArgs(['--rounds', '3', '--warmup', '0', '--events', '30']), {
    rounds: 3,
    warmupRounds: 0,
    eventsPerRound: 30,
    outDir: path.resolve('data/tmp/benchmark'),
  });
  assert.throws(() => parseArgs(['--events', '9']), /--events must be an integer/);
});
