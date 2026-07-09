import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf-8');
}

test('config.json exposes retention defaults for runtime data and owned files', () => {
  const config = JSON.parse(readText('config.json'));

  assert.equal(config.tmpDir, 'data/tmp');
  assert.equal(config.capturesDir, 'data/captures');
  assert.equal(config.logDir, 'logs');
  assert.deepEqual(
    {
      runtimeRunsDays: config.retention.runtimeRunsDays,
      waitingStatesDays: config.retention.waitingStatesDays,
      llmUsageDays: config.retention.llmUsageDays,
      logFilesDays: config.retention.logFilesDays,
      tmpFilesDays: config.retention.tmpFilesDays,
      captureFilesDays: config.retention.captureFilesDays,
    },
    {
      runtimeRunsDays: 30,
      waitingStatesDays: 30,
      llmUsageDays: 90,
      logFilesDays: 14,
      tmpFilesDays: 7,
      captureFilesDays: 30,
    },
  );
});

test('README documents owned runtime paths and workspace-local exclusions', () => {
  const readme = readText('README.md');

  for (const required of [
    'data/tmp/',
    'data/captures/',
    'logs/',
    '.agents/',
    '.claude/',
    '.superpowers/',
    'record.json',
    'Typora_Hook_Log.txt',
    'outside app self-cleanup scope',
  ]) {
    assert.ok(readme.includes(required), `README should include ${required}`);
  }
});

test('README and gitignore keep legacy root callback files as migration-only compatibility', () => {
  const readme = readText('README.md');
  const gitignore = readText('.gitignore');

  for (const required of [
    '.callback-*.log',
    'runtime path migration',
    'not part of app self-cleanup',
  ]) {
    assert.ok(readme.includes(required), `README should include ${required}`);
  }

  for (const ignored of [
    '.config',
    'data/',
    'logs/',
    '.server.log',
    '.server.err.log',
    '.callback-*.log',
    '.callback-*.err.log',
    '.agents/',
    '.claude/',
    '.superpowers/',
  ]) {
    assert.ok(gitignore.includes(ignored), `.gitignore should include ${ignored}`);
  }
});

test('README still documents long-running operations guidance', () => {
  const readme = fs.readFileSync('README.md', 'utf-8');

  for (const required of [
    'AUDIT_AGENT_LLM_API_KEY',
    'chmod 600 .config',
    'pm2 start',
    'pm2 startup',
    'systemd',
    'Restart=always',
    'logrotate',
    '.server.log',
    'sqlite3',
    '.backup',
    'WAL',
    'node scripts/prune.js --dry-run',
  ]) {
    assert.ok(readme.includes(required), `README should include ${required}`);
  }
});
