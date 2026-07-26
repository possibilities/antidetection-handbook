// E03 — Is the identity the browser presents internally coherent?
//
// The page reports its own view (fixtures/probe.html) while the origin records
// the headers it saw for that same navigation. Correlating the two is the whole
// point: a client can only be caught contradicting itself if you observe both
// sides of the same request.
//
// Claims under test:
//   §2.1  navigator.webdriver === true by default (--remote-debugging-port=0
//         sets AutomationControlled).
//   §3.4  --user-agent changes the UA string without carrying UA-CH metadata.
//   §3.4  `set device` installs an iOS Safari UA on a Chromium engine.
//   §3.2  branded page surface is present.

import { startOrigin, ab, withSession, check, report } from '../lib.mjs';

const results = [];
const origin = await startOrigin();
const collected = origin.collected;

async function probe(session, extraArgs = []) {
  const before = origin.requests.length;
  await ab(['--session', session, ...extraArgs, 'open', `${origin.base}/probe.html`], {
    timeoutMs: 90_000,
  });
  // Give the page a moment to POST its report.
  for (let i = 0; i < 40 && collected.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  const nav = origin.requests
    .slice(before)
    .find((r) => r.url.startsWith('/probe.html'));
  const page = collected.shift() ?? null;
  return { nav, page };
}

// --- Arm A: stock defaults --------------------------------------------------
let stock;
await withSession('e03a', async (s) => {
  stock = await probe(s);
});

results.push(
  check('probe page reported back', Boolean(stock.page), stock.page ? 'yes' : 'no report'),
);
results.push(
  check(
    '§2.1 navigator.webdriver is true by default',
    stock.page?.webdriver === true,
    { webdriver: stock.page?.webdriver },
  ),
);
results.push(
  check(
    'stock UA and UA-CH brands agree on Chromium major version',
    (() => {
      const m = /Chrome\/(\d+)|HeadlessChrome\/(\d+)/.exec(stock.page?.userAgent ?? '');
      const major = m && (m[1] || m[2]);
      const brands = stock.page?.uaData?.brands ?? [];
      return Boolean(major && brands.some((b) => b.version === major));
    })(),
    { ua: stock.page?.userAgent, brands: stock.page?.uaData?.brands },
  ),
);
results.push(
  check(
    'stock navigation sends Sec-CH-UA (a real Chrome always does on a secure origin)',
    Boolean(stock.nav?.headers['sec-ch-ua']),
    { 'sec-ch-ua': stock.nav?.headers['sec-ch-ua'] ?? '(absent)' },
  ),
);
results.push(
  check(
    '§3.2 no branded __AB_/agent-browser globals on a plain page',
    (stock.page?.abGlobals ?? []).length === 0,
    { abGlobals: stock.page?.abGlobals, reactHook: stock.page?.reactHook },
  ),
);
results.push(
  check(
    'page-level APIs are native when no domain filter is active',
    stock.page?.nativeness?.fetch === true && stock.page?.nativeness?.XMLHttpRequest === true,
    stock.page?.nativeness,
  ),
);

// --- Arm B: --user-agent override -------------------------------------------
const LAB_UA = 'LAB-E03-UA/2.0';
let ua;
await withSession('e03b', async (s) => {
  ua = await probe(s, ['--user-agent', LAB_UA]);
});

results.push(
  check(
    '§3.4 the UA override reaches the navigation header',
    ua.nav?.headers['user-agent']?.includes('LAB-E03-UA') === true,
    ua.nav?.headers['user-agent'],
  ),
);
results.push(
  check(
    '§3.4 UA-CH does NOT travel with the override (expect Sec-CH-UA absent or stale)',
    !ua.nav?.headers['sec-ch-ua']?.includes('LAB-E03'),
    {
      'sec-ch-ua': ua.nav?.headers['sec-ch-ua'] ?? '(absent)',
      'user-agent': ua.nav?.headers['user-agent'],
    },
  ),
);
results.push(
  check(
    '§3.4 the JS realm disagrees with the header, or UA-CH brands still say Chromium',
    ua.page ? ua.page.userAgent !== LAB_UA || Boolean(ua.page.uaData?.brands?.length) : false,
    { pageUA: ua.page?.userAgent, brands: ua.page?.uaData?.brands },
  ),
);

// --- Arm C: set device (iOS Safari UA on Chromium) --------------------------
let dev;
await withSession('e03c', async (s) => {
  await ab(['--session', s, 'open', `${origin.base}/blank.html`], { timeoutMs: 90_000 });
  await ab(['--session', s, 'set', 'device', 'iPhone 16'], { timeoutMs: 45_000 });
  dev = await probe(s);
});

results.push(
  check(
    '§3.4 `set device iPhone 16` sends an iOS Safari UA',
    /iPhone|Safari\/604/.test(dev.nav?.headers['user-agent'] ?? ''),
    dev.nav?.headers['user-agent'],
  ),
);
results.push(
  check(
    '§3.4 …while the engine is still Chromium (UA-CH brands or JS disagree)',
    Boolean(dev.page?.uaData?.brands?.length) ||
      /Chrome|Chromium|Headless/.test(dev.page?.userAgent ?? ''),
    { brands: dev.page?.uaData?.brands, pageUA: dev.page?.userAgent, webgl: dev.page?.webgl },
  ),
);

await origin.close();

console.log('\n--- stock cohort snapshot (for the baseline) ---');
console.log(
  JSON.stringify(
    {
      ua: stock.page?.userAgent,
      brands: stock.page?.uaData?.brands,
      platform: stock.page?.uaData?.platform,
      webgl: stock.page?.webgl,
      screen: stock.page?.screen,
      media: stock.page?.media,
      timezone: stock.page?.timezone,
      rtcConstructs: stock.page?.rtcConstructs,
    },
    null,
    2,
  ),
);

report('E03 — identity coherence', results);
