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
node experiments/e01-provider-stealth-default.mjs   # no browser needed
node experiments/e02-first-request-overrides.mjs
node experiments/e03-identity-coherence.mjs
```

Each prints `CONFIRMED` / `REFUTED` per claim with the raw observation beside
it. A claim is always recorded with its evidence — a green run that records
nothing cannot be audited later, and two of the harness's own bugs (below)
initially presented exactly that way.

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

What a laptop can observe: HTTP headers and ordering, page-visible JavaScript
surfaces, provider control-plane requests. Deliberately **not** covered: TLS and
JA3/JA4 fingerprints (the browser talks cleartext to this origin — protocol
fidelity needs a TLS-terminating origin), HTTP/2 and HTTP/3 behaviour, and
anything requiring a real proxy or a paid provider account.

Results are version-specific. The environment that produced the current
`FINDINGS.md` is recorded at the top of that file; re-run before trusting any of
it against a different Chrome.

## Wanted next

- **React `_valueTracker`** under `setvalue` / `clear` — the top item on the
  companion's work list, and still reasoned rather than observed. Needs a
  pinned, vendored React fixture.
- **WebRTC leak** with `--proxy` and no `--allowed-domains`: assert
  `RTCPeerConnection` constructs and gathers host candidates.
- **Branded DOM mutations** (`data-agent-browser-located`, `data-__ab-ci`) via a
  `MutationObserver` that records what a page could have seen.
- **`--profile <name>`** copy-and-discard: write state, close, assert the real
  Chrome profile is untouched and the copy is gone.
