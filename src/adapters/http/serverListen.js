export function resolveServerBindHost(config = {}) {
  const host = config?.auditReview?.http?.bindHost;
  return typeof host === 'string' && host.trim() !== '' ? host.trim() : '127.0.0.1';
}

export function listenHttpServer(app, { port, bindHost, onListening = console.log } = {}) {
  const host = typeof bindHost === 'string' && bindHost.trim() !== '' ? bindHost.trim() : '127.0.0.1';
  return app.listen(port, host, () => {
    onListening(`http://${host}:${port}`);
  });
}
