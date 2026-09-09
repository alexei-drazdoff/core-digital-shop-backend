/**
 * Test entry point.
 *
 * Sweeps scratch databases left by earlier runs, then hands the files to the
 * built in Node test runner. Cleanup happens here rather than in each file's
 * teardown because dropping a database the test process was just connected to
 * races with the pool shutting down.
 */
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { dropStaleScratchDatabases } from '../tests/helpers/harness.js';

const { values } = parseArgs({
  allowPositionals: true,
  options: { only: { type: 'string' } },
});

const suites: Record<string, string[]> = {
  unit: ['tests/unit/*.test.ts'],
  adversarial: ['tests/adversarial/*.test.ts'],
};

const selected = values.only ? [values.only] : Object.keys(suites);
const patterns = selected.flatMap((name) => {
  const suite = suites[name];
  if (!suite) throw new Error(`unknown suite "${name}". Known suites: ${Object.keys(suites).join(', ')}`);
  return suite;
});

const rootUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!rootUrl) {
  console.error('TEST_DATABASE_URL or DATABASE_URL must be set. Try: scripts/pg-dev.sh start');
  process.exit(1);
}

const dropped = await dropStaleScratchDatabases(rootUrl);
if (dropped > 0) console.log(`removed ${dropped} scratch database(s) from a previous run`);

// Bounded file concurrency.
//
// Every file creates its own database, its own application pool and a pool for
// the two supplier stubs, and they all land on one server whose max_connections
// is typically 100. Unbounded, the runner starts every file at once and two
// things go wrong: CREATE DATABASE serialises, so the last file waits out all
// the others, and the pools together ask for more connections than exist. A
// starved pool is the nastier of the two, because it makes the stubs answer
// slowly and the delivery path correctly reads that as a timeout, quietly
// turning a test about a clean refusal into a test about the timeout path.
//
// Three files times roughly 24 connections leaves comfortable headroom.
const concurrency = process.env.TEST_CONCURRENCY ?? '3';

const child = spawn(process.execPath, ['--import', 'tsx', '--test', `--test-concurrency=${concurrency}`, ...patterns], {
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code) => process.exit(code ?? 1));
