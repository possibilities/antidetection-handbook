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
2. **Coherence bugs worth fixing on their own merits.** Mixed input provenance (§3.1), branded identifiers in page scope (§3.2), no identity manifest (§3.3), and a UA override that changes the string but not the Client Hints (§3.4). All four are defects regardless of detection; §3.4 currently leaves a client *worse off* than not using the flag.
3. **Suppressing truthful automation signals.** Requires the site owner's express permission per the handbook's own rules. Because this is already reachable, the work here is adding a gate and retiring the help-text recommendation — not building a feature (§5).

The cascade the project wants is a good idea, but §4 argues it should be inverted: select tiers from **declared task requirements** up front rather than promoting in response to **observed failures**. The reason is that "the tier couldn't do the work" and "the origin refused us" are indistinguishable from the outside — you see a failure and infer a cause — so a failure-driven cascade sorts on something nobody can actually observe. Requirements are observable; causes of failure are not.

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

**The default profile is a significant signal that no flag anyone chose produces.** Without `--profile`, `chrome.rs:473-478` creates `agent-browser-chrome-<uuid>` in the temp directory for each browser launch, and `Drop for ChromeProcess` (`chrome.rs:67-80`) deletes it with `remove_dir_all` when the process ends.

Be precise about the lifetime, because it cuts both ways. State *does* accumulate within a live session — the daemon holds one browser process across many commands, so cookies set on the third command are visible on the tenth. But every session begins from nothing and discards everything on close. There is no path by which a default-configured profile ever ages.

So the handbook's *state* layer — profile continuity, cookies, caches, service workers, permission decisions — is empty at the start of every session and permanently discarded at the end.

Resist ranking this against the §3 artifacts; they are different kinds of signal and the comparison misleads. A perpetually-new profile is **high-prevalence, low-specificity**: it is shared with every incognito window, every fresh install, and every CI browser in the world, so it places the client in a large suspicious cohort without identifying it. `__AB_RENDERS_ORIG_COMMIT__` is the reverse — **near-zero prevalence, specificity of 1.0** — one grep names this exact tool forever. That is the same prevalence lens §3.2 uses to argue `__REACT_DEVTOOLS_GLOBAL_HOOK__` is benign, and it has to be applied consistently: the profile is a strong cohort signal and a weak identity signal, the globals are the opposite. Both matter, for different reasons.

Persistent profiles are supported via `--profile`; they are simply not the default. Whether that default is right is a product decision — ephemerality is a genuine privacy and isolation feature — but it should be a deliberate one rather than a side effect.

The `--remote-debugging-port=0` choice deserves emphasis because it is easy to misread as incidental. Chromium special-cases it deliberately: port `0` is the ephemeral port ChromeDriver uses, so it counts as automation, whereas a fixed port is assumed to be a developer attaching a debugger and leaves the feature unset. The handbook covers this in *Automation signals and control stacks*. agent-browser therefore reports its automation status truthfully by default — the cooperative behavior, arrived at as a side effect.

**Protocol surface.** `Runtime.enable`, `Page.enable`, and `Network.enable` are issued on session setup (`browser.rs:657-708`, `actions.rs:2754-2760`, `state.rs:164-167`). `Runtime.enable` is the classic CDP tell. The V8 changes of May 2025 killed the popular `Error.stack` side-effect detector, but execution-context disclosure remains observable, and it is a hypothesis to re-measure per Chrome release rather than a settled fact.

**Snapshot.** `snapshot.rs` reads the accessibility tree over the protocol — `Accessibility.enable` then `Accessibility.getFullAXTree` (`snapshot.rs:228, 310, 315`). That is a protocol-side read and is **not** page-observable, which is a genuinely good design choice: the *accessibility read itself* costs nothing in page surface. Be precise about the scope of that praise, though — the `snapshot` verb as shipped is not free, because supplementary `Runtime.evaluate` and `Runtime.callFunctionOn` calls (`snapshot.rs:242, 469, 719, 817`) do execute in the page.

### 2.2 Native CDP backend, Lightpanda

`cli/src/native/cdp/lightpanda.rs` targets Lightpanda, which is not Chromium. It speaks enough CDP to drive, but it is a different engine with a different JavaScript runtime, no Blink rendering, and no Chrome TLS stack.

