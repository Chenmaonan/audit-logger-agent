// src/agent/eventPublisher.js
export function createEventPublisher({ outboxStore, callbackClient }) {
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
          await callbackClient.send(event.callback_url, event.payload_json);
          outboxStore.markDelivered(event.event_id);
        } catch (error) {
          outboxStore.markFailed(event.event_id, error);
        }
      }
    },
  };
}