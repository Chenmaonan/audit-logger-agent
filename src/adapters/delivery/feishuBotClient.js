const VALID_MODES = new Set(['disabled', 'dry-run', 'live']);
const LIVE_CONFIRMATION = 'CONFIRM_FEISHU_LIVE';
const MAX_PAYLOAD_BYTES = 20 * 1024;
// A 650ms fixed interval caps sustained delivery at about 92 requests/minute,
// leaving headroom below Feishu's 100/minute limit while also satisfying 5/s.
const MIN_REQUEST_INTERVAL_MS = 650;
const DEFAULT_TIMEOUT_MS = 5000;

function sleepMs(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function validateProductionWebhook(webhookUrl) {
  let url;
  try {
    url = new URL(webhookUrl);
  } catch {
    throw new Error('Invalid Feishu webhook configuration');
  }

  const valid = url.protocol === 'https:'
    && url.hostname === 'open.feishu.cn'
    && url.port === ''
    && url.username === ''
    && url.password === ''
    && url.search === ''
    && url.hash === ''
    && /^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+$/.test(url.pathname);

  if (!valid) {
    throw new Error('Invalid Feishu webhook configuration');
  }
}

function serializePayload(payload) {
  let body;
  try {
    body = JSON.stringify(payload);
  } catch {
    throw new Error('Feishu payload is not JSON serializable');
  }

  if (body === undefined) {
    throw new Error('Feishu payload is not JSON serializable');
  }

  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new Error(`Feishu payload exceeds ${MAX_PAYLOAD_BYTES} byte limit`);
  }
  return { body, bytes };
}

/**
 * Creates an in-memory Feishu custom-bot webhook client.
 *
 * The webhook is intentionally accepted only by the constructor and is never
 * included in send arguments or return values, preventing callers from placing
 * it in outbox records. `allowTestWebhook` is exclusively for explicit tests
 * that inject a fake fetch implementation or a local HTTP sink.
 */
export function createFeishuBotClient({
  mode = 'disabled',
  webhookUrl,
  liveConfirmation,
  allowTestWebhook = false,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now(),
  sleep = sleepMs,
} = {}) {
  if (!VALID_MODES.has(mode)) {
    throw new Error('Invalid Feishu delivery mode');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Feishu timeout must be a positive number');
  }
  if (typeof now !== 'function' || typeof sleep !== 'function') {
    throw new Error('Feishu rate-limit clock is invalid');
  }

  if (mode === 'live') {
    if (liveConfirmation !== LIVE_CONFIRMATION) {
      throw new Error('Feishu live delivery confirmation is required');
    }
    if (typeof fetchImpl !== 'function') {
      throw new Error('Fetch implementation is required for Feishu live delivery');
    }
    if (!allowTestWebhook) {
      validateProductionWebhook(webhookUrl);
    } else if (typeof webhookUrl !== 'string' || webhookUrl.length === 0) {
      throw new Error('Invalid Feishu webhook configuration');
    }
  }

  let queue = Promise.resolve();
  let nextRequestAt = 0;

  async function sendLive(body) {
    const waitMs = Math.max(0, nextRequestAt - now());
    if (waitMs > 0) await sleep(waitMs);
    nextRequestAt = Math.max(nextRequestAt, now()) + MIN_REQUEST_INTERVAL_MS;

    const controller = new AbortController();
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Feishu delivery timed out'));
      }, timeoutMs);
    });
    const request = (async () => {
      let response;
      try {
        response = await fetchImpl(webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          redirect: 'error',
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) {
          throw new Error('Feishu delivery timed out');
        }
        throw new Error('Feishu delivery request failed');
      }

      if (!response?.ok) {
        const status = Number.isInteger(response?.status) ? response.status : 'unknown';
        throw new Error(`Feishu delivery failed with HTTP ${status}`);
      }

      let result;
      try {
        result = await response.json();
      } catch {
        if (controller.signal.aborted) {
          throw new Error('Feishu delivery timed out');
        }
        throw new Error('Feishu delivery returned an invalid response');
      }
      if (result?.code !== 0) {
        const error = new Error('Feishu delivery was rejected');
        error.code = 'feishu_rejected';
        error.feishuCode = Number.isInteger(result?.code) ? result.code : null;
        throw error;
      }

      return { mode: 'live', delivered: true };
    })();

    try {
      return await Promise.race([request, timeout]);
    } finally {
      clearTimeout(timer);
      request.catch(() => {});
    }
  }

  return {
    mode,

    async send(payload) {
      if (mode === 'disabled') {
        throw new Error('Feishu delivery is disabled');
      }

      const serialized = serializePayload(payload);
      if (mode === 'dry-run') {
        return { mode: 'dry-run', delivered: false, payloadBytes: serialized.bytes };
      }

      const task = queue.then(() => sendLive(serialized.body));
      queue = task.catch(() => undefined);
      return task;
    },
  };
}

export {
  DEFAULT_TIMEOUT_MS,
  LIVE_CONFIRMATION,
  MAX_PAYLOAD_BYTES,
  MIN_REQUEST_INTERVAL_MS,
};
