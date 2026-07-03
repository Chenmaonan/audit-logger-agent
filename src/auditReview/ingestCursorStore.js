// src/auditReview/ingestCursorStore.js
function nowIso() {
  return new Date().toISOString();
}

export function createIngestCursorStore(db) {
  const getStmt = db.prepare(`
    SELECT * FROM audit_ingest_cursors WHERE agent_id = ? AND file_path = ?
  `);

  const upsertStmt = db.prepare(`
    INSERT INTO audit_ingest_cursors (
      agent_id, file_path, file_mtime_ms, file_size_bytes, offset_bytes,
      last_ingested_at, last_error
    )
    VALUES (
      @agent_id, @file_path, @file_mtime_ms, @file_size_bytes, @offset_bytes,
      @last_ingested_at, @last_error
    )
    ON CONFLICT(agent_id, file_path) DO UPDATE SET
      file_mtime_ms = @file_mtime_ms,
      file_size_bytes = @file_size_bytes,
      offset_bytes = @offset_bytes,
      last_ingested_at = @last_ingested_at,
      last_error = @last_error
  `);

  const removeStmt = db.prepare(`
    DELETE FROM audit_ingest_cursors WHERE agent_id = ? AND file_path = ?
  `);

  const listStaleStmt = db.prepare(`
    SELECT * FROM audit_ingest_cursors WHERE last_ingested_at < @cutoff_iso
  `);

  const listAllStmt = db.prepare(`SELECT * FROM audit_ingest_cursors`);

  return {
    get({ agentId, filePath }) {
      return getStmt.get(agentId, filePath) ?? null;
    },

    upsert({ agentId, filePath, fileMtimeMs, fileSizeBytes, offsetBytes = 0, lastError = null }) {
      upsertStmt.run({
        agent_id: agentId,
        file_path: filePath,
        file_mtime_ms: fileMtimeMs,
        file_size_bytes: fileSizeBytes,
        offset_bytes: offsetBytes,
        last_ingested_at: nowIso(),
        last_error: lastError,
      });
      return getStmt.get(agentId, filePath);
    },

    remove({ agentId, filePath }) {
      const info = removeStmt.run(agentId, filePath);
      return { removed: info.changes };
    },

    listStale({ missingOlderThanDays }) {
      const cutoffIso = new Date(Date.now() - missingOlderThanDays * 24 * 60 * 60 * 1000).toISOString();
      return listStaleStmt.all({ cutoff_iso: cutoffIso });
    },

    cleanupOrphans({ existingFilePathsByAgent }) {
      const all = listAllStmt.all();
      const keep = existingFilePathsByAgent;
      let removed = 0;
      const deleteTxn = db.transaction((rows) => {
        for (const row of rows) {
          const key = `${row.agent_id}|${row.file_path}`;
          if (!keep.has(key)) {
            const info = removeStmt.run(row.agent_id, row.file_path);
            removed += info.changes;
          }
        }
      });
      deleteTxn(all);
      return { removed };
    },
  };
}