import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveServerBindHost, listenHttpServer } from '../../src/adapters/http/serverListen.js';

test('server entrypoint resolves configured auditReview.http.bindHost', () => {
  assert.equal(
    resolveServerBindHost({ auditReview: { http: { bindHost: '0.0.0.0' } } }),
    '0.0.0.0',
  );
  assert.equal(resolveServerBindHost({ auditReview: { http: {} } }), '127.0.0.1');
});

test('server entrypoint starts app on the resolved bind host', async () => {
  const listenCalls = [];
  const app = {
    listen(port, host, callback) {
      listenCalls.push({ port, host });
      callback?.();
      return { address: () => ({ port, address: host }) };
    },
  };

  let announced = null;
  listenHttpServer(app, {
    port: 9321,
    bindHost: '0.0.0.0',
    onListening: (url) => { announced = url; },
  });

  assert.deepEqual(listenCalls, [{ port: 9321, host: '0.0.0.0' }]);
  assert.equal(announced, 'http://0.0.0.0:9321');
});
