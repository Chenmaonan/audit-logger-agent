import fs from 'fs';
import path from 'path';

const DEFAULT_BATCH_SIZE = 5000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const DEFAULT_RETENTION = {
  enabled: true,
  runAtHour: 4,
  eventsDays: 90,
  resolvedFindingsDays: 30,
  reviewRunsDays: 60,
  outboxDays: 14,
  vacuum: 'incremental',
};

function retentionConfig(config) {
  return {
    ...DEFAULT_RETENTION,
    ...(config.retention ?? {}),
  };
}

function cutoffIso(now, days) {
  return new Date(now.getTime() - days * MS_PER_DAY).toISOString();
}

function safeLimit(value) {
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_BATCH_SIZE;
}

function countRows(db, sql, params) {
  return db.prepare(sql).get(params).count;
}

function deleteBatched(db, { countSql, deleteSql, params, batchSize, dryRun }) {
  const total = countRows(db, countSql, params);
  if (dryRun || total === 0) {
    return { deleted: total, batches: [] };
  }

  const stmt = db.prepare(deleteSql);
  const batches = [];
  while (true) {
    const info = stmt.run({ ...params, limit: batchSize });
    if (info.changes === 0) break;
    batches.push(info.changes);
    if (info.changes < batchSize) break;
  }
  return { deleted: batches.reduce((sum, n) => sum + n, 0), batches };
}

function resolveMaybeRelative(baseDir, value) {
  if (!value) return null;
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function resolveSpoolDir(config) {
  const spoolDir = config.ingest?.spoolDir;
  if (!spoolDir) return null;
  return resolveMaybeRelative(config.rootDir ?? process.cwd(), spoolDir);
}

function isSafeSpoolAgentDir(name) {
  return typeof name === 'string'
    && name.length > 0
    && !name.includes('..')
    && !name.includes('/')
    && !name.includes('\\')
    && /^[A-Za-z0-9._-]+$/.test(name);
}

function isAuditSpoolFile(name) {
  return /^audit-.*\.jsonl$/i.test(name);
}

function fileEndsWithNewline(filePath, size) {
  if (size === 0) return true;
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(1);
    fs.readSync(fd, buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } finally {
    fs.closeSync(fd);
  }
}

function cursorByPath(db) {
  const rows = db.prepare(`SELECT agent_id, file_path, file_size_bytes, offset_bytes FROM audit_ingest_cursors`).all();
  const byPath = new Map();
  for (const row of rows) {
    byPath.set(row.file_path, row);
  }
  return byPath;
}

function listSafeExpiredSpoolFiles({ db, config, cutoffMs }) {
  const spoolDir = resolveSpoolDir(config);
  if (!spoolDir || !fs.existsSync(spoolDir)) return [];

  const cursors = cursorByPath(db);
  const files = [];
  for (const dirent of fs.readdirSync(spoolDir, { withFileTypes: true })) {
    if (!dirent.isDirectory() || !isSafeSpoolAgentDir(dirent.name)) continue;
    const agentDir = path.join(spoolDir, dirent.name);
    for (const fileDirent of fs.readdirSync(agentDir, { withFileTypes: true })) {
      if (!fileDirent.isFile() || !isAuditSpoolFile(fileDirent.name)) continue;
      const filePath = path.join(agentDir, fileDirent.name);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs >= cutoffMs) continue;

      const cursor = cursors.get(filePath);
      const cursorComplete = cursor && cursor.offset_bytes >= cursor.file_size_bytes;
      const newlineComplete = fileEndsWithNewline(filePath, stat.size);
      if (cursorComplete || newlineComplete) {
        files.push(filePath);
      }
    }
  }
  return files;
}

