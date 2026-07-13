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
