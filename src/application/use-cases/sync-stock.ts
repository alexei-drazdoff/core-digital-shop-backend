/**
 * Refreshes the storefront availability counters from the suppliers.
 *
 * The counters exist so the hot storefront query never has to count keys. That
 * makes them a cache, and a cache needs a refresh path: deliveries decrement it
 * immediately, and this job corrects any drift from restocks, manual changes or
 * a delivery that failed after the counter moved.
 */
import type { SupplierGateway } from '../ports/supplier-gateway.js';
import type { ProductRepository } from '../ports/repositories.js';
import type { UnitOfWork } from '../../infrastructure/db/unit-of-work.js';
import type { Logger } from '../../infrastructure/observability/logger.js';

export class SyncStockUseCase {
  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      products: ProductRepository;
      suppliers: readonly SupplierGateway[];
      logger: Logger;
    },
  ) {}

  async execute(): Promise<{ updated: number }> {
    const { uow, products, suppliers, logger } = this.deps;

    // Availability is the sum across suppliers, because either of them can serve
    // an order and the storefront should not hide stock that a fallback holds.
    const totals = new Map<string, number>();
    for (const supplier of suppliers) {
      try {
        for (const item of await supplier.stock()) {
          totals.set(item.sku, (totals.get(item.sku) ?? 0) + item.available);
        }
      } catch (error) {
        // One unreachable supplier must not blank the whole storefront, so the
        // sync is abandoned rather than applied with a partial picture.
        logger.warn({ supplier: supplier.name, err: (error as Error).message }, 'stock sync skipped, supplier unreachable');
        return { updated: 0 };
      }
    }

    let updated = 0;
    await uow.withTransaction(async (tx) => {
      for (const product of await products.listActive(tx)) {
        await products.setStock(tx, product.id, totals.get(product.sku) ?? 0);
        updated += 1;
      }
    });
    return { updated };
  }
}