function configuredLogFiles(config) {
  const keep = new Set();
  const dbDir = path.dirname(config.dbPath);

  for (const [agentId, agentConfig] of Object.entries(config.agents ?? {})) {
    if (!agentConfig?.logDir || !fs.existsSync(resolveMaybeRelative(dbDir, agentConfig.logDir))) continue;
    const logDir = resolveMaybeRelative(dbDir, agentConfig.logDir);
    for (const dirent of fs.readdirSync(logDir, { withFileTypes: true })) {
      if (dirent.isFile()) {
        keep.add(`${agentId}|${path.join(logDir, dirent.name)}`);
      }
    }
  }

  const spoolDir = resolveSpoolDir(config);
  if (spoolDir && fs.existsSync(spoolDir)) {
    for (const dirent of fs.readdirSync(spoolDir, { withFileTypes: true })) {
      if (!dirent.isDirectory() || !isSafeSpoolAgentDir(dirent.name)) continue;
      const agentDir = path.join(spoolDir, dirent.name);
      for (const fileDirent of fs.readdirSync(agentDir, { withFileTypes: true })) {
        if (fileDirent.isFile() && isAuditSpoolFile(fileDirent.name)) {
          keep.add(`${dirent.name}|${path.join(agentDir, fileDirent.name)}`);
        }
      }
    }
  }

  return keep;
}

function countOrphanCursors(db, keep, plannedDeletedFiles = new Set()) {
  const rows = db.prepare(`SELECT agent_id, file_path FROM audit_ingest_cursors`).all();
  return rows.filter((row) => plannedDeletedFiles.has(row.file_path) || !keep.has(`${row.agent_id}|${row.file_path}`)).length;
}

