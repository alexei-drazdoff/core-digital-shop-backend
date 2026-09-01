/** CLI wrapper around the shared seeding routine. */
import { loadConfig } from '../src/infrastructure/config/env.js';
import { createPool } from '../src/infrastructure/db/pool.js';
import { seedDatabase } from './seed-database.js';

async function main(): Promise<void> {
  const pool = createPool(loadConfig());
  try {
    const summary = await seedDatabase(pool);
    const stock = await pool.query<{ supplier: string; sku: string; total: string }>(
      `SELECT supplier, sku, count(*)::text AS total FROM supplier_stub.keys
        GROUP BY supplier, sku ORDER BY supplier, sku`,
    );
    console.log(`Seeded ${summary.products} products and ${summary.keys} keys.`);
    console.log(`SKU left intentionally empty at both suppliers: ${summary.emptySku}`);
    console.table(stock.rows);
  } finally {
    await pool.end();
  }
}

main().catch((error: Error) => {
  console.error(error);
  process.exit(1);
});
