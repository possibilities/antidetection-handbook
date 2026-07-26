# Start here

A reading guide for this repo. Three artifacts, and the most important thing to
understand is that they are **not equally trustworthy**.

| artifact | what it is |
|---|---|
| [`README.md`](./README.md) | The general handbook. Standards, surfaces, principles. Broadest scope, least project-specific. |
| [`AGENT-BROWSER.md`](./AGENT-BROWSER.md) | Applied analysis of `possibilities--agent-browser`. Heavily revised under adversarial review, then corrected by measurement. |
| [`lab/`](./lab) | Executable checks. Where a document and the lab disagree, the lab wins. |

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

Deliberately not summarised here. [`lab/FINDINGS.md`](./lab/FINDINGS.md) is the
authoritative record — twelve numbered findings, each with the raw observation
and the experiment that produced it, plus a table of what an earlier confound
invalidated and what survived re-measurement.

A restatement in this file would be a second copy that drifts. Finding 8 already
needed correcting once after a later experiment, and if that correction had
needed to land in two places, one of them would still be wrong.

Start with findings 10-12 if you are short of time: identity fails to propagate
to service workers, everything at the page layer is stable across cold runs
including a byte-identical canvas hash, and JA3 is unusable as a regression gate
because Chrome shuffles ClientHello extension order every connection.

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

**Pin the commit you are citing, and the binary you are measuring.** The subject
repo advanced six commits mid-analysis, from v0.32.4 to v0.33.0, while the
installed binary stayed at 0.32.3. Nobody noticed because nothing was pinned.
Every underlying claim survived, and **every one of 68 line citations went
stale** — the worst shape a defect can take, because the document still reads as
authoritative and the first citation a reader checks does not resolve. The
handbook pins the commit for its Kernel case study and says to archive resolved
commits for a reproducible audit; the companion applied that rule to someone
else's repo and not to its own subject. Both snapshots are now in the companion's
header.

**A fingerprint that varies by design is not a regression signal.** We asserted
differing JA3 as evidence before discovering JA3 differs between two loads of
the same browser. Check whether a value is stable *at all* before building a
gate on it — `lab/experiments/e09-drift-stability.mjs` is the shape of that
check.

## Deliberately not done

The measurement backlog lives in [`lab/README.md`](./lab/README.md) under
"Wanted next" — HTTP/2 framing, a JA4 implementation, React 19, branded DOM
mutations, `--profile <name>` copy-and-discard.

One item is not a measurement task and should not be left to whoever picks up
the lab: **plugins are unsandboxed child processes inheriting the daemon
environment** (`plugins.rs:201-217`). Combined with the `LaunchMutation` surface
in the companion's §2.1, that is a code-execution and secret-exposure boundary —
a larger real risk than anything page-visible in either document. It is
source-verified, never measured, and needs a security owner rather than another
experiment. The other three repository concerns are in the companion's
out-of-scope block.

## The one-sentence version

The local path is honest by default and the provider path is not; the cascade
should select on declared requirements rather than observed failures because
failure causes are unobservable; and every version-specific claim here is a
hypothesis with an expiry date, which is why `lab/` exists.
