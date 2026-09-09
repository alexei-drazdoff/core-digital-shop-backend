/**
 * Supplier stub HTTP server.
 *
 * Implements the supplier contract from the assignment plus a small admin
 * surface (stock, chaos, issuances) that the core and the tests use. The admin
 * routes are an extension beyond the contract and are called out in the README.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from '../../infrastructure/db/pool.js';
import { OutOfStockError, SupplierStore, type ChaosConfig } from './store.js';

const issueBody = z.object({
  request_id: z.string().min(1),
  sku: z.string().min(1),
  order_id: z.string().min(1),
  /** The line the code is for. Optional so first stage callers still work. */
  order_item_id: z.string().min(1).optional(),
});

const chaosBody = z.object({
  error_rate: z.number().min(0).max(1).optional(),
  timeout_rate: z.number().min(0).max(1).optional(),
  latency_ms: z.number().int().min(0).optional(),
  hang_ms: z.number().int().min(0).optional(),
  issue_before_hang: z.boolean().optional(),
  hang_before_lookup: z.boolean().optional(),
  forced_outcome: z
    .enum(['ok', 'error', 'timeout', 'out_of_stock', 'duplicate_code', 'foreign_code', 'error_after_issue'])
    .nullable()
    .optional(),
});

const replenishBody = z.object({
  sku: z.string().min(1),
  count: z.number().int().min(1).max(100_000).optional(),
  codes: z.array(z.string().min(1)).optional(),
});

/**
 * The last three are the second stage's additions: a supplier that is not merely
 * unreliable but dishonest. They are qualitatively different from the first
 * three, which all describe an ANSWER GOING MISSING. These describe an answer
 * arriving with nothing true behind it, which no amount of retrying can fix.
 */
type Outcome = 'ok' | 'error' | 'timeout' | 'out_of_stock' | 'duplicate_code' | 'foreign_code' | 'error_after_issue';

/** forced_outcome wins so tests are deterministic; otherwise the rates decide. */
function decideOutcome(chaos: ChaosConfig, random: () => number): Outcome {
  if (chaos.forcedOutcome) return chaos.forcedOutcome;
  const roll = random();
  if (roll < chaos.timeoutRate) return 'timeout';
  if (roll < chaos.timeoutRate + chaos.errorRate) return 'error';
  return 'ok';
}

export interface SupplierStubOptions {
  readonly pool: Pool;
  readonly supplier: string;
  readonly logLevel?: string;
  readonly random?: () => number;
}

