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

export const createOrderBody = z.object({
  sku: z.string().min(1).max(64),
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
});

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
