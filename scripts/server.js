// scripts/server.js
import path from 'path';
import { fileURLToPath } from 'url';
import { openDb } from './lib/db.js';
import { ensureRuntimeSchema } from '../src/db/runtimeSchema.js';
import { createRunStore } from '../src/agent/runStore.js';
import { createWaitStore } from '../src/agent/waitStore.js';
import { createOutboxStore } from '../src/agent/outboxStore.js';
import { createPlanner } from '../src/agent/planner.js';
import { createRuntime } from '../src/agent/runtime.js';
import { createToolRegistry } from '../src/tools/registry.js';
import { buildAuditQueryTool } from '../src/tools/auditQueryTool.js';
import { buildReportTool } from '../src/tools/reportTool.js';
import { createCallbackClient } from '../src/adapters/bot/callbackClient.js';
import { createEventPublisher } from '../src/agent/eventPublisher.js';
import { createRuntimeAuditLogger } from '../src/observability/runtimeAudit.js';
import { createHttpApp } from '../src/adapters/http/app.js';
import { loadAppConfig } from '../src/app/loadConfig.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const config = loadAppConfig(rootDir);
const dbPath = path.resolve(rootDir, config.dbPath);
const db = openDb(dbPath);
ensureRuntimeSchema(db);

const runStore = createRunStore(db);
const waitStore = createWaitStore(db);
const outboxStore = createOutboxStore(db);
const registry = createToolRegistry();
registry.register(buildAuditQueryTool({ db }));
registry.register(buildReportTool({ db }));

const eventPublisher = createEventPublisher({
  outboxStore,
  callbackClient: createCallbackClient({ fetchImpl: fetch }),
});

const runtime = createRuntime({
  runStore,
  outboxStore,
  waitStore,
  planner: createPlanner(),
  registry,
  eventPublisher,
  auditLogger: createRuntimeAuditLogger(db),
});

const app = createHttpApp({ db, config: { ...config, dbPath }, runStore, runtime });
const portIndex = process.argv.indexOf('--port');
const portArg = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 9320;
const port = Number.isFinite(portArg) ? portArg : 9320;

const flushInterval = setInterval(async () => {
  try {
    await eventPublisher.flushPending(20);
  } catch (error) {
    console.error(error.message);
  }
}, 1000);

app.listen(port, '127.0.0.1', () => {
  console.log(`Agent API on http://127.0.0.1:${port}`);
});

process.on('SIGINT', () => {
  clearInterval(flushInterval);
  db.close();
  process.exit(0);
});