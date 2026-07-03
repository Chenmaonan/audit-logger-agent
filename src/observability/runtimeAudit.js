// src/observability/runtimeAudit.js
import crypto from 'crypto';
import { insertEvents } from '../../scripts/lib/db.js';

export function createRuntimeAuditLogger(db, { agentId = 'audit-runtime-agent', channel = 'system' } = {}) {
  return {
    async log({ runId, traceId = null, event, status, summary, toolName = 'agent.runtime' }) {
      const ts = new Date().toISOString();
      const resolvedTraceId = traceId ?? `trace_${runId}`;
      const spanId = crypto.randomUUID();

      insertEvents(db, [{
        ts,
        agent_id: agentId,
        trace_id: resolvedTraceId,
        span_id: spanId,
        parent_span_id: null,
        event,
        tool_name: toolName,
        status,
        result_summary: summary,
        duration_ms: null,
        channel,
        user_id: null,
        product_id: null,
        error_code: null,
        error_message: null,
        tags: JSON.stringify(['agent-runtime']),
        raw_json: JSON.stringify({
          ts,
          agent_id: agentId,
          trace_id: resolvedTraceId,
          span_id: spanId,
          event,
          tool_name: toolName,
          status,
          result_summary: summary,
        }),
      }]);
    },
  };
}