import type { AppServer } from '../types.js';
import type { Container } from '../../../composition/container.js';
import { createOrderBody } from '../schemas.js';

export function registerOrderRoutes(app: AppServer, container: Container): void {
  const { useCases, repositories, pool } = container;

  app.post('/orders', async (request, reply) => {
    const body = createOrderBody.parse(request.body);
    const idempotencyKey = request.headers['idempotency-key'];

    const result = await useCases.createOrder.execute({
      sku: body.sku,
      customerRef: body.customer_ref ?? null,
      orderId: body.order_id,
      idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : undefined,
    });

    // A replayed idempotent request answers 200, a genuinely new order 201, so
    // the client can tell whether its retry actually created anything.
    return reply.code(result.replayed ? 200 : 201).send({
      order_id: result.order.id,
      sku: result.order.sku,
      amount: result.order.amountMinor,
      currency: result.order.currency,
      status: result.order.status,
      created_at: result.order.createdAt.toISOString(),
    });
  });

  app.get('/orders/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const order = await repositories.orders.findById(pool, id);
    if (!order) return reply.code(404).send({ error: 'order_not_found' });

    const delivery = await repositories.deliveries.findByOrder(pool, id);
    const attempts = await repositories.supplierRequests.findByOrder(pool, id);

    return {
      order_id: order.id,
      sku: order.sku,
      amount: order.amountMinor,
      currency: order.currency,
      status: order.status,
      created_at: order.createdAt.toISOString(),
      paid_at: order.paidAt?.toISOString() ?? null,
      delivered_at: order.deliveredAt?.toISOString() ?? null,
      // The code is the product. It appears only once delivery is committed.
      delivery: delivery
        ? { code: delivery.code, supplier: delivery.supplier, delivered_at: delivery.deliveredAt.toISOString() }
        : null,
      // Exposed so the delivery story is inspectable without database access,
      // which is what makes the adversarial scenarios verifiable from outside.
      supplier_requests: attempts.map((attempt) => ({
        supplier: attempt.supplier,
        request_id: attempt.requestId,
        state: attempt.state,
        attempts: attempt.attempts,
      })),
    };
  });
}
