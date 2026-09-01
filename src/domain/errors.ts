/** Errors the HTTP layer knows how to turn into a status code without guessing. */
export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ProductNotFoundError extends DomainError {
  constructor(sku: string) {
    super(`unknown sku ${sku}`, 'product_not_found', 404);
  }
}

export class ProductInactiveError extends DomainError {
  constructor(sku: string) {
    super(`sku ${sku} is not on sale`, 'product_inactive', 409);
  }
}

export class OrderNotFoundError extends DomainError {
  constructor(orderId: string) {
    super(`unknown order ${orderId}`, 'order_not_found', 404);
  }
}

/** Same Idempotency-Key replayed with a different body: the two cannot both be honoured. */
export class IdempotencyConflictError extends DomainError {
  constructor(key: string) {
    super(`idempotency key ${key} was already used with a different request body`, 'idempotency_conflict', 409);
  }
}
