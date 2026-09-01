/**
 * Test harness.
 *
 * Deliberately uses the real thing wherever the behaviour under test depends on
 * it: a real Postgres (the exactly-once guarantees ARE database behaviour, so
 * mocking it would test nothing) and real supplier stub servers on real sockets
 * (a timeout has to be an actual socket timeout, not a resolved promise).
 *
 * The API is exercised through Fastify's inject rather than a listening socket.
 * Concurrent injects still produce genuinely concurrent database transactions,
 * which is where every race in this system actually happens.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { loadConfig, type AppConfig } from '../../src/infrastructure/config/env.js';
import { createPool, type Pool } from '../../src/infrastructure/db/pool.js';
import { migrateUp } from '../../src/infrastructure/db/migrate.js';
import { buildContainer, type Container } from '../../src/composition/container.js';
import { buildJobHandlers } from '../../src/composition/job-handlers.js';
import { Worker } from '../../src/infrastructure/queue/worker.js';
import { createHttpApp } from '../../src/presentation/http/app.js';
import { createSupplierStub } from '../../src/stubs/supplier/server.js';
import type { AppServer } from '../../src/presentation/http/types.js';
import { SUPPLIER_A, SUPPLIER_B, INTENTIONALLY_EMPTY_SKU } from '../../src/shared/constants.js';
import { seedDatabase } from './seed.js';

export { SUPPLIER_A, SUPPLIER_B, INTENTIONALLY_EMPTY_SKU };

export interface Harness {
  readonly container: Container;
  readonly api: AppServer;
  readonly pool: Pool;
  readonly config: AppConfig;
  readonly supplierUrls: Readonly<Record<string, string>>;
  /** Runs queued jobs until the queue is empty or `maxTicks` is reached. */
  drain(maxTicks?: number): Promise<void>;
  chaos(supplier: string, patch: Record<string, unknown>): Promise<void>;
  issuanceCount(supplier: string, orderId: string): Promise<number>;
  createOrder(sku: string, options?: { orderId?: string; idempotencyKey?: string }): Promise<{ orderId: string; amount: number }>;
  getOrder(orderId: string): Promise<Record<string, unknown>>;
  stop(): Promise<void>;
}

const silentLogger = pino({ level: process.env.TEST_LOG_LEVEL ?? 'silent' });

