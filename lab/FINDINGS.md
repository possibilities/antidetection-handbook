# Lab findings

Observed results, not reasoning. Each entry names the experiment that produced
it so it can be re-run. Where an observation contradicts
[`../AGENT-BROWSER.md`](../AGENT-BROWSER.md), the observation wins and the
document needs correcting.

**Run environment:** macOS (Apple M4), agent-browser 0.32.3, Chrome/Chromium 150
headless, 2026-07-25. Every claim here is version-specific.

---

## Confirmed as documented

**Provider stealth defaults (E01).** Observed on the wire, no account needed —
the mock endpoint captured the literal session-creation body:

```
POST /session?token=…   {"browser":"chromium","stealth":true,"ttl":300000}
```

`BROWSERLESS_STEALTH` defaults to `true`. Full sensitivity matrix (E01b), which
distinguishes a default from a constant and an unset variable from an empty one:

| input | `stealth` sent |
|---|---|
| **(unset)** | **true** |
| `""` | false |
| `"1"` / `"true"` / `"TRUE"` | true |
| `"0"` / `"false"` / `"yes"` | false |

Note the inversion, which is the part worth internalising: **every
plausible-looking "off" value disables it, so the only way to get stealth is to
never configure the variable at all.** An operator who sets `=0` out of caution
lands in the same place as one who sets `=false`; an operator who has never
heard of it gets suppression enabled against every origin they visit.

Kernel: `stealth:false`, `headless:true` — so the Kernel default does select the
profile that carries its stealth flag list.

Scope: this proves what agent-browser *sends*. Whether Browserless honours the
field is a separate question this lab cannot reach.

**`navigator.webdriver === true` by default (E03).** Confirmed from inside the
page. The `--remote-debugging-port=0` → `AutomationControlled` → `webdriver`
chain holds end to end.

**`tab new` first-request leak (E02).** Decisive. With `--user-agent` set:

| navigation | User-Agent observed at the origin |
|---|---|
| initial `open` | `LAB-E02-UA/1.0 (agent-browser lab probe)` |
| `tab new` | `…HeadlessChrome/150.0.0.0 Safari/537.36` |

The new tab's first request carries the real UA. `Target.createTarget` navigates
before the override is applied, exactly as §3.4 claims.

**`set device` sends an iOS Safari UA (E03).** Observed at the origin:
`Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) … Version/18.0 Mobile/15E148 Safari/604.1`

**No branded page surface on a plain page (E03).** `__AB_*` globals absent and
all six page APIs report `[native code]` when no domain filter is active — so
§3.2's artifacts really are conditional on the features that install them,
rather than always-on.

---

## Corrections the document needs

### 1. §3.4's UA-CH mechanism is wrong

The document says `navigator.userAgentData.brands`, `.platform` and `.mobile`
"keep reporting the real browser and OS" while the UA string changes. **They do
not.** Observed with `--user-agent LAB-E03-UA/2.0`:

| surface | stock | with override |
|---|---|---|
| request `User-Agent` | `…HeadlessChrome/150…` | `LAB-E03-UA/2.0` |
| request `Sec-CH-UA` | `"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"` | **absent** |
| `navigator.userAgent` | `…HeadlessChrome/150…` | `LAB-E03-UA/2.0` |
| `navigator.userAgentData.brands` | 3 brands | **`[]`** |

So Chrome does not leave stale hints — it **suppresses Client Hints entirely**
and empties the brands array. The UA string and `navigator.userAgent` stay
consistent with each other.

The defect is real but differently shaped, and arguably worse: the result is
**a UA string with no Client Hints at all**, which is a combination no real
Chrome 150 produces on a secure origin. The tell is an absence, not a
contradiction — and an absence is harder to notice and easier to fingerprint.

### 2. The `set device` contradiction is in the GPU, not UA-CH

Same correction applies: `set device "iPhone 16"` empties `brands` rather than
leaving Chromium values. The observable contradiction is elsewhere:

```
navigator.userAgent : Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 …) Safari/604.1
webgl.vendor        : Google Inc. (Apple)
webgl.renderer      : ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)
```

A client claiming to be an iPhone, rendering through **ANGLE Metal on an Apple
M4 desktop GPU**. That is the contradiction worth citing, and it is far more
legible than the UA-CH story the document currently tells.

### 3. New, unremarked: the default screen is smaller than the viewport

From the stock cohort with nothing overridden (E03, independently re-measured):

```
screen      : 800 × 600
availWidth… : 800 × 600
innerWidth… : 1280 × 633     <- viewport WIDER AND TALLER than the screen
outerWidth… : 0 × 0          <- window has no outer dimensions at all
devicePixelRatio: 1
```

Three impossible things at once, none of them requiring a flag to reproduce:

1. The viewport is wider than the screen it is supposedly displayed on.
2. It is also taller.
3. `outerWidth` and `outerHeight` are **zero**. Every real browser window
   reports nonzero outer dimensions; a window cannot contain a 1280px viewport
   while having no width.

The handbook lists "screen/viewport/DPR arithmetically impossible" as a *hard
manifest invariant* — a zero-tolerance check. The default configuration violates
it three ways.

This is a stock-default coherence violation that six rounds of source review did
not surface, because nobody thought to compare two numbers that live in
different parts of the codebase. It is cheap to fix (`--screen-info` since Chrome
142, per the handbook) and cheap to assert in a regression test.

