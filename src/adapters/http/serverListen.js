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

function shutdownTimeoutMs(value) {
  return Number.isFinite(value) && value > 0 ? value : 5000;
}

function waitForShutdownStep(action, { name, timeoutMs, setTimeoutFn, clearTimeoutFn }) {
  let operation;
  try {
    operation = Promise.resolve(action());
  } catch (error) {
    return Promise.reject(error);
  }

  // The race may settle on its timeout first; retain a rejection handler for a later failure.
  operation.catch(() => {});

  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeoutFn(() => {
      const error = new Error(`${name} timed out after ${timeoutMs}ms`);
      error.isGracefulShutdownTimeout = true;
      reject(error);
    }, timeoutMs);
  });

  return Promise.race([operation, timeout]).finally(() => clearTimeoutFn(timer));
}

export function createGracefulShutdown({
  scheduler,
  retentionScheduler,
  flushInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  shutdownTimeoutMs: configuredShutdownTimeoutMs = 5000,
  eventPublisher,
  server,
  db,
  logError = (message) => console.error(message),
  exit = (code) => process.exit(code),
} = {}) {
  let shutdownPromise = null;
  const timeoutMs = shutdownTimeoutMs(configuredShutdownTimeoutMs);

  async function attempt(name, action) {
    try {
      await action();
    } catch (error) {
      try {
        const message = error?.isGracefulShutdownTimeout
          ? `Graceful shutdown ${error.message}`
          : `Graceful shutdown ${name} failed: ${error.message}`;
        logError(message);
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
      await attempt('event publisher flush', () => waitForShutdownStep(
        () => eventPublisher?.flushPending?.(20),
        { name: 'event publisher flush', timeoutMs, setTimeoutFn, clearTimeoutFn },
      ));
      await attempt('HTTP server close', () => waitForShutdownStep(
        () => closeHttpServer(server),
        { name: 'HTTP server close', timeoutMs, setTimeoutFn, clearTimeoutFn },
      ));
      await attempt('SQLite close', () => db?.close?.());
      exit(0);
    })();

    return shutdownPromise;
  };
}
