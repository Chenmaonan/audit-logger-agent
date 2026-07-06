import path from 'path';
import { fileURLToPath } from 'url';
import { openDb } from './lib/db.js';
import { ensureRuntimeSchema } from '../src/db/runtimeSchema.js';
import { ensureReviewSchema } from '../src/db/reviewSchema.js';
import { loadAppConfig } from '../src/app/loadConfig.js';
import { createIngestCursorStore } from '../src/auditReview/ingestCursorStore.js';
import { createRetentionService } from '../src/auditReview/retention.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const opts = { dryRun: false, batchSize: undefined };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--batch-size':
        if (i + 1 >= argv.length || argv[i + 1].startsWith('-')) {
          throw new Error('--batch-size requires a positive integer');
        }
        opts.batchSize = Number(argv[++i]);
        if (!Number.isInteger(opts.batchSize) || opts.batchSize < 1) {
          throw new Error('--batch-size requires a positive integer');
        }
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return opts;
}

let db;
try {
  const opts = parseArgs(process.argv.slice(2));
  const rootDir = process.env.AUDIT_LOGGER_ROOT
    ? path.resolve(process.env.AUDIT_LOGGER_ROOT)
    : path.resolve(__dirname, '..');
  const config = loadAppConfig(rootDir);
  const dbPath = path.resolve(rootDir, config.dbPath);
  const runtimeConfig = { ...config, dbPath, rootDir };

  db = openDb(dbPath);
  ensureRuntimeSchema(db);
  ensureReviewSchema(db);

  const cursorStore = createIngestCursorStore(db);
  const retentionService = createRetentionService({ db, config: runtimeConfig, cursorStore });
  const result = retentionService.run(opts);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (db) db.close();
}
