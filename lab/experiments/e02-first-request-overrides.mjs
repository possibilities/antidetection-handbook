// E02 — Do identity overrides reach the FIRST request of a navigation?
//
// Claims under test (AGENT-BROWSER.md §3.4):
//   (a) `tab_new` issues Target.createTarget with the caller's URL and only
//       then attaches, so a new tab's first request escapes every override.
//   (b) more generally, the handbook's "configure before first navigation"
//       principle is violated by ordering rather than by omission.
//
// Method: an observing origin records the exact User-Agent on every document
// request. Launch with a distinctive --user-agent, then compare what arrived on
// the initial `open` navigation versus the `tab_new` navigation.
//
// FALSE-POSITIVE guard: if --user-agent simply does not work at all, both
// requests would lack it and (a) would look confirmed for the wrong reason. So
// the experiment asserts the override IS observable somewhere before drawing
// any conclusion about ordering.

import { startOrigin, ab, withSession, check, report } from '../lib.mjs';

const LAB_UA = 'LAB-E02-UA/1.0 (agent-browser lab probe)';
const results = [];

const origin = await startOrigin();

await withSession('e02', async (session) => {
  const open = await ab(
    ['--session', session, '--user-agent', LAB_UA, 'open', `${origin.base}/first.html`],
    { timeoutMs: 90_000 },
  );
  results.push(
    check('session launched with --user-agent', open.code === 0, {
      code: open.code,
      stderr: open.stderr.slice(0, 200),
    }),
  );

  // What the page believes, after the session is fully configured.
  const evald = await ab(
    ['--session', session, 'eval', 'navigator.userAgent'],
    { timeoutMs: 60_000 },
  );
  const uaInPage = String(evald.stdout || '');

  results.push(
    check(
      'the override is real: navigator.userAgent reflects --user-agent once attached',
      uaInPage.includes('LAB-E02-UA'),
      uaInPage.trim().slice(0, 200),
    ),
  );

  // Now the ordering question.
  await ab(['--session', session, 'tab', 'new', `${origin.base}/tabnew.html`], {
    timeoutMs: 60_000,
  });
});

await origin.close();

const docs = origin.documents();
const first = docs.find((r) => r.url.startsWith('/first.html'));
const tabnew = docs.find((r) => r.url.startsWith('/tabnew.html'));

results.push(
  check('initial open navigation reached the origin', Boolean(first), first?.url),
);
results.push(
  check('tab new navigation reached the origin', Boolean(tabnew), tabnew?.url),
);

results.push(
  check(
    'initial `open` navigation carries the UA override on its first request',
    Boolean(first && first.headers['user-agent']?.includes('LAB-E02-UA')),
    first?.headers['user-agent'],
  ),
);

results.push(
  check(
    '`tab new` first request carries the UA override (document claims it does NOT)',
    Boolean(tabnew && tabnew.headers['user-agent']?.includes('LAB-E02-UA')),
    tabnew?.headers['user-agent'],
  ),
);

// Sec-CH-UA travels with the UA only if userAgentMetadata was supplied.
results.push(
  check(
    'UA-CH accompanies the override (document claims it does NOT — §3.4)',
    Boolean(first && /LAB-E02/.test(first.headers['sec-ch-ua'] ?? '')),
    { 'sec-ch-ua': first?.headers['sec-ch-ua'], 'user-agent': first?.headers['user-agent'] },
  ),
);

console.log(
  '\nAll document requests observed:\n' +
    docs
      .map((d) => `  ${d.url}  ua=${JSON.stringify(d.headers['user-agent'])}`)
      .join('\n'),
);

// This experiment records observations; several claims are expected to be
// REFUTED-as-predicted. The runner interprets, so always exit 0 here.
report('E02 — identity overrides on the first request', results);
