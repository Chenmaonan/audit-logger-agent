const REQUIRED_FIELDS = ['ts', 'agent_id', 'trace_id', 'span_id', 'event', 'tool_name', 'status', 'result_summary'];
const VALID_EVENTS = ['tool.start', 'tool.end', 'tool.error', 'agent.start', 'agent.end', 'agent.error'];
const VALID_STATUSES = ['ok', 'error', 'timeout', 'cancelled'];

export function validateLogEntry(entry, lineNumber) {
  const errors = [];

  for (const field of REQUIRED_FIELDS) {
    if (entry[field] == null || entry[field] === '') {
      errors.push(`line ${lineNumber}: missing required field "${field}"`);
    }
  }

  if (entry.event && !VALID_EVENTS.includes(entry.event)) {
    errors.push(`line ${lineNumber}: invalid event "${entry.event}"`);
  }

  if (entry.status && !VALID_STATUSES.includes(entry.status)) {
    errors.push(`line ${lineNumber}: invalid status "${entry.status}"`);
  }

  if (entry.ts && isNaN(Date.parse(entry.ts))) {
    errors.push(`line ${lineNumber}: invalid ISO 8601 timestamp "${entry.ts}"`);
  }

  if (entry.result_summary && entry.result_summary.length > 200) {
    errors.push(`line ${lineNumber}: result_summary exceeds 200 chars (${entry.result_summary.length})`);
  }

  if (entry.error && typeof entry.error !== 'object') {
    errors.push(`line ${lineNumber}: error field must be an object`);
  }

  if (entry.tags && !Array.isArray(entry.tags)) {
    errors.push(`line ${lineNumber}: tags must be an array`);
  }

  return errors;
}

export function parseNdjson(content) {
  const lines = content.split('\n').filter(line => line.trim() !== '');
  const entries = [];
  const errors = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);
      const lineNumber = i + 1;
      const validationErrors = validateLogEntry(entry, lineNumber);
      if (validationErrors.length > 0) {
        errors.push(...validationErrors);
        continue;
      }
      entries.push(entry);
    } catch (e) {
      errors.push(`line ${i + 1}: invalid JSON — ${e.message}`);
    }
  }

  return { entries, errors };
}

export function normalizeEntry(entry) {
  const error = entry.error || null;
  return {
    ts: entry.ts,
    agent_id: entry.agent_id,
    trace_id: entry.trace_id,
    span_id: entry.span_id,
    parent_span_id: entry.parent_span_id || null,
    event: entry.event,
    tool_name: entry.tool_name,
    status: entry.status,
    result_summary: entry.result_summary,
    duration_ms: entry.duration_ms ?? null,
    channel: entry.channel || null,
    user_id: entry.user_id || null,
    product_id: entry.product_id || null,
    error_code: error?.code || null,
    error_message: error?.message || null,
    tags: entry.tags ? JSON.stringify(entry.tags) : null,
    raw_json: JSON.stringify(entry),
  };
}
