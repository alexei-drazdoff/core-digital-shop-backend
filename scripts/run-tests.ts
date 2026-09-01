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

const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...patterns], {
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code) => process.exit(code ?? 1));
