import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function collectTestFiles(directory) {
  if (!fs.existsSync(directory)) return [];

  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(directory, entry.name);
    return entry.isDirectory()
      ? collectTestFiles(filePath)
      : filePath.endsWith('.test.js') ? [filePath] : [];
  });
}

const testFiles = collectTestFiles('test').sort();
const runExternal = process.argv.includes('--external');
const selectedTestFiles = testFiles.filter((filePath) => {
  const isExternal = filePath.startsWith(`test${path.sep}external${path.sep}`);
  return runExternal ? isExternal : !isExternal;
});
const result = spawnSync(process.execPath, ['--test', ...selectedTestFiles], {
  stdio: 'inherit',
  env: runExternal ? { ...process.env, RUN_AUDIT_EXTERNAL_TESTS: '1' } : process.env,
});

process.exit(result.status ?? 1);
