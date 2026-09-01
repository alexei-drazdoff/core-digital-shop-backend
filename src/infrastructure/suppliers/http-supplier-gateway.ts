/**
 * HTTP client for one supplier stub.
 *
 * Its single responsibility is to turn one call into one of three honest
 * outcomes. It never retries, because the retry decision depends on the request
 * id semantics that belong to the delivery use case, not to transport.
 */
import { request } from 'undici';
import type { SupplierGateway, SupplierResult } from '../../application/ports/supplier-gateway.js';
import type { Logger } from '../observability/logger.js';
import type { CircuitBreaker } from './circuit-breaker.js';

export interface HttpSupplierGatewayOptions {
  readonly name: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly breaker: CircuitBreaker;
  readonly logger: Logger;
}

interface IssueResponseBody {
  status?: string;
  code?: string;
  reason?: string;
}

export class HttpSupplierGateway implements SupplierGateway {
  readonly name: string;

  constructor(private readonly options: HttpSupplierGatewayOptions) {
    this.name = options.name;
  }

  async issue(input: { requestId: string; orderId: string; sku: string }): Promise<SupplierResult> {
    const { baseUrl, timeoutMs, breaker, logger } = this.options;

    if (!breaker.allowsRequest()) {
      // Not a refusal. The breaker knows the supplier is unreachable right now,
      // not whether an earlier call already issued a code for this request id.
      return { kind: 'indeterminate', reason: 'circuit_open', detail: `circuit open for ${this.name}`, latencyMs: 0 };
    }

    const startedAt = Date.now();
    try {
      const response = await request(`${baseUrl}/issue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request_id: input.requestId, sku: input.sku, order_id: input.orderId }),
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });
      const latencyMs = Date.now() - startedAt;
      const body = (await response.body.json().catch(() => ({}))) as IssueResponseBody;

      if (response.statusCode === 200 && typeof body.code === 'string' && body.code.length > 0) {
        breaker.recordSuccess();
        return { kind: 'issued', code: body.code, latencyMs };
      }

      // 4xx is the supplier answering. It looked, and it is not giving us a code.
      // Nothing was issued, so failing over to the other supplier is safe.
      if (response.statusCode >= 400 && response.statusCode < 500) {
        breaker.recordSuccess();
        return { kind: 'refused', reason: body.reason ?? `http_${response.statusCode}`, latencyMs };
      }

      // 5xx is ambiguous in principle, but a served 5xx means the request reached
      // the application and was rejected by it, so it is treated as a refusal.
      // A 504 is the exception: it is a timeout wearing a status code.
      breaker.recordFailure();
      if (response.statusCode === 504) {
        return {
          kind: 'indeterminate',
          reason: 'timeout',
          detail: `gateway timeout from ${this.name}`,
          latencyMs,
        };
      }
      return { kind: 'refused', reason: body.reason ?? `http_${response.statusCode}`, latencyMs };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      breaker.recordFailure();
      const detail = error instanceof Error ? error.message : String(error);
      const timedOut = /timeout|aborted|UND_ERR_(HEADERS|BODY)_TIMEOUT/i.test(detail);

      // The important branch. No response arrived, so the supplier may well have
      // issued a code. Reporting this as a refusal would be the bug the whole
      // design exists to avoid.
      logger.warn(
        { supplier: this.name, request_id: input.requestId, order_id: input.orderId, latency_ms: latencyMs, detail },
        'supplier call did not complete, outcome is indeterminate',
      );
      return {
        kind: 'indeterminate',
        reason: timedOut ? 'timeout' : 'transport_error',
        detail,
        latencyMs,
      };
    }
  }

  async stock(): Promise<ReadonlyArray<{ sku: string; available: number }>> {
    const response = await request(`${this.options.baseUrl}/stock`, {
      method: 'GET',
      headersTimeout: this.options.timeoutMs,
      bodyTimeout: this.options.timeoutMs,
    });
    const body = (await response.body.json()) as { items?: Array<{ sku: string; available: number }> };
    return body.items ?? [];
  }
}