For detection purposes this is the **least** disguisable backend, and that is fine — it is a speed/cost play for content extraction where nobody is asking whether you are a browser. Treat it as a separate cohort with its own expectations rather than as a Chrome substitute. §4.1 selects Chrome over Lightpanda whenever a job declares it needs JS, which is the right behavior; the caveat is on the *results*, not the selection. Output gathered under Lightpanda and output gathered under Chrome are different measurement conditions, so record which tier produced a given result rather than treating the pair as interchangeable.

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

**These are where the correctness bug lives, and the mechanism is worth getting right** because the intuitive version is backwards. React does not miss the update because a native setter was bypassed; it misses it because a native setter was *not* used. React installs a `_valueTracker` that shadows `value` on the instance, so `this.value = x` runs through React's own tracked setter and updates its cached value in lockstep. When the synthetic `input` arrives, `updateValueIfChanged` compares node value to tracked value, finds them equal, and drops the event — `onChange` never fires, and React may overwrite the DOM value on its next render. For a controlled input the suppression should be deterministic rather than occasional, and the standard workaround is the inverse of the intuition: fetch `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set` and call it explicitly to defeat the tracker, *then* dispatch.

**This paragraph and the next are reasoning from React's source, not from an observed failure**, and they are load-bearing for the fix. React's tracker implementation has changed across major versions and the behaviour is not scoped here to any particular one. Before acting on this, write the two-line repro — a controlled input, `setvalue`, assert `onChange` fired — and pin the React version you observed. If the second paragraph below is wrong, the recommended fix is incomplete rather than merely unnecessary.

Two citations in that list are public API rather than defects, and shouldn't be read as such: `interaction.rs:832` implements the user-facing `dispatch_event(type, init)` verb, where emitting an untrusted event is the entire contract, and `select_option` has no CDP alternative because `Input` cannot drive a native `<select>`. The defect is the missing native-setter call, not the use of JavaScript.

**The `fill` path is a different problem.** The clear-field step at `interaction.rs:147-156` — inside `pub async fn fill` — runs `this.value = ''` plus a synthetic `input`, then writes the new value with `Input.insertText` (`interaction.rs:169`). Because `insertText` goes through the browser's own input machinery rather than the JS property, it desynchronizes the tracker and React re-syncs correctly. So the dropped clear event is harmless here: a correct event follows it.

What remains in `fill` is a provenance contradiction rather than a correctness bug — and a second artifact worth naming separately. `Input.insertText` produces a trusted `input` event but emits **no `keydown`, `keypress`, or `keyup` at all**. A page with a keystroke listener sees a value materialize without any keys being pressed. That is a sharper and more distinctive signal than an untrusted event, and it is invisible to any test that only asserts final field value.

**Fix:** for the three terminal-write sites, call the native prototype setter before dispatching. For `fill`, decide deliberately whether the verb should emit a key sequence — `insertText` is right for speed and wrong for anything testing key handling — and assert the expected event sequence either way. The handbook's *Native behavior beats broad spoofing* is the general form.

### 3.2 Branded identifiers and unmasked wrappers in page scope

Two separate injections put a stable, greppable tool name into page-reachable state. An `__AB_` or `_agentBrowser` prefix is exactly as identifying as ChromeDriver's `cdc_` properties or Puppeteer's `pptr:` source URLs: any site that has seen agent-browser once can detect it forever with a one-line check.

**The profiler globals.** `RENDERS_INIT` installs `__AB_RENDERS__`, `__AB_RENDERS_ACTIVE__`, `__AB_RENDERS_FPS__`, `__AB_RENDERS_START__`, and `__AB_RENDERS_ORIG_COMMIT__` (`react/scripts.rs`). These do require `--enable react-devtools`, since `RENDERS_INIT` early-returns without the DevTools hook (`react/scripts.rs:202`), and the hook is installed only under that flag (`actions.rs:3211-3228`, injected at `actions.rs:3223` and the CDP call at `browser.rs:1487`).

But **`vitals` is not React-gated**, and it carries the same prefix. `VITALS_INIT` installs `__AB_VITALS__`, `__AB_VITALS_INSTALLED__` (`react/scripts.rs:671-675`), and `__AB_REACT_TIMING__` (`:729`), and is injected at `actions.rs:7094` and `:7102`. The module's own docs call `vitals` a "universal verb" that is "framework-agnostic" and needs no DevTools hook (`react/mod.rs:1-7`). So the `__AB_` namespace reaches ordinary non-React pages, and the blast radius is wider than "React profiling."

