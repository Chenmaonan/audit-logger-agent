import fs from 'fs';
import path from 'path';
import { parseNdjson, normalizeEntry } from './parser.js';
import { insertEvents } from './db.js';

export function scanLogFiles(logDir, pattern, since) {
  if (!fs.existsSync(logDir)) return [];

  const files = fs.readdirSync(logDir).filter(f => {
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
      if (!regex.test(f)) return false;
    } else if (f !== pattern) {
      return false;
    }
    if (since) {
      const m = f.match(/(\d{4}-\d{2}-\d{2})/);
      if (!m || m[1] < since) return false;
    }
    return true;
  });

  return files.map(f => path.join(logDir, f)).sort();
}

export function ingestFile(db, filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const { entries, errors } = parseNdjson(content);

  if (errors.length > 0) {
    return { file: filePath, inserted: 0, errors };
  }

  const rows = entries.map(normalizeEntry);
  const inserted = insertEvents(db, rows);

  return { file: filePath, inserted, errors: [] };
}
