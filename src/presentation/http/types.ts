import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { Logger } from '../../infrastructure/observability/logger.js';

/**
 * The Fastify instance as this app configures it.
 *
 * Named explicitly because handing Fastify a concrete pino instance narrows its
 * logger generic, and route registrars have to agree on that narrowed type.
 */
export type AppServer = FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>;
