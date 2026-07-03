// src/agent/eventPublisher.js
// Accepts either `deliveryClient` or the legacy `callbackClient` name for
// backwards-compatible construction.
export function createEventPublisher({ outboxStore, deliveryClient, callbackClient }) {
  const sender = deliveryClient ?? callbackClient;
  return {
    enqueueRunEvent(run, type, payload) {
      outboxStore.enqueue({
        runId: run.run_id,
        type,
        payload,
        deliveryMode: run.delivery_mode,
        callbackUrl: run.delivery_callback_url,
      });
    },

    async flushPending(limit = 20) {
      const pending = outboxStore.listPending(limit);
      for (const event of pending) {
        try {
          await sender.send(event.callback_url, event.payload_json);
          outboxStore.markDelivered(event.event_id);
        } catch (error) {
          outboxStore.markFailed(event.event_id, error);
        }
      }
    },
  };
}