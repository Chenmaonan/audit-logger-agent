import crypto from 'crypto';
import { buildDailyReportPayloads } from './feishuCards.js';

const DEFAULT_HOURS = [10, 17];
const DEFAULT_TIMEZONE_OFFSET_MINUTES = 480;

function normalizedHours(value) {
  const hours = (Array.isArray(value) ? value : DEFAULT_HOURS)
    .map(Number)
    .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23);
  return [...new Set(hours)].sort((a, b) => a - b);
}

function normalizedOffset(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < -1440 || parsed > 1440) {
    return DEFAULT_TIMEZONE_OFFSET_MINUTES;
  }
  return Math.trunc(parsed);
}

function shiftedDate(now, offsetMinutes) {
  return new Date(now.getTime() + offsetMinutes * 60 * 1000);
}

function localParts(now, offsetMinutes) {
  const shifted = shiftedDate(now, offsetMinutes);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    date: shifted.toISOString().slice(0, 10),
  };
}

function localTimeToUtc({ year, month, day, hour }, offsetMinutes) {
  return new Date(Date.UTC(year, month, day, hour, 0, 0, 0) - offsetMinutes * 60 * 1000);
}

export function nextDailyReportAt(now = new Date(), {
  hours = DEFAULT_HOURS,
  timezoneOffsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES,
} = {}) {
  const scheduleHours = normalizedHours(hours);
  if (scheduleHours.length === 0) throw new Error('Daily report schedule requires at least one valid hour');
  const offset = normalizedOffset(timezoneOffsetMinutes);
  const local = localParts(now, offset);
  for (const hour of scheduleHours) {
    const candidate = localTimeToUtc({ ...local, hour }, offset);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  const tomorrow = new Date(Date.UTC(local.year, local.month, local.day + 1));
  return localTimeToUtc({
    year: tomorrow.getUTCFullYear(),
    month: tomorrow.getUTCMonth(),
    day: tomorrow.getUTCDate(),
    hour: scheduleHours[0],
  }, offset);
}

export function dailyReportWindow(now = new Date(), timezoneOffsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES) {
  const offset = normalizedOffset(timezoneOffsetMinutes);
  const local = localParts(now, offset);
  return {
    date: local.date,
    from: localTimeToUtc({ ...local, hour: 0 }, offset).toISOString(),
    to: now.toISOString(),
    slotHour: local.hour,
  };
}

function groupKey(agentId, traceId) {
  return JSON.stringify([agentId ?? null, traceId ?? null]);
}

function loadDailyGroups(db, { from, to }) {
  const groupRows = db.prepare(`
    SELECT
      agent_id,
      trace_id,
      COUNT(*) AS event_count,
      SUM(CASE WHEN status <> 'OK' THEN 1 ELSE 0 END) AS error_count,
      COUNT(DISTINCT tool_name) AS tool_count,
      MIN(ts) AS first_event_at,
      MAX(ts) AS last_event_at
    FROM audit_events
    WHERE ts >= @from AND ts <= @to
      AND agent_id IS NOT NULL AND agent_id <> ''
      AND trace_id IS NOT NULL AND trace_id <> ''
    GROUP BY agent_id, trace_id
    ORDER BY agent_id ASC, trace_id ASC
  `).all({ from, to });

  const groups = new Map(groupRows.map((row) => [groupKey(row.agent_id, row.trace_id), {
    ...row,
    tools: [],
    findings: [],
  }]));
  if (groups.size === 0) return [];

  const tools = db.prepare(`
    SELECT
      agent_id,
      trace_id,
      tool_name,
      COUNT(*) AS total,
      SUM(CASE WHEN status <> 'OK' THEN 1 ELSE 0 END) AS error_count
    FROM audit_events
    WHERE ts >= @from AND ts <= @to
      AND agent_id IS NOT NULL AND agent_id <> ''
      AND trace_id IS NOT NULL AND trace_id <> ''
    GROUP BY agent_id, trace_id, tool_name
    ORDER BY agent_id ASC, trace_id ASC, total DESC, tool_name ASC
  `).all({ from, to });
  for (const tool of tools) {
    groups.get(groupKey(tool.agent_id, tool.trace_id))?.tools.push(tool);
  }

  const findings = db.prepare(`
    SELECT
      findings.agent_id,
      findings.trace_id,
      occurrences.severity,
      occurrences.title,
      occurrences.summary,
      occurrences.observed_at
    FROM audit_review_finding_occurrences occurrences
    INNER JOIN audit_review_findings findings ON findings.finding_id = occurrences.finding_id
    WHERE occurrences.observed_at >= @from AND occurrences.observed_at <= @to
      AND occurrences.severity IN ('high', 'critical')
    ORDER BY occurrences.observed_at DESC
  `).all({ from, to });
  for (const finding of findings) {
    groups.get(groupKey(finding.agent_id, finding.trace_id))?.findings.push(finding);
  }

  return [...groups.values()];
}

function dedupeKey(values) {
  const digest = crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 24);
  return `feishu_daily:${digest}`;
}

