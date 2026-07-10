function cliOption(args, name) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : null;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function configuredHost(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export function resolveServerBindHost(config = {}, { args = process.argv, env = process.env } = {}) {
  const cliHost = cliOption(args, '--bind');
  if (cliHost) return cliHost;

  const environmentHost = configuredHost(env.AUDIT_AGENT_BIND_HOST);
  if (environmentHost) return environmentHost;

  const host = config?.auditReview?.http?.bindHost;
  return configuredHost(host) ?? '127.0.0.1';
}

export function listenHttpServer(app, { port, bindHost, onListening = console.log } = {}) {
  const host = typeof bindHost === 'string' && bindHost.trim() !== '' ? bindHost.trim() : '127.0.0.1';
  return app.listen(port, host, () => {
    onListening(`http://${host}:${port}`);
  });
}

function closeHttpServer(server) {
  if (!server || typeof server.close !== 'function') return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export function createGracefulShutdown({
  scheduler,
  retentionScheduler,
  flushInterval,
  clearIntervalFn = clearInterval,
  eventPublisher,
  server,
  db,
  logError = (message) => console.error(message),
  exit = (code) => process.exit(code),
} = {}) {
  let shutdownPromise = null;

  async function attempt(name, action) {
    try {
      await action();
    } catch (error) {
      try {
        logError(`Graceful shutdown ${name} failed: ${error.message}`);
      } catch {
        // A broken logger must not prevent the remaining shutdown steps.
      }
    }
  }

  return function shutdown(signal) {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      await attempt('scheduler stop', () => scheduler?.stop?.());
      await attempt('retention scheduler stop', () => retentionScheduler?.stop?.());
      await attempt('flush interval clear', () => clearIntervalFn(flushInterval));
      await attempt('event publisher flush', () => eventPublisher?.flushPending?.(20));
      await attempt('HTTP server close', () => closeHttpServer(server));
      await attempt('SQLite close', () => db?.close?.());
      exit(0);
    })();

    return shutdownPromise;
  };
}
