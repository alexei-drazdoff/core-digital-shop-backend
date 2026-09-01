/**
 * The supplier port.
 *
 * The three outcomes are deliberately not two. Collapsing `indeterminate` into
 * `refused` is precisely the mistake the assignment is built around: a timeout
 * is not a refusal, because the supplier may have issued a code that never
 * reached us. Keeping it as its own case forces every caller to decide what to
 * do about an unknown rather than assuming the worst.
 */
export type SupplierResult =
  | { readonly kind: 'issued'; readonly code: string; readonly latencyMs: number }
  /** The supplier answered and said no. Nothing was issued, so failing over is safe. */
  | { readonly kind: 'refused'; readonly reason: string; readonly latencyMs: number }
  /** Timeout, connection error, or an open circuit. The supplier MAY have issued. */
  | {
      readonly kind: 'indeterminate';
      readonly reason: 'timeout' | 'transport_error' | 'circuit_open';
      readonly detail: string;
      readonly latencyMs: number;
    };

export interface SupplierGateway {
  readonly name: string;
  /** Calls POST /issue once. Retry policy belongs to the caller, not here. */
  issue(input: { requestId: string; orderId: string; sku: string }): Promise<SupplierResult>;
  /** Current per SKU availability, used by the stock sync job. */
  stock(): Promise<ReadonlyArray<{ sku: string; available: number }>>;
}
