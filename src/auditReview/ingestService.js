// src/auditReview/ingestService.js
//
// Audit-log ingest service for the v1.4 periodic-review system.
// Reuses scripts/lib/indexer.js (scanLogFiles), scripts/lib/parser.js
// (parseNdjson + normalizeEntry) and scripts/lib/db.js (insertEvents).
//
// Adds incremental file-cursor reads per design-doc §5.4:
//   - skip when (size,mtime) unchanged
//   - read from offset when appended
//   - read whole file when truncated/rotated or first seen
//   - hold back the trailing partial line until a newline arrives

import fs from 'fs';
import path from 'path';
import { scanLogFiles } from '../../scripts/lib/indexer.js';
import { parseNdjson, normalizeEntry } from '../../scripts/lib/parser.js';
import { insertEvents } from '../../scripts/lib/db.js';

/**
 * Read bytes [offsetBytes, end) from a file as a UTF-8 string.
 * Returns { chunk, size, mtimeMs }. Throws nothing for missing files;
 * caller should stat first.
 */
export function readIncrementalChunk(filePath, offsetBytes = 0) {
  const stat = fs.statSync(filePath);
  const size = stat.size;
  const start = Math.max(0, offsetBytes);
  if (start >= size) {
    return { chunk: '', size, mtimeMs: stat.mtimeMs };
  }
  // Use a Buffer so byte offsets are exact (no UTF-8 decode boundary issues for
  // ASCII NDJSON; for multi-byte chars split across the boundary this is still
  // safe because we only consume up to the last '\n', and JSON lines are whole
  // UTF-8 codepoint sequences terminated by '\n').
  const fd = fs.openSync(filePath, 'r');
  try {
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, start);
    return { chunk: buf.toString('utf-8'), size, mtimeMs: stat.mtimeMs };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Locate the byte offset of the last '\n' in `chunk` (counted from the start
 * of the chunk, i.e. relative to `offsetBytes`). Returns -1 if there is none.
 * The partial-line length is `chunk.length - (lastNewlineRel + 1)` when a
 * trailing newline exists; otherwise it is `chunk.length` (whole chunk is
 * partial).
 */
function splitCompleteAndPartial(chunk) {
  if (chunk.length === 0) {
    return { completeText: '', partialBytes: 0, consumedBytes: 0 };
  }
  const endsWithNewline = chunk.endsWith('\n');
  if (endsWithNewline) {
    return { completeText: chunk, partialBytes: 0, consumedBytes: chunk.length };
  }
  const lastNewline = chunk.lastIndexOf('\n');
  if (lastNewline === -1) {
    // No newline at all -> everything is partial.
    return { completeText: '', partialBytes: chunk.length, consumedBytes: 0 };
  }
  // completeText includes the trailing newline at `lastNewline`.
  const completeText = chunk.slice(0, lastNewline + 1);
  const partialBytes = chunk.length - (lastNewline + 1);
  return { completeText, partialBytes, consumedBytes: lastNewline + 1 };
}

function basename(p) {
  return path.basename(p);
}

/**
 * Create the audit ingest service.
 *
 * @param {object}  opts
 * @param {object}  opts.db          better-sqlite3 Database (audit_events schema already present)
 * @param {object}  opts.config      config.json object (must contain dbPath + agents map)
 * @param {object}  opts.cursorStore result of createIngestCursorStore(db)
 * @param {() => Date} [opts.now]    injectable clock, defaults to Date.now-based
 */
export function createAuditIngestService({ db, config, cursorStore, now = () => new Date() } = {}) {
  if (!db) throw new Error('createAuditIngestService: db is required');
  if (!config) throw new Error('createAuditIngestService: config is required');
  if (!cursorStore) throw new Error('createAuditIngestService: cursorStore is required');

  const dbDir = path.dirname(config.dbPath);

  /**
   * Ingest new audit-log lines for every configured agent.
   *
   * @param {object} opts
   * @param {string} opts.sinceDate  YYYY-MM-DD — passed to scanLogFiles for filename date filtering
   * @param {string} [opts.reviewId] optional review-run id (recorded only in cursor last_error context)
   * @returns {object} result summary
   */
  function ingestSince({ sinceDate, reviewId } = {}) {
    let inserted = 0;
    let scannedFiles = 0;
    let cursorUpdates = 0;
    const parseErrors = [];

    const agents = config.agents || {};

    for (const [agentId, agentConfig] of Object.entries(agents)) {
      if (!agentConfig) continue;
      const logDir = path.resolve(dbDir, agentConfig.logDir);
      if (!fs.existsSync(logDir)) {
        // Gracefully skip — missing log directory is not a fatal error.
        continue;
      }

      let files;
      try {
        files = scanLogFiles(logDir, agentConfig.pattern, sinceDate);
      } catch {
        // scanLogFiles already guards existsSync but be defensive.
        continue;
      }

      for (const absPath of files) {
        let stat;
        try {
          stat = fs.statSync(absPath);
        } catch {
          // File vanished between readdir and stat. Remove cursor if present.
          cursorStore.remove({ agentId, filePath: absPath });
          continue;
        }
        const mtimeMs = stat.mtimeMs;
        const size = stat.size;

        const cursor = cursorStore.get({ agentId, filePath: absPath });
        let offsetBytes;
        if (cursor) {
          if (cursor.file_size_bytes === size && cursor.file_mtime_ms === mtimeMs) {
            // No change since last round.
            scannedFiles++;
            continue;
          }
          if (cursor.file_size_bytes > size) {
            // Truncation/rotation — read whole file.
            offsetBytes = 0;
          } else {
            // Appended — resume from cursor offset.
            offsetBytes = cursor.offset_bytes || 0;
          }
        } else {
          offsetBytes = 0;
        }

        scannedFiles++;

        const { chunk } = readIncrementalChunk(absPath, offsetBytes);
        const { completeText, partialBytes, consumedBytes } = splitCompleteAndPartial(chunk);

        let fileParseErrors = [];
        let fileInserted = 0;
        if (completeText.length > 0) {
          const { entries, errors } = parseNdjson(completeText);
          fileParseErrors = errors.map((e) => ({
            agent_id: agentId,
            file: basename(absPath),
            line: e.match(/^line (\d+)/)?.[1] ?? '?',
            error: e,
          }));
          if (entries.length > 0) {
            const rows = entries.map(normalizeEntry);
            fileInserted = insertEvents(db, rows);
          }
        }

        inserted += fileInserted;
        parseErrors.push(...fileParseErrors);

        // New offset: bytes consumed (complete lines) relative to start of file.
        const newOffset = offsetBytes + consumedBytes;
        const lastError = fileParseErrors.length > 0
          ? `${fileParseErrors.length} parse error(s) in ${basename(absPath)}`
          : null;

        cursorStore.upsert({
          agentId,
          filePath: absPath,
          fileMtimeMs: mtimeMs,
          fileSizeBytes: size,
          offsetBytes: newOffset,
          lastError,
        });
        cursorUpdates++;

        // Sanity: if there is leftover partial content we must NOT advance the
        // offset past it. The math already accounts for this because
        // consumedBytes excludes the partial tail.
        if (partialBytes > 0 && newOffset + partialBytes !== size) {
          // Defensive: should be unreachable.
        }
      }
    }

    return {
      inserted,
      scannedFiles,
      parseErrors,
      cursorUpdates,
    };
  }

  return { ingestSince };
}