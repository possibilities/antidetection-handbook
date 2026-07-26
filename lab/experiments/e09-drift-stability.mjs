// E09 — What is actually stable across cold runs?
//
// The handbook's measurement chapter says to assert HARD INVARIANTS on some
// values and COHORT DISTRIBUTIONS on others, and warns against turning every
// naturally-varying value into a golden string. It never says which values are
// which — so anyone building the regression harness has to guess, and guessing
// wrong gives either gates that flake or gates that catch nothing.
//
// This produces the missing table: N cold runs, each a fresh session and a
// fresh browser, classifying every observed field as stable or varying. Plus a
// smaller loop against the TLS origin, because whether the ClientHello is
// stable across launches decides whether a JA3 baseline is a gate or a hint.
//
// Deliberately modest N. This is a smoke-level stability signal, not a claim
// about population distribution — the handbook is explicit that 20 clean runs
// is a smoke gate and not evidence of 99% stability, and that caveat applies
// to this table too.

import { startOrigin, ab, withSession, check, report, AB_BIN } from '../lib.mjs';
import { startTlsOrigin } from '../tls-origin.mjs';
import { createHash } from 'node:crypto';

// Modest defaults so the suite stays runnable; raise via env for a real
// baseline. Progress is printed per run — a long silent experiment is
// indistinguishable from a wedged one, which cost us a wait.
const RUNS = Number(process.env.LAB_RUNS || 6);
const TLS_RUNS = Number(process.env.LAB_TLS_RUNS || 3);
const results = [];
const origin = await startOrigin();

const short = (v) => createHash('sha256').update(String(v)).digest('hex').slice(0, 12);

const observations = [];
for (let i = 0; i < RUNS; i++) {
  origin.collected.length = 0;
  await withSession(`e09-${i}`, async (s) => {
    await ab(['--session', s, 'open', `${origin.base}/probe.html`], { timeoutMs: 120_000 });
    for (let k = 0; k < 40 && origin.collected.length === 0; k++) {
      await new Promise((r) => setTimeout(r, 250));
    }
  });
  const p = origin.collected[0];
  process.stdout.write(`    cold run ${i + 1}/${RUNS} ${p ? 'ok' : 'NO REPORT'}\n`);
  if (!p) continue;
  observations.push({
    userAgent: p.userAgent,
    platform: p.platform,
    languages: JSON.stringify(p.languages),
    timezone: p.timezone,
    hardwareConcurrency: p.hardwareConcurrency,
    deviceMemory: p.deviceMemory,
    screen: JSON.stringify([p.screen?.width, p.screen?.height]),
    viewport: JSON.stringify([p.screen?.innerWidth, p.screen?.innerHeight]),
    dpr: p.screen?.dpr,
    webglVendor: p.webgl?.vendor,
    webglRenderer: p.webgl?.renderer,
    canvasHash: short(p.canvasSample),
    uaBrands: JSON.stringify(p.uaData?.brands),
    maxTouchPoints: p.input?.maxTouchPoints,
  });
}
await origin.close();

results.push(check(`collected ${RUNS} cold-run observations`, observations.length === RUNS, {
  got: observations.length, want: RUNS,
}));

// --- Classify every field ---------------------------------------------------
const fields = Object.keys(observations[0] ?? {});
const table = fields.map((f) => {
  const vals = observations.map((o) => String(o[f]));
  const distinct = [...new Set(vals)];
  return { field: f, distinct: distinct.length, sample: distinct[0], all: distinct };
});

const stable = table.filter((r) => r.distinct === 1).map((r) => r.field);
const varying = table.filter((r) => r.distinct > 1);

results.push(
  check(
    'canvas output is byte-identical across cold runs (so it can be a hard invariant)',
    table.find((r) => r.field === 'canvasHash')?.distinct === 1,
    table.find((r) => r.field === 'canvasHash'),
  ),
);
results.push(
  check(
    'the impossible screen/viewport geometry reproduces on every run',
    table.find((r) => r.field === 'screen')?.distinct === 1 &&
      table.find((r) => r.field === 'viewport')?.distinct === 1,
    { screen: table.find((r) => r.field === 'screen')?.all, viewport: table.find((r) => r.field === 'viewport')?.all },
  ),
);

// --- Transport stability ----------------------------------------------------
const tls = await startTlsOrigin();
for (let i = 0; i < TLS_RUNS; i++) {
  await withSession(`e09-tls-${i}`, async (s) => {
    await ab(['--session', s, '--ignore-https-errors', 'open', `${tls.base}/`], { timeoutMs: 120_000 });
  });
  await new Promise((r) => setTimeout(r, 600));
  process.stdout.write(`    handshake ${i + 1}/${TLS_RUNS} captured=${tls.hellos.length}\n`);
}
await tls.close();
const ja3s = [...new Set(tls.hellos.filter((h) => h.ja3Hash).map((h) => h.ja3Hash))];
const groupSets = [...new Set(tls.hellos.filter((h) => h.groups).map((h) => JSON.stringify(h.groups)))];

results.push(
  check(`captured ${TLS_RUNS} ClientHellos`, tls.hellos.length >= TLS_RUNS, {
    got: tls.hellos.length,
  }),
);
results.push(
  check(
    'JA3 is identical across cold launches (so a pinned baseline is a usable gate)',
    ja3s.length === 1,
    { distinctJa3: ja3s.length, hashes: ja3s },
  ),
);
results.push(
  check(
    'supported_groups is identical across launches — including the GREASE slot',
    groupSets.length === 1,
    { distinctGroupOrders: groupSets.length, groups: groupSets },
  ),
);

// --- The deliverable --------------------------------------------------------
console.log(`\n${'='.repeat(72)}\nSTABILITY TABLE — ${observations.length} cold runs, ${tls.hellos.length} handshakes\n${'='.repeat(72)}`);
console.log('\nSTABLE across every run (candidates for hard invariants):');
for (const f of stable) console.log(`  ${f.padEnd(22)} ${String(table.find((r) => r.field === f).sample).slice(0, 60)}`);
console.log('\nVARIED across runs (assert as distributions, never as golden strings):');
if (!varying.length) console.log('  (none)');
for (const r of varying) console.log(`  ${r.field.padEnd(22)} ${r.distinct} distinct values: ${JSON.stringify(r.all).slice(0, 90)}`);
console.log(`\nTransport: ${ja3s.length} distinct JA3 across ${tls.hellos.length} handshakes`);
console.log(`  ${ja3s.join('\n  ')}`);
console.log(`\n  binary under test: ${AB_BIN}`);

report('E09 — cold-run drift and stability', results);
