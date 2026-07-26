# lab — executable checks for the handbook's claims

Both documents in this repo reason from source. This directory runs things and
records what actually happened. Where the two disagree, see
[`FINDINGS.md`](./FINDINGS.md) — the observation wins.

This is also the first increment of the measurement harness the handbook asks
for in *Measurement and regression testing*, and of item 7 in the companion's
work list. The experiments are deliberately written as durable test cases rather
than throwaway scripts, because the harness is something the project needs
anyway and one-off scripts would have to be rebuilt to get it.

## Running

Node ≥ 20 and `agent-browser` on `PATH`. No dependencies, no install step.

```sh
node run-all.mjs                                   # whole suite + provenance
AB_BIN=$(pnpm bin -g)/agent-browser node run-all.mjs   # stock binary (see below)
node experiments/e01-provider-stealth-default.mjs  # or one at a time
```

**Set `AB_BIN` for anything touching the launch line.** The `agent-browser` on
`PATH` may be a wrapper; in the authoring environment it always execs the stock
binary with `--cdp`, turning every launch into an attach. `run-all.mjs` warns
when `AB_BIN` is unset, and stamps every run with provenance — binary versions,
Chrome build, OS, vendored digests, git commit — into `last-run.json`.

A `REFUTED` line is not necessarily a failure. Several experiments assert a
claim one of the documents makes, so a refutation means the *document* is
wrong. Read the claim text before treating a run as a red build.

## Experiments

| | question |
|---|---|
| `e01` / `e01b` | Do the providers request stealth by default? Full value matrix. |
| `e02` | Do identity overrides reach the first request of a navigation? |
| `e03` | Is the identity coherent between what the page claims and what the origin sees? |
| `e04` | Does a terminal synthetic write actually break React? (pinned 18.3.1) |
| `e05` | Is the `tab_new` leak an ordering race or a propagation failure? |
| `e06` | Is WebRTC containment wired to the proxy or the allowlist? |
| `e07` | Can copied headers reproduce a browser's transport? (TLS origin) |
| `e08` | The handbook's patch-completeness test, across four realms. |
| `e09` | What is actually stable across cold runs? |

## Design

**The origin observes; the page reports.** `lib.mjs` starts a local HTTP origin
that records ordered raw headers for every request, and serves fixtures that
POST their own view of themselves back to `/__collect`. Correlating the two
sides of the *same* navigation is the whole point: a client can only be caught
contradicting itself if you see what it claimed and what it sent.

**Do not probe page state through a separate CLI call.** `agent-browser eval`
does not reliably execute in the target a previous `open` navigated — we
observed `location.href === 'about:blank'` after a successful navigation, which
silently produced wrong answers for a whole run. The fixture-self-report design
removes the ambiguity entirely.

**Every arm has a control.** E01 asserts `BROWSERLESS_STEALTH=false` produces
`stealth:false` before concluding anything from the default, so a hardcoded
value cannot masquerade as a default.

**No dependencies.** Node stdlib only, so a run is reproducible from a clean
checkout and nothing in the harness can drift underneath a result.

## Scope

What a laptop can observe. `lib.mjs` gives a plaintext origin (headers and
ordering, page-visible JavaScript surfaces, provider control-plane requests);
`tls-origin.mjs` terminates TLS and parses the raw ClientHello, so cipher
suites, extensions, supported groups, key shares, ALPN and GREASE are in scope
too.

Deliberately **not** covered: HTTP/2 and HTTP/3 framing (the TLS origin decodes
only HTTP/1.1 request lines), a JA4 implementation, and anything requiring a
real proxy or a paid provider account.

Results are version-specific. The environment that produced the current
`FINDINGS.md` is recorded at the top of that file; re-run before trusting any of
it against a different Chrome.

## Wanted next

- **HTTP/2 framing** — SETTINGS, window sizes, pseudo-header order.
  `tls-origin.mjs` terminates TLS and parses the ClientHello but decodes only
  HTTP/1.1 request lines, which is why `e07`'s header-comparison arm mispairs
  its two clients when Chrome negotiates h2.
- **A JA4 implementation**, if a stable transport hash is wanted. Deliberately
  not hand-rolled here: `e09` showed Chrome shuffles extension order every
  connection, so the sorting rule is the entire point and getting it wrong
  yields something as useless as JA3 while looking authoritative.
- **Branded DOM mutations** (`data-agent-browser-located`, `data-__ab-ci`) via a
  `MutationObserver` that records what a page could have seen.
- **`--profile <name>`** copy-and-discard: write state, close, assert the real
  Chrome profile is untouched and the copy is gone.
- **React 19** — dropped UMD builds, so it needs a bundled fixture.
