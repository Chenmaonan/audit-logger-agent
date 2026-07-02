// src/app/loadConfig.js
import fs from 'fs';
import path from 'path';

export function loadAppConfig(rootDir) {
  const configPath = path.join(rootDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`config.json not found at ${configPath}`);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  return {
    ...config,
    planner: config.planner ?? {},
  };
}
