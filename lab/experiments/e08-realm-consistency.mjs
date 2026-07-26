// E08 — The handbook's patch-completeness test, run for real.
//
// "Execution realms: the patch completeness test" asserts that a value holding
// in the top-level main world says nothing about workers, iframes or service
// workers, and that most shims fail there. Never measured.
//
// Two questions, and the second is the interesting one:
//   A. STOCK — do the shared system surfaces agree across realms by default?
//      They should: nothing is being patched, so disagreement would be a
//      browser-level inconsistency.
//   B. OVERRIDE — does `--user-agent` propagate to every realm? E05 already
//      found that target-scoped state fails to reach new *targets*; workers are
//      the other place propagation can silently stop, and a UA that holds in the
//      page but not in a worker is exactly the contradiction the handbook says
//      to look for.
//
// Only fields legitimately present in all four realms are compared. `webdriver`
// is deliberately excluded from the equality check — the WebDriver spec says
// NavigatorAutomationInformation should not be exposed on WorkerNavigator, so
// its absence in a worker is correct, not a defect. We assert that separately.

import { startOrigin, ab, withSession, check, report, AB_BIN } from '../lib.mjs';

const SHARED = ['userAgent', 'languages', 'platform', 'hardwareConcurrency', 'deviceMemory', 'timezone'];
const results = [];
const origin = await startOrigin();

async function collectRealms(label, extraArgs) {
  origin.collected.length = 0;
  await withSession(`e08-${label}`, async (s) => {
    await ab(['--session', s, ...extraArgs, 'open', `${origin.base}/realms.html`], {
      timeoutMs: 120_000,
    });
    // Service worker registration and activation are the slow part.
    for (let i = 0; i < 60; i++) {
      const seen = new Set(origin.collected.filter((c) => c.kind === 'realm').map((c) => c.realm));
      if (seen.size >= 4) break;
      await new Promise((r) => setTimeout(r, 400));
    }
  });
  const byRealm = {};
  for (const c of origin.collected) if (c.kind === 'realm') byRealm[c.realm] = c;
  return byRealm;
}

function disagreements(byRealm) {
  const realms = Object.keys(byRealm);
  const out = [];
  for (const f of SHARED) {
    const vals = realms.map((r) => [r, JSON.stringify(byRealm[r][f])]);
    const distinct = new Set(vals.map(([, v]) => v));
    if (distinct.size > 1) out.push({ field: f, values: Object.fromEntries(vals) });
  }
  return out;
}

// --- Arm A: stock ----------------------------------------------------------
const stock = await collectRealms('stock', []);
const stockRealms = Object.keys(stock);

results.push(
  check('all four realms reported (page, iframe, dedicated worker, service worker)',
    stockRealms.length >= 4, { realms: stockRealms }),
);

const stockDiff = disagreements(stock);
results.push(
  check('STOCK: shared system surfaces agree across every realm',
    stockDiff.length === 0, stockDiff.length ? stockDiff : 'all agree'),
);

results.push(
  check('spec conformance: `webdriver` is absent from WorkerNavigator',
    stock['dedicated-worker']?.hasWebdriver === false &&
      stock['service-worker']?.hasWebdriver === false,
    {
      page: stock['main-page']?.hasWebdriver,
      iframe: stock['same-origin-iframe']?.hasWebdriver,
      dedicatedWorker: stock['dedicated-worker']?.hasWebdriver,
      serviceWorker: stock['service-worker']?.hasWebdriver,
    }),
);

// --- Arm B: with a UA override ---------------------------------------------
const LAB_UA = 'LAB-E08-REALM/4.0';
const over = await collectRealms('override', ['--user-agent', LAB_UA]);
const overRealms = Object.keys(over);
const carries = (r) => (over[r]?.userAgent ?? '').includes('LAB-E08-REALM');

results.push(
  check('override arm: all four realms reported', overRealms.length >= 4, { realms: overRealms }),
);
results.push(
  check('CONTROL: the override reached the main page (proves the flag applied)',
    carries('main-page'), { ua: over['main-page']?.userAgent }),
);
results.push(
  check('PATCH COMPLETENESS: the override reaches EVERY realm',
    overRealms.every(carries),
    Object.fromEntries(overRealms.map((r) => [r, carries(r) ? 'override' : 'REAL UA'])),
  ),
);

await origin.close();

console.log('\n--- stock, per realm ---');
for (const r of stockRealms) {
  const v = stock[r];
  console.log(`  ${r.padEnd(20)} tz=${v.timezone} cores=${v.hardwareConcurrency} mem=${v.deviceMemory} plat=${JSON.stringify(v.platform)}`);
}
console.log('\n--- with --user-agent, per realm ---');
for (const r of overRealms) {
  console.log(`  ${r.padEnd(20)} ${carries(r) ? 'OVERRIDE' : 'REAL UA  '}  ${String(over[r].userAgent).slice(0, 64)}`);
}
console.log(`\n  binary under test: ${AB_BIN}`);

report('E08 — realm consistency / patch completeness', results);
