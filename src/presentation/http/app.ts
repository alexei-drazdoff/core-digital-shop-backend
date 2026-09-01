import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { Container } from '../../composition/container.js';
import type { AppServer } from './types.js';
import { runWithContext } from '../../infrastructure/observability/logger.js';
import { registerErrorHandler } from './errors.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerOrderRoutes } from './routes/orders.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { registerAdminRoutes } from './routes/admin.js';

export function createHttpApp(container: Container): AppServer {
  const app = Fastify({
    loggerInstance: container.logger,
    // Trusting the caller's request id lets a correlation id survive across the
    // payment simulator, the API and the worker, which is what makes a single
    // delivery readable end to end in the logs.
    genReqId: (request) => (request.headers['x-request-id'] as string) ?? randomUUID(),
  });

  app.addHook('onRequest', (request, _reply, done) => {
    runWithContext({ correlationId: String(request.id) }, done);
  });

  registerErrorHandler(app);

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/ready', async (_request, reply) => {
    try {
      await container.pool.query('SELECT 1');
      return { status: 'ready' };
    } catch (error) {
      container.logger.error({ err: error }, 'readiness check failed');
      return reply.code(503).send({ status: 'not_ready' });
    }
  });

  app.get('/metrics', async (_request, reply) => {
    reply.header('content-type', container.metrics.registry.contentType);
    return container.metrics.render();
  });

  registerCatalogRoutes(app, container);
  registerOrderRoutes(app, container);
  registerWebhookRoutes(app, container);
  registerAdminRoutes(app, container);

  return app;
}
