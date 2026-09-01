import type { Executor } from '../pool.js';
import type { TransactionScope } from '../unit-of-work.js';
import type { Product, ProductRepository, StorefrontItem, StorefrontQuery } from '../../../application/ports/repositories.js';

interface ProductRow {
  id: number;
  sku: string;
  name: string;
  type: string;
  price_minor: number;
  cost_minor: number;
  currency: string;
  image: string | null;
  is_active: boolean;
}

function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    type: row.type,
    priceMinor: row.price_minor,
    costMinor: row.cost_minor,
    currency: row.currency,
    image: row.image,
    isActive: row.is_active,
  };
}

export class PgProductRepository implements ProductRepository {
  async findBySku(exec: Executor, sku: string): Promise<Product | null> {
    const result = await exec.query<ProductRow>(
      `SELECT id, sku, name, type, price_minor, cost_minor, currency, image, is_active
         FROM products WHERE sku = $1`,
      [sku],
    );
    const row = result.rows[0];
    return row ? toProduct(row) : null;
  }

  async findById(exec: Executor, productId: number): Promise<Product | null> {
    const result = await exec.query<ProductRow>(
      `SELECT id, sku, name, type, price_minor, cost_minor, currency, image, is_active
         FROM products WHERE id = $1`,
      [productId],
    );
    const row = result.rows[0];
    return row ? toProduct(row) : null;
  }

  async listActive(exec: Executor): Promise<readonly Product[]> {
    const result = await exec.query<ProductRow>(
      `SELECT id, sku, name, type, price_minor, cost_minor, currency, image, is_active
         FROM products WHERE is_active ORDER BY id`,
    );
    return result.rows.map(toProduct);
  }

  async availableCount(exec: Executor, productId: number): Promise<number> {
    const result = await exec.query<{ available_count: number }>(
      'SELECT available_count FROM product_stock WHERE product_id = $1',
      [productId],
    );
    return result.rows[0]?.available_count ?? 0;
  }

  /**
   * The hot storefront read.
   *
   * Ordering and paging are both on (sort_rank DESC, id DESC), which matches the
   * partial index exactly, so the planner walks the index and stops after LIMIT
   * rows. Cost stays flat as the catalog grows and as the reader pages deeper,
   * which an OFFSET based query cannot do. See docs/EXPLAIN.md.
   */
  async storefront(exec: Executor, query: StorefrontQuery): Promise<readonly StorefrontItem[]> {
    const conditions: string[] = ['p.is_active'];
    const params: unknown[] = [];

    if (query.inStockOnly) conditions.push('p.in_stock');
    if (query.type !== undefined) {
      params.push(query.type);
      conditions.push(`p.type = $${params.length}`);
    }
    if (query.cursor) {
      // Row value comparison, so one index scan does the whole predicate rather
      // than the planner unpicking an OR chain.
      params.push(query.cursor.sortRank, query.cursor.id);
      conditions.push(`(p.sort_rank, p.id) < ($${params.length - 1}, $${params.length})`);
    }
    params.push(query.limit);

    const result = await exec.query<ProductRow & { sort_rank: number; available_count: number }>(
      `SELECT p.id, p.sku, p.name, p.type, p.price_minor, p.cost_minor, p.currency, p.image,
              p.is_active, p.sort_rank, COALESCE(ps.available_count, 0) AS available_count
         FROM products p
         LEFT JOIN product_stock ps ON ps.product_id = p.id
        WHERE ${conditions.join(' AND ')}
        ORDER BY p.sort_rank DESC, p.id DESC
        LIMIT $${params.length}`,
      params,
    );

    return result.rows.map((row) => ({
      ...toProduct(row),
      sortRank: row.sort_rank,
      availableCount: row.available_count,
    }));
  }

  /**
   * Moves the availability counter and flips products.in_stock only when the
   * boolean actually changes.
   *
   * The `WHERE p.in_stock <> ...` guard is what keeps the read-mostly catalog
   * table from being rewritten on every sale: the counter churns in the narrow
   * product_stock row, the indexed flag is touched only on a real 0 boundary crossing.
   */
  async adjustStock(tx: TransactionScope, productId: number, delta: number): Promise<void> {
    await tx.query(
      `INSERT INTO product_stock (product_id, available_count)
       VALUES ($1, GREATEST($2, 0))
       ON CONFLICT (product_id) DO UPDATE
          SET available_count = GREATEST(product_stock.available_count + $2, 0),
              updated_at = now()`,
      [productId, delta],
    );
    await this.syncFlag(tx, productId);
  }

  async setStock(tx: TransactionScope, productId: number, available: number): Promise<void> {
    await tx.query(
      `INSERT INTO product_stock (product_id, available_count)
       VALUES ($1, GREATEST($2, 0))
       ON CONFLICT (product_id) DO UPDATE
          SET available_count = GREATEST($2, 0), updated_at = now()`,
      [productId, available],
    );
    await this.syncFlag(tx, productId);
  }

  private async syncFlag(tx: TransactionScope, productId: number): Promise<void> {
    await tx.query(
      `UPDATE products p
          SET in_stock = (ps.available_count > 0), updated_at = now()
         FROM product_stock ps
        WHERE ps.product_id = p.id
          AND p.id = $1
          AND p.in_stock <> (ps.available_count > 0)`,
      [productId],
    );
  }
}
