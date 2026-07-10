import fs from 'fs';
import path from 'path';

export const DEFAULT_PATHS = Object.freeze({
  dbPath: 'data/db/audit.db',
  spoolDir: 'data/spool/incoming',
  capturesDir: 'data/captures',
  tmpDir: 'data/tmp',
  logDir: 'logs',
});

function looksLikeResolvedPaths(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    value.rootDir &&
    value.dbPath &&
    value.spoolDir &&
    value.capturesDir &&
    value.tmpDir &&
    value.logDir &&
    path.isAbsolute(value.rootDir) &&
    path.isAbsolute(value.dbPath) &&
    path.isAbsolute(value.spoolDir) &&
    path.isAbsolute(value.capturesDir) &&
    path.isAbsolute(value.tmpDir) &&
    path.isAbsolute(value.logDir)
  );
}

function pathOverrides(config) {
  if (!config || typeof config !== 'object') return {};
  return config.paths && typeof config.paths === 'object' ? config.paths : {};
}

function resolveMaybeRelative(rootDir, value) {
  if (!value) return null;
  return path.isAbsolute(value) ? value : path.resolve(rootDir, value);
}

function cleanupEmptyDirectories(dir, stopAt) {
  if (!dir || !fs.existsSync(dir)) return;
  const absoluteStop = stopAt ? path.resolve(stopAt) : null;
  let current = path.resolve(dir);
  while (fs.existsSync(current) && current !== absoluteStop) {
    const entries = fs.readdirSync(current);
    if (entries.length > 0) return;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

function moveFile(source, destination, { appendOnConflict = false } = {}) {
  if (!fs.existsSync(source)) return false;
  if (path.resolve(source) === path.resolve(destination)) return false;

  fs.mkdirSync(path.dirname(destination), { recursive: true });

  if (appendOnConflict && fs.existsSync(destination)) {
    const content = fs.readFileSync(source);
    if (content.length > 0) fs.appendFileSync(destination, content);
    fs.unlinkSync(source);
    return true;
  }

  if (fs.existsSync(destination)) return false;

  try {
    fs.renameSync(source, destination);
  } catch {
    fs.copyFileSync(source, destination);
    fs.unlinkSync(source);
  }
  return true;
}

function moveDirectoryContents(sourceDir, destinationDir, results, skipped) {
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) return;
  fs.mkdirSync(destinationDir, { recursive: true });

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      moveDirectoryContents(sourcePath, destinationPath, results, skipped);
      cleanupEmptyDirectories(sourcePath, sourceDir);
      continue;
    }

    try {
      const moved = moveFile(sourcePath, destinationPath, { appendOnConflict: true });
      if (moved) {
        results.push({ from: sourcePath, to: destinationPath });
      }
    } catch (error) {
      skipped.push({ from: sourcePath, to: destinationPath, error: error.code ?? error.message });
    }
  }

  cleanupEmptyDirectories(sourceDir, path.dirname(sourceDir));
}

export function resolveRuntimePaths(config = {}, rootDir = config.rootDir ?? config.paths?.rootDir ?? process.cwd()) {
  const overrides = pathOverrides(config);
  const normalizedRoot = path.resolve(overrides.rootDir ?? config.rootDir ?? rootDir);
  const dbPath = resolveMaybeRelative(normalizedRoot, overrides.dbPath ?? config.dbPath ?? DEFAULT_PATHS.dbPath);
  const spoolDir = resolveMaybeRelative(normalizedRoot, overrides.spoolDir ?? config.ingest?.spoolDir ?? DEFAULT_PATHS.spoolDir);
  const capturesDir = resolveMaybeRelative(normalizedRoot, overrides.capturesDir ?? config.capturesDir ?? DEFAULT_PATHS.capturesDir);
  const tmpDir = resolveMaybeRelative(normalizedRoot, overrides.tmpDir ?? config.tmpDir ?? DEFAULT_PATHS.tmpDir);
  const logDir = resolveMaybeRelative(normalizedRoot, overrides.logDir ?? config.logDir ?? DEFAULT_PATHS.logDir);

  return {
    rootDir: normalizedRoot,
    dbPath,
    dbDir: path.dirname(dbPath),
    spoolDir,
    capturesDir,
    tmpDir,
    logDir,
    serverLogPath: path.join(logDir, 'server.log'),
    serverErrLogPath: path.join(logDir, 'server.err.log'),
    callbackReceiverLogPath: path.join(logDir, 'callback-9999.log'),
    callbackReceiverErrLogPath: path.join(logDir, 'callback-9999.err.log'),
    callbackCapturePath: path.join(capturesDir, 'callback-events.ndjson'),
  };
}

