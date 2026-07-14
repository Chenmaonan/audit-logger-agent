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

test('README links human users to deployment and Agent integration guides', () => {
  const readme = readText('README.md');

  for (const required of [
    'docs/dokploy-deployment.md',
    'docs/agent-audit-log-integration-guide.md',
    '/dashboard',
  ]) {
    assert.ok(readme.includes(required), `README should include ${required}`);
  }
  assert.ok(readme.includes('Dashboard 页面可直接访问'));
  assert.doesNotMatch(readme, /"AUDIT_AGENT_DASHBOARD_TOKEN"\s*:/);
});

test('Dokploy deployment guide covers required deployment, security, and recovery steps', () => {
  const guide = readText('docs/dokploy-deployment.md');

  for (const required of [
    'AUDIT_AGENT_LLM_API_KEY',
    'AUDIT_AGENT_LLM_MODEL',
    'AUDIT_AGENT_LLM_BASE_URL',
    'AUDIT_AGENT_LLM_TIMEOUT_MS',
    'AUDIT_AGENT_DASHBOARD_TOKEN',
    'compose.dokploy.yaml',
    'Dockerfile',
    '/app/data',
    '/health',
    'TLS',
    '/v1/ingest',
    'https://<域名>/dashboard',
    'auditReview.visualization.baseUrl',
    'callback',
    '备份',
    '恢复',
  ]) {
    assert.ok(guide.includes(required), `deployment guide should include ${required}`);
  }

  assert.match(guide, /(严禁|不得)[^\n]*直接暴露[^\n]*服务/);
  assert.match(guide, /限制[^\n]*未认证[^\n]*来源/);
});
