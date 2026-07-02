import { errorReport } from '../../scripts/lib/db.js';

export function buildReportTool({ db }) {
  return {
    name: 'report.errorSummary',
    async execute(input) {
      return errorReport(db, input.from, input.to, input.agentId);
    },
  };
}