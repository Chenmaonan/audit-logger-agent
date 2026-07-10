import assert from 'node:assert/strict';
import test from 'node:test';

test('deployed audit service exposes a writable health endpoint', async (t) => {
  const baseUrl = process.env.AUDIT_SERVER_URL;
  if (!baseUrl) {
    t.skip('set AUDIT_SERVER_URL to run the deployed-service smoke test');
    return;
  }

  const response = await fetch(new URL('/health', baseUrl));
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.db?.writable, true);
});
