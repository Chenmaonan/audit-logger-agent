import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDb, queryEvents } from './lib/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(__dirname, '..', 'config.json');

if (!fs.existsSync(configPath)) {
  console.error('config.json not found.');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const dbPath = path.resolve(__dirname, '..', config.dbPath);

if (!fs.existsSync(path.dirname(dbPath))) {
  console.error('No database found. Run ingest first.');
  process.exit(1);
}

const db = openDb(dbPath);

function parseArgs() {
  const filters = {};
  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--agent-id': filters.agent_id = args[++i]; break;
      case '--tool-name': filters.tool_name = args[++i]; break;
      case '--status': filters.status = args[++i]; break;
      case '--event': filters.event = args[++i]; break;
      case '--from': filters.from = args[++i]; break;
      case '--to': filters.to = args[++i]; break;
      case '--trace-id': filters.trace_id = args[++i]; break;
      case '--product-id': filters.product_id = args[++i]; break;
      case '--channel': filters.channel = args[++i]; break;
      case '--limit': filters.limit = parseInt(args[++i], 10); break;
      case '--offset': filters.offset = parseInt(args[++i], 10); break;
      case '--format': filters.format = args[++i]; break;
    }
  }

  return filters;
}

const filters = parseArgs();
const rows = queryEvents(db, filters);

if (filters.format === 'json') {
  console.log(JSON.stringify(rows, null, 2));
} else {
  if (rows.length === 0) {
    console.log('No results.');
  } else {
    console.log(`${rows.length} result(s):\n`);
    for (const row of rows) {
      console.log(`[${row.ts}] ${row.agent_id} | ${row.tool_name} | ${row.event} | ${row.status}`);
      console.log(`  trace: ${row.trace_id}  span: ${row.span_id}`);
      console.log(`  ${row.result_summary}`);
      if (row.duration_ms) console.log(`  duration: ${row.duration_ms}ms`);
      if (row.error_code) console.log(`  error: ${row.error_code} — ${row.error_message}`);
      if (row.channel) console.log(`  channel: ${row.channel}`);
      if (row.product_id) console.log(`  product: ${row.product_id}`);
      console.log('');
    }
  }
}

db.close();
