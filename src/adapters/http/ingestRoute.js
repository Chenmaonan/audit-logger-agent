import fs from 'fs';
import path from 'path';
import { validateLogEntry } from '../../../scripts/lib/parser.js';

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_LINE_BYTES = 64 * 1024;

function json(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(JSON.stringify(data));
}

function contentType(req) {
  return String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
}

function maxBodyBytes(config) {
  return config.ingest?.http?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
}

function maxLineBytes(config) {
  return config.ingest?.http?.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
}

export function isHttpIngestEnabled(config = {}) {
  return config.ingest?.http?.enabled !== false;
}

export function resolveSpoolDir(config = {}) {
  const spoolDir = config.ingest?.spoolDir ?? 'data/incoming';
  if (path.isAbsolute(spoolDir)) return spoolDir;
  const baseDir = config.rootDir ?? process.cwd();
  return path.resolve(baseDir, spoolDir);
}

function isSafeAgentId(agentId) {
  return typeof agentId === 'string'
    && agentId.length > 0
    && !agentId.includes('..')
    && !agentId.includes('/')
    && !agentId.includes('\\')
    && /^[A-Za-z0-9._-]+$/.test(agentId);
}

function eventDate(event) {
  return new Date(event.ts).toISOString().slice(0, 10);
}

async function readBody(req, limitBytes) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limitBytes) {
    const error = new Error('Request body exceeds maxBodyBytes');
    error.code = 'body_too_large';
    throw error;
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) {
      const error = new Error('Request body exceeds maxBodyBytes');
      error.code = 'body_too_large';
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function parseJsonBody(raw) {
  const parsed = raw ? JSON.parse(raw) : {};
  if (Array.isArray(parsed.events)) return parsed.events.map((event, index) => ({ event, index }));
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return [{ event: parsed, index: 0 }];
  const error = new Error('JSON body must be one event object or { "events": [...] }');
  error.code = 'invalid_body';
  throw error;
}

function parseNdjsonBody(raw, lineLimitBytes) {
  const events = [];
  const errors = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (line.trim() === '') continue;
    if (Buffer.byteLength(line, 'utf-8') > lineLimitBytes) {
      errors.push({ index: i, error: `line exceeds maxLineBytes (${lineLimitBytes})` });
      continue;
    }
    try {
      events.push({ event: JSON.parse(line), index: i });
    } catch (error) {
      errors.push({ index: i, error: `invalid JSON: ${error.message}` });
    }
  }
  return { events, errors };
}

function validateEvent(event, index, lineLimitBytes) {
  const errors = [];
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return [{ index, error: 'event must be a JSON object' }];
  }

  const serialized = JSON.stringify(event);
  if (Buffer.byteLength(serialized, 'utf-8') > lineLimitBytes) {
    errors.push({ index, error: `event exceeds maxLineBytes (${lineLimitBytes})` });
  }

  if (!isSafeAgentId(event.agent_id)) {
    errors.push({ index, error: 'agent_id is invalid' });
  }

  const validationErrors = validateLogEntry(event, index + 1);
  for (const error of validationErrors) {
    errors.push({ index, error });
  }

  return errors;
}

function appendAcceptedEvents(config, events) {
  const spoolDir = resolveSpoolDir(config);
  for (const event of events) {
    const agentDir = path.join(spoolDir, event.agent_id);
    const file = path.join(agentDir, `audit-${eventDate(event)}.jsonl`);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf-8');
  }
}

export async function handleIngestRoute(req, res, { config = {} } = {}) {
  const type = contentType(req);
  const limitBytes = maxBodyBytes(config);
  const lineLimitBytes = maxLineBytes(config);

  let raw;
  try {
    raw = await readBody(req, limitBytes);
  } catch (error) {
    if (error.code === 'body_too_large') {
      json(res, 413, { error_code: 'payload_too_large', error: error.message });
      return;
    }
    throw error;
  }

  let events = [];
  let errors = [];
  try {
    if (type === 'application/json') {
      events = parseJsonBody(raw);
    } else if (type === 'application/x-ndjson') {
      const parsed = parseNdjsonBody(raw, lineLimitBytes);
      events = parsed.events;
      errors = parsed.errors;
    } else {
      json(res, 415, { error_code: 'unsupported_media_type', error: 'Content-Type must be application/json or application/x-ndjson' });
      return;
    }
  } catch (error) {
    json(res, 400, { error_code: error.code ?? 'invalid_body', error: error.message });
    return;
  }

  const accepted = [];
  const rejectedIndexes = new Set(errors.map((error) => error.index));
  for (const item of events) {
    const eventErrors = validateEvent(item.event, item.index, lineLimitBytes);
    if (eventErrors.length > 0) {
      errors.push(...eventErrors);
      rejectedIndexes.add(item.index);
      continue;
    }
    accepted.push(item.event);
  }

  if (accepted.length > 0) {
    appendAcceptedEvents(config, accepted);
  }

  json(res, 202, {
    accepted: accepted.length,
    rejected: rejectedIndexes.size,
    errors,
  });
}
