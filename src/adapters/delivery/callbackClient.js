// src/adapters/delivery/callbackClient.js
export const DEFAULT_CALLBACK_TIMEOUT_MS = 5000;

export function createCallbackClient({
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_CALLBACK_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch implementation is required');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('callback timeout must be a positive number');
  }

  return {
    async send(url, payload) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) throw new Error('Delivery callback timed out');
        throw new Error('Delivery callback request failed');
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        throw new Error(`Delivery callback failed with HTTP ${response.status}`);
      }
    },
  };
}
