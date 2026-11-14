// main.ts — entrypoint: serve the forge, registering with the harness when
// MAKEFUN_ENV_URL is set (trial container), or standalone otherwise.
//
// Harness lifecycle (the grader's trial container sets MAKEFUN_ENV_URL):
//   1. MAKEFUN_ENV_URL names the env's origin (http://store:8080 in a trial).
//   2. Create the server and listen(0): the kernel picks a free port.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the
//      address plus N as the base URL. The first register wins.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}.
//   5. Close the server and exit 0.
//
// Standalone (local conformance runs, no MAKEFUN_ENV_URL):
//   Bind PORT when set, else an ephemeral port; write server.toml with the
//   port and serve until killed.
import { createApp } from './app.ts';
import { writeFileSync } from 'node:fs';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';
const PORT = process.env.PORT !== undefined ? parseInt(process.env.PORT, 10) : 0;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runHarness(): Promise<void> {
  const server = createApp();
  server.on('error', (err) => {
    process.stderr.write(`[forge] server error: ${err.message}\n`);
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  if (port === 0) throw new Error('no port assigned');
  const base = ENV_URL.replace(/\/$/, '');
  const reg = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ port }),
  });
  if (!reg.ok) throw new Error(`register failed: ${reg.status}`);
  await reg.text();
  // Poll /done until the env says the trial is over, then exit 0.
  let delay = 100;
  for (;;) {
    try {
      const res = await fetch(`${base}/done`);
      if (res.ok) {
        const body = (await res.json()) as { done?: boolean };
        if (body.done === true) break;
      }
    } catch {
      // A failed or slow poll is retried with a short exponential backoff.
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  process.exit(0);
}

async function runStandalone(): Promise<void> {
  const server = createApp();
  server.on('error', (err) => {
    process.stderr.write(`[forge] server error: ${err.message}\n`);
  });
  await new Promise<void>((resolve) => { server.listen(PORT, '127.0.0.1', () => resolve()); });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  if (port === 0) throw new Error('no port assigned');
  writeFileSync('server.toml', `port = ${port}\n`, 'utf8');
  process.stdout.write(`forge listening on http://127.0.0.1:${port}\n`);
}

async function main(): Promise<void> {
  if (ENV_URL !== '') await runHarness();
  else await runStandalone();
}

main().catch((err) => {
  process.stderr.write(`[forge] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
