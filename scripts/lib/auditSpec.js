export const REQUIRED_FIELDS = [
  'ts',
  'agent_id',
  'trace_id',
  'span_id',
  'event',
  'tool_name',
  'status',
  'result_summary',
];

export const EVENT_STAGE_MAP = Object.freeze({
  'tool.start': { process: 'tool', stage: 'start' },
  'tool.end': { process: 'tool', stage: 'end' },
  'tool.error': { process: 'tool', stage: 'error' },
  'agent.start': { process: 'agent', stage: 'start' },
  'agent.end': { process: 'agent', stage: 'end' },
  'agent.error': { process: 'agent', stage: 'error' },
  'run.start': { process: 'run', stage: 'start' },
  'run.resume': { process: 'run', stage: 'resume' },
  'run.waiting_user': { process: 'run', stage: 'waiting_user' },
  'run.final_result': { process: 'run', stage: 'final_result' },
  'run.failed': { process: 'run', stage: 'failed' },
  'review.recovered': { process: 'review', stage: 'recovered' },
  'review.lock.skipped': { process: 'review', stage: 'lock_skipped' },
  'review.start': { process: 'review', stage: 'start' },
  'review.ingest.completed': { process: 'review', stage: 'ingest_completed' },
  'review.detector.completed': { process: 'review', stage: 'detector_completed' },
  'review.llm.budget_exceeded': { process: 'review', stage: 'llm_budget_exceeded' },
  'review.llm.completed': { process: 'review', stage: 'llm_completed' },
  'review.notification.enqueued': { process: 'review', stage: 'notification_enqueued' },
  'review.completed': { process: 'review', stage: 'completed' },
});

export const VALID_EVENTS = Object.freeze(Object.keys(EVENT_STAGE_MAP));

export const CANONICAL_STATUS_CODES = Object.freeze([
  'OK',
  'CANCELLED',
  'UNKNOWN',
  'INVALID_ARGUMENT',
  'DEADLINE_EXCEEDED',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION',
  'ABORTED',
  'OUT_OF_RANGE',
  'UNIMPLEMENTED',
  'INTERNAL',
  'UNAVAILABLE',
  'DATA_LOSS',
  'UNAUTHENTICATED',
]);

const LEGACY_STATUS_MAP = Object.freeze({
  ok: 'OK',
  error: 'INTERNAL',
  timeout: 'DEADLINE_EXCEEDED',
  cancelled: 'CANCELLED',
});

export function isValidEvent(event) {
  return VALID_EVENTS.includes(event);
}

export function isCanonicalStatus(status) {
  return CANONICAL_STATUS_CODES.includes(status);
}

export function normalizeCanonicalStatus(status) {
  if (isCanonicalStatus(status)) return status;
  return LEGACY_STATUS_MAP[status] ?? status;
}

export function stageForEvent(event) {
  return EVENT_STAGE_MAP[event] ?? null;
}
