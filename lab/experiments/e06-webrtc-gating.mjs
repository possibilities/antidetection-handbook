// E06 — Is WebRTC containment wired to the proxy or to the allowlist?
//
// §5 item 1 (top of the work list) claims restrict_webrtc is
// `!allowed_domains.is_empty()`, so a session configured with `--proxy` but no
// `--allowed-domains` leaks the real IP over UDP. Source review confirmed the
// assignment sites; nothing had ever run it.
//
// Observable proxy: whether `new RTCPeerConnection()` constructs. When
// containment is active, network.rs:407-425 installs a constructor that throws
// unconditionally, so construction succeeding means no containment.
//
// MUST run against the stock binary in native mode. The wrapper on PATH execs
// with `--cdp`, and `--allowed-domains` is rejected outright in that mode —
// which is itself recorded as a finding.

import { startOrigin, ab, withSession, check, report, AB_BIN } from '../lib.mjs';

const results = [];
const origin = await startOrigin();

async function arm(label, args) {
  origin.collected.length = 0;
  let out = null;
  await withSession(`e06-${label}`, async (s) => {
    const r = await ab(['--session', s, ...args, 'open', `${origin.base}/probe.html`], {
      timeoutMs: 120_000,
    });
    for (let i = 0; i < 40 && origin.collected.length === 0; i++) {
      await new Promise((x) => setTimeout(x, 250));
    }
    out = { page: origin.collected[0] ?? null, code: r.code, stderr: r.stderr.trim().slice(0, 160) };
  });
  return out;
}

results.push(
  check(
    'running against the stock binary, not the CDP-attaching wrapper',
    AB_BIN !== 'agent-browser',
    { AB_BIN },
  ),
);

// --- Arm A: no proxy, no allowlist (baseline) ------------------------------
const plain = await arm('plain', []);
results.push(
  check(
    'BASELINE: with no containment configured, RTCPeerConnection constructs',
    plain?.page?.rtcConstructs === true,
    { rtc: plain?.page?.rtcConstructs, nativeness: plain?.page?.nativeness?.RTCPeerConnection },
  ),
);

// --- Arm B: allowlist set -> containment expected --------------------------
const contained = await arm('contained', ['--allowed-domains', '127.0.0.1']);
results.push(
  check(
    'CONTROL: the allowlist arm actually launched (proves the flag is accepted here)',
    Boolean(contained?.page),
    { code: contained?.code, stderr: contained?.stderr },
  ),
);
results.push(
  check(
    'with --allowed-domains, RTCPeerConnection is hard-blocked',
    typeof contained?.page?.rtcConstructs === 'string' &&
      contained.page.rtcConstructs.startsWith('threw'),
    { rtc: contained?.page?.rtcConstructs, nativeness: contained?.page?.nativeness },
  ),
);
results.push(
  check(
    'and the domain filter leaves the five HTTP wrappers non-native (§3.2)',
    contained?.page?.nativeness?.fetch === false,
    contained?.page?.nativeness,
  ),
);

// --- Arm C: proxy set, NO allowlist -> the claimed leak ---------------------
// A proxy that does not exist is fine: containment is decided at launch, and we
// only need to observe whether the RTC block was installed.
const proxied = await arm('proxied', ['--proxy', 'http://127.0.0.1:9']);
results.push(
  check(
    'CONTROL: the proxy arm launched and the page reported',
    Boolean(proxied?.page),
    { code: proxied?.code, stderr: proxied?.stderr },
  ),
);
results.push(
  check(
    '§5 CLAIM: --proxy alone does NOT install WebRTC containment (the leak)',
    proxied?.page?.rtcConstructs === true,
    { rtc: proxied?.page?.rtcConstructs, nativeness: proxied?.page?.nativeness?.RTCPeerConnection },
  ),
);

await origin.close();

console.log(
  `\n  no containment : rtcConstructs=${JSON.stringify(plain?.page?.rtcConstructs)}` +
    `\n  --allowed-domains: rtcConstructs=${JSON.stringify(contained?.page?.rtcConstructs)}` +
    `\n  --proxy only   : rtcConstructs=${JSON.stringify(proxied?.page?.rtcConstructs)}\n`,
);

report('E06 — WebRTC containment gating', results);
