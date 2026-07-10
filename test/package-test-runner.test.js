import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('测试脚本区分本地确定性测试与外部依赖测试', () => {
  const root = process.cwd();
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const runner = fs.readFileSync(path.join(root, 'scripts', 'run-tests.js'), 'utf8');

  assert.equal(packageJson.scripts.test, 'node scripts/run-tests.js');
  assert.equal(packageJson.scripts['test:external'], 'node scripts/run-tests.js --external');
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'run-tests.js')));
  assert.match(runner, /--external/);
  assert.match(runner, /runExternal/);
  assert.match(runner, /isExternal/);
});