export function createSupplierStub(options: SupplierStubOptions): FastifyInstance {
  const { pool, supplier, random = Math.random } = options;
  const store = new SupplierStore(pool, supplier);
  const app = Fastify({ logger: { level: options.logLevel ?? 'warn', base: { supplier } } });

  app.get('/health', async () => ({ status: 'ok', supplier }));

  app.post('/issue', async (request, reply) => {
    const parsed = issueBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ status: 'error', reason: 'invalid_request' });
    }
    const { request_id: requestId, sku, order_id: orderId } = parsed.data;
    // The line, when the caller names one. Recorded alongside the order so
    // /admin/issuances can be asked "how many codes did this LINE consume",
    // which is the exactly-once assertion that matters once one order makes
    // several calls.
    const orderItemId = parsed.data.order_item_id ?? orderId;
    const chaos = await store.getChaos();

    if (chaos.latencyMs > 0) await delay(chaos.latencyMs);

    // A supplier that has gone completely unreachable cannot answer a repeat
    // either. This branch runs before the idempotency lookup so that a code
    // already issued stays stranded, which is the only way a genuine orphaned
    // issuance can form.
    if (chaos.hangBeforeLookup && decideOutcome(chaos, random) === 'timeout') {
      if (chaos.issueBeforeHang) {
        try {
          await store.issue(requestId, orderId, orderItemId, sku);
        } catch (error) {
          if (!(error instanceof OutOfStockError)) throw error;
        }
      }
      await delay(chaos.hangMs);
      return reply.code(504).send({ status: 'error', reason: 'gateway_timeout' });
    }

    // Otherwise an already issued request_id always answers with the same code,
    // whatever the chaos settings say. Without this the contract would be a lie
    // and the caller could never recover from a timeout.
    const existing = await store.findIssuance(requestId);
    if (existing) {
      return reply.code(200).send({ status: 'ok', request_id: requestId, sku: existing.sku, code: existing.code });
    }

    const outcome = decideOutcome(chaos, random);

    if (outcome === 'error') {
      return reply.code(503).send({ status: 'error', reason: 'supplier_unavailable' });
    }
    if (outcome === 'out_of_stock') {
      return reply.code(409).send({ status: 'error', reason: 'out_of_stock' });
    }

    // A code that belongs to somebody else's request.
    //
    // Nothing is consumed and nothing is recorded: the stub simply says a
    // sentence that is not true. That is the shape of the failure — there is no
    // supplier-side state the caller could query to discover it, so the caller
    // has to know from its OWN records that this code is already spoken for.
    if (outcome === 'duplicate_code') {
      const duplicate = await store.someOtherIssuedCode(requestId);
      if (duplicate) {
        return reply.code(200).send({ status: 'ok', request_id: requestId, sku, code: duplicate });
      }
      // Nothing to duplicate yet. Falling through to the honest path rather than
      // inventing a code keeps a test that asks for this too early failing
      // loudly instead of passing on a fabrication.
    }

    // A code for a different product. The customer would get a key they did not
    // buy, and the real buyer of that key would later be handed it too.
    if (outcome === 'foreign_code') {
      const foreign = await store.someForeignCode(sku);
      if (foreign) {
        // The sku reported is the code's REAL one, not the one that was asked
        // for. That is the honest shape of this bug: the supplier's own records
        // are correct, it simply reached into the wrong pool, and it says so.
        // A supplier that also lied about the sku would be undetectable from the
        // response alone — and it is caught anyway, by the code registry, the
        // moment the rightful buyer of that key comes along.
        return reply.code(200).send({ status: 'ok', request_id: requestId, sku: foreign.sku, code: foreign.code });
      }
    }

    // Consumed a key, then answered with an error.
    //
    // Distinct from the timeout trap, and worth its own mode: a timeout says "no
    // answer arrived", which the caller already treats as indeterminate. An
    // explicit 503 says "this definitively failed", which is the answer that
    // tempts a caller into failing over immediately — and the key is gone.
    if (outcome === 'error_after_issue') {
      try {
        await store.issue(requestId, orderId, orderItemId, sku);
      } catch (error) {
        if (!(error instanceof OutOfStockError)) throw error;
      }
      return reply.code(503).send({ status: 'error', reason: 'supplier_unavailable' });
    }

    if (outcome === 'timeout') {
      // The trap. By default the code IS issued and only the response is
      // withheld, which models a supplier that did the work while the answer was
      // lost in transit. The caller must not treat this as a refusal.
      if (chaos.issueBeforeHang) {
        try {
          await store.issue(requestId, orderId, orderItemId, sku);
        } catch (error) {
          if (!(error instanceof OutOfStockError)) throw error;
        }
      }
      await delay(chaos.hangMs);
      return reply.code(504).send({ status: 'error', reason: 'gateway_timeout' });
    }

    try {
      const issuance = await store.issue(requestId, orderId, orderItemId, sku);
      return reply.code(200).send({ status: 'ok', request_id: requestId, sku, code: issuance.code });
    } catch (error) {
      if (error instanceof OutOfStockError) {
        return reply.code(409).send({ status: 'error', reason: 'out_of_stock' });
      }
      request.log.error({ err: error }, 'issue failed');
      return reply.code(500).send({ status: 'error', reason: 'internal_error' });
    }
  });

  // Extensions beyond the contract, used by stock sync and by the tests.
  app.get('/stock', async () => ({ supplier, items: await store.stock() }));

  app.get('/admin/issuances', async (request) => {
    const query = request.query as { order_id?: string; order_item_id?: string };
    const key = query.order_item_id ?? query.order_id;
    if (!key) return { supplier, issuances: [] };
    return { supplier, issuances: await store.issuancesForOrder(key) };
  });

  app.get('/admin/chaos', async () => ({ supplier, chaos: await store.getChaos() }));

  app.post('/admin/chaos', async (request, reply) => {
    const parsed = chaosBody.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_chaos_config' });
    const body = parsed.data;
    const chaos = await store.setChaos({
      ...(body.error_rate !== undefined && { errorRate: body.error_rate }),
      ...(body.timeout_rate !== undefined && { timeoutRate: body.timeout_rate }),
      ...(body.latency_ms !== undefined && { latencyMs: body.latency_ms }),
      ...(body.hang_ms !== undefined && { hangMs: body.hang_ms }),
      ...(body.issue_before_hang !== undefined && { issueBeforeHang: body.issue_before_hang }),
      ...(body.hang_before_lookup !== undefined && { hangBeforeLookup: body.hang_before_lookup }),
      ...(body.forced_outcome !== undefined && { forcedOutcome: body.forced_outcome }),
    });
    return { supplier, chaos };
  });

  app.post('/admin/replenish', async (request, reply) => {
    const parsed = replenishBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_replenish_request' });
    const { sku, count = 10, codes } = parsed.data;
    const generated =
      codes ??
      Array.from({ length: count }, () => {
        const block = () =>
          Array.from({ length: 4 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(random() * 36)]).join('');
        return `${block()}-${block()}-${block()}`;
      });
    const added = await store.replenish(sku, generated);
    return { supplier, sku, added };
  });

  return app;
}
