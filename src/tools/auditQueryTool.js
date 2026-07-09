import { queryEvents } from '../../scripts/lib/db.js';
import { CANONICAL_STATUS_CODES } from '../../scripts/lib/auditSpec.js';

export function buildAuditQueryTool({ db }) {
  return {
    name: 'audit.queryEvents',
    description: 'Query audit_events by agent, tool, mapped tool type, event, canonical status, trace, entity type/id, channel, time range, limit, and offset.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agent_id: { type: 'string' },
        tool_name: { type: 'string' },
        status: { enum: CANONICAL_STATUS_CODES },
        event: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        trace_id: { type: 'string' },
        entity_type: { type: 'string' },
        entity_id: { type: 'string' },
        channel: { type: 'string' },
        mapped_tool_type: { type: 'string' },
        mapping_status: { enum: ['mapped', 'unknown'] },
        limit: { type: 'number' },
        offset: { type: 'number' },
      },
    },
    async execute(input) {
      return queryEvents(db, input);
    },
  };
}