The contrast with `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` is still instructive but works differently than it first appears: that global is *plausible* — millions of developers have React DevTools installed, so it blends into a real population — and it is also the flag-gated one. The distinctive global is the ungated one.

**The domain-filter script is the larger artifact, and it rides the security path.** With `--allowed-domains` set, `install_domain_filter_script` (`network.rs:161-183`) replaces **five** page APIs with wrappers — `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon` (`network.rs:346-400`). There is no `Function.prototype.toString` masking anywhere in the file, so all five report as non-native to a one-line check. `network.rs:299` also serializes the installer into worker bootstrap source via `_agentBrowserInstallDomainFilter.toString()`, placing the literal function name in page-reachable state.

`RTCPeerConnection` belongs in a separate category and it matters for the fix below. `network.rs:407-425` does not wrap it — it installs a constructor that throws unconditionally, with `prototype` set to a frozen null-prototype object and the global defined `writable:false, configurable:false`. That is a **hard block**, detectable by one `new` call or by descriptor inspection without any `toString` involved, and it is the only part of the domain filter that changes what a page can do: WebRTC simply breaks. It is also, per the comment at `chrome.rs:512-514`, the *primary* WebRTC containment control — the launch flag is the backstop.

This matters more than the profiler globals for a simple reason: it is attached to a *security* feature. Anyone restricting an agent to an origin allowlist — the cautious, recommended configuration — gets six unmasked monkeypatches and a branded identifier, while the careless user who skips `--allowed-domains` gets none of them. The safety feature is the loudest thing in the page.

**Fix, priced honestly.** A closure will not work for the `__AB_` state: `RENDERS_INIT` and `VITALS_INIT` are injected via `addScriptToEvaluateOnNewDocument` and their results are read by a *separate, later* `Runtime.evaluate` (`scripts.rs:209` writes, `:392` reads; `:675` writes, `:752` reads). Two independent evaluations cannot share a closure — the global **is** the channel between them, which is why it exists. An isolated world would work but is not cheap either: `grep` across `cli/src` returns zero hits for `createIsolatedWorld`, `worldName`, and `executionContextId`, so it means new CDP plumbing threaded through every evaluate call site.

The cheap paths are `Runtime.addBinding`, which gives page-to-client communication without a page global, or simply a per-launch randomized property name, which keeps the channel and destroys its value as a stable signature. Take the second unless the plumbing is wanted for other reasons. Separately, rename `_agentBrowserInstallDomainFilter` to something unbranded so the worker-bootstrap source stops carrying the tool's name — that one genuinely is a one-line change.

For the domain filter, **move the five HTTP-shaped wrappers to CDP `Fetch`/`Network` interception**. Nothing is patched, so nothing needs disguising, and enforcement gets stronger because page code cannot reach around it.

**The `RTCPeerConnection` block has to stay in the page, and that limit is not negotiable.** CDP's `Fetch` and `Network` domains intercept HTTP; a peer connection is not an HTTP request, and no CDP domain lets you refuse its construction. There is no protocol-layer replacement, so "move enforcement to CDP" covers five of six APIs and zero of the WebRTC control. Anyone implementing this needs to know that before they delete the in-page block and quietly remove the primary containment while believing they replaced it.

It is worth being explicit about the option *not* taken for the remaining in-page code: masking `Function.prototype.toString` would hide it, and that is the wrong fix twice over. The handbook classes exactly that shim as an anti-pattern — it must survive descriptor inspection, prototype ownership, illegal invocation, and every worker and cross-origin realm, and most such shims do not. And there is no authorization story for it, since the thing being concealed is a security control the operator deliberately enabled. A hard block that announces itself is the honest shape for a control the operator wants; leave it visible.

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

The proposal is a system that starts with the most agent-browser-native approach and falls back toward heavier, more faithful backends. That is a good architecture. Everything depends on what triggers the fallback — and the first thing to notice is that the trigger you want is not usually available to you.

**"Capability failure" and "enforcement" are not properties of the observation.** They are facts about the origin's internal state, and you never see that state. You see a failure and infer a cause. A blank page, a missing selector, and a navigation timeout are each produced by both an ordinary SPA and a bot control, and nothing in the response distinguishes them reliably. So a cascade that classifies *observed failures* is asking engineers to sort on something they cannot see, and §4.3's "when ambiguous, do not promote" rule then eats most of the cases — which, if failure-driven promotion were the only mechanism, would collapse the whole design into "never promote."

