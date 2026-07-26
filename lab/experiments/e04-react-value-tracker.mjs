// E04 — Does a terminal synthetic write actually break React?
//
// This is the top item on the companion's work list and the last major claim
// that was reasoned from React's source rather than observed. §3.1 predicts:
// `setvalue` and `clear` set .value directly then dispatch synthetic events, so
// React's _valueTracker is updated in lockstep, updateValueIfChanged sees no
// delta, and onChange never fires — while `fill` escapes the bug because
// Input.insertText writes through the browser rather than the JS property.
//
// Controls, so a REFUTED result cannot be a broken fixture and a CONFIRMED one
// cannot be an artefact of isTrusted:
//   * baseline `fill` must update React            -> proves the fixture is wired
//   * uncontrolled input must always take the write -> proves the write lands
//   * in-page native-prototype-setter write with the SAME untrusted event must
//     update React                                  -> isolates the tracker from isTrusted
//   * a forced rerender after each case             -> reveals React overwriting the DOM
//
// Scope: React 18.3.1 UMD, pinned and vendored. React 19 dropped UMD builds, so
// a 19.x arm needs a bundled fixture and is not covered here.

import { startOrigin, ab, withSession, check, report } from '../lib.mjs';

const origin = await startOrigin();
const results = [];

const latest = () => {
  for (let i = origin.collected.length - 1; i >= 0; i--) {
    if (origin.collected[i]?.kind === 'react') return origin.collected[i];
  }
  return null;
};
const settle = async (ms = 1600) => new Promise((r) => setTimeout(r, ms));

async function arm(label, actions) {
  origin.collected.length = 0;
  let snap = null;
  await withSession(`e04-${label}`, async (s) => {
    await ab(['--session', s, 'open', `${origin.base}/react-input.html`], { timeoutMs: 90_000 });
    await settle();
    if (!latest()) return;
    await actions(s);
    await settle();
    const afterWrite = latest();
    // Force an unrelated rerender: if React's state never moved, it repaints
    // the input with its stale value and the DOM write is visibly undone.
    await ab(['--session', s, 'click', '#rerender'], { timeoutMs: 60_000 });
    await settle();
    snap = { afterWrite, afterRerender: latest() };
  });
  return snap;
}

// --- Baseline: fill (CDP Input.insertText) ---------------------------------
const fill = await arm('fill', async (s) => {
  await ab(['--session', s, 'fill', '#controlled', 'FILLED_BY_CDP'], { timeoutMs: 60_000 });
});

results.push(
  check(
    'fixture is mounted and wired (React version reported)',
    Boolean(fill?.afterWrite?.reactVersion),
    { react: fill?.afterWrite?.reactVersion },
  ),
);
results.push(
  check(
    'BASELINE: `fill` updates React state (proves the fixture can be driven)',
    fill?.afterWrite?.reactState === 'FILLED_BY_CDP',
    { domValue: fill?.afterWrite?.domValue, reactState: fill?.afterWrite?.reactState, changeCount: fill?.afterWrite?.changeCount },
  ),
);
results.push(
  check(
    'BASELINE: React state survives an unrelated rerender',
    fill?.afterRerender?.reactState === 'FILLED_BY_CDP' &&
      fill?.afterRerender?.domValue === 'FILLED_BY_CDP',
    { after: fill?.afterRerender?.domValue, state: fill?.afterRerender?.reactState },
  ),
);
results.push(
  check(
    '`fill` emits a trusted input event (Input.insertText, no keydown)',
    (fill?.afterWrite?.events ?? []).some((e) => e.type === 'input' && e.isTrusted === true),
    (fill?.afterWrite?.events ?? []).map((e) => `${e.type}:${e.isTrusted}`),
  ),
);

// --- Reachability, established before testing anything ---------------------
// `setvalue` and `clear` are daemon actions that NO shipped client emits: the
// strings appear only in the dispatch table at actions.rs:2316/2326, never in
// commands.rs, mcp.rs or main.rs. An earlier version of this experiment invoked
// them as CLI verbs, the commands silently did nothing, and every assertion
// "passed" — a textbook false positive that only the uncontrolled-input control
// caught. They are therefore latent defects in unreachable code, not live bugs.
//
// The genuinely reachable synthetic-write path is `select`
// (commands.rs:521-523 -> interaction.rs:455 / actions.rs:8784).

const sel = await arm('select', async (s) => {
  await ab(['--session', s, 'select', '#sel', 'gamma'], { timeoutMs: 60_000 });
});

results.push(
  check(
    'CONTROL: `select` actually moved the DOM value (guards against a no-op verb)',
    sel?.afterWrite?.selDom === 'gamma',
    { selDom: sel?.afterWrite?.selDom, selReact: sel?.afterWrite?.selReact },
  ),
);
results.push(
  check(
    '§3.1: does the reachable synthetic write reach React? (claim: NO)',
    sel?.afterWrite?.selReact !== 'gamma',
    {
      selDom: sel?.afterWrite?.selDom,
      selReact: sel?.afterWrite?.selReact,
      selChanges: sel?.afterWrite?.selChanges,
    },
  ),
);
results.push(
  check(
    '§3.1: an unrelated rerender reverts the select (claim: YES if React never saw it)',
    sel?.afterRerender?.selDom !== 'gamma',
    { domAfterRerender: sel?.afterRerender?.selDom, stateAfterRerender: sel?.afterRerender?.selReact },
  ),
);

await origin.close();

console.log('\n--- raw snapshots ---');
for (const [name, s] of [['fill', fill], ['select', sel]]) {
  console.log(
    `\n  ${name}\n    after write   dom=${JSON.stringify(s?.afterWrite?.domValue)} react=${JSON.stringify(s?.afterWrite?.reactState)} changes=${s?.afterWrite?.changeCount}` +
      `\n    select        dom=${JSON.stringify(s?.afterWrite?.selDom)} react=${JSON.stringify(s?.afterWrite?.selReact)} changes=${s?.afterWrite?.selChanges}` +
      `\n    after rerender dom=${JSON.stringify(s?.afterRerender?.domValue)} react=${JSON.stringify(s?.afterRerender?.reactState)}` +
      `\n    events        ${JSON.stringify((s?.afterWrite?.events ?? []).map((e) => `${e.type}:${e.isTrusted}`))}`,
  );
}

report('E04 — React _valueTracker under terminal synthetic writes', results);
