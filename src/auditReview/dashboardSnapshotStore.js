import fs from 'fs';

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function hydrate(row) {
  if (!row) return null;
  return {
    snapshotId: row.snapshot_id,
    reviewId: row.review_id,
    agentId: row.agent_id,
    generatedAt: row.generated_at,
    expiresAt: row.expires_at,
    filePath: row.file_path,
    sha256: row.sha256,
    byteSize: row.byte_size,
    title: row.title,
    status: row.status,
    findingCount: row.finding_count,
    severityCounts: parseJson(row.severity_counts_json, null),
  };
}

function deleteSnapshotFile(filePath) {
  try {
    fs.unlinkSync(filePath);
    return { status: 'deleted' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'missing' };
    return {
      status: 'failed',
      error: {
        filePath,
        code: error?.code ?? null,
        message: error?.message ?? String(error),
      },
    };
  }
}

export function createDashboardSnapshotStore(db) {
  const insertStmt = db.prepare(`
    INSERT INTO audit_dashboard_snapshots (
      snapshot_id, review_id, agent_id, generated_at, expires_at, file_path,
      sha256, byte_size, title, status, finding_count, severity_counts_json
    ) VALUES (
      @snapshot_id, @review_id, @agent_id, @generated_at, @expires_at, @file_path,
      @sha256, @byte_size, @title, @status, @finding_count, @severity_counts_json
    )
  `);
  const getStmt = db.prepare(`SELECT * FROM audit_dashboard_snapshots WHERE snapshot_id = ?`);
  const expiredSnapshotsStmt = db.prepare(`
    SELECT snapshot_id, file_path FROM audit_dashboard_snapshots WHERE expires_at <= ? ORDER BY expires_at ASC
  `);
  const deleteByIdStmt = db.prepare(`DELETE FROM audit_dashboard_snapshots WHERE snapshot_id = ?`);

  return {
    createSnapshotMetadata(snapshot) {
      insertStmt.run({
        snapshot_id: snapshot.snapshotId,
        review_id: snapshot.reviewId,
        agent_id: snapshot.agentId ?? null,
        generated_at: snapshot.generatedAt,
        expires_at: snapshot.expiresAt,
        file_path: snapshot.filePath,
        sha256: snapshot.sha256,
        byte_size: snapshot.byteSize,
        title: snapshot.title ?? null,
        status: snapshot.status ?? null,
        finding_count: snapshot.findingCount ?? null,
        severity_counts_json: snapshot.severityCounts == null ? null : JSON.stringify(snapshot.severityCounts),
      });
      return hydrate(getStmt.get(snapshot.snapshotId));
    },

    getSnapshot(snapshotId) {
      return hydrate(getStmt.get(snapshotId) ?? null);
    },

    listSnapshots({ agentId, reviewId, unexpiredAt } = {}) {
      const conditions = [];
      const params = {};
      if (agentId) {
        conditions.push('agent_id = @agentId');
        params.agentId = agentId;
      }
      if (reviewId) {
        conditions.push('review_id = @reviewId');
        params.reviewId = reviewId;
      }
      if (unexpiredAt) {
        conditions.push('expires_at > @unexpiredAt');
        params.unexpiredAt = unexpiredAt;
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      return db.prepare(`
        SELECT * FROM audit_dashboard_snapshots
        ${where}
        ORDER BY generated_at DESC, snapshot_id DESC
      `).all(params).map(hydrate);
    },

    deleteExpiredSnapshots(now) {
      const expiredSnapshots = expiredSnapshotsStmt.all(now);
      const filePaths = expiredSnapshots.map((row) => row.file_path);
      const deletedFiles = [];
      const missingFiles = [];
      const failedFiles = [];
      let deleted = 0;

      for (const snapshot of expiredSnapshots) {
        const result = deleteSnapshotFile(snapshot.file_path);
        if (result.status === 'failed') {
          failedFiles.push(result.error);
          continue;
        }

        if (result.status === 'deleted') {
          deletedFiles.push(snapshot.file_path);
        } else {
          missingFiles.push(snapshot.file_path);
        }
        deleted += deleteByIdStmt.run(snapshot.snapshot_id).changes;
      }

      return { deleted, filePaths, deletedFiles, missingFiles, failedFiles };
    },
  };
}