The way out is to notice which triggers *are* unambiguous. "This job needs WebGL" is knowable before you run anything: it is a property of the task, not an inference from a failure. So is "this job needs a persistent login," "this needs a regional egress," "this needs an extension." Requirements are observable; causes of failure are not.

Requirements still divide, though, and the split runs through the requirement list rather than through the tier ladder. **A requirement for horsepower** — GPU, compositor, extensions, real font metrics — is an ordinary capability need that tier selection can satisfy on its own. **A requirement for identity** — a regional egress, a specific ASN or geography, a provider-managed profile — is an authorization question wearing capability clothes, and it takes the §5 gate no matter which tier happens to supply it. §4.3 catches this at tier 3, where the two arrive together and the disguise is thickest, but the rule is not about tier 3: it belongs at every boundary, including a tier-2 job that declares it needs to egress from Frankfurt.

**So select tiers from declared task requirements, and treat failures as diagnostics rather than as promotion triggers.** This inverts the usual design and is the single most important structural recommendation in this document. It also happens to be faster: requirement-driven selection reaches the right tier on the first attempt instead of walking up the ladder.

### 4.1 Requirement-driven tier selection — build this

Each tier declares what it can do. A job declares what it needs. Selection is a match, computed before launch:

```text
Tier 0  Lightpanda / no-JS extraction
          provides: HTTP fetch, static content, no JS execution

Tier 1  Native CDP + headless Chrome, SwiftShader
          provides: JS execution, DOM, software canvas/WebGL, ephemeral profile

Tier 2  Native CDP + headful Chrome, real display, hardware GPU, full font corpus
          provides: hardware rendering, extensions, real font metrics,
                    persistent profile, compositor-dependent layout

Tier 3  Remote provider (Kernel et al.), managed environment
          provides: an environment the local host cannot supply
                    — see §4.3, this tier also changes identity
```

A job declaring `needs: [js, persistent-login]` selects tier 2 directly. A job declaring nothing starts at tier 0. The requirement list is a small, auditable artifact that belongs in the identity manifest (§3.3), and writing it down is most of the work — it forces the caller to say what the task actually needs instead of discovering it by failure.

**Failure-driven promotion still has a narrow, guarded place**, because requirements are sometimes discovered rather than known: a page turns out to need JS that the caller did not anticipate. Permit it only where the evidence is *positive and structural* rather than an absence — the response body contains script tags and a mount point, so the content is demonstrably JS-rendered — and never on a bare absence like "empty result" or "selector missing," which is precisely what a challenge also produces. Everything else is a stop-and-diagnose, per §4.3.

Note what this buys beyond correctness: the ambiguity problem does not arise for jobs that never fail. Requirement-driven selection is not just safer than failure-driven promotion, it is the faster architecture.

**One assumption to measure before committing to four tiers.** The cost case for a ladder rests on tier 0 handling most of the work, and nothing here establishes that. Worse, Lightpanda is not Chromium, so it will fail on ordinary sites for plain engine-incompleteness reasons — an unimplemented API, an unsupported CSS feature — and at the "did content render" layer those failures are shaped exactly like a challenge. The most frequent promotion in the system is therefore the one the safety rules are most likely to block, and the pressure to loosen the classifier will come from tier 0's ordinary gaps rather than from anyone trying to evade anything. Two consequences: measure the tier-0 hit rate before building the ladder, and make 0→1 promotion require an **engine-capability** signal (a thrown `not implemented`, a known-unsupported feature requested) rather than DOM emptiness. If the hit rate is low, the honest design is two tiers, not four.

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
| Navigation timeout | Retry within a per-origin budget; stop when the per-origin rate spikes while the fleet is healthy (§4.3) |
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

The obvious escape hatch — record the rendering requirement in per-origin policy, then let the promotion happen because it was *decided* rather than *attempted* — has a hole in it, and it is worth closing explicitly because it is the hatch this document recommends. The operator's only available basis for that policy entry is usually "headful worked and headless didn't," which is the same enforcement observation with a human inserted to relabel it. A human in the loop launders the evidence; it does not change it. The obvious patch is to require the entry to cite evidence independent of the failure that prompted it. Follow that through, though, and it dissolves into something shorter and more honest. The evidence you could cite is either a documented capability requirement — which, had it existed, you would have found *before* promoting rather than after — or an authorization fact: an operator-owned origin, a written agreement. So the ceremony of writing justifications into a policy file is not resolving the capability-versus-enforcement question at all. It is discovering that the question only has an answer when you have permission.

