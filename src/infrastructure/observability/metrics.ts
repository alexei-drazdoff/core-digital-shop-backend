/**
 * Prometheus metrics.
 *
 * Chosen to answer the questions an operator actually asks during an incident:
 * is a supplier failing, is it failing slowly or quickly, are we retrying, and
 * are we losing stock to orphaned issuances.
 */
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { DeliveryMetrics } from '../../application/ports/metrics.js';

export interface AppMetrics extends DeliveryMetrics {
  readonly registry: Registry;
  recordPaymentEvent(outcome: string): void;
  recordJob(kind: string, outcome: 'succeeded' | 'failed'): void;
  render(): Promise<string>;
}

export function createMetrics(): AppMetrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const supplierCalls = new Counter({
    name: 'supplier_calls_total',
    help: 'Supplier issue calls by outcome',
    labelNames: ['supplier', 'outcome'] as const,
    registers: [registry],
  });

  const supplierLatency = new Histogram({
    name: 'supplier_call_duration_seconds',
    help: 'Supplier issue call latency',
    labelNames: ['supplier', 'outcome'] as const,
    // Bucketed around the configured timeout so a shift from fast failures to
    // slow ones is visible, which is the difference between a refusal and a trap.
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers: [registry],
  });

  const supplierRetries = new Counter({
    name: 'supplier_retries_total',
    help: 'Retries issued against a supplier with the same request id',
    labelNames: ['supplier'] as const,
    registers: [registry],
  });

  const deliveries = new Counter({
    name: 'deliveries_total',
    help: 'Orders delivered exactly once',
    labelNames: ['supplier'] as const,
    registers: [registry],
  });

  const orphans = new Counter({
    name: 'orphan_issuances_total',
    help: 'Codes issued by a supplier that could not be sold, written off as shrinkage',
    labelNames: ['supplier'] as const,
    registers: [registry],
  });

  // The signal that a supplier is not merely unreliable but dishonest. A rising
  // rate here is qualitatively different from a rising failure rate: retries
  // cannot fix it, and every one of these was a code somebody tried to sell us
  // twice.
  const rejections = new Counter({
    name: 'supplier_rejected_responses_total',
    help: 'Supplier answers refused as invalid, by reason',
    labelNames: ['supplier', 'reason'] as const,
    registers: [registry],
  });

  const paymentEvents = new Counter({
    name: 'payment_events_total',
    help: 'Payment webhook events by outcome',
    labelNames: ['outcome'] as const,
    registers: [registry],
  });

  const jobs = new Counter({
    name: 'jobs_total',
    help: 'Background jobs by kind and outcome',
    labelNames: ['kind', 'outcome'] as const,
    registers: [registry],
  });

  return {
    registry,
    recordSupplierCall(supplier, outcome, latencyMs) {
      supplierCalls.inc({ supplier, outcome });
      supplierLatency.observe({ supplier, outcome }, latencyMs / 1000);
    },
    recordRetry(supplier) {
      supplierRetries.inc({ supplier });
    },
    recordDelivery(supplier) {
      deliveries.inc({ supplier });
    },
    recordOrphan(supplier) {
      orphans.inc({ supplier });
    },
    recordRejection(supplier, reason) {
      rejections.inc({ supplier, reason });
    },
    recordPaymentEvent(outcome) {
      paymentEvents.inc({ outcome });
    },
    recordJob(kind, outcome) {
      jobs.inc({ kind, outcome });
    },
    render() {
      return registry.metrics();
    },
  };
}
