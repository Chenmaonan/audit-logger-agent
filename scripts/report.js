import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  openDb,
  dailySummary,
  errorReport,
  toolUsageStats,
  reportDateForNow,
  reportTimezoneOffsetMinutes,
} from './lib/db.js';
import { loadAppConfig } from '../src/app/loadConfig.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const config = loadAppConfig(rootDir);
const dbPath = config.paths.dbPath;

if (!fs.existsSync(dbPath)) {
  console.error('No database found. Run ingest first.');
  process.exit(1);
}

const db = openDb(dbPath);

function parseArgs() {
  const opts = { type: 'daily' };
  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--type': opts.type = args[++i]; break;
      case '--date': opts.date = args[++i]; break;
      case '--from': opts.from = args[++i]; break;
      case '--to': opts.to = args[++i]; break;
      case '--agent-id': opts.agent_id = args[++i]; break;
    }
  }

  return opts;
}

const opts = parseArgs();
const timezoneOffsetMinutes = reportTimezoneOffsetMinutes(config);

switch (opts.type) {
  case 'daily': {
    const date = opts.date || reportDateForNow(new Date(), timezoneOffsetMinutes);
    console.log(`Daily Summary — ${date}${opts.agent_id ? ` (agent: ${opts.agent_id})` : ''}\n`);
    const rows = dailySummary(db, date, opts.agent_id, { timezoneOffsetMinutes });

    if (rows.length === 0) {
      console.log('No events for this date.');
    } else {
      console.log(`${'Agent'.padEnd(24)} ${'Tool'.padEnd(32)} ${'Status'.padEnd(10)} Count`);
      console.log('-'.repeat(72));
      for (const r of rows) {
        console.log(`${r.agent_id.padEnd(24)} ${r.tool_name.padEnd(32)} ${r.status.padEnd(10)} ${r.count}`);
      }
    }
    break;
  }

  case 'errors': {
    const from = opts.from || '1970-01-01';
    const to = opts.to || '2099-12-31';
    console.log(`Error Report — ${from} to ${to}${opts.agent_id ? ` (agent: ${opts.agent_id})` : ''}\n`);
    const rows = errorReport(db, from, to, opts.agent_id);

    if (rows.length === 0) {
      console.log('No errors in this range.');
    } else {
      for (const r of rows) {
        console.log(`[${r.ts}] ${r.agent_id} | ${r.tool_name}`);
        console.log(`  status: ${r.status}`);
        if (r.error_message) console.log(`  error: ${r.error_message}`);
        console.log(`  summary: ${r.result_summary}`);
        console.log(`  trace: ${r.trace_id}`);
        console.log('');
      }
    }
    break;
  }

  case 'tools': {
    const from = opts.from || '1970-01-01';
    const to = opts.to || '2099-12-31';
    console.log(`Tool Usage Stats — ${from} to ${to}${opts.agent_id ? ` (agent: ${opts.agent_id})` : ''}\n`);
    const rows = toolUsageStats(db, from, to, opts.agent_id);

    if (rows.length === 0) {
      console.log('No tool usage in this range.');
    } else {
      console.log(`${'Agent'.padEnd(24)} ${'Tool'.padEnd(32)} ${'Total'.padEnd(8)} ${'OK'.padEnd(8)} ${'Err'.padEnd(8)} ${'Avg(ms)'.padEnd(10)} ${'Max(ms)'}`);
      console.log('-'.repeat(100));
      for (const r of rows) {
        console.log(
          `${r.agent_id.padEnd(24)} ${r.tool_name.padEnd(32)} ` +
          `${String(r.total).padEnd(8)} ${String(r.ok_count).padEnd(8)} ${String(r.error_count).padEnd(8)} ` +
          `${String(r.avg_duration_ms).padEnd(10)} ${r.max_duration_ms}`
        );
      }
    }
    break;
  }

  default:
    console.error(`Unknown report type: ${opts.type}. Use daily, errors, or tools.`);
}

db.close();
