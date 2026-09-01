/**
 * Runs the whole system in one terminal: two supplier stubs, the API and the worker.
 *
 * Child processes are tracked by handle rather than by matching on command
 * lines, so shutting down cannot take anything else with it.
 */
import { spawn, type ChildProcess } from 'node:child_process';

interface Service {
  readonly name: string;
  readonly script: string;
  readonly env: NodeJS.ProcessEnv;
}

const services: Service[] = [
  { name: 'supplier-a', script: 'src/stubs/supplier/main.ts', env: { SUPPLIER_NAME: 'supplier_a', SUPPLIER_PORT: '4001' } },
  { name: 'supplier-b', script: 'src/stubs/supplier/main.ts', env: { SUPPLIER_NAME: 'supplier_b', SUPPLIER_PORT: '4002' } },
  { name: 'api', script: 'src/composition/main-api.ts', env: {} },
  { name: 'worker', script: 'src/composition/main-worker.ts', env: {} },
];

const children: ChildProcess[] = [];
let shuttingDown = false;

for (const service of services) {
  const child = spawn(process.execPath, ['--import', 'tsx', service.script], {
    env: { ...process.env, ...service.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);

  const prefix = service.name.padEnd(10);
  child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`[${prefix}] ${chunk}`));
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[${prefix}] ${chunk}`));
  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.error(`[${prefix}] exited with code ${code}, stopping everything`);
    shutdown(1);
  });
}

function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 1000).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('starting supplier-a:4001, supplier-b:4002, api:3000, worker');
