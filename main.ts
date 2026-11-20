// Entrypoint: boot the forge, announce it to the contest environment, and
// stay alive until the environment says the trial is over.
//
// The environment (its base URL is in MAKEFUN_ENV_URL) expects this exact
// lifecycle: bind an ephemeral port, POST the port to /register so the
// suite knows where to dial, then poll /done and exit 0 once it answers
// {"done": true}. Everything the forge serves lives in app.ts; this file
// is only the lifecycle around it.

import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';

/** How long to wait between two polls of the environment's /done endpoint. */
const DONE_POLL_MS = 500;

/** Pause for the given number of milliseconds. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Tell the environment which port the forge is on. The first registration
 * wins and a repeat is answered 409, so any HTTP response at all — success
 * or conflict — means the suite has our address; only a request that never
 * arrived is worth retrying.
 */
async function registerWithEnv(envBase: string, port: number): Promise<void> {
  const target = `${envBase}/register`;
  const payload = JSON.stringify({ port });
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      });
      return;
    } catch {
      if (attempt === 20) throw new Error(`could not register with the environment at ${target}`);
      await pause(250);
    }
  }
}

/**
 * Poll the environment until it reports the trial is done. It answers at
 * once, so this is a plain poll on a timer — never a held-open request.
 * A failed poll (the environment may still be coming up) just retries.
 */
async function awaitDone(envBase: string): Promise<void> {
  const target = `${envBase}/done`;
  for (;;) {
    try {
      const response = await fetch(target);
      const body = (await response.json()) as { done?: unknown };
      if (body.done === true) return;
    } catch {
      // Not reachable or not JSON yet; keep waiting.
    }
    await pause(DONE_POLL_MS);
  }
}

const envBase = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

const server = createApp();

// A stop signal (a local Ctrl-C, or the pod winding the trial down) closes
// the listener and ends the process cleanly instead of dropping in-flight
// requests on the floor.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    console.log(`received ${signal}; shutting down`);
    server.close();
    process.exit(0);
  });
}

await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve());
});

const bound = server.address() as AddressInfo | null;
if (bound === null) throw new Error('the forge server did not bind a port');
console.log(`github-core-clone-01 forge listening on 127.0.0.1:${bound.port}`);

if (envBase === '') {
  // A local run outside a trial: there is nobody to register with or poll,
  // so just serve until the process is stopped.
  console.log('MAKEFUN_ENV_URL is unset; serving until stopped');
} else {
  await registerWithEnv(envBase, bound.port);
  console.log('registered with the environment; serving until it reports done');
  await awaitDone(envBase);
  console.log('the environment reports done; exiting');
  server.close();
  process.exit(0);
}
