import { queryEvents } from '../../scripts/lib/db.js';

export function buildAuditQueryTool({ db }) {
  return {
    name: 'audit.queryEvents',
    description: 'Query audit_events by agent, tool, event, status, trace, product, channel, time range, limit, and offset.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agent_id: { type: 'string' },
        tool_name: { type: 'string' },
        status: { enum: ['ok', 'error', 'timeout', 'cancelled'] },
        event: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        trace_id: { type: 'string' },
        product_id: { type: 'string' },
        channel: { type: 'string' },
        limit: { type: 'number' },
        offset: { type: 'number' },
      },
    },
    async execute(input) {
      return queryEvents(db, input);
    },
  };
}