export function createNotificationDigestScheduler({
  db,
  outboxStore,
  config,
  feishuMode = 'disabled',
  now = () => new Date(),
  timerApi = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  },
} = {}) {
  if (!db) throw new Error('createNotificationDigestScheduler: db is required');
  if (!outboxStore) throw new Error('createNotificationDigestScheduler: outboxStore is required');
  const notification = config?.auditReview?.notification ?? {};
  const daily = notification.dailyReport ?? {};
  const enabled = notification.enabled !== false && notification.mode === 'feishu_bot' && daily.enabled !== false;
  const hours = normalizedHours(daily.hours);
  const timezoneOffsetMinutes = normalizedOffset(daily.timezoneOffsetMinutes ?? config?.report?.timezoneOffsetMinutes);
  const cardConfig = notification.card ?? {};
  const maxAttempts = notification.maxAttempts;
  let started = false;
  let timer = null;
  let runChain = Promise.resolve();

  function clearTimer() {
    if (timer) timerApi.clearTimeout(timer);
    timer = null;
  }

  function scheduleNext() {
    clearTimer();
    if (!started || !enabled || feishuMode === 'disabled') return;
    const current = now();
    const next = nextDailyReportAt(current, { hours, timezoneOffsetMinutes });
    timer = timerApi.setTimeout(() => {
      timer = null;
      runChain = runChain.catch(() => {}).then(() => runNow({ scheduledFor: next }));
      runChain.finally(() => {
        if (started) scheduleNext();
      }).catch(() => {});
    }, Math.max(0, next.getTime() - current.getTime()));
  }

  function runNow({ scheduledFor = now() } = {}) {
    if (!enabled) return { enqueued: false, reason: 'disabled', groups: [] };
    if (feishuMode === 'disabled') return { enqueued: false, reason: 'disabled', groups: [] };
    const window = dailyReportWindow(scheduledFor, timezoneOffsetMinutes);
    const groups = loadDailyGroups(db, window);
    const rendered = groups.map((group) => ({
      group,
      payloads: buildDailyReportPayloads({
        date: window.date,
        generatedAt: scheduledFor.toISOString(),
        group,
        maxPayloadBytes: cardConfig.maxPayloadBytes,
        foldThresholdChars: cardConfig.foldThresholdChars,
      }),
    }));
    if (feishuMode === 'dry-run') {
      return { enqueued: false, reason: 'dry_run', window, groups: rendered };
    }

    let enqueuedCount = 0;
    for (const item of rendered) {
      item.payloads.forEach((payload, index) => {
        const result = outboxStore.enqueue({
          runId: `daily_${window.date}_${window.slotHour}`,
          type: 'audit_daily_trace_report',
          payload,
          deliveryMode: 'feishu_bot',
          callbackUrl: null,
          maxAttempts,
          dedupeKey: dedupeKey([
            window.date,
            window.slotHour,
            item.group.agent_id,
            item.group.trace_id,
            index,
          ]),
        });
        if (result?.enqueued !== false) enqueuedCount += 1;
      });
    }
    return { enqueued: enqueuedCount > 0, enqueuedCount, window, groups: rendered };
  }

  function start() {
    if (started) return;
    started = true;
    scheduleNext();
  }

  function stop() {
    started = false;
    clearTimer();
  }

  return { start, stop, runNow, nextRunAt: () => nextDailyReportAt(now(), { hours, timezoneOffsetMinutes }) };
}

export { loadDailyGroups };
