/**
 * Backoff schedule for supplier retries.
 *
 * Pure and injectable so tests can assert the schedule without waiting for it.
 * Full jitter rather than plain exponential: when a supplier recovers after an
 * outage, every stalled order would otherwise retry at the same instant and knock
 * it straight back over.
 */
export interface BackoffOptions {
  readonly baseMs: number;
  readonly maxMs: number;
  readonly random?: () => number;
}

export function backoffDelayMs(attempt: number, options: BackoffOptions): number {
  const random = options.random ?? Math.random;
  const exponential = Math.min(options.maxMs, options.baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(random() * exponential);
}

/** Delay before a failed job is retried. Same shape, longer horizon. */
export function jobRetryDelayMs(attempt: number): number {
  const seconds = Math.min(300, 2 ** Math.min(attempt, 8));
  return Math.floor(seconds * 1000 * (0.5 + Math.random() * 0.5));
}
