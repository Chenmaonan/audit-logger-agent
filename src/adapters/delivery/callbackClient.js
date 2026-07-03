// src/adapters/delivery/callbackClient.js
export function createCallbackClient({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch implementation is required');
  }

  return {
    async send(url, payload) {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Delivery callback failed with HTTP ${response.status}`);
      }
    },
  };
}