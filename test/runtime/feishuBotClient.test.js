import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  createFeishuBotClient,
  LIVE_CONFIRMATION,
  MAX_PAYLOAD_BYTES,
  MIN_REQUEST_INTERVAL_MS,
} from '../../src/adapters/delivery/feishuBotClient.js';

const PRODUCTION_WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/test-hook-id';

function okResponse(body = { code: 0 }) {
  return { ok: true, status: 200, async json() { return body; } };
}

test('Feishu client validates modes, fails closed when disabled, and dry-run never fetches', async () => {
  assert.throws(() => createFeishuBotClient({ mode: 'unknown' }), /Invalid Feishu delivery mode/);

  let fetchCalls = 0;
  const fetchImpl = async () => { fetchCalls += 1; return okResponse(); };
  const disabled = createFeishuBotClient({ mode: 'disabled', fetchImpl });
  await assert.rejects(() => disabled.send({ msg_type: 'interactive' }), /disabled/);

  const dryRun = createFeishuBotClient({ mode: 'dry-run', fetchImpl });
  const result = await dryRun.send({ msg_type: 'interactive', card: { elements: [] } });
  assert.deepEqual(result, { mode: 'dry-run', delivered: false, payloadBytes: 49 });
  assert.equal(fetchCalls, 0);
});

test('Feishu client enforces the 20KB UTF-8 request limit before delivery', async () => {
  const client = createFeishuBotClient({ mode: 'dry-run' });
  const payload = { content: '中'.repeat(MAX_PAYLOAD_BYTES) };
  await assert.rejects(() => client.send(payload), /exceeds 20480 byte limit/);
});

test('Feishu live mode requires confirmation and a strict production webhook URL', () => {
  assert.throws(() => createFeishuBotClient({
    mode: 'live',
    webhookUrl: PRODUCTION_WEBHOOK,
  }), /confirmation is required/);

  for (const invalidUrl of [
    'http://open.feishu.cn/open-apis/bot/v2/hook/test',
    'https://example.com/open-apis/bot/v2/hook/test',
    'https://open.feishu.cn/open-apis/bot/v2/hook/test?secret=1',
    'https://open.feishu.cn/open-apis/bot/v2/hook/',
  ]) {
    assert.throws(() => createFeishuBotClient({
      mode: 'live',
      webhookUrl: invalidUrl,
      liveConfirmation: LIVE_CONFIRMATION,
      fetchImpl: async () => okResponse(),
    }), /Invalid Feishu webhook configuration/);
  }

  assert.doesNotThrow(() => createFeishuBotClient({
    mode: 'live',
    webhookUrl: 'http://127.0.0.1:1234/test-only',
    liveConfirmation: LIVE_CONFIRMATION,
    allowTestWebhook: true,
    fetchImpl: async () => okResponse(),
  }));
});

test('Feishu live POST disables redirects and requires HTTP success with JSON code 0', async () => {
  let request;
  const client = createFeishuBotClient({
    mode: 'live',
    webhookUrl: PRODUCTION_WEBHOOK,
    liveConfirmation: LIVE_CONFIRMATION,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return okResponse();
    },
  });

  assert.deepEqual(await client.send({ msg_type: 'interactive', card: {} }), { mode: 'live', delivered: true });
  assert.equal(request.url, PRODUCTION_WEBHOOK);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(request.options.body), { msg_type: 'interactive', card: {} });
  assert.ok(request.options.signal instanceof AbortSignal);

  const rejected = createFeishuBotClient({
    mode: 'live',
    webhookUrl: PRODUCTION_WEBHOOK,
    liveConfirmation: LIVE_CONFIRMATION,
    fetchImpl: async () => okResponse({ code: 19001, msg: 'raw secret response' }),
  });
  await assert.rejects(
    () => rejected.send({ msg_type: 'interactive' }),
    (error) => error.message === 'Feishu delivery was rejected'
      && error.code === 'feishu_rejected'
      && error.feishuCode === 19001
      && !error.message.includes(PRODUCTION_WEBHOOK)
      && !error.message.includes('raw secret response'),
  );
});

test('Feishu live mode sends the card envelope to an isolated local HTTP sink', async () => {
  let received = null;
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      received = JSON.parse(body);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 0, msg: 'success' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const client = createFeishuBotClient({
      mode: 'live',
      webhookUrl: `http://127.0.0.1:${port}/open-apis/bot/v2/hook/mock`,
      liveConfirmation: LIVE_CONFIRMATION,
      allowTestWebhook: true,
    });
    const payload = { msg_type: 'interactive', card: { schema: '2.0', body: { elements: [] } } };

    assert.deepEqual(await client.send(payload), { mode: 'live', delivered: true });
    assert.deepEqual(received, payload);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Feishu live errors redact fetch details and requests time out', async () => {
  const networkFailure = createFeishuBotClient({
    mode: 'live',
    webhookUrl: PRODUCTION_WEBHOOK,
    liveConfirmation: LIVE_CONFIRMATION,
    fetchImpl: async () => { throw new Error(`connect failed ${PRODUCTION_WEBHOOK}`); },
  });
  await assert.rejects(
    () => networkFailure.send({ msg_type: 'interactive' }),
    (error) => error.message === 'Feishu delivery request failed' && !error.message.includes(PRODUCTION_WEBHOOK),
  );

  const timeout = createFeishuBotClient({
    mode: 'live',
    webhookUrl: PRODUCTION_WEBHOOK,
    liveConfirmation: LIVE_CONFIRMATION,
    timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted with raw details')), { once: true });
    }),
  });
  await assert.rejects(() => timeout.send({ msg_type: 'interactive' }), /Feishu delivery timed out/);

  const responseTimeout = createFeishuBotClient({
    mode: 'live',
    webhookUrl: PRODUCTION_WEBHOOK,
    liveConfirmation: LIVE_CONFIRMATION,
    timeoutMs: 5,
    fetchImpl: async () => {
      return {
        ok: true,
        status: 200,
        async json() { return new Promise(() => {}); },
      };
    },
  });
  await assert.rejects(() => responseTimeout.send({ msg_type: 'interactive' }), /Feishu delivery timed out/);
});

test('Feishu live delivery stays below both five requests/second and 100 requests/minute', async () => {
  let clock = 0;
  const starts = [];
  const client = createFeishuBotClient({
    mode: 'live',
    webhookUrl: PRODUCTION_WEBHOOK,
    liveConfirmation: LIVE_CONFIRMATION,
    now: () => clock,
    sleep: async (delayMs) => { clock += delayMs; },
    fetchImpl: async () => {
      starts.push(clock);
      return okResponse();
    },
  });

  await Promise.all(Array.from({ length: 101 }, (_, index) => client.send({ index })));
  assert.equal(starts.length, 101);
  for (let index = 1; index < starts.length; index += 1) {
    assert.ok(starts[index] - starts[index - 1] >= MIN_REQUEST_INTERVAL_MS);
  }
  assert.ok(starts[5] - starts[0] >= 1000, 'sixth request must not start inside the first second');
  assert.ok(starts[100] - starts[0] >= 60_000, '101st request must not start inside the first minute');
});
