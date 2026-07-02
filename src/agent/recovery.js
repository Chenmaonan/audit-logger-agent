// src/agent/recovery.js
import { createFailedFinalResultPayload } from './payloads.js';

const STALE_THRESHOLD_MS = 5 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

// On process restart, in-flight runs left in created/planning/running can never
// resume (the executor died). Mark stale ones as failed and emit a failed
// final_result so the Bot/user see a terminal state. waiting_user runs are
// left intact so the user can still respond to the pending decision card.
export function recoverInflightRuns({ runStore, eventPublisher, auditLogger, staleThresholdMs = STALE_THRESHOLD_MS }) {
  const recovered = [];
  const cutoff = Date.now() - staleThresholdMs;
  const runs = runStore.listNonTerminalRuns();

  for (const run of runs) {
    const updatedAtMs = Date.parse(run.updated_at ?? run.created_at);
    const isStale = !Number.isNaN(updatedAtMs) && updatedAtMs < cutoff;
    const errorCode = 'runtime_interrupted';
    const errorMessage = isStale
      ? '运行任务因进程重启且超时未恢复，已标记为失败。'
      : '运行任务因进程重启中断，已标记为失败。';

    const failedResult = {
      type: 'final_result',
      status: 'failed',
      title: '任务执行失败',
      summary: errorMessage,
      error: { code: errorCode, message: errorMessage, retryable: true },
    };

    let failedRun;
    try {
      failedRun = runStore.transitionRun(run.run_id, 'failed', {
        result: failedResult,
        errorCode,
        errorMessage,
      });
    } catch {
      failedRun = runStore.updateRun(run.run_id, {
        status: 'failed',
        result: failedResult,
        errorCode,
        errorMessage,
      });
    }

    eventPublisher.enqueueRunEvent(failedRun, 'final_result', createFailedFinalResultPayload(failedRun, { code: errorCode, message: errorMessage, summary: errorMessage, retryable: true }));
    auditLogger.log({ runId: run.run_id, event: 'run.failed', status: 'error', summary: errorMessage }).catch(() => {});
    recovered.push(run.run_id);
  }

  return recovered;
}