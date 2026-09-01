/** The two supplier stubs. A is primary, B is the fallback. */
export const SUPPLIER_A = 'supplier_a';
export const SUPPLIER_B = 'supplier_b';
export const SUPPLIERS = [SUPPLIER_A, SUPPLIER_B] as const;
export type SupplierName = (typeof SUPPLIERS)[number];

/**
 * Seeded with no stock at either supplier so the "empty stock, recoverable
 * state, no crash" acceptance scenario is reproducible without editing data first.
 */
export const INTENTIONALLY_EMPTY_SKU = 'SUB-SPOTIFY-1M';
