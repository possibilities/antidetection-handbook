// E07 — Can copied headers reproduce a browser's transport identity?
//
// The handbook's network chapter rests on one claim, stated in several places
// and never measured: "Header values cannot reproduce browser TLS, protocol
// framing, Fetch Metadata context, compression or pools." It is listed as a
// myth-table entry ("Copy browser headers into requests/curl") and as the
// reason a generic HTTP client cannot stand in for a browser.
//
// This measures it. Both clients fetch the same TLS origin; curl is given
// Chrome's exact header set. The origin parses each ClientHello before TLS
// completes and reports the components a JA3/JA4-style fingerprint is built
// from. If the claim holds, the headers will match and the transport will not.
//
// Second question, from the handbook's own post-quantum note: does Chrome
// actually offer X25519MLKEM768 (0x11ec)? That claim came from a vendor blog
// post and has never been checked against a real handshake.

import { startTlsOrigin } from '../tls-origin.mjs';
import { ab, withSession, check, report, AB_BIN } from '../lib.mjs';
import { execFile } from 'node:child_process';

const results = [];
const origin = await startTlsOrigin();

// --- Arm A: the browser ----------------------------------------------------
await withSession('e07', async (s) => {
  await ab(['--session', s, '--ignore-https-errors', 'open', `${origin.base}/`], {
    timeoutMs: 120_000,
  });
});
await new Promise((r) => setTimeout(r, 1500));
const browserHello = origin.hellos[0] ?? null;
const browserReq = origin.requests.find((r) => r.line);

// --- Arm B: curl, carrying Chrome's headers verbatim -----------------------
const CHROME_HEADERS = [
  'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/150.0.0.0 Safari/537.36',
  'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language: en-US,en;q=0.9',
  'Accept-Encoding: gzip, deflate, br, zstd',
  'sec-ch-ua: "Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
  'sec-ch-ua-mobile: ?0',
  'sec-ch-ua-platform: "macOS"',
  'Sec-Fetch-Site: none',
  'Sec-Fetch-Mode: navigate',
  'Sec-Fetch-User: ?1',
  'Sec-Fetch-Dest: document',
  'Upgrade-Insecure-Requests: 1',
];
const before = origin.hellos.length;
await new Promise((resolve) => {
  execFile(
    'curl',
    ['-sk', '--http1.1', ...CHROME_HEADERS.flatMap((h) => ['-H', h]), `${origin.base}/`],
    { timeout: 30_000 },
    () => resolve(),
  );
});
await new Promise((r) => setTimeout(r, 800));
const curlHello = origin.hellos[before] ?? null;
const curlReq = origin.requests.find((r) => r.line && r !== browserReq);

await origin.close();

// --- Did we observe both? --------------------------------------------------
results.push(
  check('browser ClientHello captured and parsed', Boolean(browserHello && !browserHello.error), {
    error: browserHello?.error,
    ciphers: browserHello?.cipherCount,
    exts: browserHello?.extensionCount,
  }),
);
results.push(
  check('curl ClientHello captured and parsed', Boolean(curlHello && !curlHello.error), {
    error: curlHello?.error,
    ciphers: curlHello?.cipherCount,
    exts: curlHello?.extensionCount,
  }),
);

// --- The headers DO match (that is the premise of the myth) ---------------
const headerUA = (r) => (r?.headers ?? []).find((h) => /^user-agent:/i.test(h));
results.push(
  check(
    'PREMISE: curl sent the same User-Agent the browser did',
    headerUA(curlReq)?.toLowerCase().includes('headlesschrome/150') === true,
    { browser: headerUA(browserReq)?.slice(0, 60), curl: headerUA(curlReq)?.slice(0, 60) },
  ),
);

// --- The transport does NOT -----------------------------------------------
results.push(
  check(
    'CLAIM: the TLS fingerprints differ despite identical headers',
    Boolean(browserHello?.ja3Hash && curlHello?.ja3Hash && browserHello.ja3Hash !== curlHello.ja3Hash),
    { browserJa3: browserHello?.ja3Hash, curlJa3: curlHello?.ja3Hash },
  ),
);
results.push(
  check(
    'cipher suite lists differ',
    JSON.stringify(browserHello?.ciphers) !== JSON.stringify(curlHello?.ciphers),
    { browser: browserHello?.cipherCount, curl: curlHello?.cipherCount },
  ),
);
results.push(
  check(
    'extension lists differ (order and membership)',
    JSON.stringify(browserHello?.extensions) !== JSON.stringify(curlHello?.extensions),
    { browser: browserHello?.extensionCount, curl: curlHello?.extensionCount },
  ),
);
results.push(
  check(
    'GREASE is present in the browser hello and absent from curl (RFC 8701)',
    browserHello?.greasePresent === true && curlHello?.greasePresent === false,
    { browser: browserHello?.greasePresent, curl: curlHello?.greasePresent },
  ),
);

// --- Post-quantum: verify the handbook's own note --------------------------
const MLKEM = '0x11ec';
results.push(
  check(
    'handbook note: Chrome offers X25519MLKEM768 (0x11ec) in supported_groups',
    (browserHello?.groups ?? []).includes(MLKEM),
    { groups: browserHello?.groups, keyShare: browserHello?.keyShare },
  ),
);
results.push(
  check(
    'and curl does not offer it (so the group is a browser-cohort signal here)',
    !(curlHello?.groups ?? []).includes(MLKEM),
    { curlGroups: curlHello?.groups },
  ),
);

console.log('\n--- browser ClientHello ---');
console.log(JSON.stringify(
  { alpn: browserHello?.alpn, versions: browserHello?.supportedVersions, groups: browserHello?.groups,
    keyShare: browserHello?.keyShare, cipherCount: browserHello?.cipherCount,
    extensionCount: browserHello?.extensionCount, grease: browserHello?.greasePresent,
    ja3Hash: browserHello?.ja3Hash }, null, 2));
console.log('\n--- curl ClientHello (identical headers) ---');
console.log(JSON.stringify(
  { alpn: curlHello?.alpn, versions: curlHello?.supportedVersions, groups: curlHello?.groups,
    cipherCount: curlHello?.cipherCount, extensionCount: curlHello?.extensionCount,
    grease: curlHello?.greasePresent, ja3Hash: curlHello?.ja3Hash }, null, 2));
console.log(`\n  binary under test: ${AB_BIN}`);

report('E07 — transport identity vs copied headers', results);
