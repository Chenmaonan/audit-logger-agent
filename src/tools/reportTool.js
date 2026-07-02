import { errorReport } from '../../scripts/lib/db.js';

export function buildReportTool({ db }) {
  return {
    name: 'report.errorSummary',
    description: 'Return audit error rows for a time range, optionally filtered by agentId, for final user-facing summaries.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
        agentId: { type: ['string', 'null'] },
      },
      required: ['from', 'to'],
    },
    async execute(input) {
      return errorReport(db, input.from, input.to, input.agentId);
    },
  };
}