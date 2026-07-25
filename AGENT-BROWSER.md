# agent-browser: detection surfaces and identity coherence

**A companion to [The Antidetection Handbook](./README.md), specific to [`possibilities--agent-browser`](https://agent-browser.dev).**

> **Snapshot:** 2026-07-25. Claims below were read from the working tree at that date and cite `path:line`. Line numbers drift; re-read before relying on any of them.

The handbook is general. This document answers a narrower question: *what does agent-browser actually look like on the wire and in the page today, and what should be built next?*

Claims cite `path:line`. Where the answer is "this does not exist," it says so — and where I searched for something and found nothing, it says that too, since the two are different.

---

## 1. The short version

agent-browser's native backend is **not** trying to hide, and currently could not hide if it wanted to. It launches Chrome with `--remote-debugging-port=0`, which sets Chromium's `AutomationControlled` runtime feature, which makes `navigator.webdriver` return `true`. Add `--headless=new`, `Runtime.enable`, and a fresh throwaway profile on every launch, and any site that looks at all sees automation.

On Linux and in CI the picture is starker still — software rendering and a container font corpus put a recognizable cohort on top of the automation signals. On a developer's macOS or Windows machine it is milder: the SwiftShader routing is Linux-gated (`cfg!(target_os = "linux")` at `chrome.rs:418`), so those hosts keep hardware Metal/D3D backends and the real OS font corpus.

That is a defensible default. What complicates the picture is that the *defaults* are honest while the *configuration surface* is not: `--args`, `--init-script`, and `--user-agent` already let anyone suppress those signals, the help text uses `--disable-blink-features=AutomationControlled` as its worked example, and the plugin protocol ships a `navigator.webdriver` shim as a test vector (§2.1). Nothing gates any of it.

So the available work splits into three piles.

1. **Fidelity work that is also correctness work.** Real GPU, headful, real fonts, persistent profile, stable egress, coherent locale/timezone. These make the browser genuinely more ordinary rather than pretending to be, they fix real rendering bugs, and none of them require anyone's permission. This is where nearly all the value is.
2. **Coherence bugs worth fixing on their own merits.** Mixed input provenance (§3.1), identifying page globals (§3.2), no identity manifest (§3.3), and a UA override that changes the string but not the Client Hints (§3.4). All four are defects regardless of detection; §3.4 currently leaves a client *worse off* than not using the flag.
3. **Suppressing truthful automation signals.** Requires the site owner's express permission per the handbook's own rules. Because this is already reachable, the work here is adding a gate and retiring the help-text recommendation — not building a feature (§5).

The cascade the project wants is a good idea, but it has to select on **capability**, not on **enforcement**. §4 works through that distinction and the cases where it genuinely blurs.

---

## 2. What each backend actually presents

### 2.1 Native CDP backend, local Chrome

`cli/src/native/cdp/chrome.rs` builds the launch line. The identity-relevant flags:

| Flag | Line | Consequence |
|---|---|---|
| `--remote-debugging-port=0` | `chrome.rs:398` | **Sets `AutomationControlled`.** `navigator.webdriver === true`. |
| `--headless=new` | `chrome.rs:444` | Also sets `AutomationControlled`; no platform windows; skipped when extensions are loaded. |
| `--use-angle=vulkan`, `--use-vulkan=swiftshader`, `--use-webgpu-adapter=swiftshader` | `chrome.rs:424-426` | Forces software rendering — but only under `options.webgpu && cfg!(target_os = "linux")`. macOS and Windows keep hardware Metal/D3D. |
| `--enable-unsafe-swiftshader` | `chrome.rs:456` | *Permissive, not forcing.* Allows the software fallback so WebGL doesn't hard-fail where drivers are absent (`chrome.rs:452-455`). On a host with a working GPU it changes nothing observable. |
| `--user-data-dir=…` | `chrome.rs:470, 477` | Persistence when `--profile` is given. **Absent it, every launch mints a fresh `agent-browser-chrome-<uuid>` temp profile** (`chrome.rs:473-478`) — see below. |
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

**The default profile may be the loudest signal in the whole system, and it is not a flag anyone chose.** Without `--profile`, `chrome.rs:473-478` creates `agent-browser-chrome-<uuid>` in the temp directory for each browser launch, and `Drop for ChromeProcess` (`chrome.rs:67-80`) deletes it with `remove_dir_all` when the process ends.

Be precise about the lifetime, because it cuts both ways. State *does* accumulate within a live session — the daemon holds one browser process across many commands, so cookies set on the third command are visible on the tenth. But every session begins from nothing and discards everything on close. There is no path by which a default-configured profile ever ages.

So the handbook's *state* layer — profile continuity, cookies, caches, service workers, permission decisions — is empty at the start of every session and permanently discarded at the end. A browser that is always brand new, on a first-run timestamp seconds old, is a more durable signal than any of the JavaScript artifacts in §3, and unlike those it is not a bug anyone introduced. Persistent profiles are supported via `--profile`; they are simply not the default. Whether that default is right is a product decision, but it should be a deliberate one.

The `--remote-debugging-port=0` choice deserves emphasis because it is easy to misread as incidental. Chromium special-cases it deliberately: port `0` is the ephemeral port ChromeDriver uses, so it counts as automation, whereas a fixed port is assumed to be a developer attaching a debugger and leaves the feature unset. The handbook covers this in *Automation signals and control stacks*. agent-browser therefore reports its automation status truthfully by default — the cooperative behavior, arrived at as a side effect.

**Protocol surface.** `Runtime.enable`, `Page.enable`, and `Network.enable` are issued on session setup (`browser.rs:657-708`, `actions.rs:2754-2760`, `state.rs:164-167`). `Runtime.enable` is the classic CDP tell. The V8 changes of May 2025 killed the popular `Error.stack` side-effect detector, but execution-context disclosure remains observable, and it is a hypothesis to re-measure per Chrome release rather than a settled fact.

**Snapshot.** `snapshot.rs` reads the accessibility tree over the protocol — `Accessibility.enable` then `Accessibility.getFullAXTree` (`snapshot.rs:228, 310, 315`). That is a protocol-side read and is **not** page-observable, which is a genuinely good design choice: the primary perception path costs nothing in page surface. Supplementary `Runtime.evaluate` and `Runtime.callFunctionOn` calls (`snapshot.rs:242, 469, 719, 817`) do execute in the page.

### 2.2 Native CDP backend, Lightpanda

`cli/src/native/cdp/lightpanda.rs` targets Lightpanda, which is not Chromium. It speaks enough CDP to drive, but it is a different engine with a different JavaScript runtime, no Blink rendering, and no Chrome TLS stack.

For detection purposes this is the **least** disguisable backend, and that is fine — it is a speed/cost play for content extraction where nobody is asking whether you are a browser. Treat it as a separate cohort with its own expectations rather than as a Chrome substitute. §4.1 promotes from here to Chrome as tier 0 → 1, which is the right behavior; the caveat is on the *results*, not the promotion. Output gathered under Lightpanda and output gathered under Chrome are different measurement conditions, so record which tier produced a given result rather than treating the pair as interchangeable.

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

### 2.5 `read` — the backend that isn't a browser

`agent-browser read` does not drive a browser at all. `cli/src/read.rs` fetches over `reqwest` with `rustls-tls-webpki-roots` (`cli/Cargo.toml:25`) and sends a self-describing User-Agent:

```rust
const USER_AGENT_VALUE: &str = concat!("agent-browser/", env!("CARGO_PKG_VERSION"), " read");
```

That is `read.rs:13`, sent at `read.rs:331`. This is a fifth cohort with a JA3/JA4 nothing like Chrome's — rustls, not BoringSSL — and no browser identity whatsoever.

Two things follow. First, it belongs in the §6 measurement matrix as its own baseline; a harness that only profiles the CDP backends will miss it entirely. Second, and worth noticing: **`read` already does what §5 recommends.** It identifies itself honestly, in the header a site actually reads, with a version string an operator could allowlist. It is the declared-identity posture, shipped, in the cheapest code path in the project. If the argument in §5 seems abstract, this is the concrete precedent — and the obvious place to attach a Web Bot Auth signature first, since it has no browser stack to reconcile.

---

## 3. Four coherence findings worth fixing on their own merits

These are defects independent of detection. Each would be worth fixing if no bot control existed anywhere.

### 3.1 Mixed input provenance

The main interaction paths use CDP input — `Input.dispatchMouseEvent`, `dispatchKeyEvent`, `dispatchTouchEvent`, `insertText` (`interaction.rs:96, 169, 253, 337, 914, 954, 1097`; `actions.rs:5769, 5835, 7327`). Those produce `isTrusted === true`.

But several fast paths synthesize events in the page instead:

Three sites end a write with a synthetic event and no trusted event after it:

- `element.rs:1180-1199` — `set_element_value`, reached only from the `setvalue` command (`actions.rs:6722`).
- `interaction.rs:455` — `select_option`.
- `actions.rs:8784` — `select.dispatchEvent(new Event('change', ...))`.

**These are where the correctness bug lives, and the mechanism is worth getting right** because the intuitive version is backwards. React does not miss the update because a native setter was bypassed; it misses it because a native setter was *not* used. React installs a `_valueTracker` that shadows `value` on the instance, so `this.value = x` runs through React's own tracked setter and updates its cached value in lockstep. When the synthetic `input` arrives, `updateValueIfChanged` compares node value to tracked value, finds them equal, and drops the event — `onChange` never fires, and React may overwrite the DOM value on its next render. For a controlled input the suppression is deterministic, not occasional. The standard workaround is the inverse of the intuition: fetch `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set` and call it explicitly to defeat the tracker, *then* dispatch.

Two citations in that list are public API rather than defects, and shouldn't be read as such: `interaction.rs:832` implements the user-facing `dispatch_event(type, init)` verb, where emitting an untrusted event is the entire contract, and `select_option` has no CDP alternative because `Input` cannot drive a native `<select>`. The defect is the missing native-setter call, not the use of JavaScript.

**The `fill` path is a different problem.** The clear-field step at `interaction.rs:147-156` — inside `pub async fn fill` — runs `this.value = ''` plus a synthetic `input`, then writes the new value with `Input.insertText` (`interaction.rs:169`). Because `insertText` goes through the browser's own input machinery rather than the JS property, it desynchronizes the tracker and React re-syncs correctly. So the dropped clear event is harmless here: a correct event follows it.

What remains in `fill` is a provenance contradiction rather than a correctness bug — and a second artifact worth naming separately. `Input.insertText` produces a trusted `input` event but emits **no `keydown`, `keypress`, or `keyup` at all**. A page with a keystroke listener sees a value materialize without any keys being pressed. That is a sharper and more distinctive signal than an untrusted event, and it is invisible to any test that only asserts final field value.

**Fix:** for the three terminal-write sites, call the native prototype setter before dispatching. For `fill`, decide deliberately whether the verb should emit a key sequence — `insertText` is right for speed and wrong for anything testing key handling — and assert the expected event sequence either way. The handbook's *Native behavior beats broad spoofing* is the general form.

### 3.2 Branded identifiers and unmasked wrappers in page scope

Two separate injections put a stable, greppable tool name into page-reachable state. An `__AB_` or `_agentBrowser` prefix is exactly as identifying as ChromeDriver's `cdc_` properties or Puppeteer's `pptr:` source URLs: any site that has seen agent-browser once can detect it forever with a one-line check.

**The profiler globals.** `RENDERS_INIT` installs `__AB_RENDERS__`, `__AB_RENDERS_ACTIVE__`, `__AB_RENDERS_FPS__`, `__AB_RENDERS_START__`, and `__AB_RENDERS_ORIG_COMMIT__` (`react/scripts.rs`). These do require `--enable react-devtools`, since `RENDERS_INIT` early-returns without the DevTools hook (`react/scripts.rs:202`), and the hook is installed only under that flag (`actions.rs:3211-3228`, injected at `actions.rs:3223` and the CDP call at `browser.rs:1487`).

But **`vitals` is not React-gated**, and it carries the same prefix. `VITALS_INIT` installs `__AB_VITALS__`, `__AB_VITALS_INSTALLED__` (`react/scripts.rs:671-675`), and `__AB_REACT_TIMING__` (`:729`), and is injected at `actions.rs:7094` and `:7102`. The module's own docs call `vitals` a "universal verb" that is "framework-agnostic" and needs no DevTools hook (`react/mod.rs:1-7`). So the `__AB_` namespace reaches ordinary non-React pages, and the blast radius is wider than "React profiling."

The contrast with `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` is still instructive but works differently than it first appears: that global is *plausible* — millions of developers have React DevTools installed, so it blends into a real population — and it is also the flag-gated one. The distinctive global is the ungated one.

**The domain-filter script is the larger artifact, and it rides the security path.** With `--allowed-domains` set, `install_domain_filter_script` (`network.rs:161-183`) replaces `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon`, and `RTCPeerConnection` with wrappers (`network.rs:346-426`). There is no `Function.prototype.toString` masking anywhere in the file, so all six report as non-native to a one-line check. Worse, `network.rs:299` serializes the installer into worker bootstrap source via `_agentBrowserInstallDomainFilter.toString()`, placing the literal function name in page-reachable state.

This matters more than the profiler globals for a simple reason: it is attached to a *security* feature. Anyone restricting an agent to an origin allowlist — the cautious, recommended configuration — gets six unmasked monkeypatches and a branded identifier, while the careless user who skips `--allowed-domains` gets none of them. The safety feature is the loudest thing in the page.

**Fix:** move profiler and vitals state off `window` into a closure or isolated world, and rename `_agentBrowserInstallDomainFilter` to something unbranded so the worker-bootstrap source stops carrying the tool's name.

For the domain filter itself, **move enforcement to CDP `Fetch`/`Network` interception** rather than page-level wrappers. It is worth being explicit about the option not taken: masking `Function.prototype.toString` on the six wrappers would hide them, and that is the wrong fix twice over. The handbook classes exactly that shim as an anti-pattern — it has to survive descriptor inspection, prototype ownership, illegal invocation, and every worker and cross-origin realm, and most such shims do not. And there is no authorization story for it, because the thing being concealed is a security control the operator chose to enable. Protocol-level interception has neither problem: nothing is patched, so nothing needs disguising, and the enforcement is stronger because page code cannot reach around it.

The reason to do any of this is hygiene before fingerprinting. A page can currently read *and tamper with* `__AB_RENDERS_ORIG_COMMIT__`, and can enumerate which of the operator's security controls are active — both are defects whatever a detector does with them.

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

"Retry with a different browser identity until one gets through" is enforcement evasion regardless of how the retry is implemented.

**Be precise about what the rule constrains.** Every tier in §4.1 *is* a different identity — different GPU, fonts, egress, profile, sometimes a different engine. Promotion is therefore always identity rotation, and the quoted rule does no work on the act itself. The entire distinction rests on the **trigger**. A cascade cannot be made compliant by changing how it switches identities; only by constraining what causes it to.

| Trigger | Verdict |
|---|---|
| Page rendered blank; content requires JS | Promote |
| WebGL required, SwiftShader output insufficient | Promote |
| Selector never appeared; DOM lacks the element | Promote |
| Transport error or browser crash | Retry at the same tier |
| Navigation timeout | Stop and log — see §4.3, a challenge with a delay loop presents exactly this way |
| **HTTP 403 from a bot control** | **Stop** |
| **Interstitial or challenge page detected** | **Stop** |
| **429 rate limit** | **Honor `Retry-After`; do not switch identity** |
| **CAPTCHA appeared** | **Stop** |

Every row above is a clean case. The cascade will not fail on those — it will fail on the ambiguous ones below.

### 4.3 The ambiguous cases, which are the ones that matter

The table above is clean because the examples are clean. Real triggers are not, and a cascade that only handles the clean cases will drift into enforcement-triggered promotion by accident. Three cases deserve explicit handling.

**A challenge that looks like a rendering failure.** Tier 0 fetches a page and gets almost no DOM. Is that an SPA that needs JS (promote) or a bot-control interstitial (stop)? Both look identical to a "did the content render" check. If the rule is "blank page → promote," then every JS challenge silently escalates the job to a real browser that will execute the challenge — an enforcement cascade wearing a capability cascade's clothes.

The fix is ordering: **run challenge detection first, and let it win.** A challenge classifier whose only output is `STOP` must be evaluated before any "content missing → promote" rule, not after. This is the single most important implementation detail in the whole cascade, and it is easy to get backwards because the capability rule is the one you write first.

**Headless fails, headful works.** The most common real promotion, and genuinely ambiguous. It could be that the site's layout needs a real compositor, or that video decode needs a real GPU — legitimate capability. Or the site detected headless — enforcement. Frequently you cannot tell from the outside.

Treat unexplained lower-tier failure as a **stop-and-log**, not an automatic promotion. "Promote and find out" is exactly how this boundary erodes: each individual promotion looks reasonable, and the aggregate is a retry-until-through loop.

The obvious escape hatch — record the rendering requirement in per-origin policy, then let the promotion happen because it was *decided* rather than *attempted* — has a hole in it, and it is worth closing explicitly because it is the hatch this document recommends. The operator's only available basis for that policy entry is usually "headful worked and headless didn't," which is the same enforcement observation with a human inserted to relabel it. A human in the loop launders the evidence; it does not change it. So require the entry to cite evidence **independent of the failure that prompted it** — a documented WebGL or video requirement, an authorization record, an operator-owned origin — and to name that evidence in the policy file. If the only justification is "the lower tier got blocked," that is not a capability finding no matter who writes it down.

**A 403 that is not a bot control.** Geo-restriction, expired credentials, and genuinely missing authorization all return 403, and only some are bot controls. Do not build a classifier that tries to tell them apart in order to decide whether to keep going. Default 403 to `STOP` and let the per-origin policy carve out the known-benign cases explicitly. A conservative default that occasionally halts a legitimate job is recoverable; a permissive default that occasionally evades enforcement is not.

The asymmetry with the challenge classifier above is deliberate, not a contradiction: build one, don't build the other. A challenge classifier's only output is `STOP`, so its errors fail safe. A 403 classifier's output is permission to continue, so its errors fail toward proceeding against an origin that refused. Build classifiers whose failure mode is halting.

**Promotion into someone else's stealth profile.** This is the hole the three cases above do not close. §4.1's tier 3 promotes to a remote provider on "needs an environment the local host cannot provide," which quietly admits "the local host cannot provide a clean residential egress" as a *capability* trigger. And per §2.4, Kernel's headless profile ships a default stealth flag list. So the top of the cascade is *promote into a stealth configuration you did not write and cannot see* — reachable without ever authoring an enforcement rule, and phrased in capability language throughout.

Draw the line by what changes rather than by which tier you are entering: a promotion that buys **horsepower** (more GPU, more memory, a display) is a capability decision and belongs to the cascade; a promotion that changes **identity** — egress, ASN, geography, or a provider-supplied automation-suppression profile — is a stealth decision and takes the §5 authorization gate instead. Tier 3 usually does both at once, which is exactly why it needs to be split rather than waved through. In practice: enumerate what the provider's profile actually differs in before wiring it into a cascade, and if you cannot enumerate it, that is itself the finding.

**Enforcement disguised as a transient error.** The table treats timeouts, connection resets, and transport errors as retryable, which is correct in general and exploitable in particular: a bot control that drops connections or serves a 503 is indistinguishable from a flaky network at the single-request level. The distinguishing feature is not the individual failure but its *distribution* — enforcement concentrates on one origin while the rest of the fleet is healthy. Borrow the handbook's circuit breaker: track transient-failure rate per origin, and when it exceeds a threshold, escalate to the stop path rather than continuing to retry. A retry budget that is per-request rather than per-origin will happily grind against an origin that has already decided to refuse you.

**Learned tier preferences are the known-detector table, rediscovered.** The obvious optimization once a cascade exists is to remember which tier worked for which origin and start there next time. That is a pure win when the reason was capability. When the reason was detection, a cache of "origin X needs tier 3" is exactly the pre-classification §4.4 rejects — assembled by the system rather than by a person, which makes it harder to notice and no different in effect. If you build tier memoization, key it on the *recorded reason* for the promotion and refuse to memoize anything whose reason was unexplained or enforcement-adjacent. This is the strongest argument for logging a structured reason on every promotion: without one, you cannot implement this rule, and the cache silently becomes the thing you said you would not build.

The general principle: **when the trigger is ambiguous, the cascade must not promote.** Ambiguity resolving toward "try harder" is the failure mode, and it produces no error message and no log line unless you build one.

### 4.4 The "known detectors" idea

Pre-classifying sites by which bot-control vendor protects them, in order to pre-select a stealthier tier, is enforcement evasion with the enforcement step cached. It moves the decision earlier in time; it does not change what the decision is. The same table applies.

There is a legitimate version of site-specific configuration, and it is worth building instead: a per-origin policy table recording **authorization** — which origins the operator owns or has written permission to automate, which credentials and rate limits apply, which are API-first, and which are simply out of scope. That table makes the system safer and is exactly what `policy.rs` is already shaped for.

### 4.5 Where this plugs in

`cli/src/native/policy.rs` already has the right primitive: an `ActionPolicy` returning `Allow`, `Deny`, or `RequiresConfirmation`, loaded from JSON, with an `AGENT_BROWSER_CONFIRM_ACTIONS` env override. Today it gates *actions*. Extend the same mechanism to gate origins and tier promotions, and the cascade gets an auditable policy layer instead of scattered conditionals.

There is currently **no backend or provider cascade** in the codebase — I searched for one specifically. Retry and fallback logic does exist elsewhere (transient IPC handling in `cli/connection.rs:1005-1081`, daemon respawn in `main.rs:1675`, download retry in `install.rs:256`, accessibility-tree re-query in `element.rs:345` and `:516`, and a content-extraction fallback ladder in `read.rs`), but none of it switches backend or provider. The cascade would be new construction, so it can be built with the stop-state in it from the first commit rather than retrofitted — which is the only time these boundaries actually hold.

---

## 5. What "undetectable" can and cannot mean here

Splitting the ask honestly requires a test, because the obvious objection to any such split is that it is rationalization. Every item in the first pile below *does* make the browser harder to detect. If "harder to detect" were the criterion, the piles would collapse into one.

**The test is whether a change makes a true statement true, or makes a false statement plausible.** Installing a font corpus means the browser genuinely has those fonts. Using a real GPU means it genuinely renders with that GPU. A persistent profile genuinely accumulates the history it reports. Nothing is asserted that is not the case, and the browser would survive arbitrarily deep inspection because there is nothing underneath to find. By contrast, `--disable-blink-features=AutomationControlled` makes a truthful signal report falsely, and `--user-agent` without metadata makes the client contradict itself on the first request. Those are claims about a browser that does not exist.

This is the same line the handbook draws with *Native behavior beats broad spoofing* and *Truthful cohorts beat arbitrary personas*, and it has a practical corollary: first-pile work is durable because reality does not drift out from under it, while second-pile work breaks on every browser release.

Two honest concessions. The test is about the change, not the motive, so it does not discriminate by intent — and at the margin intent does matter. An aged profile is genuinely aged, but if the reason for aging it is to pass for a human rather than to test session continuity, that is closer to the line than a real GPU is, whatever the mechanism. And a sufficiently complete first pile does converge on "indistinguishable from an ordinary browser," which is the point: an authorized automation client *is* an ordinary browser, run by someone with permission. The test stops being useful only if you are trying to launder the second pile through the first, which is why the gate in the second list matters more than the list itself.

**Available, valuable, and requires no one's permission — do all of this:**

- **Headful with a real display and hardware GPU.** Removes `--headless=new` from the AutomationControlled set, replaces SwiftShader with a real renderer, and fixes genuine rendering differences. Biggest single fidelity gain.
- **A real font corpus matched to the declared OS cohort.** Kernel's own history is the case study: commit `cba3f77` added fonts specifically because a three-font container was a signal. Match a cohort; do not install everything.
- **Persistent profiles with single ownership.** Already supported via `--user-data-dir`. Needs leasing, encryption, and a TTL — `storageState` and cookies are bearer credentials.
- **Stable egress per session, and fix the WebRTC trigger.** Proxy support exists; egress *stability* and IPv6/DNS policy do not. A session whose ASN changes mid-flight is incoherent no matter how good the browser is. WebRTC containment *does* exist and is well built — `chrome.rs:510-517` forces `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` and `retain`s away any user override so it cannot be weakened, and `network.rs:405-427` blocks `RTCPeerConnection` in-page. But both gate on `restrict_webrtc`, which `actions.rs:2938` and `:3707` define as `!allowed_domains.is_empty()`. **The leak protection is wired to `--allowed-domains`, not to `--proxy`**, so a proxied session without domain filtering — the natural way to use a proxy — leaks the real IP over UDP. Gate it on proxy configuration instead, or on both.
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
3. **A per-backend cohort baseline.** Native-headless, native-headful, Lightpanda, WebDriver, `read`, and each remote provider are *different cohorts* — six kinds of client, not one. `read` is the easiest to forget and the most distinctive, since its rustls handshake looks nothing like Chrome's. A remote provider's output is a measurement of that provider and can change without notice, so re-baseline on a schedule rather than on suspicion.
4. **Positive and negative controls.** Include a plain WebDriver session with `navigator.webdriver === true` to prove the probe can see an intentional signal, and a stock browser to measure false positives.
5. **An `isTrusted` assertion** across every interaction verb, which would have caught §3.1 automatically.

Run these per Chrome release. Every version-specific claim in this document is a hypothesis with an expiry date.

---

## 7. Recommended order of work

1. **Re-gate WebRTC containment on proxy configuration** (§5) — today a proxied session without `--allowed-domains` leaks the real IP over UDP. A real leak, and the smallest diff on this list.
2. Fix the three terminal synthetic writes to call the native prototype setter (§3.1) — silent correctness bug in React apps.
3. Fix `--user-agent` to carry `userAgentMetadata`, or refuse the override (§3.4) — currently makes clients worse, not better.
4. Change the `--args` help-text example (§5) — a one-line diff that stops recommending the anti-pattern.
5. Move domain-filter enforcement to CDP `Fetch`/`Network` interception (§3.2) — removes six page-level wrappers and the branded identifier outright, and is harder for page code to reach around. Do not mask `toString` instead; that is the anti-pattern, not the fix.
6. De-globalize the `__AB_` profiler and vitals state (§3.2).
7. Build the origin-side measurement harness (§6), covering all five cohorts including `read` — everything after this is guesswork without it.
8. Introduce the identity manifest (§3.3) — the structural prerequisite for the cascade and for item 3's fix.
9. Reconsider the throwaway-profile default (§2.1) — persistent profiles are supported but off, and a perpetually-new browser is a louder signal than anything in §3.
10. Build the capability cascade (§4.1) with the stop-state (§4.2) and the tier-3 identity/horsepower split (§4.3) present from the first commit.
11. Add headful/hardware-GPU and font-cohort tiers (§5) — the largest fidelity gain.
12. Extend `policy.rs` to per-origin authorization, and gate the suppression flags behind it (§4.5, §5).
13. Track Web Bot Auth (§5); prototype signing on `read` first, since it has no browser stack to reconcile.

Items 1-5 are worth doing regardless of any position on detection, which is why they come first: they need no policy decision to justify them.

The property worth protecting through all of it is that agent-browser is honest by default. `--remote-debugging-port=0` arrived at the cooperative behavior by accident, and every finding above is fixable without giving that up.
