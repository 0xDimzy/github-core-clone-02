// main.ts — entrypoint: bind an ephemeral port, register with the harness,
// then serve until the harness signals done.
import { createApp } from './app.ts';
import { writeFileSync } from 'node:fs';

const PORT = process.env.PORT !== undefined ? parseInt(process.env.PORT, 10) : 0;

async function main(): Promise<void> {
  const server = createApp();
  server.on('error', (err) => {
    process.stderr.write(`[forge] server error: ${err.message}\n`);
  });
  await new Promise<void>((resolve) => { server.listen(PORT, '127.0.0.1', () => resolve()); });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  if (port === 0) throw new Error('no port assigned');
  writeFileSync('server.toml', `port = ${port}\n`, 'utf8');
  if (process.env.MAKEFUN_DONE_URL) {
    const res = await fetch(process.env.MAKEFUN_DONE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port, url: `http://127.0.0.1:${port}` }),
    });
    if (!res.ok) throw new Error(`registration failed: ${res.status}`);
    await res.text();
  } else {
    process.stdout.write(`forge listening on http://127.0.0.1:${port}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`[forge] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