**The rule underneath, which is what to actually implement:**

> On origins you own or are expressly authorized against, promote freely — the ambiguity does not matter, because you are entitled to the access either way. On any other origin, never promote on an unexplained lower-tier failure.

That is one sentence, it is enforceable in `policy.rs` as an origin-class lookup rather than a free-text justification field, and it is honest about where the line actually falls.

**It also forces an admission the four-tier picture obscures.** Almost no third-party origin has an authorization record. So for most unowned traffic the ladder is not four tiers — it is tier 0 to tier 1 on declared requirements, and then stop. The upper half exists for origins you own, for authorized engagements, and for jobs whose requirements were declared up front. An engineer should know that before building four tiers and discovering that two of them are unreachable for the traffic they actually have.

**A 403 that is not a bot control.** Geo-restriction, expired credentials, and genuinely missing authorization all return 403, and only some are bot controls. Do not build a classifier that tries to tell them apart in order to decide whether to keep going. Default 403 to `STOP` and let the per-origin policy carve out the known-benign cases explicitly. A conservative default that occasionally halts a legitimate job is recoverable; a permissive default that occasionally evades enforcement is not.

The asymmetry with the challenge classifier above is deliberate, but the reason is not the one it is tempting to give. It would be neat to say "a challenge classifier only ever outputs `STOP`, so its errors fail safe" — and that is wrong. Only its *positive* output is `STOP`. Its negative output is silence, and silence falls through to whatever the default is. If the default is "content missing, so promote," then a missed challenge promotes straight into it: precisely the failure mode being refused for the 403 case one paragraph earlier.

The real asymmetry is about **defaults, not output vocabulary**. Both paths must default to stopping. 403 defaults `STOP` with narrow authorization-based carve-outs. Blank DOM must *also* default to `STOP`, with promotion requiring positive structural evidence of a JS-dependent page — a root-mount script tag, a recognized framework bundle, an engine-capability error from tier 0 — never the mere absence of content. Build classifiers whose *default* is halting, and the principle is actually implemented rather than asserted.

**Promotion into someone else's stealth profile.** This is the hole the three cases above do not close. §4.1's tier 3 promotes to a remote provider on "needs an environment the local host cannot provide," which quietly admits "the local host cannot provide a clean residential egress" as a *capability* trigger. And per §2.4, Kernel's headless profile ships a default stealth flag list. So the top of the cascade is *promote into a stealth configuration you did not write and cannot see* — reachable without ever authoring an enforcement rule, and phrased in capability language throughout.

Draw the line by what changes rather than by which tier you are entering: a promotion that buys **horsepower** (more GPU, more memory, a display) is a capability decision and belongs to the cascade; a promotion that changes **identity** — egress, ASN, geography, or a provider-supplied automation-suppression profile — is a stealth decision and takes the §5 authorization gate instead. Tier 3 usually does both at once, which is exactly why it needs to be split rather than waved through. In practice: enumerate what the provider's profile actually differs in before wiring it into a cascade, and if you cannot enumerate it, that is itself the finding.

**Enforcement disguised as a transient error.** The table treats timeouts, connection resets, and transport errors as retryable, which is correct in general and exploitable in particular: a bot control that drops connections or serves a 503 is indistinguishable from a flaky network at the single-request level. The distinguishing feature is not the individual failure but its *distribution* — enforcement concentrates on one origin while the rest of the fleet is healthy. Borrow the handbook's circuit breaker: track transient-failure rate per origin, and when it exceeds a threshold, escalate to the stop path rather than continuing to retry. A retry budget that is per-request rather than per-origin will happily grind against an origin that has already decided to refuse you.

**Learned tier preferences are the known-detector table, rediscovered.** The obvious optimization once a cascade exists is to remember which tier worked for which origin and start there next time. That is a pure win when the reason was capability. When the reason was detection, a cache of "origin X needs tier 3" is exactly the pre-classification §4.5 rejects — assembled by the system rather than by a person, which makes it harder to notice and no different in effect. If you build tier memoization, key it on the *recorded reason* for the promotion and refuse to memoize anything whose reason was unexplained or enforcement-adjacent. This is the strongest argument for logging a structured reason on every promotion: without one, you cannot implement this rule, and the cache silently becomes the thing you said you would not build.

