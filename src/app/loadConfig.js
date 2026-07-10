// src/app/loadConfig.js
import fs from 'fs';
import path from 'path';
import { normalizeAppConfig } from './paths.js';

export function loadAppConfig(rootDir, { env = process.env } = {}) {
  const configuredPath = env.AUDIT_AGENT_CONFIG_PATH;
  const configPath = configuredPath && configuredPath.trim() !== ''
    ? (path.isAbsolute(configuredPath) ? configuredPath : path.resolve(rootDir, configuredPath))
    : path.join(rootDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found at ${configPath}`);
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (error) {
    throw new Error(`Invalid JSON in config file ${configPath}: ${error.message}`);
  }
  return normalizeAppConfig(config, rootDir);
}