export async function startHarness(overrides: Partial<NodeJS.ProcessEnv> = {}): Promise<Harness> {
  const rootUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!rootUrl) throw new Error('TEST_DATABASE_URL or DATABASE_URL must be set to run the tests');

  // Every test file gets its own throwaway database.
  //
  // The runner executes files in parallel processes, and a shared database
  // would have them dropping each other's schemas mid-test. Isolating at the
  // database level keeps the suite parallel and every file reproducible on its
  // own, which matters more here than the second it costs to migrate.
  const { databaseUrl } = await createScratchDatabase(rootUrl);

  const bootstrapPool = createPool(loadConfig({ ...process.env, DATABASE_URL: databaseUrl }));
  await migrateUp(bootstrapPool);
  await seedDatabase(bootstrapPool);
  await bootstrapPool.end();

  // Real supplier processes on ephemeral ports. Port 0 lets the OS pick, so
  // parallel test files never collide.
  //
  // The base configuration is validated BEFORE anything starts listening. A
  // config error after a socket is open leaves a handle that keeps the test
  // runner alive forever, which turns a clear failure into a hang.
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    ADMIN_TOKEN: 'test-admin-token',
    SUPPLIER_A_URL: 'http://127.0.0.1:1',
    SUPPLIER_B_URL: 'http://127.0.0.1:1',
    // Short and deterministic: the tests script the failures, so there is no
    // reason to wait out production timeouts.
    SUPPLIER_TIMEOUT_MS: '400',
    SUPPLIER_MAX_ATTEMPTS: '3',
    SUPPLIER_BACKOFF_BASE_MS: '10',
    SUPPLIER_BACKOFF_MAX_MS: '30',
    STUCK_ORDER_AFTER_MS: '0',
    // The harness drives the worker by hand, so the periodic sweeps must not
    // fire underneath a test and make it non deterministic.
    WORKER_PERIODIC_TASKS: 'false',
    ...overrides,
  };
  loadConfig(baseEnv);

  const stubPool = createPool(loadConfig({ ...process.env, DATABASE_URL: databaseUrl }));
  const stubs = await Promise.all(
    [SUPPLIER_A, SUPPLIER_B].map(async (supplier) => {
      const app = createSupplierStub({ pool: stubPool, supplier, logLevel: 'silent' });
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address() as AddressInfo;
      return { supplier, app, url: `http://127.0.0.1:${address.port}` };
    }),
  );

  const supplierUrls = Object.fromEntries(stubs.map((stub) => [stub.supplier, stub.url]));
  const config = loadConfig({
    ...baseEnv,
    SUPPLIER_A_URL: supplierUrls[SUPPLIER_A],
    SUPPLIER_B_URL: supplierUrls[SUPPLIER_B],
  });

  const container = buildContainer({ config, logger: silentLogger });
  const api = createHttpApp(container);
  await api.ready();

  const worker = new Worker({
    queue: container.queue,
    exec: container.pool,
    handlers: buildJobHandlers(container),
    options: { concurrency: 4, pollIntervalMs: 5 },
    logger: silentLogger,
  });

  const harness: Harness = {
    container,
    api,
    pool: container.pool,
    config,
    supplierUrls,

    async drain(maxTicks = 40) {
      // Jobs can enqueue follow-up jobs (a delivery scheduling a
      // reconciliation), so the loop keeps ticking until nothing is left.
      for (let tick = 0; tick < maxTicks; tick += 1) {
        const processed = await worker.tick();
        if (processed === 0) {
          const pending = await container.pool.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM jobs WHERE state = 'pending' AND run_after <= now()`,
          );
          if ((pending.rows[0]?.count ?? 0) === 0) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
    },

    async chaos(supplier, patch) {
      const stub = stubs.find((candidate) => candidate.supplier === supplier);
      if (!stub) throw new Error(`unknown supplier ${supplier}`);
      const response = await stub.app.inject({ method: 'POST', url: '/admin/chaos', payload: patch });
      if (response.statusCode !== 200) throw new Error(`chaos update failed: ${response.body}`);
    },

    async issuanceCount(supplier, orderId) {
      const stub = stubs.find((candidate) => candidate.supplier === supplier);
      if (!stub) throw new Error(`unknown supplier ${supplier}`);
      const response = await stub.app.inject({ url: `/admin/issuances?order_id=${orderId}` });
      return (response.json() as { issuances: unknown[] }).issuances.length;
    },

    async createOrder(sku, options = {}) {
      const response = await api.inject({
        method: 'POST',
        url: '/orders',
        headers: options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {},
        payload: { sku, ...(options.orderId ? { order_id: options.orderId } : {}) },
      });
      if (response.statusCode >= 400) throw new Error(`order creation failed: ${response.body}`);
      const body = response.json() as { order_id: string; amount: number };
      return { orderId: body.order_id, amount: body.amount };
    },

    async getOrder(orderId) {
      const response = await api.inject({ url: `/orders/${orderId}` });
      return response.json() as Record<string, unknown>;
    },

    async stop() {
      await worker.stop();
      await api.close();
      await Promise.all(stubs.map((stub) => stub.app.close()));
      await stubPool.end();
      await container.shutdown();
    },
  };

  return harness;
}

interface ScratchDatabase {
  readonly databaseUrl: string;
}

/** Creates an empty database for one test file, reachable from the same server. */
async function createScratchDatabase(rootUrl: string): Promise<ScratchDatabase> {
  const parsed = new URL(rootUrl);
  const databaseName = `dshop_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

  const admin = new URL(rootUrl);
  admin.pathname = '/postgres';

  const adminPool = createPool(loadConfig({ ...process.env, DATABASE_URL: admin.toString() }));
  try {
    // The name is generated here, never taken from input, so interpolating it
    // into DDL (which cannot be parameterised) is safe.
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await adminPool.end();
  }

  parsed.pathname = `/${databaseName}`;
  return { databaseUrl: parsed.toString() };
}

/**
 * Removes scratch databases left by earlier runs.
 *
 * Cleanup happens at the START of a run rather than in each file's teardown.
 * Dropping a database the test process itself was just connected to races with
 * the connection pool winding down, and a forced drop turns that race into a
 * spurious failure. Sweeping beforehand is deterministic and cannot fail a test.
 */
export async function dropStaleScratchDatabases(rootUrl: string): Promise<number> {
  const admin = new URL(rootUrl);
  admin.pathname = '/postgres';
  const adminPool = createPool(loadConfig({ ...process.env, DATABASE_URL: admin.toString() }));
  let dropped = 0;
  try {
    const stale = await adminPool.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE 'dshop_test_%'`,
    );
    for (const { datname } of stale.rows) {
      // Names come from pg_database, never from input, so interpolation is safe.
      await adminPool.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`).catch(() => undefined);
      dropped += 1;
    }
  } finally {
    await adminPool.end();
  }
  return dropped;
}

/** A distinct order id per test, so nothing collides inside a shared schema. */
export function uniqueOrderId(prefix = 'T'): string {
  return `ord_${prefix}${randomUUID().replace(/-/g, '').slice(0, 20).toUpperCase()}`;
}