The general principle: **when the trigger is ambiguous, the cascade must not promote.** Ambiguity resolving toward "try harder" is the failure mode, and it produces no error message and no log line unless you build one.

### 4.4 What "stop" has to mean, or nobody will honor it

A rule that only says *stop* will be removed by the first engineer whose job needs doing. If the cascade halts and the caller simply gets a failure, the pressure to add "just one more tier" is enormous and eventually irresistible — so the stop path needs a destination, not just a brake.

Make `STOP` produce a **diagnostic and a decision point**, not a dead end: what was attempted, at which tier, what was observed, why it was classified as enforcement rather than capability, and what an operator's options are. Those options are legitimate and worth enumerating in the output, because they are what makes the boundary survivable — request access or an API key from the origin; use an official API if one exists; run against an owned staging instance instead; confirm the origin is in scope at all; or decide the job should not run.

This is also where the handbook's human-in-the-loop boundary sits, and it is narrower than it first looks. A human deciding *whether to seek authorization* is an ordinary business decision and entirely appropriate. A human being handed the challenge to solve so the automation can continue is the thing both documents prohibit. The difference is whether the person is exercising judgment about the engagement or acting as a CAPTCHA-solving subroutine.

Designed this way, the stop-state stops being the component everyone routes around.

### 4.5 The "known detectors" idea

Pre-classifying sites by which bot-control vendor protects them, in order to pre-select a stealthier tier, is enforcement evasion with the enforcement step cached. It moves the decision earlier in time; it does not change what the decision is. The same table applies.

There is a legitimate version of site-specific configuration, and it is worth building instead: a per-origin policy table recording **authorization** — which origins the operator owns or has written permission to automate, which credentials and rate limits apply, which are API-first, and which are simply out of scope. That table makes the system safer and is exactly what `policy.rs` is already shaped for.

### 4.6 Where this plugs in

`cli/src/native/policy.rs` already has the right primitive: an `ActionPolicy` returning `Allow`, `Deny`, or `RequiresConfirmation`, loaded from JSON, with an `AGENT_BROWSER_CONFIRM_ACTIONS` env override. Today it gates *actions*. Extend the same mechanism to gate origins and tier promotions, and the cascade gets an auditable policy layer instead of scattered conditionals.

There is currently **no backend or provider cascade** in the codebase — I searched for one specifically. Retry and fallback logic does exist elsewhere (transient IPC handling in `cli/connection.rs:1005-1081`, daemon respawn in `main.rs:1675`, download retry in `install.rs:256`, accessibility-tree re-query in `element.rs:345` and `:516`, and a content-extraction fallback ladder in `read.rs`), but none of it switches backend or provider. The cascade would be new construction, so it can be built with the stop-state in it from the first commit rather than retrofitted — which is the only time these boundaries actually hold.

---

## 5. What "undetectable" can and cannot mean here

Splitting the ask honestly requires a test, because the obvious objection to any such split is that it is rationalization. Every item in the first pile below *does* make the browser harder to detect. If "harder to detect" were the criterion, the piles would collapse into one.

**The test is whether a change makes a true statement true, or makes a false statement plausible — where "true" is measured against the environment actually running.** That second clause is not decoration; without it the test collapses. Installing a macOS font corpus into a Linux container makes a trivially true statement true (those files are on disk) that was chosen precisely to make a false one plausible (this is a Mac). Font corpora are a fingerprinting surface *because* they correlate with OS, so "matched to the declared cohort" only passes when the declared cohort is the environment you are actually in. That is just the handbook's *Truthful cohorts* rule — "must describe the environment actually running" — applied to this document's own recommendations.

With the referent fixed, the sorting works. A real GPU means the browser genuinely renders with that GPU. Fonts matched to the real OS mean it genuinely has them. Nothing asserted becomes false under inspection. By contrast `--disable-blink-features=AutomationControlled` makes a truthful signal report falsely, `--user-agent` without metadata makes the client contradict itself on the first request, and a macOS font corpus on Linux is a claim about a machine that does not exist. First-pile work also **degrades gracefully** where second-pile work breaks: a font cohort that drifts with an OS update is slightly stale, while a shim that drifts is a contradiction. (Drift still happens — §6 exists because of it.)

