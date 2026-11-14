// main.ts — entrypoint: spawn the prebuilt Go forge binary beside this file
// and wait for it. The binary implements the harness lifecycle itself
// (bind an ephemeral port, POST $MAKEFUN_ENV_URL/register {"port": N}, poll
// GET $MAKEFUN_ENV_URL/done until {"done": true}, then exit 0; standalone:
// bind PORT or an ephemeral port, write server.toml, serve until killed).
// The Go server is a from-scratch rewrite of the Node forge (see README.md);
// `forge` is a statically linked Linux amd64 binary built from the .go
// sources in this directory, vendored as the rules allow.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const bin = join(dir, 'forge');

const child = spawn(bin, [], { stdio: 'inherit' });

let shuttingDown = false;
const forward = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    child.kill(signal);
  } catch {
    // Already gone.
  }
};
process.on('SIGTERM', () => forward('SIGTERM'));
process.on('SIGINT', () => forward('SIGINT'));

child.on('error', (err: Error) => {
  process.stderr.write(`[entry] cannot start forge binary: ${err.message}\n`);
  process.exit(1);
});
child.on('exit', (code: number | null, signal: string | null) => {
  process.exit(signal ? 1 : (code ?? 1));
});
