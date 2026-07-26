// E05 — Is the `tab_new` leak an ordering race or a propagation failure?
//
// §3.4 currently hedges between two hypotheses and says E02 could not tell them
// apart, because E02 only looked at the first request. This resolves it.
//
// Three request classes from the SAME new tab:
//   1. the navigation itself      (created by Target.createTarget)
//   2. a subresource (<img>)      (issued after the document parses)
//   3. a page-initiated fetch     (issued later still, from page JS)
//
// Interpretation:
//   navigation default, later requests sentinel  -> ordering race only
//   ALL three default                            -> whole-target propagation failure
//   ALL three sentinel                           -> no leak on this path
//
// Second matrix arm: with `--allowed-domains` set,
// should_defer_url_until_network_controls (actions.rs:2571-2581) is expected to
// create about:blank first and navigate after controls install — so the leak
// should disappear entirely on the containment path.

import { startOrigin, ab, withSession, check, report } from '../lib.mjs';

const SENTINEL = 'LAB-E05-SENTINEL/3.0';
const results = [];

function classify(reqs) {
  const pick = (pred) => reqs.find(pred);
  const has = (r) => (r ? (r.headers['user-agent']?.includes('LAB-E05-SENTINEL') ? 'sentinel' : 'default') : 'absent');
  return {
    navigation: has(pick((r) => r.url.startsWith('/tabtarget.html'))),
    subresource: has(pick((r) => r.url.startsWith('/sub-image.png'))),
    pageFetch: has(pick((r) => r.url.startsWith('/from-js.json'))),
  };
}

async function arm(label, extraLaunchArgs) {
  const origin = await startOrigin();
  let initial = null;
  let tab = null;
  await withSession(`e05-${label}`, async (s) => {
    await ab(
      ['--session', s, '--user-agent', SENTINEL, ...extraLaunchArgs, 'open', `${origin.base}/blank.html`],
      { timeoutMs: 90_000 },
    );
    initial = origin.requests.find((r) => r.url.startsWith('/blank.html'));
    const before = origin.requests.length;
    await ab(['--session', s, 'tab', 'new', `${origin.base}/tabtarget.html`], { timeoutMs: 90_000 });
    await new Promise((r) => setTimeout(r, 2500));
    tab = classify(origin.requests.slice(before));
  });
  await origin.close();
  return { initial, tab, all: origin.requests.map((r) => `${r.url} ${r.headers['user-agent']?.slice(0, 28)}`) };
}

// --- Arm A: ordinary path (no containment) ---------------------------------
const plain = await arm('plain', []);

results.push(
  check(
    'CONTROL: the sentinel reaches the initial tab (proves the override works)',
    plain.initial?.headers['user-agent']?.includes('LAB-E05-SENTINEL') === true,
    plain.initial?.headers['user-agent'],
  ),
);
results.push(
  check(
    'new-tab NAVIGATION leaks the real UA (the E02 result, reconfirmed)',
    plain.tab.navigation === 'default',
    plain.tab,
  ),
);
results.push(
  check(
    'DISCRIMINATOR: later requests from that tab also lack the override',
    plain.tab.subresource === 'default' && plain.tab.pageFetch === 'default',
    plain.tab,
  ),
);

// --- Arm B: containment path (--allowed-domains) ---------------------------
const contained = await arm('contained', ['--allowed-domains', '127.0.0.1']);

results.push(
  check(
    'CONTROL: containment arm still reaches the initial tab',
    contained.initial?.headers['user-agent']?.includes('LAB-E05-SENTINEL') === true,
    contained.initial?.headers['user-agent'],
  ),
);
results.push(
  check(
    'with --allowed-domains the defer path removes the navigation leak',
    contained.tab.navigation === 'sentinel',
    contained.tab,
  ),
);

const verdict =
  plain.tab.navigation === 'default' &&
  plain.tab.subresource === 'default' &&
  plain.tab.pageFetch === 'default'
    ? 'WHOLE-TARGET PROPAGATION FAILURE — the override never reaches the new target at all'
    : plain.tab.navigation === 'default'
      ? 'ORDERING RACE — only the first request escapes; later requests carry the override'
      : 'NO LEAK on this path';

console.log(`\n  ordinary path   : ${JSON.stringify(plain.tab)}`);
console.log(`  containment path: ${JSON.stringify(contained.tab)}`);
console.log(`\n  VERDICT: ${verdict}\n`);

report('E05 — tab_new: ordering race vs propagation failure', results);
