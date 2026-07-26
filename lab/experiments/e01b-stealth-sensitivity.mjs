// E01b — sensitivity matrix for BROWSERLESS_STEALTH.
//
// E01 established that an unset variable yields `stealth:true`. That alone does
// not prove the value is a *default* rather than a constant, and it does not
// establish how the parser treats edge values. The source reads:
//
//   env::var("BROWSERLESS_STEALTH").map(|v| v == "1" || eq_ignore_case("true"))
//                                  .unwrap_or(true)
//
// so the prediction is sharp and slightly counter-intuitive: ANY value that is
// not "1"/"true" yields false — including the empty string, which is why the
// unset arm must genuinely unset rather than pass "".
//
// Scope: this proves what agent-browser SENDS. It says nothing about whether
// Browserless honours the field.

import { startMockProvider, ab, sessionName, check, report } from '../lib.mjs';

const cases = [
  { label: '(unset)', unset: true, expect: true },
  { label: '""', value: '', expect: false },
  { label: '"true"', value: 'true', expect: true },
  { label: '"TRUE"', value: 'TRUE', expect: true },
  { label: '"1"', value: '1', expect: true },
  { label: '"false"', value: 'false', expect: false },
  { label: '"0"', value: '0', expect: false },
  { label: '"yes"', value: 'yes', expect: false },
];

const results = [];
const observed = [];

for (const c of cases) {
  const mock = await startMockProvider();
  await ab(
    ['--session', sessionName('e01b'), '--provider', 'browserless', 'open', 'http://127.0.0.1:1/'],
    {
      env: {
        BROWSERLESS_API_KEY: 'lab-nonce',
        BROWSERLESS_API_URL: mock.base,
        NO_PROXY: '127.0.0.1,localhost',
        ...(c.unset ? {} : { BROWSERLESS_STEALTH: c.value }),
      },
      unsetEnv: c.unset ? ['BROWSERLESS_STEALTH'] : [],
      timeoutMs: 45_000,
    },
  );
  await mock.close();

  const call = mock.calls.find((x) => x.url.startsWith('/session'));
  const got = call?.body?.stealth;
  observed.push({ input: c.label, sent: got, calls: mock.calls.length });
  results.push(
    check(
      `BROWSERLESS_STEALTH=${c.label} -> stealth:${c.expect}`,
      got === c.expect,
      { sent: got, expected: c.expect, body: call?.body },
    ),
  );
}

console.log('\n  input          -> stealth sent');
for (const o of observed) {
  console.log(`  ${String(o.input).padEnd(14)} -> ${o.sent}`);
}
console.log(
  '\n  Reading: only "1"/"true" (case-insensitive) enable it explicitly, yet an\n' +
    '  UNSET variable also yields true. So the safe-looking values — empty, "0",\n' +
    '  "false", anything unrecognised — all disable it, and the only way to get\n' +
    '  stealth without asking is to not configure it at all.',
);

process.exit(report('E01b — BROWSERLESS_STEALTH sensitivity', results) ? 0 : 1);
