/** Counters the delivery path emits. Kept as a port so tests need no metrics registry. */
export interface DeliveryMetrics {
  recordSupplierCall(supplier: string, outcome: 'issued' | 'refused' | 'indeterminate', latencyMs: number): void;
  recordRetry(supplier: string): void;
  recordDelivery(supplier: string): void;
  recordOrphan(supplier: string): void;
}

export const noopDeliveryMetrics: DeliveryMetrics = {
  recordSupplierCall: () => {},
  recordRetry: () => {},
  recordDelivery: () => {},
  recordOrphan: () => {},
};
