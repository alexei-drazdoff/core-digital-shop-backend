/**
 * The background worker.
 *
 * Claims jobs with SKIP LOCKED, runs them with a per-job timeout, and reschedules
 * failures with jittered backoff. Every handler it dispatches to is idempotent,
 * because at-least-once delivery is the only guarantee a queue like this offers
 * and pretending otherwise is how duplicates get created.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Job, JobKind, JobQueue } from '../../application/ports/queue.js';
import { jobRetryDelayMs } from '../../application/retry-policy.js';
import type { Executor } from '../db/pool.js';
import type { Logger } from '../observability/logger.js';
import { runWithContext } from '../observability/logger.js';

export type JobHandler = (job: Job) => Promise<void>;

export interface WorkerOptions {
  readonly concurrency: number;
  readonly pollIntervalMs: number;
  /** A job that outlives this is abandoned so a stuck handler cannot hold the queue. */
  readonly jobTimeoutMs?: number;
}

export class Worker {
  private readonly workerId = `worker-${randomUUID().slice(0, 8)}`;
  private running = false;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly deps: {
      queue: JobQueue;
      exec: Executor;
      handlers: Readonly<Record<JobKind, JobHandler>>;
      options: WorkerOptions;
      logger: Logger;
      onJobFinished?: (kind: JobKind, outcome: 'succeeded' | 'failed') => void;
    },
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop?.catch(() => undefined);
    this.loop = null;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        const processed = await this.tick();
        // Only idle when there was nothing to do. A busy queue is drained at full speed.
        if (processed === 0) await sleep(this.deps.options.pollIntervalMs);
      } catch (error) {
        this.deps.logger.error({ err: error }, 'worker loop error');
        await sleep(this.deps.options.pollIntervalMs);
      }
    }
  }

  /** One claim-and-run cycle. Exposed so tests can drive the worker deterministically. */
  async tick(): Promise<number> {
    const { queue, exec, options } = this.deps;
    const jobs = await queue.claim(exec, this.workerId, options.concurrency);
    if (jobs.length === 0) return 0;
    await Promise.all(jobs.map((job) => this.runJob(job)));
    return jobs.length;
  }

  private async runJob(job: Job): Promise<void> {
    const { queue, exec, handlers, logger, onJobFinished } = this.deps;
    const handler = handlers[job.kind];
    const startedAt = Date.now();

    // Each job gets its own correlation id, so the log lines a single delivery
    // produces across suppliers and retries can be pulled out as one story.
    await runWithContext({ correlationId: `job-${job.id}` }, async () => {
      if (!handler) {
        await queue.fail(exec, job.id, `no handler for kind ${job.kind}`, null);
        logger.error({ job_id: job.id, kind: job.kind }, 'job has no handler, marked dead');
        return;
      }

      try {
        await this.withTimeout(handler(job), this.deps.options.jobTimeoutMs ?? 120_000, job);
        await queue.complete(exec, job.id);
        onJobFinished?.(job.kind, 'succeeded');
        logger.debug({ job_id: job.id, kind: job.kind, duration_ms: Date.now() - startedAt }, 'job completed');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const exhausted = job.attempts >= job.maxAttempts;
        await queue.fail(exec, job.id, message, exhausted ? null : new Date(Date.now() + jobRetryDelayMs(job.attempts)));
        onJobFinished?.(job.kind, 'failed');
        logger[exhausted ? 'error' : 'warn'](
          { job_id: job.id, kind: job.kind, attempts: job.attempts, err: message },
          exhausted ? 'job exhausted its retries and is now dead' : 'job failed and will be retried',
        );
      }
    });
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, job: Job): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`job ${job.id} (${job.kind}) exceeded ${ms}ms`)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
