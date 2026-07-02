// src/agent/stateMachine.js
export const RUN_STATUSES = [
  'created',
  'planning',
  'running',
  'waiting_user',
  'completed',
  'failed',
  'cancelled',
];

const ALLOWED_TRANSITIONS = {
  created: new Set(['planning', 'cancelled']),
  planning: new Set(['running', 'failed', 'cancelled']),
  running: new Set(['waiting_user', 'completed', 'failed', 'cancelled']),
  waiting_user: new Set(['running', 'failed', 'cancelled']),
  completed: new Set([]),
  failed: new Set([]),
  cancelled: new Set([]),
};

export function canTransition(from, to) {
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid run status transition: ${from} -> ${to}`);
  }
}