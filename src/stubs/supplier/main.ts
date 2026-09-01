/**
 * Entry point for one supplier stub process.
 *
 * Usage: SUPPLIER_NAME=supplier_a SUPPLIER_PORT=4001 tsx src/stubs/supplier/main.ts
 */
import { loadConfig } from '../../infrastructure/config/env.js';
import { createPool } from '../../infrastructure/db/pool.js';
import { createSupplierStub } from './server.js';

async function main(): Promise<void> {
  const supplier = process.env.SUPPLIER_NAME ?? 'supplier_a';
  const port = Number.parseInt(process.env.SUPPLIER_PORT ?? '4001', 10);
  const host = process.env.SUPPLIER_HOST ?? '0.0.0.0';

  const pool = createPool(loadConfig());
  const app = createSupplierStub({ pool, supplier, logLevel: process.env.LOG_LEVEL ?? 'warn' });

  const shutdown = async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ host, port });
  console.log(`[${supplier}] listening on http://${host}:${port}`);
}

main().catch((error: Error) => {
  console.error(error);
  process.exit(1);
});
