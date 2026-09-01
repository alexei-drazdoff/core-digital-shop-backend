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
});

const chaosBody = z.object({
  error_rate: z.number().min(0).max(1).optional(),
  timeout_rate: z.number().min(0).max(1).optional(),
  latency_ms: z.number().int().min(0).optional(),
  hang_ms: z.number().int().min(0).optional(),
  issue_before_hang: z.boolean().optional(),
  hang_before_lookup: z.boolean().optional(),
  forced_outcome: z.enum(['ok', 'error', 'timeout', 'out_of_stock']).nullable().optional(),
});

const replenishBody = z.object({
  sku: z.string().min(1),
  count: z.number().int().min(1).max(100_000).optional(),
  codes: z.array(z.string().min(1)).optional(),
});

type Outcome = 'ok' | 'error' | 'timeout' | 'out_of_stock';

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
    const chaos = await store.getChaos();

    if (chaos.latencyMs > 0) await delay(chaos.latencyMs);

    // A supplier that has gone completely unreachable cannot answer a repeat
    // either. This branch runs before the idempotency lookup so that a code
    // already issued stays stranded, which is the only way a genuine orphaned
    // issuance can form.
    if (chaos.hangBeforeLookup && decideOutcome(chaos, random) === 'timeout') {
      if (chaos.issueBeforeHang) {
        try {
          await store.issue(requestId, orderId, sku);
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
      return reply.code(200).send({ status: 'ok', request_id: requestId, code: existing.code });
    }

    const outcome = decideOutcome(chaos, random);

    if (outcome === 'error') {
      return reply.code(503).send({ status: 'error', reason: 'supplier_unavailable' });
    }
    if (outcome === 'out_of_stock') {
      return reply.code(409).send({ status: 'error', reason: 'out_of_stock' });
    }

    if (outcome === 'timeout') {
      // The trap. By default the code IS issued and only the response is
      // withheld, which models a supplier that did the work while the answer was
      // lost in transit. The caller must not treat this as a refusal.
      if (chaos.issueBeforeHang) {
        try {
          await store.issue(requestId, orderId, sku);
        } catch (error) {
          if (!(error instanceof OutOfStockError)) throw error;
        }
      }
      await delay(chaos.hangMs);
      return reply.code(504).send({ status: 'error', reason: 'gateway_timeout' });
    }

    try {
      const issuance = await store.issue(requestId, orderId, sku);
      return reply.code(200).send({ status: 'ok', request_id: requestId, code: issuance.code });
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
    const orderId = (request.query as { order_id?: string }).order_id;
    if (!orderId) return { supplier, issuances: [] };
    return { supplier, issuances: await store.issuancesForOrder(orderId) };
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