function runMaintenance(db, vacuum) {
  const maintenance = {
    walCheckpoint: null,
    incrementalVacuum: false,
    errors: [],
  };

  try {
    maintenance.walCheckpoint = db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (error) {
    maintenance.errors.push(`wal_checkpoint: ${error.message}`);
  }

  if (vacuum === 'incremental') {
    try {
      const autoVacuum = Number(db.pragma('auto_vacuum', { simple: true }));
      if (autoVacuum === 2) {
        db.pragma('incremental_vacuum');
        maintenance.incrementalVacuum = true;
      }
    } catch (error) {
      maintenance.errors.push(`incremental_vacuum: ${error.message}`);
    }
  }

  return maintenance;
}

export function createRetentionService({ db, config, cursorStore = null, now = () => new Date() } = {}) {
  if (!db) throw new Error('createRetentionService: db is required');
  if (!config) throw new Error('createRetentionService: config is required');

  function run({ dryRun = false, batchSize = DEFAULT_BATCH_SIZE } = {}) {
    const cfg = retentionConfig(config);
    const size = safeLimit(batchSize);
    const nowDate = now();
    const eventCutoffIso = cutoffIso(nowDate, cfg.eventsDays);
    const result = {
      dryRun,
      cutoffs: {
        auditEvents: eventCutoffIso,
        resolvedFindings: cutoffIso(nowDate, cfg.resolvedFindingsDays),
        reviewRuns: cutoffIso(nowDate, cfg.reviewRunsDays),
        outboxEvents: cutoffIso(nowDate, cfg.outboxDays),
      },
      deleted: {
        auditEvents: 0,
        reviewRuns: 0,
        resolvedFindings: 0,
        outboxEvents: 0,
        ingestCursors: 0,
        spoolFiles: 0,
      },
      batches: {
        auditEvents: [],
        reviewRuns: [],
        resolvedFindings: [],
        outboxEvents: [],
      },
      maintenance: null,
    };

    const deletions = {
      auditEvents: deleteBatched(db, {
        countSql: `SELECT COUNT(*) AS count FROM audit_events WHERE ts < @cutoff`,
        deleteSql: `
          DELETE FROM audit_events
          WHERE rowid IN (
            SELECT rowid FROM audit_events WHERE ts < @cutoff ORDER BY ts ASC LIMIT @limit
          )
        `,
        params: { cutoff: result.cutoffs.auditEvents },
        batchSize: size,
        dryRun,
      }),
      reviewRuns: deleteBatched(db, {
        countSql: `SELECT COUNT(*) AS count FROM audit_review_runs WHERE started_at < @cutoff`,
        deleteSql: `
          DELETE FROM audit_review_runs
          WHERE rowid IN (
            SELECT rowid FROM audit_review_runs WHERE started_at < @cutoff ORDER BY started_at ASC LIMIT @limit
          )
        `,
        params: { cutoff: result.cutoffs.reviewRuns },
        batchSize: size,
        dryRun,
      }),
      resolvedFindings: deleteBatched(db, {
        countSql: `
          SELECT COUNT(*) AS count
          FROM audit_review_findings
          WHERE status = 'resolved' AND resolved_at IS NOT NULL AND resolved_at < @cutoff
        `,
        deleteSql: `
          DELETE FROM audit_review_findings
          WHERE rowid IN (
            SELECT rowid
            FROM audit_review_findings
            WHERE status = 'resolved' AND resolved_at IS NOT NULL AND resolved_at < @cutoff
            ORDER BY resolved_at ASC
            LIMIT @limit
          )
        `,
        params: { cutoff: result.cutoffs.resolvedFindings },
        batchSize: size,
        dryRun,
      }),
      outboxEvents: deleteBatched(db, {
        countSql: `
          SELECT COUNT(*) AS count
          FROM agent_outbox_events
          WHERE delivery_status IN ('delivered', 'dead_letter') AND created_at < @cutoff
        `,
        deleteSql: `
          DELETE FROM agent_outbox_events
          WHERE rowid IN (
            SELECT rowid
            FROM agent_outbox_events
            WHERE delivery_status IN ('delivered', 'dead_letter') AND created_at < @cutoff
            ORDER BY created_at ASC
            LIMIT @limit
          )
        `,
        params: { cutoff: result.cutoffs.outboxEvents },
        batchSize: size,
        dryRun,
      }),
    };

    for (const [key, value] of Object.entries(deletions)) {
      result.deleted[key] = value.deleted;
      result.batches[key] = value.batches;
    }

    const expiredSpoolFiles = listSafeExpiredSpoolFiles({
      db,
      config,
      cutoffMs: Date.parse(result.cutoffs.auditEvents),
    });
    result.deleted.spoolFiles = expiredSpoolFiles.length;
    if (!dryRun) {
      for (const filePath of expiredSpoolFiles) {
        fs.rmSync(filePath, { force: true });
      }
    }

    if (cursorStore && typeof cursorStore.cleanupOrphans === 'function') {
      const keep = configuredLogFiles(config);
      if (dryRun) {
        result.deleted.ingestCursors = countOrphanCursors(db, keep, new Set(expiredSpoolFiles));
      } else {
        result.deleted.ingestCursors = cursorStore.cleanupOrphans({ existingFilePathsByAgent: keep }).removed;
      }
    }

    if (!dryRun) {
      result.maintenance = runMaintenance(db, cfg.vacuum);
    }

    return result;
  }

  return { run };
}

function nextRunDelayMs(now, runAtHour) {
  const next = new Date(now.getTime());
  next.setHours(runAtHour, 0, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

export function createRetentionScheduler({
  retentionService,
  config,
  now = () => new Date(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  onRun = () => {},
  onError = () => {},
} = {}) {
  if (!retentionService) throw new Error('createRetentionScheduler: retentionService is required');
  if (!config) throw new Error('createRetentionScheduler: config is required');

  const cfg = retentionConfig(config);
  let timer = null;

  function scheduleNext() {
    const delayMs = nextRunDelayMs(now(), cfg.runAtHour);
    timer = setTimeoutFn(() => {
      try {
        onRun(retentionService.run());
      } catch (error) {
        onError(error);
      } finally {
        scheduleNext();
      }
    }, delayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  return {
    start() {
      if (timer || cfg.enabled === false) return;
      scheduleNext();
    },

    stop() {
      if (timer) {
        clearTimeoutFn(timer);
        timer = null;
      }
    },

    runNow({ dryRun = false, batchSize } = {}) {
      return retentionService.run({ dryRun, batchSize });
    },
  };
}
