/**
 * Connections inbound webhook route.
 *
 * Mounted under /connections BEFORE the auth gate in server/index.ts — bank
 * providers call it machine-to-machine, so session auth never applies.
 *
 * POST /webhook/:provider — the provider resolves through ./connections/
 * registry: unknown → 404, registered but unconfigured → 503 (fail closed),
 * failing the adapter's dual-header shared-secret check → 401.
 *
 * The handler never calls the provider. It classifies the body through the
 * adapter, records the delivery (eventId dedupe — replays answer 200 no-op)
 * and applies the delivery's action:
 *   sync   → enqueue a coalesced `connections_sync` job (transactional outbox)
 *   status → set connections.status (+ user-facing message)
 *   ignore → recorded only
 * Any transient failure (DB down) un-records the event and answers 503, so the
 * provider redelivers instead of the update being silently lost.
 */

import { Hono } from 'hono';

import { getAggregator, hasProvider } from './registry';
import { enqueueConnectionSync } from './job';
import { USER_MESSAGES } from './errors';
import { forgetWebhookEvent, getConnectionByExternal, recordWebhookEvent, setConnectionStatus } from './store';
import { pool } from '../core/db';
import { HttpError } from '../core/validate';

const app = new Hono();

app.post('/webhook/:provider', async (c) => {
  const provider = c.req.param('provider');
  if (!hasProvider(provider)) throw new HttpError(404, `unknown connections provider ${provider}`);
  const aggregator = getAggregator(provider);
  if (!aggregator) throw new HttpError(503, `connections provider ${provider} is not configured`);

  if (!aggregator.verifyWebhookHeaders(c.req.raw.headers)) {
    throw new HttpError(401, 'invalid webhook signature');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await c.req.text());
  } catch {
    throw new HttpError(400, 'webhook body is not valid JSON');
  }
  const delivery = aggregator.mapWebhookDelivery(raw);
  if (!delivery) throw new HttpError(400, 'webhook payload is not a recognized event');

  const isFirstDelivery = await recordWebhookEvent({
    eventId: delivery.eventId,
    provider,
    externalItemId: delivery.externalItemId,
    payload: delivery.raw,
    now: new Date(),
  });
  if (!isFirstDelivery) {
    // Replayed eventId — already applied, answer success without re-effects.
    return c.json({ received: true, replay: true });
  }

  try {
    const conn = delivery.externalItemId ? await getConnectionByExternal(provider, delivery.externalItemId) : null;
    // Unknown/foreign items are accepted but unactionable.
    if (conn && conn.status !== 'disconnected') {
      if (delivery.action === 'sync') {
        await enqueueConnectionSync(pool, conn, 'sync', `webhook:${delivery.event}`);
      } else if (delivery.action === 'status' && delivery.status) {
        await setConnectionStatus(
          conn.id,
          delivery.status,
          delivery.status === 'unauthorized' ? USER_MESSAGES.auth : delivery.status === 'error' ? USER_MESSAGES.permanent : null,
        );
      }
    }
  } catch (err) {
    // Transient: release the dedupe claim so the provider's retry is applied, and ask for one.
    await forgetWebhookEvent(delivery.eventId).catch(() => undefined);
    console.error(`connections webhook ${delivery.event} failed, asking provider to retry: ${err instanceof Error ? err.message : String(err)}`);
    throw new HttpError(503, 'temporarily unable to process webhook; retry');
  }
  return c.json({ received: true });
});

export default app;
