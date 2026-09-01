import type { AppServer } from '../types.js';
import type { Container } from '../../../composition/container.js';
import { decodeCursor, encodeCursor, storefrontQuery } from '../schemas.js';

export function registerCatalogRoutes(app: AppServer, container: Container): void {
  const { repositories, pool } = container;

  /**
   * The hot storefront endpoint.
   *
   * Paging is keyset, not OFFSET: the cursor carries the last (sort_rank, id)
   * seen, so page 500 costs the same as page 1. See docs/EXPLAIN.md for the plan.
   */
  app.get('/catalog/products', async (request) => {
    const query = storefrontQuery.parse(request.query);
    const items = await repositories.products.storefront(pool, {
      type: query.type,
      limit: query.limit,
      cursor: decodeCursor(query.cursor),
      inStockOnly: query.in_stock,
    });

    const last = items.at(-1);
    return {
      items: items.map((item) => ({
        sku: item.sku,
        name: item.name,
        type: item.type,
        price: item.priceMinor,
        currency: item.currency,
        image: item.image,
        available: item.availableCount,
      })),
      // Absent when the page was not full, which tells the client to stop
      // without needing a count query.
      next_cursor: last && items.length === query.limit ? encodeCursor(last.sortRank, last.id) : null,
    };
  });

  app.get('/catalog/products/:sku', async (request, reply) => {
    const { sku } = request.params as { sku: string };
    const product = await repositories.products.findBySku(pool, sku);
    if (!product) return reply.code(404).send({ error: 'product_not_found' });

    const available = await repositories.products.availableCount(pool, product.id);

    return {
      sku: product.sku,
      name: product.name,
      type: product.type,
      price: product.priceMinor,
      currency: product.currency,
      image: product.image,
      is_active: product.isActive,
      available,
    };
  });
}
