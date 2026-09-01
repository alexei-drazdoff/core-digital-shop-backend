/**
 * Worker process.
 *
 * Runs the job queue plus three periodic sweeps. Splitting it from the API is
 * what keeps the webhook fast: a supplier that hangs for thirty seconds delays a
 * background job, not the payment provider's request.
 */
import Fastify from 'fastify';
import { buildContainer } from './container.js';
import { buildJobHandlers } from './job-handlers.js';
import { Worker } from '../infrastructure/queue/worker.js';

async function main(): Promise<void> {
  const container = buildContainer();
  const { config, logger, useCases, metrics } = container;

  const worker = new Worker({
    queue: container.queue,
    exec: container.pool,
    handlers: buildJobHandlers(container),
    options: { concurrency: config.WORKER_CONCURRENCY, pollIntervalMs: config.WORKER_POLL_INTERVAL_MS },
    logger,
    onJobFinished: (kind, outcome) => metrics.recordJob(kind, outcome),
  });

  const timers: NodeJS.Timeout[] = [];
  if (config.WORKER_PERIODIC_TASKS) {
    // The safety net. Even if every job were lost, these sweeps would still
    // drive paid orders to a final state.
    timers.push(
      setInterval(() => {
        void useCases.recoverStuckOrders.execute().catch((error: Error) => logger.error({ err: error }, 'recovery sweep failed'));
      }, config.RECOVERY_SCAN_INTERVAL_MS),
      setInterval(() => {
        void useCases.syncStock.execute().catch((error: Error) => logger.error({ err: error }, 'stock sync failed'));
      }, config.STOCK_SYNC_INTERVAL_MS),
    );
  }

  // The worker owns the delivery, retry and orphan counters, so it needs a
  // listener of its own for them to be scrapeable at all.
  const admin = Fastify({ loggerInstance: logger });
  admin.get('/health', async () => ({ status: 'ok', role: 'worker' }));
  admin.get('/metrics', async (_request, reply) => {
    reply.header('content-type', metrics.registry.contentType);
    return metrics.render();
  });
  await admin.listen({ host: config.API_HOST, port: config.WORKER_METRICS_PORT });

  worker.start();
  logger.info(
    { concurrency: config.WORKER_CONCURRENCY, metrics_port: config.WORKER_METRICS_PORT },
    'worker started',
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down worker');
    for (const timer of timers) clearInterval(timer);
    await worker.stop();
    await admin.close();
    await container.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: Error) => {
  console.error(error);
  process.exit(1);
});
