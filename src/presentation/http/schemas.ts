import { z } from 'zod';

/** Matches the webhook contract from the assignment exactly. */
export const paymentWebhookBody = z.object({
  event_id: z.string().min(1).max(200),
  order_id: z.string().min(1).max(200),
  status: z.enum(['paid', 'failed']),
  amount: z.number().int().nonnegative(),
  currency: z.string().length(3),
  created_at: z.string().datetime({ offset: true }),
});

const orderLine = z.object({
  sku: z.string().min(1).max(64),
  /**
   * Capped rather than unbounded: each unit becomes its own line with its own
   * supplier conversation, so a quantity is a multiplier on real work.
   */
  qty: z.number().int().min(1).max(20).default(1),
});

/**
 * A basket, or a single SKU.
 *
 * Both shapes are accepted on purpose. The single-SKU form is the first stage's
 * contract and every client written against it keeps working; `items` is the
 * multi-product form this stage adds. They are mutually exclusive because a
 * request that says both has no obvious meaning, and guessing one would be worse
 * than refusing.
 */
export const createOrderBody = z
  .object({
    sku: z.string().min(1).max(64).optional(),
    items: z.array(orderLine).min(1).max(50).optional(),
    customer_ref: z.string().max(200).optional(),
    /**
     * Optional client supplied id, constrained to the same shape the service
     * generates. Accepting it is what makes the "webhook before the order" case
     * reproducible, so it is validated rather than trusted.
     */
    order_id: z
      .string()
      .regex(/^ord_[A-Za-z0-9_-]{1,64}$/, 'order_id must look like ord_<identifier>')
      .optional(),
  })
  .refine((body) => Boolean(body.sku) !== Boolean(body.items), {
    message: 'provide exactly one of "sku" or "items"',
    path: ['items'],
  });

/** Normalises either accepted shape into the one the use case speaks. */
export function orderLinesFrom(body: z.infer<typeof createOrderBody>): Array<{ sku: string; qty: number }> {
  if (body.items) return body.items.map((line) => ({ sku: line.sku, qty: line.qty }));
  return [{ sku: body.sku as string, qty: 1 }];
}

export const storefrontQuery = z.object({
  type: z.enum(['topup', 'key', 'subscription', 'giftcard']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
  in_stock: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /** Opaque keyset cursor of the form "<sortRank>.<id>". */
  cursor: z
    .string()
    .regex(/^-?\d+\.\d+$/)
    .optional(),
});

export const replenishBody = z.object({
  sku: z.string().min(1),
  supplier: z.string().min(1).optional(),
  count: z.number().int().min(1).max(10_000).default(10),
});

export function encodeCursor(sortRank: number, id: number): string {
  return `${sortRank}.${id}`;
}

export function decodeCursor(cursor: string | undefined): { sortRank: number; id: number } | undefined {
  if (!cursor) return undefined;
  const [rank, id] = cursor.split('.');
  if (rank === undefined || id === undefined) return undefined;
  return { sortRank: Number.parseInt(rank, 10), id: Number.parseInt(id, 10) };
}
