import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppServer } from './types.js';
import { ZodError } from 'zod';
import { DomainError } from '../../domain/errors.js';

/**
 * One place that decides what the client sees.
 *
 * Domain errors carry their own status, validation errors become 400, and
 * anything unrecognised becomes a 500 with the detail kept in the logs rather
 * than echoed back.
 */
export function registerErrorHandler(app: AppServer): void {
  app.setErrorHandler((error: Error, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof DomainError) {
      request.log.info({ err: error.message, code: error.code }, 'request rejected by domain rule');
      return reply.code(error.httpStatus).send({ error: error.code, message: error.message });
    }

    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: 'validation_failed',
        details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }

    const statusCode = (error as { statusCode?: number }).statusCode;
    if (typeof statusCode === 'number' && statusCode < 500) {
      return reply.code(statusCode).send({ error: 'bad_request', message: error.message });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error' });
  });
}
