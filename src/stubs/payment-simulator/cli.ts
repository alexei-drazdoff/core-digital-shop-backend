/**
 * CLI for reproducing the adversarial payment scenarios by hand.
 *
 * Examples:
 *   npm run simulate -- pay --order ord_X --amount 500
 *   npm run simulate -- race --order ord_X --amount 500 --concurrency 50
 *   npm run simulate -- replay --order ord_X --amount 500 --concurrency 50
 *   npm run simulate -- early --amount 500
 */
import { parseArgs } from 'node:util';
import { PaymentSimulator, buildPayload } from './simulator.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    api: { type: 'string', default: process.env.API_URL ?? 'http://127.0.0.1:3000' },
    order: { type: 'string' },
    amount: { type: 'string', default: '500' },
    currency: { type: 'string', default: 'RUB' },
    concurrency: { type: 'string', default: '50' },
    status: { type: 'string', default: 'paid' },
  },
});

const command = positionals[0] ?? 'pay';
const simulator = new PaymentSimulator({ baseUrl: values.api as string });
const amount = Number.parseInt(values.amount as string, 10);
const concurrency = Number.parseInt(values.concurrency as string, 10);

function summarise(results: ReadonlyArray<{ statusCode: number; body: unknown }>): void {
  const byOutcome = new Map<string, number>();
  for (const result of results) {
    const outcome = `${result.statusCode} ${(result.body as { outcome?: string }).outcome ?? ''}`.trim();
    byOutcome.set(outcome, (byOutcome.get(outcome) ?? 0) + 1);
  }
  console.log(`sent ${results.length} webhook(s):`);
  for (const [outcome, count] of [...byOutcome].sort()) console.log(`  ${count} x ${outcome}`);
}

async function main(): Promise<void> {
  switch (command) {
    case 'pay': {
      if (!values.order) throw new Error('--order is required');
      const result = await simulator.send(
        buildPayload({
          orderId: values.order as string,
          amount,
          currency: values.currency as string,
          status: values.status as 'paid' | 'failed',
        }),
      );
      console.log(result.statusCode, JSON.stringify(result.body));
      break;
    }

    // Criterion 1: many distinct events for one order, all at once.
    case 'race': {
      if (!values.order) throw new Error('--order is required');
      summarise(
        await simulator.race({
          orderId: values.order as string,
          amount,
          currency: values.currency as string,
          concurrency,
          distinctEvents: true,
        }),
      );
      break;
    }

    // Criterion 2: the same event id delivered many times.
    case 'replay': {
      if (!values.order) throw new Error('--order is required');
      summarise(
        await simulator.race({
          orderId: values.order as string,
          amount,
          currency: values.currency as string,
          concurrency,
          distinctEvents: false,
        }),
      );
      break;
    }

    // Criterion 3: a webhook for an order that does not exist yet.
    case 'early': {
      const orderId = (values.order as string | undefined) ?? `ord_EARLY${Date.now()}`;
      const result = await simulator.send(buildPayload({ orderId, amount, currency: values.currency as string }));
      console.log(`order_id used: ${orderId}`);
      console.log(result.statusCode, JSON.stringify(result.body));
      console.log('now create that order with the same order_id and it will be paid automatically');
      break;
    }

    default:
      throw new Error(`unknown command "${command}". Use pay, race, replay or early.`);
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
