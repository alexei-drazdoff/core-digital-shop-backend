import type { AppServer } from '../types.js';
import type { Container } from '../../../composition/container.js';
import { createOrderBody, orderLinesFrom } from '../schemas.js';

export function registerOrderRoutes(app: AppServer, container: Container): void {
  const { useCases, repositories, pool } = container;

  app.post('/orders', async (request, reply) => {
    const body = createOrderBody.parse(request.body);
    const idempotencyKey = request.headers['idempotency-key'];

    const result = await useCases.createOrder.execute({
      items: orderLinesFrom(body),
      customerRef: body.customer_ref ?? null,
      orderId: body.order_id,
      idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : undefined,
    });

    // A replayed idempotent request answers 200, a genuinely new order 201, so
    // the client can tell whether its retry actually created anything.
    return reply.code(result.replayed ? 200 : 201).send({
      order_id: result.order.id,
      // Kept for the single-line case so first stage clients see the field they
      // already read. A basket has no one SKU, and saying it did would be worse
      // than saying nothing.
      sku: result.items.length === 1 ? result.items[0]?.sku : null,
      amount: result.order.amountMinor,
      currency: result.order.currency,
      status: result.order.status,
      items: result.items.map((item) => ({
        order_item_id: item.id,
        line_no: item.lineNo,
        sku: item.sku,
        price: item.priceMinor,
        status: item.status,
      })),
      created_at: result.order.createdAt.toISOString(),
    });
  });

  app.get('/orders/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const order = await repositories.orders.findById(pool, id);
    if (!order) return reply.code(404).send({ error: 'order_not_found' });

    const [items, deliveries, refunds, attempts] = await Promise.all([
      repositories.orderItems.findByOrder(pool, id),
      repositories.deliveries.findByOrder(pool, id),
      repositories.refunds.findByOrder(pool, id),
      repositories.supplierRequests.findByOrder(pool, id),
    ]);

    const deliveryByItem = new Map(deliveries.map((delivery) => [delivery.orderItemId, delivery]));
    const refundByItem = new Map(refunds.map((refund) => [refund.orderItemId, refund]));

    const deliveredMinor = items
      .filter((item) => item.status === 'delivered')
      .reduce((total, item) => total + item.priceMinor, 0);
    const refundedMinor = refunds.reduce((total, refund) => total + refund.amountMinor, 0);

    return {
      order_id: order.id,
      sku: items.length === 1 ? items[0]?.sku : null,
      amount: order.amountMinor,
      currency: order.currency,
      status: order.status,
      created_at: order.createdAt.toISOString(),
      paid_at: order.paidAt?.toISOString() ?? null,
      delivered_at: order.deliveredAt?.toISOString() ?? null,

      // The first stage's shape, kept for a single line order. A basket has no
      // one delivery, so it is null there and the caller has to read `items`,
      // which is the only honest answer when three codes came from three
      // suppliers and one of them never arrived.
      delivery:
        items.length === 1 && items[0] && deliveryByItem.has(items[0].id)
          ? {
              code: deliveryByItem.get(items[0].id)?.code,
              supplier: deliveryByItem.get(items[0].id)?.supplier,
              delivered_at: deliveryByItem.get(items[0].id)?.deliveredAt.toISOString(),
            }
          : null,

      // The per-line truth. This is what makes a partially fulfilled basket
      // legible: each line says whether the customer got a code or the money.
      items: items.map((item) => {
        const delivery = deliveryByItem.get(item.id);
        const refund = refundByItem.get(item.id);
        return {
          order_item_id: item.id,
          line_no: item.lineNo,
          sku: item.sku,
          price: item.priceMinor,
          status: item.status,
          rounds: item.rounds,
          // The code is the product. It appears only once delivery is committed.
          delivery: delivery
            ? {
                code: delivery.code,
                supplier: delivery.supplier,
                delivered_at: delivery.deliveredAt.toISOString(),
              }
            : null,
          refund: refund
            ? {
                amount: refund.amountMinor,
                reason: refund.reason,
                refunded_at: refund.createdAt.toISOString(),
              }
            : null,
        };
      }),

      // The assignment's invariant, answered for this one order without needing
      // the admin surface: paid must equal delivered plus refunded once every
      // line is resolved. `unresolved` is what is still in flight.
      money: {
        paid: order.paidAt ? order.amountMinor : 0,
        delivered: deliveredMinor,
        refunded: refundedMinor,
        unresolved: order.amountMinor - deliveredMinor - refundedMinor,
      },

      // Exposed so the delivery story is inspectable without database access,
      // which is what makes the adversarial scenarios verifiable from outside.
      supplier_requests: attempts.map((attempt) => ({
        order_item_id: attempt.orderItemId,
        supplier: attempt.supplier,
        request_id: attempt.requestId,
        epoch: attempt.epoch,
        state: attempt.state,
        attempts: attempt.attempts,
      })),
    };
  });
}
