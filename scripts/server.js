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
import { createCallbackClient } from '../src/adapters/delivery/callbackClient.js';
import { createEventPublisher } from '../src/agent/eventPublisher.js';
import { createRuntimeAuditLogger } from '../src/observability/runtimeAudit.js';
import { createHttpApp } from '../src/adapters/http/app.js';
import { recoverInflightRuns } from '../src/agent/recovery.js';
import { loadAppConfig } from '../src/app/loadConfig.js';
import { loadOpenAIConfig } from '../src/llm/openaiConfig.js';
import { createOpenAIResponsesClient } from '../src/llm/openaiResponsesClient.js';
import { ensureReviewSchema } from '../src/db/reviewSchema.js';
import { createReviewStore } from '../src/auditReview/reviewStore.js';
import { createLockStore } from '../src/auditReview/lockStore.js';
import { createIngestCursorStore } from '../src/auditReview/ingestCursorStore.js';
import { createAuditIngestService } from '../src/auditReview/ingestService.js';
import { createCandidateDetector } from '../src/auditReview/candidateDetector.js';
import { createLlmReviewer } from '../src/auditReview/llmReviewer.js';
import { createReviewNotifier } from '../src/auditReview/notification.js';
import { createVisualization } from '../src/auditReview/visualization.js';
import { createDashboardAuth } from '../src/auditReview/dashboardAuth.js';
import { createAuditReviewScheduler } from '../src/auditReview/scheduler.js';
import { createRetentionScheduler, createRetentionService } from '../src/auditReview/retention.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const config = loadAppConfig(rootDir);
const dbPath = path.resolve(rootDir, config.dbPath);
const runtimeConfig = { ...config, dbPath, rootDir };
const db = openDb(dbPath);
ensureRuntimeSchema(db);
ensureReviewSchema(db);

const runStore = createRunStore(db);
const waitStore = createWaitStore(db);
const outboxStore = createOutboxStore(db);
const registry = createToolRegistry();
registry.register(buildAuditQueryTool({ db }));
registry.register(buildReportTool({ db }));

const openAIConfig = loadOpenAIConfig({ env: process.env, appConfig: config });
const llmClient = createOpenAIResponsesClient({
  apiKey: openAIConfig.apiKey,
  baseURL: openAIConfig.baseURL,
  timeoutMs: openAIConfig.timeoutMs,
});

const planner = createPlanner({
  llmClient,
  model: openAIConfig.model,
  registry,
});

const auditLogger = createRuntimeAuditLogger(db);
const reviewAuditLogger = createRuntimeAuditLogger(db, { agentId: 'audit-logger-agent' });

const eventPublisher = createEventPublisher({
  outboxStore,
  callbackClient: createCallbackClient({ fetchImpl: fetch }),
});

const runtime = createRuntime({
  runStore,
  outboxStore,
  waitStore,
  planner,
  registry,
  eventPublisher,
  auditLogger,
  executor: (task) => setImmediate(task),
});

// P3-04: recover runs orphaned by a process restart before serving traffic.
try {
  const recovered = recoverInflightRuns({ runStore, eventPublisher, auditLogger });
  if (recovered.length > 0) {
    console.log(`Recovered ${recovered.length} orphaned run(s) marked as failed.`);
  }
} catch (error) {
  console.error(`Run recovery failed: ${error.message}`);
}

// v1.4: audit review scheduler — construct all review-system dependencies.
const reviewStore = createReviewStore(db);
const lockStore = createLockStore(db);
const cursorStore = createIngestCursorStore(db);
const ingestService = createAuditIngestService({ db, config: runtimeConfig, cursorStore, now: () => new Date() });
const detector = createCandidateDetector({ db, riskPolicy: config.auditReview?.riskPolicy ?? {} });
const llmReviewer = createLlmReviewer({
  llmClient,
  model: openAIConfig.model,
  promptVersion: config.auditReview?.llmReview?.promptVersion,
  reviewerVersion: config.auditReview?.llmReview?.reviewerVersion,
});
const reviewNotifier = createReviewNotifier({ outboxStore, config });
const reviewVisualization = createVisualization({ reviewStore, config, llmClient, model: openAIConfig.model });
const dashboardAuth = createDashboardAuth({ config, env: process.env });
const scheduler = createAuditReviewScheduler({
  db,
  config,
  reviewStore,
  lockStore,
  ingestService,
  cursorStore,
  detector,
  llmReviewer,
  notifier: reviewNotifier,
  visualization: reviewVisualization,
  auditLogger: reviewAuditLogger,
  llmModel: openAIConfig.model,
  now: () => new Date(),
});
const retentionService = createRetentionService({ db, config: runtimeConfig, cursorStore, now: () => new Date() });
const retentionScheduler = createRetentionScheduler({
  retentionService,
  config: runtimeConfig,
  onRun: (result) => {
    console.log(`Retention cleanup completed: ${JSON.stringify(result.deleted)}`);
  },
  onError: (error) => {
    console.error(`Retention cleanup failed: ${error.message}`);
  },
});

// v1.4: validate dashboard auth boot config (throws if non-loopback without token).
dashboardAuth.validateBoot({ bindHost: config.auditReview?.http?.bindHost ?? '127.0.0.1' });

// v1.4: recover stale review runs on startup.
try {
  scheduler.recoverStaleRuns();
} catch (error) {
  console.error(`Review recovery failed: ${error.message}`);
}

// v1.4: start the periodic scheduler if enabled.
if (config.auditReview?.enabled !== false) {
  scheduler.start();
  console.log('Audit review scheduler started.');
}

if (runtimeConfig.retention?.enabled !== false) {
  retentionScheduler.start();
  console.log(`Retention scheduler started for hour ${runtimeConfig.retention?.runAtHour ?? 4}.`);
}

const app = createHttpApp({
  db,
  config: runtimeConfig,
  runStore,
  runtime,
  scheduler,
  reviewStore,
  visualization: reviewVisualization,
  dashboardAuth,
});
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
  scheduler.stop();
  retentionScheduler.stop();
  clearInterval(flushInterval);
  db.close();
  process.exit(0);
});
