/**
 * Seeds the catalog and both supplier key pools from the material shipped with
 * the assignment. Exported as a function so the CLI script and the test harness
 * seed from exactly the same code, and tests cannot drift from what a reviewer
 * gets after `npm run seed`.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Pool } from '../src/infrastructure/db/pool.js';
import { SUPPLIER_A, SUPPLIER_B, INTENTIONALLY_EMPTY_SKU } from '../src/shared/constants.js';

/** Modelled supplier cost as a share of the sale price. */
export const SUPPLIER_COST_RATIO = 0.7;

interface CatalogFile {
  products: Array<{ sku: string; name: string; type: string; price: number; currency: string; image?: string }>;
}

interface KeysFile {
  keys: string[];
}

export interface SeedSummary {
  readonly products: number;
  readonly keys: number;
  readonly emptySku: string;
}

const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export async function seedDatabase(pool: Pool): Promise<SeedSummary> {
  const catalog: CatalogFile = JSON.parse(await readFile(here('catalog.json'), 'utf8'));
  const keyPool: KeysFile = JSON.parse(await readFile(here('keys.json'), 'utf8'));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Upsert, so re-seeding is safe and never orphans existing orders.
    for (const [index, product] of catalog.products.entries()) {
      await client.query(
        `INSERT INTO products (sku, name, type, price_minor, cost_minor, currency, image, sort_rank, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
         ON CONFLICT (sku) DO UPDATE
            SET name = EXCLUDED.name, type = EXCLUDED.type,
                price_minor = EXCLUDED.price_minor, cost_minor = EXCLUDED.cost_minor,
                currency = EXCLUDED.currency, image = EXCLUDED.image,
                sort_rank = EXCLUDED.sort_rank, updated_at = now()`,
        [
          product.sku,
          product.name,
          product.type,
          product.price,
          // No supplier price list ships with the assignment, so cost is a flat
          // share of the sale price. It only has to be a real number for the
          // margin in the money journal to mean something.
          Math.round(product.price * SUPPLIER_COST_RATIO),
          product.currency,
          product.image ?? null,
          catalog.products.length - index,
        ],
      );
    }

    await client.query(
      `INSERT INTO product_stock (product_id, available_count)
       SELECT id, 0 FROM products ON CONFLICT (product_id) DO NOTHING`,
    );

    await client.query('DELETE FROM supplier_stub.issuances');
    await client.query('DELETE FROM supplier_stub.keys');

    // One SKU is left empty at both suppliers so the out of stock recovery
    // scenario is reachable straight after seeding, with no data surgery.
    const stockedSkus = catalog.products.map((product) => product.sku).filter((sku) => sku !== INTENTIONALLY_EMPTY_SKU);

    for (const [index, code] of keyPool.keys.entries()) {
      await client.query(
        `INSERT INTO supplier_stub.keys (supplier, sku, code) VALUES ($1, $2, $3)
         ON CONFLICT (supplier, code) DO NOTHING`,
        [index % 2 === 0 ? SUPPLIER_A : SUPPLIER_B, stockedSkus[index % stockedSkus.length], code],
      );
    }

    for (const supplier of [SUPPLIER_A, SUPPLIER_B]) {
      await client.query(`INSERT INTO supplier_stub.chaos (supplier) VALUES ($1) ON CONFLICT (supplier) DO NOTHING`, [
        supplier,
      ]);
    }

    // Bring the storefront counters in line with the pools just loaded.
    await client.query(
      `WITH counted AS (
         SELECT p.id AS product_id, COALESCE(k.available, 0) AS available
           FROM products p
      LEFT JOIN (SELECT sku, count(*)::int AS available FROM supplier_stub.keys
                  WHERE state = 'available' GROUP BY sku) k ON k.sku = p.sku
       )
       UPDATE product_stock ps SET available_count = counted.available, updated_at = now()
         FROM counted WHERE ps.product_id = counted.product_id`,
    );
    await client.query(
      `UPDATE products p SET in_stock = (ps.available_count > 0), updated_at = now()
         FROM product_stock ps
        WHERE ps.product_id = p.id AND p.in_stock <> (ps.available_count > 0)`,
    );

    await client.query('COMMIT');
    return { products: catalog.products.length, keys: keyPool.keys.length, emptySku: INTENTIONALLY_EMPTY_SKU };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
