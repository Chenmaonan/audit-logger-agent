import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDb } from './lib/db.js';
import { ingestAll } from './lib/indexer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(__dirname, '..', 'config.json');

if (!fs.existsSync(configPath)) {
  console.error('config.json not found. Create one from the template.');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const dbPath = path.resolve(__dirname, '..', config.dbPath);
const db = openDb(dbPath);

const sinceArg = process.argv.includes('--since') ? process.argv[process.argv.indexOf('--since') + 1] : null;

console.log(`Ingesting audit logs into ${dbPath}...${sinceArg ? ` (since ${sinceArg})` : ''}`);
const results = ingestAll(db, config, sinceArg);

let totalInserted = 0;
let totalErrors = 0;

for (const r of results) {
  if (r.errors.length > 0) {
    console.error(`  ${r.file} (${r.agent_id}): ${r.errors.length} parse errors`);
    for (const err of r.errors.slice(0, 5)) {
      console.error(`    ${err}`);
    }
    totalErrors += r.errors.length;
  } else {
    console.log(`  ${r.file} (${r.agent_id}): ${r.inserted} events indexed`);
    totalInserted += r.inserted;
  }
}

console.log(`\nDone. ${totalInserted} events inserted, ${totalErrors} errors.`);
db.close();
