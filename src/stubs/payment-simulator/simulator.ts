/**
 * Payment provider simulator.
 *
 * Sends webhooks that follow the contract from the assignment. The same code
 * drives the manual reproduction CLI and the automated race tests, so what a
 * reviewer runs by hand is exactly what CI runs.
 */
import { request } from 'undici';

export interface WebhookPayload {
  event_id: string;
  order_id: string;
  status: 'paid' | 'failed';
  amount: number;
  currency: string;
  created_at: string;
}

export interface SendResult {
  readonly statusCode: number;
  readonly body: unknown;
  readonly eventId: string;
}

export interface SimulatorOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
}

export function buildPayload(input: {
  orderId: string;
  amount: number;
  currency?: string;
  status?: 'paid' | 'failed';
  eventId?: string;
  createdAt?: Date;
}): WebhookPayload {
  return {
    event_id: input.eventId ?? `evt_${Math.random().toString(36).slice(2, 10)}`,
    order_id: input.orderId,
    status: input.status ?? 'paid',
    amount: input.amount,
    currency: input.currency ?? 'RUB',
    created_at: (input.createdAt ?? new Date()).toISOString(),
  };
}

export class PaymentSimulator {
  constructor(private readonly options: SimulatorOptions) {}

  async send(payload: WebhookPayload): Promise<SendResult> {
    const response = await request(`${this.options.baseUrl}/webhooks/payment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      headersTimeout: this.options.timeoutMs ?? 10_000,
      bodyTimeout: this.options.timeoutMs ?? 10_000,
    });
    const body = await response.body.json().catch(() => ({}));
    return { statusCode: response.statusCode, body, eventId: payload.event_id };
  }

  /**
   * Fires N webhooks for one order at the same time.
   *
   * `distinctEvents` selects which acceptance criterion is being exercised:
   * true gives N different event ids racing for one order (criterion 1), false
   * replays a single event id N times (criterion 2). Both must end with exactly
   * one delivery, but they stress different layers of the defence.
   */
  async race(input: {
    orderId: string;
    amount: number;
    concurrency: number;
    distinctEvents: boolean;
    currency?: string;
  }): Promise<readonly SendResult[]> {
    const sharedEventId = `evt_${Math.random().toString(36).slice(2, 10)}`;
    const payloads = Array.from({ length: input.concurrency }, (_, index) =>
      buildPayload({
        orderId: input.orderId,
        amount: input.amount,
        currency: input.currency,
        eventId: input.distinctEvents ? `evt_${Math.random().toString(36).slice(2, 10)}_${index}` : sharedEventId,
      }),
    );

    // Promise.all rather than a loop: the point is genuine simultaneity, so the
    // sockets open together instead of being serialised by the client.
    return Promise.all(payloads.map((payload) => this.send(payload)));
  }
}
