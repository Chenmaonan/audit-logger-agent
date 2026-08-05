const TRANSITIONS = Object.freeze({
  acknowledge: Object.freeze({
    allowedFromStatuses: Object.freeze(['open', 'snoozed']),
    toStatus: 'acknowledged',
  }),
  snooze: Object.freeze({
    allowedFromStatuses: Object.freeze(['open', 'acknowledged']),
    toStatus: 'snoozed',
  }),
  resolve: Object.freeze({
    allowedFromStatuses: Object.freeze(['open', 'acknowledged', 'snoozed']),
    toStatus: 'resolved',
  }),
  reopen: Object.freeze({
    allowedFromStatuses: Object.freeze(['acknowledged', 'resolved']),
    toStatus: 'open',
  }),
});

export class FindingLifecycleError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'FindingLifecycleError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function invalid(message, details) {
  return new FindingLifecycleError('invalid_finding_action', message, details);
}

function requiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(`${fieldName} is required`, { field: fieldName });
  }
  return value.trim();
}

function optionalString(value, fieldName) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') {
    throw invalid(`${fieldName} must be a string`, { field: fieldName });
  }
  return value.trim() || null;
}

function getAliasedValue(input, camelName, snakeName) {
  const camelValue = input[camelName];
  const snakeValue = input[snakeName];
  if (camelValue !== undefined && snakeValue !== undefined && camelValue !== snakeValue) {
    throw invalid(`${camelName} and ${snakeName} must match`, { field: snakeName });
  }
  return camelValue !== undefined ? camelValue : snakeValue;
}

function normalizeExpectedStateVersion(input) {
  const value = getAliasedValue(input, 'expectedStateVersion', 'expected_state_version');
  if (!Number.isInteger(value) || value < 1) {
    throw invalid('expected_state_version must be a positive integer', {
      field: 'expected_state_version',
    });
  }
  return value;
}

function normalizeSnoozedUntil(input, actedAt) {
  const value = getAliasedValue(input, 'snoozedUntil', 'snoozed_until');
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid('snoozed_until is required for snooze', { field: 'snoozed_until' });
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw invalid('snoozed_until must be a valid date-time', { field: 'snoozed_until' });
  }
  if (parsed.getTime() <= actedAt.getTime()) {
    throw invalid('snoozed_until must be in the future', { field: 'snoozed_until' });
  }
  return parsed.toISOString();
}

function makeFindingPatch(action, { actor, actedAt, snoozedUntil }) {
  const actedAtIso = actedAt.toISOString();
  switch (action) {
    case 'acknowledge':
      return {
        status: 'acknowledged',
        acknowledgedAt: actedAtIso,
        acknowledgedBy: actor,
        snoozedUntil: null,
        resolvedAt: null,
      };
    case 'snooze':
      return {
        status: 'snoozed',
        snoozedUntil,
        resolvedAt: null,
      };
    case 'resolve':
      return {
        status: 'resolved',
        snoozedUntil: null,
        resolvedAt: actedAtIso,
      };
    case 'reopen':
      return {
        status: 'open',
        acknowledgedAt: null,
        acknowledgedBy: null,
        snoozedUntil: null,
        resolvedAt: null,
      };
    default:
      throw invalid('Unsupported finding action');
  }
}

function toLifecycleError(result) {
  const details = result?.finding
    ? {
        current_status: result.finding.status,
        current_state_version: result.finding.state_version,
      }
    : undefined;
  if (result?.outcome === 'not_found') {
    return new FindingLifecycleError('finding_not_found', 'Finding not found');
  }
  if (result?.outcome === 'state_conflict') {
    return new FindingLifecycleError(
      'finding_state_conflict',
      'Finding state does not allow this action',
      details
    );
  }
  if (result?.outcome === 'version_conflict') {
    return new FindingLifecycleError(
      'finding_version_conflict',
      'Finding state version has changed',
      details
    );
  }
  return null;
}

/**
 * Create the Finding lifecycle service.
 *
 * reviewStore must expose applyFindingAction(input). The store operation must
 * atomically check existence, current status, and state_version; update the
 * Finding (incrementing state_version); and append the Action row.
 */
export function createFindingLifecycleService({ reviewStore, now = () => new Date() } = {}) {
  if (!reviewStore || typeof reviewStore.applyFindingAction !== 'function') {
    throw new Error(
      'createFindingLifecycleService: reviewStore.applyFindingAction is required'
    );
  }
  if (typeof now !== 'function') {
    throw new Error('createFindingLifecycleService: now must be a function');
  }

  function performAction(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw invalid('Finding action input must be an object');
    }

    const findingId = requiredString(input.findingId, 'findingId');
    const action = requiredString(input.action, 'action');
    const transition = TRANSITIONS[action];
    if (!transition) {
      throw invalid(`Unsupported finding action: ${action}`, { field: 'action' });
    }

    const actor = requiredString(input.actor, 'actor');
    const expectedStateVersion = normalizeExpectedStateVersion(input);
    const note = action === 'resolve' || action === 'reopen'
      ? requiredString(input.note, 'note')
      : optionalString(input.note, 'note');

    const nowValue = now();
    const actedAt = nowValue instanceof Date ? new Date(nowValue.getTime()) : new Date(nowValue);
    if (!Number.isFinite(actedAt.getTime())) {
      throw new Error('createFindingLifecycleService: now returned an invalid date');
    }

    const snoozedUntil = action === 'snooze'
      ? normalizeSnoozedUntil(input, actedAt)
      : null;
    const actedAtIso = actedAt.toISOString();

    const result = reviewStore.applyFindingAction({
      findingId,
      expectedStateVersion,
      allowedFromStatuses: [...transition.allowedFromStatuses],
      toStatus: transition.toStatus,
      findingPatch: makeFindingPatch(action, { actor, actedAt, snoozedUntil }),
      action: {
        actionType: action,
        actor,
        note,
        snoozedUntil,
        createdAt: actedAtIso,
      },
    });

    const lifecycleError = toLifecycleError(result);
    if (lifecycleError) throw lifecycleError;
    if (!result || result.outcome !== 'updated' || !result.finding || !result.action) {
      throw new Error('reviewStore.applyFindingAction returned an invalid result');
    }

    return { finding: result.finding, action: result.action };
  }

  return { performAction };
}
