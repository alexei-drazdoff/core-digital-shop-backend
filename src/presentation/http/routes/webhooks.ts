import type { AppServer } from '../types.js';
import type { Container } from '../../../composition/container.js';
import { paymentWebhookBody } from '../schemas.js';

export function registerWebhookRoutes(app: AppServer, container: Container): void {
  const { useCases, metrics } = container;

  /**
   * Payment webhook.
   *
   * The contract says deliveries are at-least-once, may arrive out of order, and
   * want a fast 200. All three shape this handler:
   *
   *   idempotence is enforced by the event id primary key, not by a lookup here;
   *   an unknown order is parked and answered 200, not rejected;
   *   the supplier is never called on this path, so the response time does not
   *   depend on a third party. The delivery job is enqueued in the same
   *   transaction and a worker picks it up.
   *
   * A 5xx is reserved for genuine failures to record the event, which is exactly
   * when we do want the payment provider to try again.
   */
  app.post('/webhooks/payment', async (request, reply) => {
    const body = paymentWebhookBody.parse(request.body);

    const result = await useCases.applyPaymentEvent.execute({
      eventId: body.event_id,
      orderId: body.order_id,
      status: body.status,
      amountMinor: body.amount,
      currency: body.currency,
      occurredAt: new Date(body.created_at),
      payload: body,
    });

    metrics.recordPaymentEvent(result.kind === 'ignored' ? result.outcome : result.kind);
    return reply.code(200).send({ received: true, outcome: result.kind });
  });
}
