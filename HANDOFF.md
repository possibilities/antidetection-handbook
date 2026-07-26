# Handoff

For the team that will build this. Three artifacts, and the most important thing
to understand is that they are **not equally trustworthy**.

| artifact | what it is |
|---|---|
| [`README.md`](./README.md) | The general handbook. Standards, surfaces, principles. Stable since `44533e3`. |
| [`AGENT-BROWSER.md`](./AGENT-BROWSER.md) | Applied analysis of `possibilities--agent-browser`. Revised seven times. |
| [`lab/`](./lab) | Executable checks. Where the two disagree, the lab wins. |

## Read the confidence tier before acting on any claim

Everything in the companion falls into one of three tiers, and the tier matters
more than the wording.

**Measured** — an experiment in `lab/` produced it, with a control proving the
subject actually did something. Act on these. They are listed in
[`lab/FINDINGS.md`](./lab/FINDINGS.md).

**Source-verified** — read from code, cited `path:line`, checked by at least two
readers. Reliable for *what the code says*; silent about what it does at
runtime. Roughly everything in §2 and §4.

**Reasoned** — an inference nobody has run. Treat as a hypothesis with an expiry
date. The document flags these inline.

The reason for the tiering is empirical, not stylistic. Of the claims we
measured, **three of five went against what source review had concluded** —
including one that six review rounds and two independent reviewers had all
agreed on. Source review converges confidently on wrong answers.

## What is established

Measured, with controls:

- `BROWSERLESS_STEALTH` defaults to `true`; every Browserless session requests
  suppression unless opted out. The full value matrix has an inversion worth
  knowing: `""`, `"0"`, `"false"` all *disable* it, so the only way to get
  stealth is to never set the variable.
- WebRTC containment is gated on `--allowed-domains`, not `--proxy`. A proxied
  session with no allowlist leaks the real IP over UDP. Also unavailable
  entirely in `--cdp` attach mode.
- `tab_new` is a **whole-target propagation failure**, not a first-request race.
  Navigation, subresources and page fetches from a new tab all miss the
  override.
- `--user-agent` suppresses Client Hints entirely (`Sec-CH-UA` absent, `brands`
  emptied) rather than leaving stale values — a combination no real Chrome
  produces.
- The stock headless default violates the handbook's *hard* geometry invariant
  three ways: screen 800×600, viewport 1280×633, `outerWidth` 0.
- §3.1's React correctness bug **does not exist** as a live defect. Two of the
  four sites are unreachable from any shipped client; the reachable one updates
  React correctly.
- Copied headers cannot reproduce browser transport. curl carrying Chrome's
  exact header set offered 49 cipher suites to Chrome's 16, 6 extensions to 17,
  and no GREASE. The handbook's myth-table entry is now measured.
- Chrome 150 offers X25519MLKEM768 (`0x11ec`) as a real 1216-byte key share.
  A strong browser-versus-generic-client discriminator today, and the single
  most likely component to move as post-quantum deployment matures.
- **Do not baseline JA3.** Chrome shuffles ClientHello extension order every
  connection — 10 handshakes, 10 distinct orders, one constant extension set —
  so a pinned JA3 gate fails 100% of the time on an unmodified browser. Assert
  order-independent things: the extension set, the cipher set, GREASE presence,
  groups minus the GREASE slot, ALPN.
- At the page layer everything measured is **stable** across cold runs,
  including a byte-identical canvas hash. The stability table is in
  `lab/FINDINGS.md`; it is what tells you which gates can be exact and which
  must be distributions.
- Identity propagation fails in two places, and they compose: new targets
  (`tab_new`) and **service workers**. A fix framed as "create the target at
  `about:blank` first" addresses neither. What is missing is one initializer
  every realm and target runs before it can emit traffic.

## Build order

Dependency order, not severity order. §4.5 has the schema; §7 has the full list.

1. **Observation harness** — `lab/tls-origin.mjs` now terminates TLS and parses
   the ClientHello, so cipher suites, extensions, groups, key shares, ALPN and
   GREASE are already in scope. What remains is decoding HTTP/2 framing to
   capture SETTINGS and pseudo-header order. Everything downstream changes
   observable behaviour, so without a baseline you cannot tell a fix from a
   regression.
2. **Resolved identity manifest** — the record of what actually launched.
3. **Fail-closed authorization** — a required artifact, not `ActionPolicy`,
   which fails open when its config is malformed and is the wrong granularity
   for process-wide flags.
4. **A real capability model** — requested / provider-declared / runtime-verified,
   with *unknown never satisfying a requirement*.
5. **Requirement-driven selection** — only on top of 2–4.

**Before writing selection code, read §4.5's invariant 4 and its consequence.**
No adapter telemetry channel exists today, so the closed evidence enum has one
live arm and runtime promotion must ship switched off. Building the selector
without that constraint reintroduces page-authored promotion evidence.

## Traps that cost us time

**Verify what your harness is driving.** The `agent-browser` on `PATH` here is a
wrapper that always execs the stock binary with `--cdp`, turning every launch
into an attach. A whole round of results described a browser the project never
started. Use `AB_BIN=$(pnpm bin -g)/agent-browser` with `AGENT_BROWSER_NATIVE=1`
for anything touching the launch line.

**A confirming experiment with a broken subject looks like a confirming
experiment.** We invoked two CLI verbs that do not exist. They silently did
nothing and *every assertion passed* — exactly the result we expected to see.
Only a control asking "did the write land at all?" caught it. Every experiment
needs an arm that fails loudly when nothing happened.

**Do not probe page state through a separate CLI call.** `agent-browser eval`
does not reliably run in the target a previous `open` navigated. Have the
fixture report its own view and correlate it with the request headers the origin
saw for that same navigation.

**Reachability before severity.** Two of the four sites in our top-ranked
correctness finding were dead code. Grep the dispatch table for who actually
emits an action before ranking a fix.

**A fingerprint that varies by design is not a regression signal.** We asserted
differing JA3 as evidence before discovering JA3 differs between two loads of
the same browser. Check whether a value is stable *at all* before building a
gate on it — `lab/experiments/e09-drift-stability.mjs` is the shape of that
check.

## Deliberately not done

HTTP/2 framing — SETTINGS, window sizes and pseudo-header order (the TLS layer
is done; `lab/tls-origin.mjs` only decodes HTTP/1.1 request lines today). A JA4
implementation, if you want a stable transport hash — the sorting rule is the
whole point and we deliberately did not hand-roll it. React 19
(dropped UMD; needs a bundled fixture). Real proxy and paid-provider arms.
Branded DOM mutations under a `MutationObserver`. `--profile <name>`
copy-and-discard. The four repository security concerns in the companion's
out-of-scope block — of those, **plugins as unsandboxed child processes
inheriting the daemon environment** is a larger risk than anything page-visible
in either document, and deserves its own review.

## The one-sentence version

The local path is honest by default and the provider path is not; the cascade
should select on declared requirements rather than observed failures because
failure causes are unobservable; and every version-specific claim here is a
hypothesis with an expiry date, which is why `lab/` exists.
