// src/agent/eventPublisher.js
// Accepts either `deliveryClient` or the legacy `callbackClient` name for
// backwards-compatible construction. New delivery modes are explicitly routed
// through `deliveryClients`; secrets remain owned by those in-memory clients.
export function createEventPublisher({
  outboxStore,
  deliveryClient,
  callbackClient,
  deliveryClients = {},
  feishuBotClient,
}) {
  const callbackSender = deliveryClient ?? callbackClient;
  const clients = new Map(Object.entries(deliveryClients));
  if (callbackSender) clients.set('callback', callbackSender);
  if (feishuBotClient) clients.set('feishu_bot', feishuBotClient);
  let activeFlush = null;

  async function deliver(event) {
    const sender = clients.get(event.delivery_mode);
    if (!sender || typeof sender.send !== 'function') {
      throw new Error(`No delivery client configured for mode ${event.delivery_mode}`);
    }
    if (event.delivery_mode === 'feishu_bot' && (sender.mode === 'disabled' || sender.mode === 'dry-run')) {
      return { mode: sender.mode, delivered: false };
    }
    if (event.delivery_mode === 'callback') {
      return sender.send(event.callback_url, event.payload_json);
    }
    return sender.send(event.payload_json, { eventId: event.event_id, type: event.type });
  }

  return {
    enqueueRunEvent(run, type, payload, { dedupeKey } = {}) {
      return outboxStore.enqueue({
        runId: run.run_id,
        type,
        payload,
        deliveryMode: run.delivery_mode,
        callbackUrl: run.delivery_mode === 'callback' ? run.delivery_callback_url : null,
        dedupeKey,
      });
    },

    flushPending(limit = 20) {
      if (activeFlush) return activeFlush;

      const flush = (async () => {
        const pending = outboxStore.listPending(limit);
        for (const event of pending) {
          try {
            const result = await deliver(event);
            if (result?.delivered === false) continue;
            outboxStore.markDelivered(event.event_id);
          } catch (error) {
            outboxStore.markFailed(event.event_id, error);
          }
        }
      })();

      activeFlush = flush;
      flush.then(
        () => { if (activeFlush === flush) activeFlush = null; },
        () => { if (activeFlush === flush) activeFlush = null; },
      );
      return flush;
    },
  };
}