Two things the test does not do. It says nothing about **motive**, and one case genuinely needs motive to sort: a persistent profile is authentically aged whether you are testing session continuity or manufacturing an appearance of humanity, and no property of the change distinguishes those. That case is irreducible; call it a judgment call rather than pretending the test covers it. And a sufficiently complete first pile does converge on "indistinguishable from an ordinary browser" — which is the point, not a loophole, because an authorized automation client *is* an ordinary browser operated by someone with permission. The test only stops working if you are laundering second-pile changes through first-pile language, which is why the gate on the second list matters more than the list itself.

**Available, valuable, and requires no one's permission — do all of this:**

- **Headful with a real display and hardware GPU.** Buys rendering, compositor, GPU and font fidelity, and fixes genuine layout differences. Biggest single fidelity gain — and it buys **zero** reduction in automation signalling. `--remote-debugging-port=0` sets `AutomationControlled` independently (§2.1), so dropping `--headless=new` removes one of two sufficient causes and `navigator.webdriver` stays `true`. That is exactly why this belongs in pile 1: it improves fidelity without touching a truthful signal. Anyone expecting it to quiet `webdriver` has misread the flag table.
- **A real font corpus matched to the OS actually running.** Kernel's own history is the case study: commit `cba3f77` added fonts specifically because a three-font container was a signal. Match the real platform, not a platform you would prefer to present, and do not install everything — an implausibly complete corpus is its own outlier.
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

One ranked list would need three incompatible sort keys — cheapness, severity, and whether the change is observable enough to need a baseline first. So here are two lists.

### No-regret: ship without waiting for anything

These are small, independently justified, and do not depend on a measurement baseline or a policy decision.

1. **Gate `--force-webrtc-ip-handling-policy` on `proxy.is_some() || !allowed_domains.is_empty()`** (§5). Today a proxied session without `--allowed-domains` leaks the real IP over UDP. This half is a genuine one-liner with no page surface. Note the *other* half is not: `install_domain_filter_script` early-returns on an empty allowlist (`network.rs:166-168`), so extending the in-page `RTCPeerConnection` block to proxy-only sessions means new injection plumbing and breaking WebRTC for people who wanted a proxy and nothing else. That is a product decision, not a fix — see item 9.
2. **Make the three terminal synthetic writes call the native prototype setter** (§3.1) — silent correctness bug in React apps.
3. **Reject a `--user-agent` override that carries no metadata** (§3.4). Today the flag leaves clients worse off than not using it; refusing it is a strict improvement and needs nothing else. *Populating* `userAgentMetadata` is the better fix but depends on the manifest, so it lands with item 6.
4. **Rename `_agentBrowserInstallDomainFilter`** so worker-bootstrap source stops carrying the tool's name (§3.2), and randomize the `__AB_` property names per launch. Both are cheap; the isolated-world version is not, and is not required.
5. **Change the `--args` help-text example** (§5). One line, and it stops the tool recommending the anti-pattern to everyone who runs `--help`.

### Gated: needs the harness or a decision first

6. **Build the origin-side measurement harness** (§6), covering all six cohorts including `read`. Everything below changes observable behavior, and without a baseline you cannot tell a fix from a regression.
7. **Introduce the identity manifest** (§3.3) — prerequisite for the cascade, for item 3's better half, and for any cohort claim. Needs a field list and an owner; it is a subsystem, not a task.
8. **Move the five HTTP-shaped domain-filter wrappers to CDP `Fetch`/`Network` interception** (§3.2). The `RTCPeerConnection` hard block stays in the page — no CDP domain replaces it.
9. **Decide the throwaway-profile default** (§2.1) and whether proxied sessions lose WebRTC (item 1). Both are product decisions with real tradeoffs — ephemerality is a privacy feature, and persistent profiles need leasing, encryption, and a TTL, which is three subsystems in a clause.
10. **Build requirement-driven tier selection** (§4.1) with the stop-state (§4.2), the identity/horsepower split applied at every boundary (§4.3), and a diagnostic stop path (§4.4) from the first commit. Measure the tier-0 hit rate before committing to four tiers.
11. **Add headful/hardware-GPU and font-cohort tiers** (§5) — the largest fidelity gain, and the one most in need of a baseline to prove it worked.
12. **Extend `policy.rs` to per-origin authorization** (§4.6, §5), gating the suppression flags. The handbook's authorization record is a ready-made schema; cite it rather than inventing one.
13. **Track Web Bot Auth** (§5); prototype signing on `read` first, since it has no browser stack to reconcile.

The property worth protecting through all of it is that agent-browser is honest by default. `--remote-debugging-port=0` arrived at the cooperative behavior by accident, and every finding above is fixable without giving that up.