export function getRuntimePaths(config = {}, rootDir = config.rootDir ?? config.paths?.rootDir ?? process.cwd()) {
  if (looksLikeResolvedPaths(config)) {
    return config;
  }
  if (looksLikeResolvedPaths(config.paths)) {
    return config.paths;
  }
  return resolveRuntimePaths(config, rootDir);
}

export function ensureRuntimeLayout(pathsOrConfig, rootDir) {
  const paths = rootDir ? resolveRuntimePaths(pathsOrConfig, rootDir) : getRuntimePaths(pathsOrConfig);
  for (const dir of [paths.dbDir, paths.spoolDir, paths.capturesDir, paths.tmpDir, paths.logDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return paths;
}

export function normalizeAppConfig(config = {}, rootDir = process.cwd()) {
  const normalizedRoot = path.resolve(config.rootDir ?? rootDir);
  const normalized = {
    ...config,
    rootDir: normalizedRoot,
    dbPath: config.dbPath ?? DEFAULT_PATHS.dbPath,
    ingest: {
      ...config.ingest,
      http: { ...(config.ingest?.http ?? {}) },
      spoolDir: config.ingest?.spoolDir ?? DEFAULT_PATHS.spoolDir,
    },
    capturesDir: config.capturesDir ?? DEFAULT_PATHS.capturesDir,
    tmpDir: config.tmpDir ?? DEFAULT_PATHS.tmpDir,
    logDir: config.logDir ?? DEFAULT_PATHS.logDir,
    planner: config.planner ?? {},
  };
  normalized.paths = resolveRuntimePaths(normalized, normalizedRoot);
  return normalized;
}

export function migrateLegacyRuntimeArtifacts(pathsOrConfig, rootDir) {
  const paths = rootDir ? resolveRuntimePaths(pathsOrConfig, rootDir) : getRuntimePaths(pathsOrConfig);
  const moved = [];
  const skipped = [];
  const root = paths.rootDir;

  const fileMoves = [
    { from: path.join(root, '.server.log'), to: paths.serverLogPath, appendOnConflict: true },
    { from: path.join(root, '.server.err.log'), to: paths.serverErrLogPath, appendOnConflict: true },
    { from: path.join(root, '.callback-9999.log'), to: paths.callbackReceiverLogPath, appendOnConflict: true },
    { from: path.join(root, '.callback-9999.err.log'), to: paths.callbackReceiverErrLogPath, appendOnConflict: true },
    { from: path.join(root, 'data', 'callback-events.ndjson'), to: paths.callbackCapturePath, appendOnConflict: true },
    { from: path.join(root, 'data', 'audit.db'), to: paths.dbPath },
    { from: path.join(root, 'data', 'audit.db-wal'), to: `${paths.dbPath}-wal` },
    { from: path.join(root, 'data', 'audit.db-shm'), to: `${paths.dbPath}-shm` },
    { from: path.join(root, 'data', 'audit.db-journal'), to: `${paths.dbPath}-journal` },
  ];

  for (const move of fileMoves) {
    try {
      const didMove = moveFile(move.from, move.to, { appendOnConflict: move.appendOnConflict === true });
      if (didMove) moved.push({ from: move.from, to: move.to });
    } catch (error) {
      skipped.push({ from: move.from, to: move.to, error: error.code ?? error.message });
    }
  }

  moveDirectoryContents(path.join(root, 'data', 'incoming'), paths.spoolDir, moved, skipped);
  cleanupEmptyDirectories(path.join(root, 'data', 'incoming'), path.join(root, 'data'));

  return { moved, skipped };
}
