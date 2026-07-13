import crypto from 'crypto';

function nowIso() {
  return new Date().toISOString();
}

function batchId() {
  return `batch_${crypto.randomUUID()}`;
}

function tableExists(db, tableName) {
  try {
    return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tableName) != null;
  } catch {
    return false;
  }
}

function tableHasColumn(db, tableName, columnName) {
  try {
    return db.prepare(`PRAGMA table_info(${tableName})`).all().some((row) => row.name === columnName);
  } catch {
    return false;
  }
}

export function createLogBatchStore(db) {
  const getOpenStmt = db.prepare(`
    SELECT * FROM audit_log_batches
    WHERE agent_id = ? AND status = 'open'
    ORDER BY opened_at DESC
    LIMIT 1
  `);
  const getStmt = db.prepare(`SELECT * FROM audit_log_batches WHERE batch_id = ?`);
  const insertOpenStmt = db.prepare(`
    INSERT INTO audit_log_batches (
      batch_id, agent_id, status, opened_at, locked_at, review_id, snapshot_id, raw_deleted_at
    ) VALUES (
      @batch_id, @agent_id, 'open', @opened_at, NULL, NULL, NULL, NULL
    )
  `);
  const lockStmt = db.prepare(`
    UPDATE audit_log_batches
    SET status = 'locked',
        locked_at = @locked_at,
        review_id = @review_id
    WHERE batch_id = @batch_id AND status = 'open'
  `);
  const markReviewedStmt = db.prepare(`
    UPDATE audit_log_batches
    SET status = 'reviewed',
        review_id = @review_id,
        snapshot_id = @snapshot_id
    WHERE batch_id = @batch_id
  `);
  const markRawDeletedStmt = db.prepare(`
    UPDATE audit_log_batches
    SET status = 'raw_deleted',
        raw_deleted_at = @raw_deleted_at
    WHERE batch_id = @batch_id
  `);
  const listReviewedRawCandidatesStmt = db.prepare(`
    SELECT batch_id
    FROM audit_log_batches
    WHERE agent_id = @agent_id
      AND status = 'reviewed'
      AND raw_deleted_at IS NULL
      AND snapshot_id IS NOT NULL
      AND snapshot_id <> ''
      AND batch_id <> COALESCE(@exclude_batch_id, '')
    ORDER BY opened_at ASC, batch_id ASC
  `);

  function insertOpen(agentId, now) {
    const id = batchId();
    insertOpenStmt.run({ batch_id: id, agent_id: agentId, opened_at: now });
    return getStmt.get(id);
  }

  const lockTxn = db.transaction(({ agentId, reviewId, now }) => {
    const open = getOpenStmt.get(agentId) ?? insertOpen(agentId, now);
    lockStmt.run({
      batch_id: open.batch_id,
      locked_at: now,
      review_id: reviewId,
    });
    return {
      lockedBatch: getStmt.get(open.batch_id),
      openBatch: insertOpen(agentId, now),
    };
  });

  return {
    getOrCreateOpenBatch(agentId, { now = nowIso() } = {}) {
      return getOpenStmt.get(agentId) ?? insertOpen(agentId, now);
    },

    lockOpenBatchForReview({ agentId, reviewId, now = nowIso() } = {}) {
      return lockTxn({ agentId, reviewId, now });
    },

    markReviewed({ batchId, reviewId, snapshotId } = {}) {
      markReviewedStmt.run({
        batch_id: batchId,
        review_id: reviewId,
        snapshot_id: snapshotId,
      });
      return getStmt.get(batchId) ?? null;
    },

    markRawDeleted({ batchId, now = nowIso() } = {}) {
      markRawDeletedStmt.run({
        batch_id: batchId,
        raw_deleted_at: now,
      });
      return getStmt.get(batchId) ?? null;
    },

    deleteReviewedRawLogsForAgent({ agentId, excludeBatchId = null, now = nowIso() } = {}) {
      if (!tableExists(db, 'audit_events')) {
        return { skipped: true, reason: 'missing_audit_events_table', agentId, batchIds: [], deletedRows: 0 };
      }
      if (!tableHasColumn(db, 'audit_events', 'batch_id')) {
        return { skipped: true, reason: 'missing_audit_events_batch_id', agentId, batchIds: [], deletedRows: 0 };
      }
      if (!tableHasColumn(db, 'audit_events', 'agent_id')) {
        return { skipped: true, reason: 'missing_audit_events_agent_id', agentId, batchIds: [], deletedRows: 0 };
      }

      const deleteTxn = db.transaction((params) => {
        const batches = listReviewedRawCandidatesStmt.all({
          agent_id: params.agentId,
          exclude_batch_id: params.excludeBatchId,
        });
        const deleteStmt = db.prepare(`
          DELETE FROM audit_events
          WHERE agent_id = @agent_id AND batch_id = @batch_id
        `);
        let deletedRows = 0;
        for (const batch of batches) {
          deletedRows += deleteStmt.run({
            agent_id: params.agentId,
            batch_id: batch.batch_id,
          }).changes;
          markRawDeletedStmt.run({
            batch_id: batch.batch_id,
            raw_deleted_at: params.now,
          });
        }
        return {
          skipped: false,
          reason: null,
          agentId: params.agentId,
          batchIds: batches.map((batch) => batch.batch_id),
          deletedRows,
        };
      });

      return deleteTxn({ agentId, excludeBatchId, now });
    },

    listBatches({ agentId, status } = {}) {
      const conditions = [];
      const params = {};
      if (agentId) {
        conditions.push('agent_id = @agentId');
        params.agentId = agentId;
      }
      if (status) {
        conditions.push('status = @status');
        params.status = status;
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      return db.prepare(`
        SELECT * FROM audit_log_batches
        ${where}
        ORDER BY opened_at DESC, batch_id DESC
      `).all(params);
    },
  };
}
