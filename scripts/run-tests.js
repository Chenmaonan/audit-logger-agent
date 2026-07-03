import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const TEST_ROOTS = [
  path.join('test', 'auditReview'),
  path.join('test', 'http'),
  path.join('test', 'llm'),
  path.join('test', 'runtime'),
];

function collectTestFiles(dir) {
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return collectTestFiles(fullPath);
      return fullPath.endsWith('.test.js') ? [fullPath] : [];
    });
}

const testFiles = TEST_ROOTS
  .flatMap((dir) => collectTestFiles(dir))
  .sort();

const suite = spawnSync(process.execPath, ['--test', ...testFiles], {
  stdio: 'inherit',
});

if (suite.status !== 0) {
  process.exit(suite.status ?? 1);
}

const selfTest = spawnSync(process.execPath, [path.join('test', 'self-test.js')], {
  stdio: 'inherit',
});

process.exit(selfTest.status ?? 1);
