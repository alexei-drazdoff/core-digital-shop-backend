/** API process. Serves HTTP only; delivery work belongs to the worker. */
import { buildContainer } from './container.js';
import { createHttpApp } from '../presentation/http/app.js';

async function main(): Promise<void> {
  const container = buildContainer();
  const app = createHttpApp(container);

  // Drain in-flight requests before closing the pool, so a deploy cannot cut a
  // transaction in half.
  const shutdown = async (signal: string) => {
    container.logger.info({ signal }, 'shutting down api');
    await app.close();
    await container.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: container.config.API_HOST, port: container.config.API_PORT });
  container.logger.info({ port: container.config.API_PORT }, 'api listening');
}

main().catch((error: Error) => {
  console.error(error);
  process.exit(1);
});