---

### 4. §3.1's correctness bug is not a live bug (E04)

The top item on the work list, reproduced against pinned React 18.3.1 UMD. The
answer went the other way.

**Two of the four "terminal synthetic write" sites are unreachable.** The
strings `"setvalue"` and `"clear"` appear only in the daemon dispatch table
(`actions.rs:2316`, `:2326`). No shipped client emits either action — not
`commands.rs`, not `mcp.rs`, not `main.rs`. They are latent defects in code
nothing can call.

This was caught by a control, not by inspection. The first run invoked them as
CLI verbs, the commands silently did nothing, and **every assertion "passed"** —
DOM unchanged, React unchanged, zero events. Textbook false positive. Only the
uncontrolled-input control ("did the write land at all?") exposed it.

**The reachable synthetic write does reach React.** `select` (`commands.rs:521`
→ `interaction.rs:455` / `actions.rs:8784`) dispatches a bare `change` event:

```
after `select #sel gamma`:  selDom="gamma"  selReact="gamma"  selChanges=1
after forced rerender:      selDom="gamma"  selReact="gamma"
```

React's `onChange` fired and the value survived. The `_valueTracker` dedup path
applies to text inputs, where React reads the `input` event; `<select>` change
handling does not go through it. So the mechanism is real but does not bite on
the only path a user can reach.

**Net:** §3.1 should not claim a live correctness bug, and "fix the four
terminal synthetic writes" does not belong on a no-regret list. What survives is
(a) dead code that would be a bug if wired up, and (b) the provenance point
below, which stands on its own.

### 5. Mixed provenance inside one `fill`, confirmed (E04)

Native capture listeners on the controlled input recorded, for a single `fill`:

```
input:false   beforeinput:true   input:true
```

An **untrusted** `input` (the clear step) followed by trusted events — one
logical action emitting both, exactly as §3.1 describes. Also note what is
absent: no `keydown`, no `keyup`. `Input.insertText` produces a trusted `input`
with no keystrokes at all, so a page listening for key events sees a value
materialise from nothing.

### 6. `tab_new` is a propagation failure, not an ordering race (E05)

§3.4 hedged between the two. Three request classes from the same new tab, with
a launch-level sentinel UA:

| request from the new tab | User-Agent |
|---|---|
| the navigation itself | default |
| a subresource (`<img>`) | default |
| a page-initiated `fetch()` | default |

All three. The override never reaches the new target **at all** — it is not that
the first request outruns the configuration. The fix is therefore larger than
"create at `about:blank` then navigate": new targets need an initializer that
replays identity and init scripts, or nothing target-scoped will ever apply to
them.

### 7. WebRTC containment is wired to the allowlist, not the proxy (E06)

The top work-list item, 7/7 confirmed against the stock binary:

| configuration | `new RTCPeerConnection()` |
|---|---|
| nothing set | constructs |
| `--allowed-domains` | **throws `SecurityError`** |
| `--proxy` only | **constructs — the leak** |

A proxied session with no allowlist has no WebRTC containment, exactly as
claimed. Also observed under containment, correcting §3.2's count: of the six
page APIs, `fetch`, `WebSocket`, `EventSource`, `sendBeacon` and
`RTCPeerConnection` report non-native, but **`XMLHttpRequest` reports
`[native code]`**. Four wrappers plus one hard block, not five plus one.

---

## A confound that invalidated part of an earlier round

**The `agent-browser` on `PATH` here is a wrapper, not the binary.** At line
1080 it always execs the stock binary with `--cdp <endpoint>`, attaching to a
browserctl-managed browser rather than launching one. Every experiment before
E06 ran against a browser this project did not launch.

Found only because the E05 containment arm failed with
`--allowed-domains is not supported with --cdp because WebRTC containment
cannot be installed` — a real finding in its own right: **containment is
unavailable in CDP-attach mode**, so in a browserctl-backed setup it can never
be switched on.

What this invalidated, and what survived re-measurement against the stock
binary (`AB_BIN=$(pnpm bin -g)/agent-browser`, `AGENT_BROWSER_NATIVE=1`):

| finding | status |
|---|---|
| provider stealth defaults (E01/E01b) | unaffected — no browser involved |
| React tracker and reachability (E04) | unaffected — browser-side and source-level |
| UA override / UA-CH suppression (E03) | unaffected — same post-attach CDP path |
| `navigator.webdriver === true` | **weakened** — cannot be attributed to agent-browser's launch line |
| screen 800×600 / viewport 1280×633 / outer 0×0 | **re-measured natively, holds identically** |

The lesson generalises past this repo: verify what your harness is actually
driving before trusting a single result. A wrapper that transparently changes
launch into attach produces plausible numbers for a different subject, and
nothing in the output says so.

---

## Harness bugs worth remembering

Two of my own, both of which initially produced plausible-looking wrong results:

- `onRequest` fired before the POST body was read, so page-side reports appeared
  empty. A test that silently collects nothing looks identical to a test whose
  subject reported nothing.
- CLI `eval` does not reliably run in the target the previous `open` navigated —
  observed `location.href === 'about:blank'` after a successful navigation. The
  fix was structural: the fixture page reports its own view, so whatever context
  loaded the document is the context that answers. **Do not probe page state
  through a separate CLI call**; correlate the page's self-report with the
  request headers the origin saw for that same navigation.
