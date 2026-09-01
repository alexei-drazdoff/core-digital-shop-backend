import { z } from 'zod';

/**
 * Every knob the system exposes is declared here and validated once at boot.
 * A misconfigured process must fail immediately and loudly, never halfway
 * through the first money-carrying request.
 */
const booleanFromEnv = z
  .string()
  .transform((value) => value === 'true' || value === '1')
  .pipe(z.boolean());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: booleanFromEnv.default('false'),

  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(20),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  ADMIN_TOKEN: z.string().min(1).default('dev-admin-token'),

  // Supplier A is primary, supplier B is the fallback.
  SUPPLIER_A_URL: z.string().url().default('http://127.0.0.1:4001'),
  SUPPLIER_B_URL: z.string().url().default('http://127.0.0.1:4002'),

  /** Per-attempt HTTP timeout. Deliberately short so the timeout trap is easy to exercise. */
  SUPPLIER_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
  /** Attempts against a single supplier, including the first one. */
  SUPPLIER_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(3),
  SUPPLIER_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(100),
  SUPPLIER_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(2_000),

  /** Consecutive failures before a supplier circuit opens. */
  CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(5),
  CIRCUIT_OPEN_MS: z.coerce.number().int().positive().default(5_000),

  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(4),
  /**
   * The worker serves its own health and metrics endpoints here.
   *
   * Metrics registries are per process, and delivery, retry and orphan counters
   * are all incremented in the worker. Without a listener of its own they would
   * be produced and never scraped.
   */
  WORKER_METRICS_PORT: z.coerce.number().int().positive().default(3001),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(200),
  /**
   * A paid order older than this with no delivery is considered stuck and is
   * recovered. Zero is allowed and means "consider everything stuck at once",
   * which is how tests drive recovery without waiting.
   */
  STUCK_ORDER_AFTER_MS: z.coerce.number().int().nonnegative().default(30_000),
  RECOVERY_SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  STOCK_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  /** Set false in tests that drive the worker loop by hand. */
  WORKER_PERIODIC_TASKS: booleanFromEnv.default('true'),
});

export type AppConfig = Readonly<z.infer<typeof envSchema>>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return Object.freeze(parsed.data);
}
