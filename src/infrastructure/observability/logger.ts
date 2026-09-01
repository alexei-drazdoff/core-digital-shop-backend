import { AsyncLocalStorage } from 'node:async_hooks';
import { pino, type Logger } from 'pino';
import type { AppConfig } from '../config/env.js';

export type { Logger };

export interface RequestContext {
  correlationId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with a correlation id that every log line inside it will carry. */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

export function createLogger(config: AppConfig): Logger {
  return pino({
    level: config.LOG_LEVEL,
    base: { service: 'digital-shop-core', env: config.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Correlation id is injected rather than threaded through every call site,
    // so a payment can be followed across the webhook, the queue and the worker.
    mixin() {
      const correlationId = currentCorrelationId();
      return correlationId ? { correlation_id: correlationId } : {};
    },
    // The issued key is the product itself, so it never reaches the log stream.
    // Paths are narrow on purpose: a blanket 'code' rule would also swallow
    // pg error codes and make incidents harder to read.
    redact: {
      paths: ['req.headers.authorization', 'issued_code', '*.issued_code', 'delivery.issued_code'],
      censor: '[redacted]',
    },
    ...(config.LOG_PRETTY
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } } }
      : {}),
  });
}
