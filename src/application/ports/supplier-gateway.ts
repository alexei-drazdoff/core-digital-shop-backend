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
  | {
      readonly kind: 'issued';
      readonly code: string;
      /**
       * What the supplier claims to be answering about.
       *
       * Carried through rather than assumed, because at this stage the supplier
       * may be answering about something else entirely, and the caller is the
       * only party in a position to notice. `sku` is null when the supplier did
       * not say — silence is not a contradiction.
       */
      readonly requestId: string;
      readonly sku: string | null;
      readonly latencyMs: number;
    }
  /** The supplier answered and said no. Nothing was issued, so failing over is safe. */
  | { readonly kind: 'refused'; readonly reason: string; readonly latencyMs: number }
  /** Timeout, connection error, or an open circuit. The supplier MAY have issued. */
  | {
      readonly kind: 'indeterminate';
      readonly reason: 'timeout' | 'transport_error' | 'circuit_open';
      readonly detail: string;
      readonly latencyMs: number;
    };

export interface SupplierIssueRequest {
  readonly requestId: string;
  readonly orderId: string;
  /** The line being fetched. One code, one line, one request id. */
  readonly orderItemId: string;
  readonly sku: string;
}

export interface SupplierGateway {
  readonly name: string;
  /** Calls POST /issue once. Retry policy belongs to the caller, not here. */
  issue(input: SupplierIssueRequest): Promise<SupplierResult>;
  /** Current per SKU availability, used by the stock sync job. */
  stock(): Promise<ReadonlyArray<{ sku: string; available: number }>>;
}
