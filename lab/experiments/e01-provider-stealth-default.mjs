// E01 — Do the remote providers request stealth by default?
//
// Claim under test (AGENT-BROWSER.md §1, §2.4, §5): BROWSERLESS_STEALTH
// defaults to true, so every Browserless session asks a third-party service to
// suppress automation signals unless the operator opted out. KERNEL_STEALTH
// defaults to false.
//
// Method: point the provider endpoint at a local mock and read the
// session-creation body. No account, no egress, no browser. This is the
// cheapest experiment in the lab and it tests the most consequential claim in
// the document, which is a good argument for running it first.
//
// What would make this a FALSE POSITIVE: if agent-browser sent `stealth: true`
// only because some other lab env var implied it. Guarded by running a second
// arm with BROWSERLESS_STEALTH=false and requiring the flag to follow.

import { startMockProvider, ab, sessionName, check, report } from '../lib.mjs';

const results = [];

// --- Browserless, default (nothing set) ------------------------------------
{
  const mock = await startMockProvider();
  await ab(
    ['--session', sessionName('e01a'), '--provider', 'browserless', 'open', 'http://127.0.0.1:1/'],
    {
      env: {
        BROWSERLESS_API_KEY: 'lab-token',
        BROWSERLESS_API_URL: mock.base,
        // Deliberately NOT setting BROWSERLESS_STEALTH.
      },
      timeoutMs: 45_000,
    },
  );
  await mock.close();

  const session = mock.calls.find((c) => c.url.startsWith('/session'));
  results.push(
    check(
      'Browserless session-creation request was observed',
      Boolean(session),
      session ? `${session.method} ${session.url} body=${session.raw}` : mock.calls,
    ),
  );
  results.push(
    check(
      'BROWSERLESS_STEALTH defaults to true (stealth:true sent with no env var set)',
      session?.body?.stealth === true,
      { stealth: session?.body?.stealth, body: session?.body },
    ),
  );
}

// --- Browserless, explicit opt-out (guards against a false positive) -------
{
  const mock = await startMockProvider();
  await ab(
    ['--session', sessionName('e01b'), '--provider', 'browserless', 'open', 'http://127.0.0.1:1/'],
    {
      env: {
        BROWSERLESS_API_KEY: 'lab-token',
        BROWSERLESS_API_URL: mock.base,
        BROWSERLESS_STEALTH: 'false',
      },
      timeoutMs: 45_000,
    },
  );
  await mock.close();

  const session = mock.calls.find((c) => c.url.startsWith('/session'));
  results.push(
    check(
      'the flag is genuinely wired: BROWSERLESS_STEALTH=false sends stealth:false',
      session?.body?.stealth === false,
      { stealth: session?.body?.stealth },
    ),
  );
}

// --- Kernel, default -------------------------------------------------------
{
  const mock = await startMockProvider();
  await ab(
    ['--session', sessionName('e01c'), '--provider', 'kernel', 'open', 'http://127.0.0.1:1/'],
    {
      env: {
        KERNEL_API_KEY: 'lab-token',
        KERNEL_ENDPOINT: mock.base,
      },
      timeoutMs: 45_000,
    },
  );
  await mock.close();

  const session = mock.calls.find((c) => c.url.includes('browsers'));
  results.push(
    check(
      'KERNEL_STEALTH defaults to false',
      session?.body?.stealth === false,
      { stealth: session?.body?.stealth, body: session?.body },
    ),
  );
  results.push(
    check(
      'KERNEL_HEADLESS defaults to true (selects the profile carrying Kernel stealth flags)',
      session?.body?.headless === true,
      { headless: session?.body?.headless },
    ),
  );
}

process.exit(report('E01 — provider stealth defaults', results) ? 0 : 1);
