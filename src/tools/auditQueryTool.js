import { queryEvents } from '../../scripts/lib/db.js';

export function buildAuditQueryTool({ db }) {
  return {
    name: 'audit.queryEvents',
    async execute(input) {
      return queryEvents(db, input);
    },
  };
}