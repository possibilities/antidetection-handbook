# agent-browser: detection surfaces and identity coherence

**A companion to [The Antidetection Handbook](./README.md), specific to [`possibilities--agent-browser`](https://agent-browser.dev).**

> **Snapshot:** 2026-07-25. Claims below were read from the working tree at that date and cite `path:line`. Line numbers drift; re-read before relying on any of them.

The handbook is general. This document answers a narrower question: *what does agent-browser actually look like on the wire and in the page today, and what should be built next?*

Every factual claim here was read out of the source. Where the answer is "this does not exist," it says so.

---

## 1. The short version

agent-browser's native backend is **not** trying to hide, and currently could not hide if it wanted to. It launches Chrome with `--remote-debugging-port=0`, which sets Chromium's `AutomationControlled` runtime feature, which makes `navigator.webdriver` return `true`. Add `--headless=new`, SwiftShader software rendering, `Runtime.enable`, and a container font corpus, and any site that looks at all is going to see an automated Linux container.

That is a defensible default. What complicates the picture is that the *defaults* are honest while the *configuration surface* is not: `--args`, `--init-script`, and `--user-agent` already let anyone suppress those signals, the help text uses `--disable-blink-features=AutomationControlled` as its worked example, and the plugin protocol ships a `navigator.webdriver` shim as a test vector (§2.1). Nothing gates any of it.

So the available work splits into three piles.

1. **Fidelity work that is also correctness work.** Real GPU, headful, real fonts, persistent profile, stable egress, coherent locale/timezone. These make the browser genuinely more ordinary rather than pretending to be, they fix real rendering bugs, and none of them require anyone's permission. This is where nearly all the value is.
2. **Coherence bugs worth fixing on their own merits.** Mixed input provenance (§3.1), identifying page globals (§3.2), no identity manifest (§3.3), and a UA override that changes the string but not the Client Hints (§3.4). All four are defects regardless of detection; §3.4 currently leaves a client *worse off* than not using the flag.
3. **Suppressing truthful automation signals.** Requires the site owner's express permission per the handbook's own rules. Because this is already reachable, the work here is adding a gate and retiring the help-text recommendation — not building a feature (§5).

The cascade the project wants is a good idea, but it has to select on **capability**, not on **enforcement**. §4 is about that distinction, and it is the one place where the stated goal conflicts with the handbook.

---

## 2. What each backend actually presents

### 2.1 Native CDP backend, local Chrome

`cli/src/native/cdp/chrome.rs` builds the launch line. The identity-relevant flags:

| Flag | Line | Consequence |
|---|---|---|
| `--remote-debugging-port=0` | `chrome.rs:398` | **Sets `AutomationControlled`.** `navigator.webdriver === true`. |
| `--headless=new` | `chrome.rs:444` | Also sets `AutomationControlled`; no platform windows; skipped when extensions are loaded. |
| `--use-angle=vulkan`, `--use-vulkan=swiftshader`, `--use-webgpu-adapter=swiftshader`, `--enable-unsafe-swiftshader` | `chrome.rs:424-426, 456` | Software rendering. WebGL/WebGPU report SwiftShader. |
| `--user-data-dir=…` | `chrome.rs:470, 477` | Profile persistence is supported and configurable. |
| `--proxy-server=…`, `--proxy-bypass-list=…` | `chrome.rs:460, 464` | Chromium-native proxying, so browser TLS is preserved through a `CONNECT` tunnel. |
| `--ignore-certificate-errors` | `chrome.rs:482` | Conditional, but a real risk if it is ever on by default. |

There is no stealth flag in the **defaults**. But the repo does ship a complete suppression *surface*, and its own help text advertises it:

```
  --args <args>    Browser launch args, comma or newline separated (or AGENT_BROWSER_ARGS)
                   e.g., --args "--no-sandbox,--disable-blink-features=AutomationControlled"
```

That is `output.rs:3521` — the automation-suppression flag is the illustrative example for `--args`. Alongside it: `--init-script` / `AGENT_BROWSER_INIT_SCRIPTS` registers arbitrary page scripts before first navigation, `--user-agent` / `AGENT_BROWSER_USER_AGENT` overrides the UA, and `--extension` loads extensions. The plugin protocol exposes the same surface programmatically — `LaunchMutation` carries `args`, `extensions`, `init_scripts`, and `user_agent` (`plugins.rs:71-80`), and the protocol's own test fixture demonstrates it with:

```json
{"launch":{"args":["--disable-blink-features=AutomationControlled"],
           "initScripts":["Object.defineProperty(navigator,\"webdriver\",{get:()=>undefined});"]}}
```

That is `plugins.rs:1272` — the handbook's canonical anti-pattern, shipped as a test vector.

This matters for §5. Suppression is not hypothetical future work requiring a design decision; it is **reachable today through documented flags, with no authorization gate anywhere in the path**. The engineering question is not whether to build it but whether to put a gate in front of what already exists.

The `--remote-debugging-port=0` choice deserves emphasis because it is easy to misread as incidental. Chromium special-cases it deliberately: port `0` is the ephemeral port ChromeDriver uses, so it counts as automation, whereas a fixed port is assumed to be a developer attaching a debugger and leaves the feature unset. The handbook covers this in *Automation signals and control stacks*. agent-browser therefore reports its automation status truthfully by default — the cooperative behavior, arrived at as a side effect.

**Protocol surface.** `Runtime.enable`, `Page.enable`, and `Network.enable` are issued on session setup (`browser.rs:657-708`, `actions.rs:2754-2760`, `state.rs:164-167`). `Runtime.enable` is the classic CDP tell. The V8 changes of May 2025 killed the popular `Error.stack` side-effect detector, but execution-context disclosure remains observable, and it is a hypothesis to re-measure per Chrome release rather than a settled fact.

**Snapshot.** `snapshot.rs` reads the accessibility tree over the protocol — `Accessibility.enable` then `Accessibility.getFullAXTree` (`snapshot.rs:228, 310, 315`). That is a protocol-side read and is **not** page-observable, which is a genuinely good design choice: the primary perception path costs nothing in page surface. Supplementary `Runtime.evaluate` and `Runtime.callFunctionOn` calls (`snapshot.rs:242, 469, 719, 817`) do execute in the page.

### 2.2 Native CDP backend, Lightpanda

`cli/src/native/cdp/lightpanda.rs` targets Lightpanda, which is not Chromium. It speaks enough CDP to drive, but it is a different engine with a different JavaScript runtime, no Blink rendering, and no Chrome TLS stack.

For detection purposes this is the **least** disguisable backend, and that is fine — it is a speed/cost play for content extraction where nobody is asking whether you are a browser. Treat it as a separate cohort with its own expectations rather than as a Chrome substitute. Do not let a cascade silently promote work from Lightpanda to Chrome and call the results comparable; they are different measurement conditions.

### 2.3 WebDriver backend

`cli/src/native/webdriver/backend.rs`, with `appium.rs` for mobile. WebDriver sets the `webdriver-active` flag by specification — `navigator.webdriver` is `true` and is *supposed* to be. This is the most standards-cooperative backend in the project.

### 2.4 Remote providers, including Kernel

`cli/src/native/providers.rs` resolves a CDP WebSocket URL for `browserbase`, `browserless`, `browser-use`, `kernel`, `agentcore`, and plugin providers (`providers.rs:50-195`). The Kernel path (`connect_kernel`, `providers.rs:393`) talks to `https://api.onkernel.com` (`providers.rs:396`, overridable via `KERNEL_ENDPOINT`) and returns a WebSocket the client drives.

**This is the direct link to the handbook.** The Kernel provider's server side is the image audited in *What Kernel's public image repo implements*. Everything in that section applies to this backend, and three items are operationally significant here:

- **Headless and headful are asymmetric.** Kernel's "headless+stealth" default flag list applies only to the headless profile and only when `CHROMIUM_FLAGS` is empty. Which agent-browser sessions land on which profile determines what the origin sees, and the answer is not visible from the client.
- **A fixed persistent profile.** Kernel uses one persistent `/home/kernel/user-data`. Profile continuity across agent-browser sessions is therefore a server-side property that the client does not control and should not assume is isolated.
- **The control plane is the security story, not the fingerprint.** The audited image forces `--remote-allow-origins=*`, runs its API as root, and bakes a CA private key into the image trust store. None of that changes what a *website* sees; all of it matters for what a *session* can reach. If agent-browser executes untrusted or model-generated code against a Kernel session, read handbook findings 2 and 3 together before deciding that is acceptable.

Practically: when using a remote provider, agent-browser is a **client of someone else's identity decisions**. The right posture is to measure what the provider actually emits rather than to reason about it from the client side, which §6 covers.

---

## 3. Four coherence findings worth fixing on their own merits

These are defects independent of detection. Each would be worth fixing if no bot control existed anywhere.

### 3.1 Mixed input provenance

The main interaction paths use CDP input — `Input.dispatchMouseEvent`, `dispatchKeyEvent`, `dispatchTouchEvent`, `insertText` (`interaction.rs:96, 169, 253, 337, 914, 954, 1097`; `actions.rs:5769, 5835, 7327`). Those produce `isTrusted === true`.

But several fast paths synthesize events in the page instead:

- `element.rs:1198` — sets `.value` directly, then fires `input` and `change`.
- `interaction.rs:154, 223, 455, 713-714, 832` — page-level `dispatchEvent(new Event(...))`.
- `actions.rs:8784` — `select.dispatchEvent(new Event('change', ...))`.

This is not an obscure fallback. The clear-field step that precedes ordinary typing (`interaction.rs:147-156`) runs `this.value = ''` plus a synthetic `input` via `Runtime.callFunctionOn`, and *then* types with trusted CDP key events. So the common path already mixes provenance within one action: untrusted clear, trusted keystrokes.

Two consequences, and the first is the one that will actually bite:

1. **Correctness.** Frameworks that track native setters — React's synthetic event system most notoriously — routinely ignore a bare `.value =` plus synthetic `input`. This is a well-known source of "the form filled but the app didn't notice" bugs. The failure is silent and looks like a flaky selector.
2. **Coherence.** A page that reads `event.isTrusted` sees a contradiction *within a single user action*, which is a sharper signal than uniformly untrusted input would be.

**Fix:** prefer real CDP input everywhere it works; keep the JS path as an explicit, logged fallback rather than a silent fast path; and assert the expected event sequence in tests. The handbook's *Native behavior beats broad spoofing* is the general form of this.

### 3.2 Identifying page globals

The React profiler injects, via `Page.addScriptToEvaluateOnNewDocument` (`react/mod.rs:11, 25`; `react/scripts.rs`):

```
window.__AB_RENDERS__          window.__AB_RENDERS_ACTIVE__
window.__AB_RENDERS_FPS__      window.__AB_RENDERS_START__
window.__AB_RENDERS_ORIG_COMMIT__
```

An `__AB_` prefix is exactly as identifying as ChromeDriver's `cdc_` properties or Puppeteer's `pptr:` source URLs — a unique, greppable string naming the tool. It is opt-in and scoped to React profiling, which limits the blast radius, but any site that has seen agent-browser once can detect it forever with a one-line check.

Note the contrast with `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` (`react/mod.rs:26`), also injected: that one is *plausible*, because millions of real developers have React DevTools installed. It blends into a real population. The `__AB_` globals do not.

**Fix:** move profiler state off `window` into a closure or an isolated world, or at minimum randomize the property name per session so it is not a stable string. Do this because leaking tool internals into page scope is bad hygiene — a page can read *and tamper with* `__AB_RENDERS_ORIG_COMMIT__` — not only because it is detectable.

### 3.3 No identity manifest

There is no single object that owns the relationship between browser version, platform, locale, timezone, viewport, GPU class, font corpus, proxy, and profile. Flags are assembled independently in `chrome.rs`, and nothing rejects a contradiction before launch.

This is the handbook's *One source of truth* principle, and its absence is what makes every other improvement fragile: a proxy in Frankfurt with a `America/Los_Angeles` timezone and an `en-US` locale is currently a configuration nobody will catch. Adding a manifest is the single highest-leverage structural change, because the cascade in §4 needs somewhere to record what each tier is allowed to change.

### 3.4 `--user-agent` overrides the string and nothing else

`browser.rs:435` and `browser.rs:1325` both issue:

```rust
"Emulation.setUserAgentOverride",
Some(json!({ "userAgent": ua })),
```

No `userAgentMetadata`. No `acceptLanguage`. No `platform`.

CDP's `setUserAgentOverride` accepts a `userAgentMetadata` object precisely so that UA Client Hints move with the UA string. Passing only `userAgent` changes the HTTP `User-Agent` header and `navigator.userAgent`, while `navigator.userAgentData.brands`, `.platform`, and `.mobile` keep reporting the real browser and OS. `Accept-Language` is untouched as well.

This is the handbook's named anti-pattern, verbatim:

> **Do not override only the UA string.** If a compatibility test requires a UA override, use a supported DevTools/automation API that also accepts UA metadata, then assert both request headers and JavaScript values.

Anyone who reaches for `--user-agent` today gets a client that contradicts itself on the first request — a *worse* position than not setting it at all, since the mismatch between UA and UA-CH is a stronger signal than an honest UA. It is also a correctness bug: server-side UA sniffing and client-side `userAgentData` checks in the same application will disagree.

**Fix:** populate `userAgentMetadata` from the identity manifest whenever `userAgent` is set, and reject a UA override that has no accompanying metadata rather than silently applying half of it.

---

## 4. The cascade

The proposal is a system that starts with the most agent-browser-native approach and falls back toward heavier, more faithful backends. That is a good architecture. Everything depends on what triggers the fallback.

### 4.1 Capability cascade — build this

Select the cheapest backend that can actually do the job, and promote when the *work* fails:

```text
Tier 0  Lightpanda / no-JS extraction
          promote on: JS-dependent content, missing DOM, render mismatch

Tier 1  Native CDP + headless Chrome, SwiftShader
          promote on: WebGL/canvas/video requirement, layout depends on GPU,
                      font/emoji rendering matters, extension required

Tier 2  Native CDP + headful Chrome, real display, hardware GPU, full font corpus
          promote on: needs a stable regional egress or a persistent profile

Tier 3  Remote provider (Kernel et al.) with a managed environment
          promote on: needs an environment the local host cannot provide
```

Every promotion here answers "the previous tier **could not do the work**." Those triggers are observable, loggable, and defensible. They are also exactly the triggers that make the system faster and cheaper, because tier 0 handles the majority of real work.

### 4.2 Enforcement cascade — do not build this

> **This is where the stated goal conflicts with the handbook, and the handbook is right.**

A cascade that promotes tiers *because a site denied, challenged, or blocked the previous attempt* is the pattern the handbook lists among its explicitly prohibited operating patterns:

> profile/proxy/fingerprint rotation after denial

and in the agent rules:

> MUST NOT rotate identity after enforcement.

"Retry with a different browser identity until one gets through" is enforcement evasion regardless of how the retry is implemented. It is also the specific behavior that turns a QA tool into something a site owner will describe to their lawyer as circumvention. That it is automated and tasteful does not change the character of the act.

The distinction is sharp and worth stating precisely:

| Trigger | Verdict |
|---|---|
| Page rendered blank; content requires JS | Promote |
| WebGL required, SwiftShader output insufficient | Promote |
| Selector never appeared; DOM lacks the element | Promote |
| Timeout, transport error, browser crash | Retry or promote |
| **HTTP 403 from a bot control** | **Stop** |
| **Interstitial or challenge page detected** | **Stop** |
| **429 rate limit** | **Honor `Retry-After`; do not switch identity** |
| **CAPTCHA appeared** | **Stop** |

A useful implementation test: *if the origin were a cooperating partner watching your logs, would this promotion embarrass you?* Capability promotions are boring. Enforcement promotions are the ones you would not want to explain.

### 4.3 The ambiguous cases, which are the ones that matter

The table above is clean because the examples are clean. Real triggers are not, and a cascade that only handles the clean cases will drift into enforcement-triggered promotion by accident. Three cases deserve explicit handling.

**A challenge that looks like a rendering failure.** Tier 0 fetches a page and gets almost no DOM. Is that an SPA that needs JS (promote) or a bot-control interstitial (stop)? Both look identical to a "did the content render" check. If the rule is "blank page → promote," then every JS challenge silently escalates the job to a real browser that will execute the challenge — an enforcement cascade wearing a capability cascade's clothes.

The fix is ordering: **run challenge detection first, and let it win.** A challenge classifier whose only output is `STOP` must be evaluated before any "content missing → promote" rule, not after. This is the single most important implementation detail in the whole cascade, and it is easy to get backwards because the capability rule is the one you write first.

**Headless fails, headful works.** The most common real promotion, and genuinely ambiguous. It could be that the site's layout needs a real compositor, or that video decode needs a real GPU — legitimate capability. Or the site detected headless — enforcement. Frequently you cannot tell from the outside.

Treat unexplained lower-tier failure as a **stop-and-log**, not an automatic promotion. If a specific origin turns out to have a real rendering requirement, record that in the per-origin policy and let the promotion happen because it was *decided*, not because it was *attempted*. "Promote and find out" is exactly how this boundary erodes: each individual promotion looks reasonable, and the aggregate is a retry-until-through loop.

**A 403 that is not a bot control.** Geo-restriction, expired credentials, and genuinely missing authorization all return 403, and only some are bot controls. Do not build a classifier that tries to tell them apart in order to decide whether to keep going. Default 403 to `STOP` and let the per-origin policy carve out the known-benign cases explicitly. A conservative default that occasionally halts a legitimate job is recoverable; a permissive default that occasionally evades enforcement is not.

The general principle: **when the trigger is ambiguous, the cascade must not promote.** Ambiguity resolving toward "try harder" is the failure mode, and it is a failure mode that produces no error message and no log line unless you build one.

### 4.4 The "known detectors" idea

Pre-classifying sites by which bot-control vendor protects them, in order to pre-select a stealthier tier, is enforcement evasion with the enforcement step cached. It moves the decision earlier in time; it does not change what the decision is. The same table applies.

There is a legitimate version of site-specific configuration, and it is worth building instead: a per-origin policy table recording **authorization** — which origins the operator owns or has written permission to automate, which credentials and rate limits apply, which are API-first, and which are simply out of scope. That table makes the system safer and is exactly what `policy.rs` is already shaped for.

### 4.5 Where this plugs in

`cli/src/native/policy.rs` already has the right primitive: an `ActionPolicy` returning `Allow`, `Deny`, or `RequiresConfirmation`, loaded from JSON, with an `AGENT_BROWSER_CONFIRM_ACTIONS` env override. Today it gates *actions*. Extend the same mechanism to gate origins and tier promotions, and the cascade gets an auditable policy layer instead of scattered conditionals.

There is currently **no** backend or provider cascade in the codebase. The only retry logic is transient IPC/daemon handling in `connection.rs:1005-1081`, which is unrelated. The cascade would be new construction, so it can be built with the stop-state in it from the first commit rather than retrofitted — which is the only time these boundaries actually hold.

---

## 5. What "undetectable" can and cannot mean here

Splitting the ask honestly:

**Available, valuable, and requires no one's permission — do all of this:**

- **Headful with a real display and hardware GPU.** Removes `--headless=new` from the AutomationControlled set, replaces SwiftShader with a real renderer, and fixes genuine rendering differences. Biggest single fidelity gain.
- **A real font corpus matched to the declared OS cohort.** Kernel's own history is the case study: commit `cba3f77` added fonts specifically because a three-font container was a signal. Match a cohort; do not install everything.
- **Persistent profiles with single ownership.** Already supported via `--user-data-dir`. Needs leasing, encryption, and a TTL — `storageState` and cookies are bearer credentials.
- **Stable egress per session.** Proxy support exists; egress *stability* and IPv6/DNS/WebRTC leak policy do not. A session whose ASN changes mid-flight is incoherent no matter how good the browser is.
- **Fix §3.1 and §3.2.** Correctness wins that also remove artifacts.
- **An identity manifest (§3.3)** that rejects contradictions before launch.

**Requires the site owner's express permission — and is already reachable, so the work is adding the gate:**

- Suppressing `AutomationControlled` via `--args "--disable-blink-features=AutomationControlled"`.
- Injecting property shims via `--init-script` or a plugin's `initScripts`.
- Overriding the UA via `--user-agent`.
- Patched control stacks (Patchright, rebrowser-patches) to hide CDP artifacts.
- Any synthetic-input humanization aimed at behavioral classifiers.

The first three are documented flags today (§2.1), with the suppression flag used as the help-text example and the `navigator.webdriver` shim shipped as a plugin test vector. So this is not a "should we build it" question. Three things are worth doing:

1. **Stop advertising it.** Change the `--args` example in `output.rs:3521` to something neutral like `--no-sandbox` or `--window-size=1920,1080`. A tool's help text is a recommendation, and right now it recommends the anti-pattern to every user who runs `--help`.
2. **Gate it.** These flags should require a per-origin authorization record naming the approving party — not a global `stealth: true`. The handbook's *Authorization assertion* example is the shape, and `policy.rs` is the natural home.
3. **Log it.** Any session that suppresses a truthful signal should say so in its output, so it appears in the record rather than only in someone's shell history.

**Not available at any tier:** solving or outsourcing challenges, rotating after denial, or presenting a synthetic persona to a third party that has not agreed to it.

### The declared-identity alternative

For an agent product specifically, the ceiling on evasion is falling while the ceiling on declaration is rising. The IETF chartered a [`webbotauth` working group](https://datatracker.ietf.org/group/webbotauth/), and [`draft-meunier-webbotauth-httpsig-protocol`](https://datatracker.ietf.org/doc/draft-meunier-webbotauth-httpsig-protocol/) applies [RFC 9421 HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421) so an automated client can *sign* its requests and be recognized as a known operator rather than guessed at.

For agent-browser this is a plausible product feature, not just a standards note: an operator-level signing key, a hosted key directory, and a `Signature-Agent` header would let cooperating origins grant access *because* it is an agent. Sites increasingly want to distinguish "an agent acting for a real user with a real account" from anonymous scraping, and they cannot do that if every agent looks like a browser pretending not to be one.

Calibrate the timeline honestly: the working group exists, but nothing has been adopted yet — there is no `draft-ietf-webbotauth-*` document, and the drafts were renamed once already in mid-2026. The `Signature-Agent` header has changed shape across revisions, so deployed verifiers and current drafts do not necessarily agree. This is a "track it and prototype" item, not a "ship it this quarter" item. But it is the direction to watch, and it is strictly better positioned than an evasion arms race the project cannot win against every vendor simultaneously.

---

## 6. Measure before optimizing

Nothing above should be taken on faith, including this document. The handbook's *Measurement and regression testing* chapter applies directly, and agent-browser has an advantage: `cli/src/doctor/` already exists as a place to put diagnostics.

Minimum useful harness:

1. **A first-party origin** that records what each backend actually emits: TLS ClientHello and JA4, ALPN, HTTP version, H2 SETTINGS and pseudo-header order, full header order, source IP and ASN. Never a third-party checker, and never with production credentials.
2. **A cross-context probe** asserting that UA, languages, platform, `hardwareConcurrency`, and timezone agree across page, iframe, dedicated worker, and service worker. This catches emulation that only applied to the main realm — the most common silent failure.
3. **A per-backend cohort baseline.** Native-headless, native-headful, Lightpanda, and each remote provider are *different cohorts*. A remote provider's output is a measurement of that provider, and it can change without notice, so re-baseline on a schedule rather than on suspicion.
4. **Positive and negative controls.** Include a plain WebDriver session with `navigator.webdriver === true` to prove the probe can see an intentional signal, and a stock browser to measure false positives.
5. **An `isTrusted` assertion** across every interaction verb, which would have caught §3.1 automatically.

Run these per Chrome release. Every version-specific claim in this document is a hypothesis with an expiry date.

---

## 7. Recommended order of work

1. Fix mixed input provenance (§3.1) — correctness bug, cheapest, highest immediate payoff.
2. Fix `--user-agent` to carry `userAgentMetadata`, or refuse the override (§3.4) — currently makes clients worse, not better.
3. Change the `--args` help-text example (§5) — a one-line diff that stops recommending the anti-pattern.
4. De-globalize the `__AB_` profiler state (§3.2) — small, contained hygiene fix.
5. Build the origin-side measurement harness (§6) — everything after this is guesswork without it.
6. Introduce the identity manifest (§3.3) — the structural prerequisite for the cascade and for §3.4's fix.
7. Build the capability cascade (§4.1) with the stop-state (§4.2) present from the first commit.
8. Add headful/hardware-GPU and font-cohort tiers (§5) — the largest fidelity gain.
9. Extend `policy.rs` to per-origin authorization, and gate the suppression flags behind it (§4.5, §5).
10. Track Web Bot Auth (§5) and prototype request signing when the drafts stabilize.

Items 1-5 are worth doing regardless of any position on detection. That is the tell that they are the right place to start.

---

## Closing

The handbook's closing rule applies here without modification: the durable advantage is not a bigger pile of evasions. For agent-browser specifically it is a coherent identity model, native protocol behavior, a cascade that promotes on capability and stops on enforcement, and a harness that catches contradictions before a site does.

The most valuable property agent-browser has right now is that it is honest by default. Whatever gets built on top, keep the stop-state — it is much easier to hold a boundary that was never crossed than to reintroduce one after the retry loop already works.
