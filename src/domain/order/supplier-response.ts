/**
 * Deciding whether a supplier's answer can be believed.
 *
 * The first stage's supplier was unreliable but honest: it could fail to answer,
 * and the whole design is built around not mistaking a lost answer for a refusal.
 * The second stage's supplier lies. It hands back a code it already gave someone
 * else, or a code for a different product, and both of those arrive looking
 * exactly like success — status 200, a plausible string, no error anywhere.
 *
 * So an answer has to be checked before it is believed, and the checks are here,
 * pure, because "would this response be accepted" is a question worth being able
 * to ask without a supplier, a database or a delivery in flight.
 *
 * What is deliberately NOT here: whether the code is already in the registry.
 * That is a fact about the world, not about the response, and it can only be
 * settled by the database in the same transaction that claims it. Checking it
 * here as well would be a check that can go stale between asking and acting.
 *
 * A rejection is also the ONE case that earns a new request epoch. Everything
 * the first stage retried was a MISSING answer, and re-asking the same request
 * id was right because the question had never been answered. A rejected answer
 * is the opposite: the supplier has an answer for that id and it is wrong, so
 * re-asking returns the same wrong thing forever. Advancing the epoch is
 * confined to this case precisely so the timeout trap keeps working, where
 * advancing it would buy a second code.
 */

export type ResponseRejection =
  /** The supplier answered about a different request than the one we made. */
  | 'request_id_mismatch'
  /** The code is for a different product: somebody else's goods. */
  | 'sku_mismatch'
  /** Not a code at all. */
  | 'malformed_code';

export interface SupplierIssueResponse {
  readonly requestId: string;
  readonly sku: string | null;
  readonly code: string;
}

export interface ExpectedIssue {
  readonly requestId: string;
  readonly sku: string;
}

/**
 * Returns the reason to refuse the response, or null to accept it.
 *
 * `sku` is optional in the response because a supplier is not obliged to echo
 * it, and refusing every answer that omits it would break a contract we do not
 * control. When it IS present and disagrees, that is a positive statement that
 * the code is for something else, and it is refused.
 */
export function rejectSupplierResponse(
  response: SupplierIssueResponse,
  expected: ExpectedIssue,
): ResponseRejection | null {
  if (response.requestId !== expected.requestId) return 'request_id_mismatch';
  if (response.sku !== null && response.sku !== expected.sku) return 'sku_mismatch';
  if (response.code.trim().length === 0) return 'malformed_code';
  return null;
}
