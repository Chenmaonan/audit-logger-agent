import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensureReviewSchema } from '../../src/db/reviewSchema.js';
import { createDashboardSnapshotStore } from '../../src/auditReview/dashboardSnapshotStore.js';

function openDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = OFF');
  ensureReviewSchema(db);
  return db;
}

test('dashboardSnapshotStore creates metadata and filters by scope and unexpired snapshots', () => {
  const db = openDb();
  const store = createDashboardSnapshotStore(db);
  const base = {
    generatedAt: '2026-07-10T10:00:00.000Z',
    filePath: 'snapshots/review-1.html',
    sha256: 'a'.repeat(64),
    byteSize: 512,
    title: 'Review 1',
    status: 'ready',
    findingCount: 2,
    severityCounts: { high: 1, medium: 1 },
  };

  const scoped = store.createSnapshotMetadata({
    ...base,
    snapshotId: 'snap-1',
    reviewId: 'review-1',
    agentId: 'agent-a',
    expiresAt: '2026-07-11T10:00:00.000Z',
  });
  store.createSnapshotMetadata({
    ...base,
    snapshotId: 'snap-2',
    reviewId: 'review-2',
    agentId: 'agent-b',
    filePath: 'snapshots/review-2.html',
    expiresAt: '2026-07-11T10:00:00.000Z',
  });
  store.createSnapshotMetadata({
    ...base,
    snapshotId: 'snap-expired',
    reviewId: 'review-1',
    agentId: null,
    filePath: 'snapshots/expired.html',
    expiresAt: '2026-07-10T09:59:59.000Z',
  });

  assert.deepEqual(scoped.severityCounts, { high: 1, medium: 1 });
  assert.equal(store.getSnapshot('snap-1').filePath, 'snapshots/review-1.html');
  assert.deepEqual(
    store.listSnapshots({ agentId: 'agent-a', unexpiredAt: '2026-07-10T10:00:00.000Z' }).map((row) => row.snapshotId),
    ['snap-1'],
  );
  assert.deepEqual(
    store.listSnapshots({ reviewId: 'review-1', unexpiredAt: '2026-07-10T10:00:00.000Z' }).map((row) => row.snapshotId),
    ['snap-1'],
  );
  assert.deepEqual(
    store.listSnapshots({ unexpiredAt: '2026-07-11T10:00:01.000Z' }).map((row) => row.snapshotId),
    [],
    '24h-expired snapshots should be excluded by the unexpired filter',
  );
  db.close();
});

test('dashboardSnapshotStore deleteExpiredSnapshots removes expired HTML files and metadata only', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-snapshot-store-'));
  const db = openDb();
  try {
    const store = createDashboardSnapshotStore(db);
    const oldPath = path.join(tmpDir, 'old.html');
    const freshPath = path.join(tmpDir, 'fresh.html');
    const missingPath = path.join(tmpDir, 'missing.html');
    const failedPath = path.join(tmpDir, 'failed-directory.html');
    fs.writeFileSync(oldPath, '<html>old</html>');
    fs.writeFileSync(freshPath, '<html>fresh</html>');
    fs.mkdirSync(failedPath);

    store.createSnapshotMetadata({
      snapshotId: 'old',
      reviewId: 'review-old',
      agentId: 'agent-a',
      generatedAt: '2026-07-09T10:00:00.000Z',
      expiresAt: '2026-07-10T09:00:00.000Z',
      filePath: oldPath,
      sha256: 'b'.repeat(64),
      byteSize: 100,
    });
    store.createSnapshotMetadata({
      snapshotId: 'missing',
      reviewId: 'review-missing',
      agentId: 'agent-a',
      generatedAt: '2026-07-09T10:00:00.000Z',
      expiresAt: '2026-07-10T09:30:00.000Z',
      filePath: missingPath,
      sha256: 'd'.repeat(64),
      byteSize: 100,
    });
    store.createSnapshotMetadata({
      snapshotId: 'failed',
      reviewId: 'review-failed',
      agentId: 'agent-a',
      generatedAt: '2026-07-09T10:00:00.000Z',
      expiresAt: '2026-07-10T09:45:00.000Z',
      filePath: failedPath,
      sha256: 'e'.repeat(64),
      byteSize: 100,
    });
    store.createSnapshotMetadata({
      snapshotId: 'fresh',
      reviewId: 'review-fresh',
      agentId: 'agent-a',
      generatedAt: '2026-07-10T10:00:00.000Z',
      expiresAt: '2026-07-11T10:00:00.000Z',
      filePath: freshPath,
      sha256: 'c'.repeat(64),
      byteSize: 100,
    });

    const result = store.deleteExpiredSnapshots('2026-07-10T10:00:00.000Z');
    assert.equal(result.deleted, 2);
    assert.deepEqual(result.filePaths, [oldPath, missingPath, failedPath]);
    assert.deepEqual(result.deletedFiles, [oldPath]);
    assert.deepEqual(result.missingFiles, [missingPath]);
    assert.equal(result.failedFiles.length, 1);
    assert.equal(result.failedFiles[0].filePath, failedPath);

    assert.equal(fs.existsSync(oldPath), false);
    assert.equal(fs.existsSync(freshPath), true);
    assert.equal(fs.existsSync(failedPath), true);
    assert.equal(store.getSnapshot('old'), null);
    assert.equal(store.getSnapshot('missing'), null);
    assert.ok(store.getSnapshot('failed'), 'failed file deletion keeps metadata for retry');
    assert.equal(store.getSnapshot('fresh').filePath, freshPath);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
