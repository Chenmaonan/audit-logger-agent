// src/observability/runtimeAudit.js
import crypto from 'crypto';
import { insertEvents } from '../../scripts/lib/db.js';

export function createRuntimeAuditLogger(db, { agentId = 'feishu-independent-agent' } = {}) {
  return {
    async log({ runId, traceId = null, event, status, summary, toolName = 'agent.runtime' }) {
      insertEvents(db, [{
        ts: new Date().toISOString(),
        agent_id: agentId,
        trace_id: traceId ?? `trace_${runId}`,
        span_id: crypto.randomUUID(),
        parent_span_id: null,
        event,
        tool_name: toolName,
        status,
        result_summary: summary,
        duration_ms: null,
        channel: 'feishu',
        user_id: null,
        product_id: null,
        error_code: null,
        error_message: null,
        tags: JSON.stringify(['agent-runtime']),
        raw_json: JSON.stringify({
          ts: new Date().toISOString(),
          agent_id: agentId,
          trace_id: traceId ?? `trace_${runId}`,
          event,
          tool_name: toolName,
          status,
          result_summary: summary,
        }),
      }]);
    },
  };
}