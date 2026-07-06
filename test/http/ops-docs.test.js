import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

test('README documents long-running operations guidance and ignored local files', () => {
  const readme = fs.readFileSync('README.md', 'utf-8');
  const gitignore = fs.readFileSync('.gitignore', 'utf-8');

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
  ]) {
    assert.ok(readme.includes(required), `README should include ${required}`);
  }

  for (const ignored of ['.config', 'data/', '.server.log']) {
    assert.ok(gitignore.includes(ignored), `.gitignore should include ${ignored}`);
  }
});
