// github-core-clone-01 entrypoint: the forge's whole life in one small file.
//
// The forge itself lives in app.ts. This file only runs the handshake with the
// trial environment, in three phases:
//
//   1. Find the environment. Its base URL comes from MAKEFUN_ENV_URL. With no
//      URL there is nobody to talk to, so bail out right away.
//   2. Bring the forge up on a kernel-chosen port and tell the environment
//      about it. Port 0 means "pick any free one"; the environment's own port
//      (8080 in a trial container) is never ours to bind.
//   3. Sit tight until the environment reports the trial is finished, then
//      shut the forge down and leave cleanly.
//
// Nothing here talks to the outside world except the two environment calls
// above (register, then done). Both are retried patiently: the environment
// may still be waking up when we first knock, and a failed knock is not a
// reason to give up. The only answers that end the program early are a
// missing environment URL and a register reply that says our request itself
// was wrong.

import { createApp } from './app.ts';

// One environment call gets this long before we abandon it and try again.
const CALL_BUDGET_MS = 30_000;
// Pauses between retries start here and double each time, up to the cap.
const FIRST_PAUSE_MS = 250;
const LONGEST_PAUSE_MS = 2_000;

// Replies that mean "registered, carry on".
const REGISTER_OK = new Set([200, 409]);
// Replies that mean "our request was malformed": retrying cannot help.
const REGISTER_FATAL = new Set([400, 405]);

function pause(milliseconds: number): Promise<void> {
  return new Promise((done) => setTimeout(done, milliseconds));
}

// How long to wait before the next attempt after `failures` failed ones.
// Doubling from FIRST_PAUSE_MS, capped: 250, 500, 1000, 2000, 2000, ...
function pauseAfter(failures: number): number {
  let wait = FIRST_PAUSE_MS;
  for (let step = 0; step < failures && wait < LONGEST_PAUSE_MS; step += 1) {
    wait = Math.min(LONGEST_PAUSE_MS, wait * 2);
  }
  return wait;
}

// The environment's origin, with any trailing slashes trimmed off so the
// paths we append later join cleanly. Exits the process when it is absent.
function envOrigin(): string {
  const raw = process.env.MAKEFUN_ENV_URL ?? '';
  const origin = raw.replace(/\/+$/, '');
  if (origin.length === 0) {
    process.stderr.write('[forge] MAKEFUN_ENV_URL is not set, so there is no environment to join\n');
    process.exit(1);
  }
  return origin;
}

// Raised only when the environment rejects our register request outright.
class BadRegisterError extends Error {
  constructor(status: number, detail: string) {
    super(`environment refused registration with HTTP ${status}: ${detail}`);
    this.name = 'BadRegisterError';
  }
}

// Tell the environment which port the forge bound. A 200 means it recorded
// us; a 409 means some earlier registration already won and we simply wait
// alongside it. Anything else fatal (400/405) throws; every other failure
// — a dropped connection, a timeout, an unexpected status — is retried
// forever, because the environment may just not be ready yet.
async function announcePort(origin: string, port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    let response: Response | undefined;
    try {
      response = await fetch(`${origin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_BUDGET_MS),
      });
    } catch (cause) {
      // No answer at all: wait a beat and knock again.
      await pause(pauseAfter(failures));
      failures += 1;
      continue;
    }
    if (REGISTER_OK.has(response.status)) return;
    if (REGISTER_FATAL.has(response.status)) {
      throw new BadRegisterError(response.status, await response.text());
    }
    await pause(pauseAfter(failures));
    failures += 1;
  }
}

// Ask the environment, over and over, whether the trial is over. A "no"
// (or any hiccup: timeout, bad JSON, a non-200) just means "not yet", so we
// pause and ask again. This function only returns once the answer is yes.
async function awaitTrialEnd(origin: string): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const response = await fetch(`${origin}/done`, {
        signal: AbortSignal.timeout(CALL_BUDGET_MS),
      });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
        failures = 0;
      } else {
        failures += 1;
      }
    } catch {
      failures += 1;
    }
    await pause(pauseAfter(failures));
  }
}

// Start the forge, register it, wait for the trial to finish, shut it down.
async function run(): Promise<void> {
  const origin = envOrigin();
  const forge = createApp();
  const boundPort = await new Promise<number>((resolve, reject) => {
    forge.once('error', reject);
    forge.listen(0, () => {
      const bound = forge.address();
      if (bound === null || typeof bound === 'string') {
        reject(new Error('forge did not bind a TCP port'));
        return;
      }
      resolve(bound.port);
    });
  });
  process.stdout.write(`[forge] listening on port ${boundPort}\n`);

  await announcePort(origin, boundPort);
  process.stdout.write('[forge] registered with the environment; waiting for the trial to end\n');

  await awaitTrialEnd(origin);
  forge.close();
  process.stdout.write('[forge] trial done, forge stopped\n');
}

run().then(
  () => process.exit(0),
  (cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`[forge] ${message}\n`);
    process.exit(1);
  },
);
