# agent-browser: detection surfaces and identity coherence

**A companion to [The Antidetection Handbook](./README.md), specific to [`possibilities--agent-browser`](https://agent-browser.dev).**

> **Snapshot:** 2026-07-25. Claims below were read from the working tree at that date and cite `path:line`. Line numbers drift; re-read before relying on any of them.

The handbook is general. This document answers a narrower question: *what does agent-browser actually look like on the wire and in the page today, and what should be built next?*

Claims cite `path:line`. Where the answer is "this does not exist," it says so — and where I searched for something and found nothing, it says that too, since the two are different.

---

## 1. The short version

agent-browser's native backend is **not** trying to hide, and currently could not hide if it wanted to. It launches Chrome with `--remote-debugging-port=0`, which sets Chromium's `AutomationControlled` runtime feature, which makes `navigator.webdriver` return `true`. Add `--headless=new`, `Runtime.enable`, and a fresh throwaway profile on every launch, and any site that looks at all sees automation.

In GPU-less containers and CI the picture is starker still — software rendering and a thin container font corpus add a recognizable cohort on top of the automation signals. On a developer's own machine it is milder: the SwiftShader *routing* is gated on `options.webgpu && cfg!(target_os = "linux")` (`chrome.rs:418`), so a macOS or Windows host keeps hardware Metal/D3D and the real OS font corpus. What every headless launch gets is the permissive `--enable-unsafe-swiftshader`, which changes nothing where a working GPU exists.

That is a defensible default — for the **local Chrome path**. The picture changes twice over.

First, the configuration surface is not honest even locally: `--args`, `--init-script`, and `--user-agent` let anyone suppress those signals, the help text uses `--disable-blink-features=AutomationControlled` as its worked example, and the plugin protocol ships a `navigator.webdriver` shim as a test vector (§2.1). Nothing gates any of it.

Second, and more importantly: **the Browserless provider requests stealth by default.** `BROWSERLESS_STEALTH` defaults to `true` (`providers.rs:325-327`) and is sent in every session-creation body, and the Kernel provider defaults to the headless profile that carries Kernel's stealth flag list (§2.4). Both are documented product features — `KERNEL_STEALTH`'s own documentation reads "Enable stealth mode to avoid bot detection." So "agent-browser is honest by default" is true of the native backend and false of at least one provider path, and a user reaching a remote provider gets signal suppression without ever typing the word.

So the available work splits into three piles.

1. **Fidelity work that is also correctness work.** Real GPU, headful, real fonts, persistent profile, stable egress, coherent locale/timezone. These make the browser genuinely more ordinary rather than pretending to be, and they fix real rendering bugs. They do not *inherently* suppress automation signals — but that is a narrower claim than "needs no permission," because any of them can still be enforcement-conditioned, and §5 sorts that on three axes rather than one. This is where nearly all the value is.
2. **Coherence bugs worth fixing on their own merits.** Mixed input provenance (§3.1), branded identifiers in page scope (§3.2), no identity manifest (§3.3), and a UA override that changes the string but not the Client Hints (§3.4). All four are defects regardless of detection; §3.4 currently leaves a client *worse off* than not using the flag.
3. **Suppressing truthful automation signals.** Requires the site owner's express permission per the handbook's own rules. Because this is already reachable, the work here is adding a gate and retiring the help-text recommendation — not building a feature (§5).

The cascade the project wants is a good idea, but §4 argues it should be inverted: select tiers from **declared task requirements** up front rather than promoting in response to **observed failures**. The reason is that "the tier couldn't do the work" and "the origin refused us" are indistinguishable from the outside — you see a failure and infer a cause — so a failure-driven cascade sorts on something nobody can actually observe. Requirements can be established before contact; causes of failure cannot be established at all.

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

The **native Chrome launch line** carries no stealth flag. That is a narrower statement than it looks, and §2.4 covers the provider paths where it stops being true.

Even for local Chrome, the repo ships a complete suppression *surface*, and its own help text advertises it:

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

**One sharp edge inside `--profile` itself.** It persists only in its *path* form. Given a Chrome profile **name**, `chrome.rs:557-573` locates your real Chrome user-data directory, **copies** the profile to a temp dir, and rewrites the option to point at the copy — then hands that temp dir to `ChromeProcess.temp_user_data_dir` (`chrome.rs:588`), where the same `Drop` deletes it. So `agent-browser --profile Default` reads your existing login state and discards every write the session makes. That is defensible as a safety property (your real profile is never mutated) but it is the opposite of what "persistent profile" implies, and anyone reaching for `--profile` to build continuity needs to pass a path.

The `--remote-debugging-port=0` choice deserves emphasis because it is easy to misread as incidental. Chromium special-cases it deliberately: port `0` is the ephemeral port ChromeDriver uses, so it counts as automation, whereas a fixed port is assumed to be a developer attaching a debugger and leaves the feature unset. The handbook covers this in *Automation signals and control stacks*. The local native Chrome path therefore reports its automation status truthfully by default — the cooperative behavior, arrived at as a side effect. §2.4 covers where that stops being true.

**Protocol surface.** `Runtime.enable`, `Page.enable`, and `Network.enable` are issued on session setup (`browser.rs:657-708`, `actions.rs:2754-2760`, `state.rs:164-167`). `Runtime.enable` is the classic CDP tell. The V8 changes of May 2025 killed the popular `Error.stack` side-effect detector, but execution-context disclosure remains observable, and it is a hypothesis to re-measure per Chrome release rather than a settled fact.

**Snapshot.** `snapshot.rs` reads the accessibility tree over the protocol — `Accessibility.enable` then `Accessibility.getFullAXTree` (`snapshot.rs:228, 310, 315`). That is a protocol-side read and is **not** page-observable, which is a genuinely good design choice: the *accessibility read itself* costs nothing in page surface. Be precise about the scope of that praise, though — the `snapshot` verb as shipped is not free, because supplementary `Runtime.evaluate` and `Runtime.callFunctionOn` calls (`snapshot.rs:242, 469, 719, 817`) do execute in the page.

### 2.2 Native CDP backend, Lightpanda

`cli/src/native/cdp/lightpanda.rs` targets Lightpanda, which is not Chromium. It speaks enough CDP to drive, but it is a different engine with a different JavaScript runtime, no Blink rendering, and no Chrome TLS stack.

For detection purposes this is the **least** disguisable backend, and that is fine — it is a speed/cost play for content extraction where nobody is asking whether you are a browser. Treat it as a separate cohort with its own expectations rather than as a Chrome substitute. §4.1 selects Chrome over Lightpanda whenever a job declares it needs JS, which is the right behavior; the caveat is on the *results*, not the selection. Output gathered under Lightpanda and output gathered under Chrome are different measurement conditions, so record which tier produced a given result rather than treating the pair as interchangeable.

### 2.3 WebDriver backend

`cli/src/native/webdriver/backend.rs`, with `appium.rs` for mobile. WebDriver sets the `webdriver-active` flag by specification — `navigator.webdriver` is `true` and is *supposed* to be. This is the most standards-cooperative backend in the project.

### 2.4 Remote providers, including Kernel

`cli/src/native/providers.rs` resolves a CDP WebSocket URL for `browserbase`, `browserless`, `browser-use`, `kernel`, `agentcore`, and plugin providers (`providers.rs:50-195`). The Kernel path (`connect_kernel`, `providers.rs:393`) talks to `https://api.onkernel.com` (`providers.rs:396`, overridable via `KERNEL_ENDPOINT`) and returns a WebSocket the client drives.

**The providers are where "honest by default" stops being true, and it is not subtle.** `connect_browserless` reads `BROWSERLESS_STEALTH` and defaults it to **`true`** (`providers.rs:325-327`), sending `"stealth": true` in every session-creation body (`:338`) unless the operator explicitly opts out. Kernel has the parallel `KERNEL_STEALTH` (`providers.rs:403`, default `false`, sent at `:413`).

These are not accidents or leftovers. They are documented product features: `README.md:1649` lists `BROWSERLESS_STEALTH` with default `true`, and `README.md:1725` describes `KERNEL_STEALTH` as *"Enable stealth mode to avoid bot detection."* The provider docs pages repeat both.

So the accurate statement about this project is: **the local Chrome path is honest by default; the Browserless path requests stealth by default.** A user who types `agent-browser --provider browserless open <url>` has asked a third-party service to suppress automation signals against an origin, without ever seeing the word "stealth," and with no authorization gate anywhere in the path. That belongs in §5's second pile, and flipping the default is a smaller diff than anything currently on the no-regret list.

**The rest of the Kernel path is the closest link to the handbook — but keep the evidence honest.** The Kernel provider talks to a hosted service; the handbook audits Kernel's *public image* and explicitly disclaims visibility into hosted control planes and private layers. The client proves only which endpoint and options it requests. It cannot establish the hosted image digest, whether the API runs as root there, what CA material exists, or which flags are effective. So treat the audit as a **comparator** for the hosted backend rather than a description of it, and require provider attestation or first-party measurement before importing its conclusions. With that caveat, three items are operationally significant:

- **Headless and headful are asymmetric, and the client chooses — badly, by default.** Kernel's "headless+stealth" default flag list applies only to the headless profile and only when `CHROMIUM_FLAGS` is empty. agent-browser selects the profile via `KERNEL_HEADLESS`, defaulting to **`true`** (`providers.rs:400-402`, posted at `:411-415`). So the default Kernel session lands on precisely the profile that carries the stealth flag list. `KERNEL_STEALTH` defaulting to `false` does not offset this: the two are separate knobs, and the flag list travels with the headless profile regardless.
- **A fixed persistent profile, partly client-selected.** Kernel uses one persistent `/home/kernel/user-data`, and the client can name a profile via `KERNEL_PROFILE_NAME` (`providers.rs:417-424`). Profile continuity is therefore *influenced* by the client but owned by the server — do not assume a session is isolated from previous ones just because you did not ask for continuity.
- **The control plane is the security story, not the fingerprint.** The audited image forces `--remote-allow-origins=*`, runs its API as root, and bakes a CA private key into the image trust store. None of that changes what a *website* sees; all of it matters for what a *session* can reach. If agent-browser executes untrusted or model-generated code against a Kernel session, read handbook findings 2 and 3 together before deciding that is acceptable.

Practically: when using a remote provider, agent-browser is a **client of someone else's identity decisions**. The right posture is to measure what the provider actually emits rather than to reason about it from the client side, which §6 covers.

---

### 2.5 `read` — the backend that isn't a browser

`agent-browser read` does not drive a browser at all. `cli/src/read.rs` fetches over `reqwest` with `rustls-tls-webpki-roots` (`cli/Cargo.toml:25`) and sends a self-describing User-Agent:

```rust
const USER_AGENT_VALUE: &str = concat!("agent-browser/", env!("CARGO_PKG_VERSION"), " read");
```

That is `read.rs:13`, sent at `read.rs:331`. This is a fifth cohort with a JA3/JA4 nothing like Chrome's — rustls, not BoringSSL — and no browser identity whatsoever.

This applies to the **URL-argument form only**. `handle_read` (`actions.rs:4237-4278`) has two shapes: given a URL it calls `run_read` (`:4249`), the reqwest path described here; given no URL it makes no HTTP request at all, instead extracting from the browser's already-fetched HTML via `read_json_from_active_html` (`:4274`) and requiring a live browser. So `read` never launches or escalates to a browser — the framing holds — but in the no-URL form neither the rustls handshake nor the honest UA ever happens, because there is no request.

Two things follow. First, the URL form belongs in the §6 measurement matrix as its own baseline; a harness that only profiles the CDP backends will miss it entirely. Second, and worth noticing with one caveat: **`read` already does the transparent half of what §5 recommends.** It self-identifies honestly in the header a site actually reads. But a UA string is *not* declared identity in the sense §5 means — any client can send those bytes, so it is unauthenticated self-description, useful for courtesy and log correlation and useless as an allowlist key. Reserve "declared identity" for authenticated credentials and signatures. If the argument in §5 seems abstract, this is the concrete precedent — and the obvious place to attach a Web Bot Auth signature first, since it has no browser stack to reconcile.

---

## 3. Four coherence findings worth fixing on their own merits

These are defects independent of detection. Each would be worth fixing if no bot control existed anywhere.

### 3.1 Mixed input provenance

The main interaction paths use CDP input — `Input.dispatchMouseEvent`, `dispatchKeyEvent`, `dispatchTouchEvent`, `insertText` (`interaction.rs:96, 169, 253, 337, 914, 954, 1097`; `actions.rs:5769, 5835, 7327`). Those produce `isTrusted === true`.

But several fast paths synthesize events in the page instead:

Four sites end a write with a synthetic event and no trusted event after it:

- `element.rs:1180-1199` — `set_element_value`, reached from the `setvalue` command (`actions.rs:6722`).
- `interaction.rs:710-714` — the `clear` verb, reached from `actions.rs:2316` via `handle_clear` (`actions.rs:6511`). Sets `this.value = ''` and fires synthetic `input` and `change`, then returns with no CDP `Input` call.
- `interaction.rs:455` — `select_option`.
- `actions.rs:8784` — `select.dispatchEvent(new Event('change', ...))`.

Note that `clear` is the same code as the clear-*step* inside `fill` discussed below, but with a decisive difference: in `fill` a trusted `Input.insertText` follows and repairs it, whereas the standalone `clear` verb ends there.

**Measured, and the answer is not what this section originally claimed** — see [`lab/FINDINGS.md`](./lab/FINDINGS.md), experiment E04, against pinned React 18.3.1.

Two of those four sites are **unreachable**. `"setvalue"` and `"clear"` appear only in the daemon dispatch table (`actions.rs:2316`, `:2326`); no shipped client emits either action, not `commands.rs`, not `mcp.rs`, not `main.rs`. They are latent defects in code nothing can call. That was caught by a control rather than by reading: the first run invoked them as CLI verbs, they silently did nothing, and every assertion "passed" with the DOM unchanged and zero events fired.

The one reachable synthetic write — `select` — **does** reach React. Dispatching a bare `change` event updated React state (`selChanges=1`) and the value survived a forced rerender. The `_valueTracker` dedup applies to text inputs, where React reads the `input` event; `<select>` change handling does not go through it.

So the mechanism below is real, and worth understanding, but it does not currently bite any path a user can reach. React misses an update because a native setter was *not* used: `_valueTracker` shadows `value` on the instance, so `this.value = x` runs through React's own tracked setter and updates its cache in lockstep; when the synthetic `input` arrives, `updateValueIfChanged` finds no delta and drops the event. The workaround is the inverse of the intuition — call `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set` explicitly, *then* dispatch.

**What this changes.** This section should not claim a live correctness bug, and fixing the four sites does not belong on a no-regret list. What survives is dead code that would be a defect if wired up, plus the provenance finding below — which is independent and did reproduce.

**The `fill` path is a different problem, and it reproduced.** Native capture listeners recorded, for a single `fill`:

```
input:false    beforeinput:true    input:true
```

An untrusted `input` from the clear step (`interaction.rs:147-156`), followed by trusted events from `Input.insertText` (`interaction.rs:169`). One logical action emitting both provenances. React itself is fine — `insertText` writes through the browser rather than the JS property, so the tracker desynchronizes and React re-syncs — but the mixed signature is real and observable.

What remains in `fill` is a provenance contradiction rather than a correctness bug — and a second artifact worth naming separately. `Input.insertText` produces a trusted `input` event but emits **no `keydown`, `keypress`, or `keyup` at all**. A page with a keystroke listener sees a value materialize without any keys being pressed. That is a sharper and more distinctive signal than an untrusted event, and it is invisible to any test that only asserts final field value.

**Fix:** for the four terminal-write sites, call the native prototype setter before dispatching. For `fill`, decide deliberately whether the verb should emit a key sequence — `insertText` is right for speed and wrong for anything testing key handling — and assert the expected event sequence either way. The handbook's *Native behavior beats broad spoofing* is the general form.

### 3.2 Branded identifiers and unmasked wrappers in page scope

Several separate injections put a stable, greppable tool name into page-reachable state, and the DOM mutations are the ones most likely to be on. Beyond the two script injections below, the snapshot and locator paths write branded **attributes and nodes** into the live document: `data-agent-browser-located` on semantic-locator targets (`actions.rs:8084`, queried at `:8111`, removed at `:8123`), `data-__ab-ci` on cursor-enriched snapshots, and an `__agent_browser_annotations__` overlay element for screenshots. A `MutationObserver` sees every one of them, and unlike the profiler globals these ride ordinary snapshot and click flows rather than an opt-in flag.

They are also a correctness risk, not only an observability one: the cleanup at `:8123` strips the attribute unconditionally, so a page that already used `data-agent-browser-located` for its own purposes loses it. Prefer backend node IDs or `Runtime.callFunctionOn` object references over marking the DOM at all; failing that, preserve any prior value and use a per-operation random suffix. An `__AB_` or `_agentBrowser` prefix is exactly as identifying as ChromeDriver's `cdc_` properties or Puppeteer's `pptr:` source URLs: any site that has seen agent-browser once can detect it forever with a one-line check.

**The profiler globals.** `RENDERS_INIT` installs `__AB_RENDERS__`, `__AB_RENDERS_ACTIVE__`, `__AB_RENDERS_FPS__`, `__AB_RENDERS_START__`, and `__AB_RENDERS_ORIG_COMMIT__` (`react/scripts.rs`). These do require `--enable react-devtools` (or its `react` alias, `actions.rs:3222`), since `RENDERS_INIT` early-returns without the DevTools hook (`react/scripts.rs:202-203`), and the hook is installed only under that flag (`actions.rs:3211-3228`, injected at `actions.rs:3223` and the CDP call at `browser.rs:1487`).

But **`vitals` is not React-gated**, and it carries the same prefix. `VITALS_INIT` installs `__AB_VITALS__`, `__AB_VITALS_INSTALLED__` (`react/scripts.rs:671-675`), and `__AB_REACT_TIMING__` (`:729`), and is injected at `actions.rs:7094` and `:7102`. The module's own docs call `vitals` a "universal verb" that is "framework-agnostic" and needs no DevTools hook (`react/mod.rs:1-7`). So the `__AB_` namespace reaches ordinary non-React pages, and the blast radius is wider than "React profiling."

The contrast with `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` is still instructive but works differently than it first appears: that global is *plausible* — millions of developers have React DevTools installed, so it blends into a real population — and it is also the flag-gated one. The distinctive global is the ungated one.

**The domain-filter script is the larger artifact, and it rides the security path.** With `--allowed-domains` set, `install_domain_filter_script` (`network.rs:161-183`) replaces **five** page APIs with wrappers — `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon` (`network.rs:346-406`). There is no `Function.prototype.toString` masking anywhere in the file, so all five report as non-native to a one-line check. `network.rs:299` also serializes the installer into worker bootstrap source via `_agentBrowserInstallDomainFilter.toString()`, placing the literal function name in page-reachable state.

`RTCPeerConnection` belongs in a separate category and it matters for the fix below. `network.rs:407-425` does not wrap it — it installs a constructor that throws unconditionally, with `prototype` set to a frozen null-prototype object and the global defined `writable:false, configurable:false`. That is a **hard block**, detectable by one `new` call or by descriptor inspection without any `toString` involved, and it is the only part of the domain filter that changes what a page can do: WebRTC simply breaks. It is also, per the comment at `chrome.rs:512-514`, the *primary* WebRTC containment control — the launch flag is the backstop.

This matters more than the profiler globals for a simple reason: it is attached to a *security* feature. Anyone restricting an agent to an origin allowlist — the cautious, recommended configuration — gets five unmasked monkeypatches, a hard-blocked constructor, and a branded identifier, while the careless user who skips `--allowed-domains` gets none of them. The safety feature is the loudest thing in the page.

**Fix, priced honestly.** A closure will not work for the `__AB_` state: `RENDERS_INIT` and `VITALS_INIT` are injected via `addScriptToEvaluateOnNewDocument` and their results are read by a *separate, later* `Runtime.evaluate` (`scripts.rs:209` writes, `:392` reads; `:675` writes, `:752` reads). Two independent evaluations cannot share a closure — the global **is** the channel between them, which is why it exists. An isolated world would work but is not cheap either: `grep` across `cli/src` returns zero hits for `createIsolatedWorld`, `worldName`, and `executionContextId`, so it means new CDP plumbing threaded through every evaluate call site.

The cheap paths are `Runtime.addBinding`, which gives page-to-client communication without a page global at all, or a per-launch randomized property name, which keeps the channel and destroys its value as a stable signature.

**Split these by purpose, though, because they are not the same kind of change.** Removing page-readable and page-tamperable state, and preserving a page's own colliding attribute values, are straightforward correctness and hygiene: they make the tool interfere less with the document, and they would be worth doing if no detector existed. *Randomizing or debranding an identifier* is different — its entire function is to reduce observability, and a high-entropy per-session property can even add identifying surface. That belongs behind §5's purpose-and-trigger axis rather than in the permission-neutral pile. `Runtime.addBinding` is the better answer precisely because it removes the state instead of disguising it.

Renaming `_agentBrowserInstallDomainFilter` sits on the line: dropping a vendor name from worker-bootstrap source is mostly hygiene, but do it because tool internals should not be in page scope, not because it is harder to grep.

For the domain filter, the honest task is **"prove which wrappers are redundant,"** not "move them to CDP." An earlier draft said the five HTTP-shaped wrappers could move to `Fetch`/`Network` interception and nothing would be patched. That is wrong, and the code says so itself: `install_domain_filter` already installs **both** layers, and its doc comment (`network.rs:456-467`) states the JS layer exists precisely "for APIs outside Fetch interception, including workers, WebSocket, EventSource, sendBeacon, and RTCPeerConnection." Four of the five are documented as beyond Fetch's reach, and the script also wraps `Worker`, `SharedWorker`, and `importScripts`, which §3.2's inventory did not count.

Realistically only `fetch` and `XMLHttpRequest` are candidates for removal, and even that needs proof rather than assumption. Before deleting any layer, build a parity matrix — page × same-origin iframe × OOPIF × popup × dedicated/shared/service worker, crossed with fetch, XHR, WebSocket, EventSource, beacon, and redirect — and show the protocol layer actually covers the cell. Removing a wrapper that CDP does not replace converts an observability improvement into a containment hole.

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

**`--user-agent` is not the worst instance — the shipped presets are.** `set device` routes through the same string-only setter (`actions.rs:7350-7369`), and its preset table installs full **iOS Safari** UA strings on a **Chromium** engine:

```
"iphone 16" => (393, 852, 3.0, true,
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 …
   Version/18.0 Mobile/15E148 Safari/604.1")
```

**What actually happens is measured, not inferred** — see [`lab/FINDINGS.md`](./lab/FINDINGS.md), experiment E03. An earlier draft of this section said `navigator.userAgentData` keeps reporting Chromium brands. It does not. On Chrome 150:

| surface | stock | `--user-agent` set | `set device "iPhone 16"` |
|---|---|---|---|
| request `User-Agent` | `…HeadlessChrome/150…` | the override | iOS Safari string |
| request `Sec-CH-UA` | 3 brands | **absent** | **absent** |
| `navigator.userAgent` | matches header | matches header | matches header |
| `userAgentData.brands` | 3 brands | **`[]`** | **`[]`** |

Chrome does not leave stale hints — it **suppresses Client Hints entirely** and empties the brands array, and `navigator.userAgent` follows the override faithfully. So the defect is real but differently shaped than described, and arguably worse: the result is a UA string with *no* Client Hints at all, which is a combination no real Chrome 150 produces on a secure origin. An absence is harder to notice than a contradiction, and trivially checkable by a detector.

**The contradiction that does survive is in the hardware.** Same run, `set device "iPhone 16"`:

```
navigator.userAgent : Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 …) Safari/604.1
webgl.renderer      : ANGLE (Apple, ANGLE Metal Renderer: Apple M4, …)
```

An iPhone rendering through Metal on a desktop M4. That is the citable contradiction; the UA-CH story was the wrong one to tell. Treat the exact `userAgentData` outcome as version-specific and re-measure it rather than reasoning about it — that is precisely the claim that was wrong here.

Two further defects in the preset table itself: the Android entries hardcode `Chrome/130.0.0.0` regardless of which executable is actually running, and native `set device` does not enable touch emulation, so a "mobile" persona still reports no touch points.

**A second leak: new tabs navigate before they are configured.** `tab_new` issues `Target.createTarget` with the caller's URL and only then attaches (`browser.rs:1117-1164`). Measured (E02): the initial `open` carried the override, the `tab new` navigation carried `HeadlessChrome/150.0.0.0`.

Two scoping corrections. First, this is **not** every invocation: `should_defer_url_until_network_controls` (`actions.rs:2571-2581`) already makes `handle_tab_new` create `about:blank` first and navigate after controls are installed — but only when a domain allowlist or authenticated proxy is configured (`actions.rs:5851-5875`). The leak is the ordinary path. Encouragingly, **the fix already exists in the codebase**; it is conditioned on network containment rather than on identity.

Second, calling this a first-request *race* is probably too generous. Attachment only enables domains — identity overrides and init scripts are applied to the initial target and never replayed to new ones, so this may be a whole-target propagation failure rather than an ordering problem. E02 measured the first request only; distinguishing the two requires checking whether *later* requests from that tab carry the override.

**Fix.** One acceptance contract, but not one coding task — partial delivery must not be labelled done. It decomposes into: an identity state model; valid UA/metadata/preset semantics (including whether an iOS Safari persona on Chromium should exist at all, versus responsive-only presets, Android emulation derived from the real browser version, and a genuine WebKit backend for iOS); a reusable target initializer that every new target runs before first navigation; and pre-navigation plus new-target tests. Extending the existing defer condition to cover identity — not just containment — is the smallest useful first step.

---

## 4. The cascade

The proposal is a system that starts with the most agent-browser-native approach and falls back toward heavier, more faithful backends. That is a good architecture. Everything depends on what triggers the fallback — and the first thing to notice is that the trigger you want is not usually available to you.

**"Capability failure" and "enforcement" are not properties of the observation.** They are facts about the origin's internal state, and you never see that state. You see a failure and infer a cause. A blank page, a missing selector, and a navigation timeout are each produced by both an ordinary SPA and a bot control, and nothing in the response distinguishes them reliably. So a cascade that classifies *observed failures* is asking engineers to sort on something they cannot see, and §4.3's "when ambiguous, do not promote" rule then eats most of the cases — which, if failure-driven promotion were the only mechanism, would collapse the whole design into "never promote."

The way out is to notice which triggers *are* unambiguous. "This job needs WebGL" is knowable before you run anything: it is a property of the task, not an inference from a failure. So is "this job needs a persistent login," "this needs a regional egress," "this needs an extension." Requirements can be established before contact; causes of failure cannot be established at all.

Requirements still divide, though, and the split runs through the requirement list rather than through the tier ladder. **A requirement for horsepower** — GPU, compositor, real font metrics — is an ordinary capability need that tier selection can satisfy on its own. Extensions are not a single class: classify an extension by its *digest and effects*, since one may be accessibility functionality, one enterprise policy, and one an identity or signal mutation that belongs in the second category. **A requirement for identity** — a regional egress, a specific ASN or geography, a provider-managed profile — is an authorization question wearing capability clothes, and it takes the §5 gate no matter which tier happens to supply it. §4.3 catches this at tier 3, where the two arrive together and the disguise is thickest, but the rule is not about tier 3: it belongs at every boundary, including a tier-2 job that declares it needs to egress from Frankfurt.

**So select tiers from declared task requirements, and treat failures as diagnostics rather than as promotion triggers.** This inverts the usual design and is the single most important structural recommendation in this document. It also happens to be faster: requirement-driven selection reaches the right tier on the first attempt instead of walking up the ladder.

### 4.1 Requirement-driven tier selection — build this

Each tier declares what it can do. A job declares what it needs. Selection is a match, computed before launch:

```text
Tier 0  `read` (URL form) — no JS at all; Lightpanda — its own JS runtime,
          not Blink, driven through Runtime.evaluate
          provides: HTTP fetch, static content; Lightpanda adds a partial
                    JS/DOM subset — enumerate it, do not assume Chrome parity

Tier 1  Native CDP + headless Chrome, SwiftShader
          provides: JS execution, DOM, software canvas/WebGL,
                    persistent profile (--profile works here too)

Tier 2  Native CDP + headful Chrome, real display, hardware GPU, full font corpus
          provides: hardware rendering, real font metrics, extensions
                    (extensions genuinely force headful, chrome.rs:441-444),
                    compositor-dependent layout

Tier 3  Remote provider (Kernel et al.), managed environment
          provides: an environment the local host cannot supply
                    — see §4.3, this tier also changes identity
```

A job declaring `needs: [js, persistent-login]` selects tier **1** — persistence is orthogonal to headfulness, and `--profile` works identically at either tier. Only a genuine rendering, font-metric, or extension requirement justifies tier 2. A job declaring nothing starts at tier 0.

**The obvious attack on this design, which has to be closed or the inversion is theatre.** Declared requirements are *assertions*, not observations, so they can launder a denial across sessions:

> Job A runs at tier 0, hits an ambiguous blank page, and correctly stops. An operator — or a retry wrapper — resubmits the same work as job B with `needs: [js]`, justified by nothing except what happened to job A. Job B now selects the higher tier *before launch* and never touches a promotion rule at all.

Every guard in §4.2 and §4.3 is bypassed, and the audit trail looks clean. A requirement inferred from a prior target failure is still failure-derived, and starting a new session does not launder it.

So the requirement artifact has to carry provenance and be **frozen before first contact** with the target. Three things must be separate records rather than one blob:

1. **Task requirements** — immutable, with issuer, scope, and *when and from what they were established*. Written before the first observation of the target.
2. **Method authorization** — which methods are permitted against which origins, by whom (§4.3).
3. **The resolved environment manifest** — what actually got launched (§3.3).

If (1) cannot cite a source that predates contact with the origin, it is not a requirement; it is a promotion wearing a requirement's clothes. Attempt lineage has to survive across sessions for this check to mean anything, which is a real piece of engineering and does not exist in the codebase today.

**Failure-driven promotion has one narrow opening, and page content is not it.** The tempting rule is "the body has script tags and a mount point, so it is demonstrably JS-rendered" — but a challenge shell and a server-rendered hydration page both look exactly like that. Page-authored evidence cannot establish anything, because a bot control authors pages too.

The only promotion authority on an unowned origin is a **closed enum** of two entries: a requirement fixed before first contact (§4.1 selection, not a promotion at all), or **typed engine-originated capability telemetry** — the engine itself raising `not implemented` or refusing an unsupported API. That signal comes from your own runtime rather than from the target, which is what makes it trustworthy. DOM shape, framework bundles, selector misses, page-authored error strings, and HTTP status text are **diagnostic only**: log them, never let them authorize a transition.

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
| Requirement fixed **before first contact** (declared WebGL, extension, persistent login) | Select the matching tier at launch — this is §4.1, not a promotion |
| Typed engine-originated capability error (`not implemented`, unsupported API) | Promote |
| Page rendered blank, or selector never appeared | **Stop and diagnose** — a challenge shell and an unrendered SPA are indistinguishable here |
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

> **An unexplained runtime failure may never change the environment on an origin you do not own.** Where an authorization record exists, a transition is permitted only if it stays inside that record's exact terms.

Note what the second clause does *not* say. "You are entitled to the access, so promote freely" is wrong, and it contradicts the handbook this document companions: *permission to access a site does not by itself authorize concealing automation status*. Authorization is **method-specific**. A record covering access does not silently extend to a different provider, a different geography, a suppression flag, an extension, a patched control stack, or a profile you did not declare. Nor does owning `app.example` transitively authorize the embedded identity provider or challenge vendor whose origins the page pulls in. So the check is a match against the record's `(origins, purpose, methods, provider config, identity deltas, artifact digests, expiry)` — not an origin-class boolean.

**One correction to a claim an earlier draft of this section made.** I previously concluded that for unowned origins the ladder is "really two tiers." That is the wrong invariant. Up-front requirements are exempt by construction, so an unowned third-party job with a genuine hardware-WebGL, font-metric, accessibility-extension, or cloud-GPU need can legitimately select tier 2 or 3 at launch — and conversely a dishonest declaration can preselect them, which is what the provenance rule in §4.1 exists to catch. The policy constrains **the source of a transition**, never the tier count. Tier cardinality was a proxy, and a misleading one.

**A 403 that is not a bot control.** Geo-restriction, expired credentials, and genuinely missing authorization all return 403, and only some are bot controls. Do not build a classifier that tries to tell them apart in order to decide whether to keep going. Default 403 to `STOP` and let the per-origin policy carve out the known-benign cases explicitly. A conservative default that occasionally halts a legitimate job is recoverable; a permissive default that occasionally evades enforcement is not.

The asymmetry with the challenge classifier above is deliberate, but the reason is not the one it is tempting to give. It would be neat to say "a challenge classifier only ever outputs `STOP`, so its errors fail safe" — and that is wrong. Only its *positive* output is `STOP`. Its negative output is silence, and silence falls through to whatever the default is. If the default is "content missing, so promote," then a missed challenge promotes straight into it: precisely the failure mode being refused for the 403 case one paragraph earlier.

The real asymmetry is about **defaults, not output vocabulary**. Both paths must default to stopping. 403 defaults `STOP` with narrow authorization-based carve-outs. Blank DOM must *also* default to `STOP`, with promotion requiring typed engine-originated capability telemetry — never page content, and never the mere absence of content. A root-mount script tag and a recognized framework bundle are *not* evidence: a challenge shell has both. Build classifiers whose *default* is halting, and the principle is actually implemented rather than asserted.

**Promotion into someone else's stealth profile.** This is the hole the three cases above do not close. §4.1's tier 3 promotes to a remote provider on "needs an environment the local host cannot provide," which quietly admits "the local host cannot provide a clean residential egress" as a *capability* trigger. And per §2.4, Kernel's headless profile ships a default stealth flag list. So the top of the cascade is *promote into a stealth configuration you did not write and cannot see* — reachable without ever authoring an enforcement rule, and phrased in capability language throughout.

Draw the line by what changes rather than by which tier you are entering: a promotion that buys **horsepower** (more GPU, more memory, a display) is a capability decision and belongs to the cascade; a promotion that changes **identity** — egress, ASN, geography, or a provider-supplied automation-suppression profile — is a stealth decision and takes the §5 authorization gate instead. Tier 3 usually does both at once, which is exactly why it needs to be split rather than waved through. In practice: enumerate what the provider's profile actually differs in before wiring it into a cascade, and if you cannot enumerate it, that is itself the finding.

**Enforcement disguised as a transient error.** The table treats timeouts, connection resets, and transport errors as retryable, which is correct in general and exploitable in particular: a bot control that drops connections or serves a 503 is indistinguishable from a flaky network at the single-request level. The distinguishing feature is not the individual failure but its *distribution* — enforcement concentrates on one origin while the rest of the fleet is healthy. Borrow the handbook's circuit breaker: track transient-failure rate per origin, and when it exceeds a threshold, escalate to the stop path rather than continuing to retry. A retry budget that is per-request rather than per-origin will happily grind against an origin that has already decided to refuse you.

**Learned tier preferences are the known-detector table, rediscovered.** The obvious optimization once a cascade exists is to remember which tier worked for which origin and start there next time. That is a pure win when the reason was capability. When the reason was detection, a cache of "origin X needs tier 3" is exactly the pre-classification §4.5 rejects — assembled by the system rather than by a person, which makes it harder to notice and no different in effect. If you build tier memoization, key it on the *recorded reason* for the promotion and refuse to memoize anything whose reason was unexplained or enforcement-adjacent. This is the strongest argument for logging a structured reason on every promotion: without one, you cannot implement this rule, and the cache silently becomes the thing you said you would not build.

The general principle: **when the trigger is ambiguous, the cascade must not promote.** Ambiguity resolving toward "try harder" is the failure mode, and it produces no error message and no log line unless you build one.

### 4.4 What "stop" has to mean, or nobody will honor it

A rule that only says *stop* will be removed by the first engineer whose job needs doing. If the cascade halts and the caller simply gets a failure, the pressure to add "just one more tier" is enormous and eventually irresistible — so the stop path needs a destination, not just a brake.

**`STOP` also has to be a state, not a log line.** As described so far it is a diagnostic, and a diagnostic does not stop anything: the next command in the same session can change options and carry on, because `DaemonState` tracks confirmation but has no notion of a stopped job attempt. Make it **job-scoped and absorbing** — it must block further target traffic, retries, relaunches, and environment changes for that attempt lineage; quarantine or close the browser; release profile, account, and egress leases; and persist the disposition so a later session cannot silently resume. Resumption is a *new* job with newly validated method-specific authority, not a continuation.

Then make it produce a **diagnostic and a decision point**: what was attempted, at which tier, and what was observed. Report a typed disposition — `explicit_enforcement`, `ambiguous_default_stop`, `policy_denial`, `retry_budget_exhausted` — plus the rule that fired and the residual uncertainty. Do **not** ask it to report "why this was enforcement rather than capability": §4 opens by establishing that the cause is unobservable, and ambiguity is itself the trigger. A stop record that invents a cause is worse than one that says it does not know. Alongside the disposition, give the operator their real options. Those options are legitimate and worth enumerating in the output, because they are what makes the boundary survivable — request access or an API key from the origin; use an official API if one exists; run against an owned staging instance instead; confirm the origin is in scope at all; or decide the job should not run.

This is also where the handbook's human-in-the-loop boundary sits, and it is narrower than it first looks. A human deciding *whether to seek authorization* is an ordinary business decision and entirely appropriate. A human being handed the challenge to solve so the automation can continue is the thing both documents prohibit. The difference is whether the person is exercising judgment about the engagement or acting as a CAPTCHA-solving subroutine.

Designed this way, the stop-state stops being the component everyone routes around.

### 4.5 A worked schema, because the hard parts are the definitions

Everything above is a design principle, and a principle is not buildable. Left as prose, an engineer still has to invent the security semantics of "predates contact," "same attempt lineage," "typed engine telemetry," "effective method," and "verified capability" — and two implementations could both claim compliance while disagreeing on every one. Four records, the three named in §4.1 plus the attempt record that makes their relationship enforceable:

```yaml
task_requirements:
  schema: 1
  job_id: …
  lineage_id: …                  # survives retries AND new sessions
  issuer: …
  issued_at: …
  target_origins: […]
  source_refs: […]               # immutable, independently checkable
  needs:
    - capability: hardware_webgl
      constraints: {…}
      established_at: …
      provenance_ref: …
  frozen_digest: sha256:…

method_authorization:
  authorization_id: …
  approving_party: …
  evidence_ref: …
  purpose: …
  origins: […]                   # define redirect/frame/subresource semantics
  methods:
    providers: […]
    network_modes: […]
    launch_flags: […]
    extension_digests: […]       # digest and effects, not the noun "extension"
    init_script_digests: […]
    signal_suppression: […]
  accounts_actions_limits: {…}
  valid_from: …
  expires_at: …
  challenge_policy: stop

# The environment is THREE records, not one — an earlier draft collapsed them
# and created a lifecycle cycle: invariant 2 wants the record before
# authorization, invariant 5 selects from it, but provider and runtime facts
# only exist after provisioning. Split by when each fact becomes knowable.

candidate_plan:                  # PRELAUNCH, immutable once frozen
  manifest_id: …
  job_id: …
  requirements_digest: …
  authorization_digest: …
  adapter_and_version: …
  executable_or_image_digest: …  # of STAGED bytes, not a path (TOCTOU)
  effective_launch_plan: …       # AFTER CLI/env/config/plugin/provider merge
  requested_capabilities: …
  extensions: [{digest, declared_effects, verified_effects}]
  profile: {class, lineage, lease}

provisioned_attestation:         # obtained UNDER QUARANTINE from target egress
  manifest_id: …
  provider_declared: …           # unknown unless the provider actually attests
  runtime_verified: …            # from fixed adapter probes on about:blank
  actual_versions: …

runtime_observations:            # POSTLAUNCH, append-only
  manifest_id: …
  network: {requested, observed}
  display_renderer_fonts: {requested, observed}
  effective_mutation_digests: […]
  # NEVER retroactively authorizes the launch it describes.

job_attempt:
  attempt_id: …
  job_id: …
  parent_attempt_id: …
  lineage_id: …                  # controller-assigned, not caller-resettable
  first_target_contact_at: …
  manifest_id: …
  status: running|stopped|complete
  transition_reason:
    type: precontact_requirement|engine_capability
    capability: …
    evidence_ref: …
  stop:
    stop_id: …
    disposition: explicit_enforcement|ambiguous_default_stop|policy_denial|retry_budget_exhausted
    rule_id: …
    observed_facts_ref: …
    stopped_at: …
    reset_grant_ref: …           # must reference THIS stop_id, approved after it

# Every record also needs: schema version, canonical encoding and hash rules,
# revision, issuer/signature, revocation semantics, set ordering, secret
# redaction, and a statement of exactly which bytes each digest covers.
# `first_target_contact_at` needs precontact/null semantics and a definition
# spanning DNS, TCP, TLS, redirects, restored pages, workers, and provider
# startup pages.
```

**The invariants matter more than the YAML.** These are the parts an implementer would otherwise have to guess:

1. Requirements must be committed **before** first target contact — and wall-clock fields cannot prove that, since an issuer can backdate them and job B can honestly postdate job A's contact while still laundering it. Use a controller-owned append-only event sequence: the requirement digest is committed at event *N*, the lineage's earliest target-egress event is *N+1*. `lineage_id` must be **controller-assigned and not caller-resettable**, or the laundering attack in §4.1 stays open.
2. The **fully merged** effective launch plan must be known before the authorization comparison, and hashed over *staged bytes* rather than paths. Plugins need two gates: authorize executing the plugin digest, then authorize the mutations it returns — running an unsandboxed plugin merely to discover the plan is already a side effect.
3. Unknown **never** satisfies a requirement — but evaluate this field by field, not per provider. A provider that returns no metadata can still satisfy facts established statically or independently (that a CDP endpoint connected, say); it cannot satisfy provider-only claims like image digest, region, GPU, profile lineage, or suppression state.
4. "Engine telemetry" means **the adapter returning a typed result for a fixed adapter-issued operation** — not a `Runtime.evaluate` exception, which the page authors. Preserving `exceptionDetails` instead of flattening it does not help; the *value* is still page-authored. Defensible sources are adapter-specific: a versioned static descriptor for `read`; a capability table keyed to binary digest for Lightpanda; binary/argv descriptors, structured protocol errors and fixed precontact probes on `about:blank` for local Chrome; negotiated W3C capabilities for WebDriver; an authenticated quote bound to the session ID for a remote provider.
5. Selection picks the **least** environment satisfying both requirements and authorization. Capability sets form a partial order, so define dominance over observable effects plus a stable target-independent preference. Ties are broken **deterministically, not failed closed** — only *unknown* and *unsatisfied* fail, via invariant 3. Incomparable minima need a precontact operator choice.
6. Once STOP latches, resumption requires a **reset grant** that references that exact `stop_id`, was approved after it, states what changed, and scopes retry count, methods, and origins. "A new job with newly validated authorization" is too weak — it permits revalidating the same standing grant forever. Enforce atomically across daemons.

The transition, end to end:

> **freeze requirements + authorization → enumerate candidates → resolve each candidate plan → authorization-filter → choose and freeze → provision under quarantine → attest the exact result → bind authorized egress → first target contact**

Note that binding comes *before* first contact, not at launch: a restored page, an extension, a provider startup page, or a service worker can emit target traffic the moment the browser exists.

**The honest consequence of invariant 4, which an earlier draft buried.** None of those adapter channels exists today — the current code flattens both `Runtime.evaluate` exceptions and CDP errors to strings, and wrapping a string in an enum is not a fix. So until that plumbing is built, the closed evidence enum has **exactly one live arm: precontact requirements**, and *runtime promotion must be switched off entirely*. That is a real constraint on what can ship, not a caveat. Stating it is more useful than implying the rule is available today.

### 4.6 The "known detectors" idea

Pre-classifying sites by which bot-control vendor protects them, in order to pre-select a stealthier tier, is enforcement evasion with the enforcement step cached. It moves the decision earlier in time; it does not change what the decision is. The same table applies.

There is a legitimate version of site-specific configuration, and it is worth building instead: a per-origin policy table recording **authorization** — which origins the operator owns or has written permission to automate, which credentials and rate limits apply, which are API-first, and which are simply out of scope. That table makes the system safer, and it belongs in the separate authorization artifact of §4.7 — not in `policy.rs`, which fails open and is the wrong granularity for it.

### 4.7 Where this plugs in

`cli/src/native/policy.rs` has an `ActionPolicy` returning `Allow`, `Deny`, or `RequiresConfirmation`, loaded from JSON with an `AGENT_BROWSER_CONFIRM_ACTIONS` env override. It is the closest existing thing — but calling it "already the right primitive," as an earlier draft did, overstates it in three ways that matter:

- **It fails open.** `load_if_exists()` is `Self::load(&path).ok()` (`policy.rs:76-80`), so an unreadable or malformed policy file becomes `None` and every check is skipped. Reload errors are discarded too (`let _ = policy.reload()`, `actions.rs:2085`). An authorization gate that disappears when its config is broken is not a gate.
- **Confirmation is not authorization.** A human clicking yes is not the site owner's approving record, and the schema has nowhere to put one.
- **It is the wrong granularity.** The policy holds flat action-name lists, but the things needing control are process-wide: `--args`, `--extension`, and init scripts registered for *every future document*. A per-origin action check cannot contain a launch flag that has already been applied to the browser, or an init script that will run on the next redirect, popup, frame, or worker.

So the authorization record belongs in a separate, **required** artifact. Merge CLI, env, config, plugin, and provider mutations into one effective launch plan; validate that plan fail-closed *before* launch; and bind the resulting session to its authorized origin set across redirects, popups, frames, workers, and later navigation. `ActionPolicy` can stay for what it is good at — gating individual actions — but it cannot carry this.

There is currently **no backend or provider cascade** in the codebase — I searched for one specifically. Retry and fallback logic does exist elsewhere — transient IPC handling in `cli/src/connection.rs:1005-1081`, daemon respawn in `main.rs:1675`, a three-attempt Chrome launch retry with a 500 ms backoff in `chrome.rs:577-605`, download retry in `install.rs:256`, accessibility-tree re-query in `element.rs:345` and `:516`, and a content-extraction fallback ladder in `read.rs` — but none of it switches backend or provider. The cascade would be new construction, so it can be built with the stop-state in it from the first commit rather than retrofitted — which is the only time these boundaries actually hold.

---

## 5. What "undetectable" can and cannot mean here

Splitting the ask honestly requires a test, because the obvious objection to any such split is that it is rationalization. Every item in the first pile below *does* make the browser harder to detect. If "harder to detect" were the criterion, the piles would collapse into one.

**The test is whether a change makes a true statement true, or makes a false statement plausible — where "true" is measured against the environment actually running.** That second clause is not decoration; without it the test collapses. Installing a macOS font corpus into a Linux container makes a trivially true statement true (those files are on disk) that was chosen precisely to make a false one plausible (this is a Mac). Font corpora are a fingerprinting surface *because* they correlate with OS, so "matched to the declared cohort" only passes when the declared cohort is the environment you are actually in. That is just the handbook's *Truthful cohorts* rule — "must describe the environment actually running" — applied to this document's own recommendations.

With the referent fixed, the sorting works. A real GPU means the browser genuinely renders with that GPU. Fonts matched to the real OS mean it genuinely has them. Nothing asserted becomes false under inspection. By contrast `--disable-blink-features=AutomationControlled` makes a truthful signal report falsely, `--user-agent` without metadata makes the client contradict itself on the first request, and a macOS font corpus on Linux is a claim about a machine that does not exist. First-pile work also **degrades gracefully** where second-pile work breaks: a font cohort that drifts with an OS update is slightly stale, while a shim that drifts is a contradiction. (Drift still happens — §6 exists because of it.)

**But truthfulness is a coherence property, not an authorization property, and an earlier draft of this section conflated them.** The counterexample is short: rent a genuine Mac with a real GPU and a real font corpus, *because* your truthful Linux environment was refused. Every statement it makes is true, it survives arbitrarily deep inspection, and it passes the test above — and it is still an enforcement-conditioned identity change, forbidden by §4 for reasons that have nothing to do with truth. The motive problem is not confined to aged profiles; it applies to **every** bullet below.

The test also runs the other way. Privacy normalization and farbling, and browser-supported compatibility or accessibility emulation, all deliberately report values that differ from the physical hardware — and none inherently requires a site owner's permission. Tor Browser is not lying to anyone. So "differs from the hardware" does not imply "needs authorization" any more than "matches the hardware" implies "does not."

Sort on **three independent axes** instead of one:

| Axis | Question | Failure looks like |
|---|---|---|
| **Coherence** | Is the configuration one a real instance of the declared cohort would have, and is that cohort what is actually running? | UA says Windows, fonts say Linux |
| **Purpose and trigger** | Why this change, and was it conditioned on an origin refusing you? | Switched hosts after a 403 |
| **Method authorization** | Is this method permitted against this origin, by a record that says so? | Suppression flag with no approving party |

A change needs all three. The test earlier in this section answers only the first, which is why it belongs in the coherence chapter and not in a permissions argument. "Environment actually running" is itself layered — host, VM, container, vGPU, virtual display, browser policy — so name the layer you mean rather than treating it as self-evident.

That also means the heading below is mis-titled if read as a permission claim. These items **do not inherently suppress automation signals**; they still require ordinary authority over the workload, data, and network, and they must not be enforcement-conditioned. That is a narrower promise than "requires no one's permission," and it is the one this document can actually support.

**Does not inherently suppress automation signals — but still needs ordinary workload authority, and must not be enforcement-conditioned:**

- **Headful with a real display and hardware GPU.** Buys rendering, compositor, GPU and font fidelity, and fixes genuine layout differences. Biggest single fidelity gain — and it buys **zero** reduction in automation signalling. `--remote-debugging-port=0` sets `AutomationControlled` independently (§2.1), so dropping `--headless=new` removes one of two sufficient causes and `navigator.webdriver` stays `true`. That is exactly why this belongs in pile 1: it improves fidelity without touching a truthful signal. Anyone expecting it to quiet `webdriver` has misread the flag table.
- **A real font corpus matched to the OS actually running.** Kernel's own history is the case study: commit `cba3f77` added fonts specifically because a three-font container was a signal. Match the real platform, not a platform you would prefer to present, and do not install everything — an implausibly complete corpus is its own outlier.
- **Persistent profiles with single ownership.** Already supported via `--profile` (`flags.rs:257`); `--user-data-dir` is the Chrome switch the code emits, not a CLI flag. Needs leasing, encryption, and a TTL — `storageState` and cookies are bearer credentials.
- **Note a live incompatibility before promising composability.** `ensure_allowed_domains_supported_for_launch` (`actions.rs:2596-2641`) *rejects* `--allowed-domains` combined with `--restore`, and with saved storage state, because restored state can replay origins before the allowlist is in force. So "persistent login" and "per-origin confinement" are not currently composable, and any plan offering both needs a way to activate saved state without pre-control origin replay.
- **Stable egress per session, and fix the WebRTC trigger.** Proxy support exists; egress *stability* and IPv6/DNS policy do not. A session whose ASN changes mid-flight is incoherent no matter how good the browser is. WebRTC containment *does* exist and is well built — `chrome.rs:510-517` forces `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` and `retain`s away any user override so it cannot be weakened, and `network.rs:407-425` blocks `RTCPeerConnection` in-page. But both gate on `restrict_webrtc`, which `actions.rs:2938` and `:3707` define as `!allowed_domains.is_empty()`. **The leak protection is wired to `--allowed-domains`, not to `--proxy`**, so a proxied session without domain filtering — the natural way to use a proxy — leaks the real IP over UDP. Gate it on proxy configuration instead, or on both.
- **Fix §3.1 and §3.2.** Correctness wins that also remove artifacts.
- **An identity manifest (§3.3)** that rejects contradictions before launch.

**Requires the site owner's express permission — and is already reachable, so the work is adding the gate:**

- **`BROWSERLESS_STEALTH`, which defaults to `true`** (`providers.rs:325-327`) — the only item on this list that is currently *on* unless someone turns it off.
- **`KERNEL_STEALTH`** (`providers.rs:403`, default `false`), and `KERNEL_HEADLESS` (default `true`), which selects the Kernel profile carrying the stealth flag list.
- Suppressing `AutomationControlled` via `--args "--disable-blink-features=AutomationControlled"`.
- Injecting property shims via `--init-script` or a plugin's `initScripts`.
- Overriding the UA via `--user-agent`.
- Patched control stacks (Patchright, rebrowser-patches) to hide CDP artifacts.
- Any synthetic-input humanization aimed at behavioral classifiers.

The first three are documented flags today (§2.1), with the suppression flag used as the help-text example and the `navigator.webdriver` shim shipped as a plugin test vector. So this is not a "should we build it" question. Three things are worth doing:

1. **Stop advertising it.** Change the `--args` example in `output.rs:3521` to something genuinely neutral such as `--window-size=1920,1080`. Not `--no-sandbox`, which disables a browser security boundary and is no better a recommendation than the flag it would replace. A tool's help text is a recommendation, and right now it recommends the anti-pattern to every user who runs `--help`.
2. **Gate it.** These flags should require a per-origin authorization record naming the approving party — not a global `stealth: true`. The handbook's *Authorization assertion* example is the shape; §4.7 explains why `policy.rs` cannot carry it.
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
3. **A per-backend cohort baseline.** Native-headless, native-headful, Lightpanda, WebDriver, URL-form `read`, and **each remote provider separately** are all different cohorts. `read` is the easiest to forget and the most distinctive, since its rustls handshake looks nothing like Chrome's. A remote provider's output is a measurement of that provider and can change without notice, so re-baseline on a schedule rather than on suspicion.
4. **Positive and negative controls.** Include a plain WebDriver session with `navigator.webdriver === true` to prove the probe can see an intentional signal, and a stock browser to measure false positives.
5. **A per-verb event-provenance contract**, asserted in tests. Not a blanket `isTrusted === true`: `dispatch_event` is *contractually* untrusted (§3.1) and the select paths have their own semantics. Write down what each verb should emit — trusted or not, which events, in what order — and assert that. A blanket assertion would be wrong for at least two verbs and would still have caught §3.1.

Run these per Chrome release. Every version-specific claim in this document is a hypothesis with an expiry date.

---

## 7. Recommended order of work

One ranked list would need three incompatible sort keys — cheapness, severity, and whether the change is observable enough to need a baseline first. So here are two lists.

### No-regret: ship without waiting for anything

These are small, independently justified, and do not depend on a measurement baseline or a policy decision.

1. **Flip `BROWSERLESS_STEALTH` to default `false`** (§2.4, §5) — one `unwrap_or` and a docs line. Today every Browserless session asks a third party to suppress automation signals unless the user knew to opt out. Whatever the answer, it should be an explicit choice rather than an inherited default; if the product decision is to keep it on, log it per session so it appears in the record.
2. **Gate `--force-webrtc-ip-handling-policy` on `proxy.is_some() || !allowed_domains.is_empty()`** (§5). Today a proxied session without `--allowed-domains` leaks the real IP over UDP. This half is a genuine one-liner with no page surface. Note the *other* half is not: `install_domain_filter_script` early-returns on an empty allowlist (`network.rs:166-168`), so extending the in-page `RTCPeerConnection` block to proxy-only sessions means new injection plumbing and breaking WebRTC for people who wanted a proxy and nothing else. That is a product decision, not a fix — see item 10.
3. **~~Fix the four terminal synthetic writes~~ — reproduced, and there is no live bug to fix** (§3.1, E04). Two sites are unreachable from any shipped client and the reachable one (`select`) updates React correctly. Left here as the worked example of why the reproduce-first rule earned its place: this was ranked as a silent correctness bug in production code, and an hour of measurement removed it from the list entirely. What remains is a decision about the dead handlers — wire them up correctly or delete them — which is neither urgent nor no-regret.
4. **Reject a `--user-agent` override that carries no metadata** (§3.4). Today the flag leaves clients worse off than not using it; refusing it is a strict improvement and needs nothing else. *Populating* `userAgentMetadata` is the better fix but depends on the manifest, so it lands with item 8.
5. **Rename `_agentBrowserInstallDomainFilter`** so worker-bootstrap source stops carrying the tool's name (§3.2), and randomize the `__AB_` property names per launch. Both are cheap; the isolated-world version is not, and is not required.
6. **Change the `--args` help-text example** (§5) to `--window-size=1920,1080`. One line, and it stops the tool recommending the anti-pattern to everyone who runs `--help`. Not `--no-sandbox` — that disables a browser security boundary and is no more neutral than the flag it replaces.

### Gated: build in dependency order, not severity order

The remaining items have hard prerequisites, and an earlier draft listed them in an order that could not be executed — selection before the capability model it matches against, and before the authorization it needs at every identity-changing boundary. Ordered by what unblocks what:

7. **Observation schema and origin-side harness** (§6). Every cohort gets a baseline: native-headless, native-headful, Lightpanda, WebDriver, URL-form `read`, and *each remote provider separately* — providers are not one cohort, and their output can change without notice. Everything below alters observable behavior, so without this you cannot distinguish a fix from a regression.
8. **Resolved identity manifest and target initializer** (§3.3). The record of what actually launched. Prerequisite for item 4's better half, for any cohort claim, and for the capability model. Needs a field list and an owner; it is a subsystem, not a task.
9. **Fail-closed authorization and session confinement** (§4.5, §4.7, §5). A required record — not `ActionPolicy`, which fails open and is the wrong granularity. Merge CLI, env, config, plugin, and provider mutations into one effective launch plan, validate it before launch, and bind the session to its authorized origin set across redirects, popups, frames, and workers. This gates the suppression flags and every identity-changing transition, so it must precede selection. The handbook's authorization record is a ready-made schema; cite it rather than inventing one.
10. **A real capability model, requested / provider-declared / runtime-verified** (§4.1). Replace the ordinal ladder with orthogonal axes — engine and API subset, display class, renderer and adapter, font digest, extensions, profile semantics and lease, egress, provider effects. This matters because the ladder's rungs are not what they claim: Lightpanda has its own JS runtime rather than none, headful does not guarantee a hardware GPU or a real display (Linux may start Xvfb, and `LaunchOptions` carries no GPU or font contract), tier 1 is not inherently SwiftShader, and built-in providers return `metadata: None` so tier 3 cannot attest anything at all. **Unknown must not satisfy a requirement.**
11. **Requirement-driven selection** (§4.1) with frozen, provenanced requirements, the absorbing STOP state (§4.4), and the identity/horsepower split at every boundary (§4.3). Only now, on top of 8-10. Measure the tier-0 hit rate before committing to more than two tiers.
12. **Prove which domain-filter wrappers are redundant** (§3.2) via the parity matrix, then remove only those. The `RTCPeerConnection` block and the worker-scoped wrappers stay.
13. **Decide the product questions** (§2.1, item 2): the throwaway-profile default, and whether proxied sessions lose WebRTC. Also resolve the `--allowed-domains` / `--restore` incompatibility if persistent login and per-origin confinement are meant to compose.
14. **Add headful/hardware-GPU and font-cohort capabilities** (§5) — the largest fidelity gain, and the one most in need of item 7 to prove it worked.
15. **Track Web Bot Auth** (§5); prototype signing on `read` first, since it has no browser stack to reconcile.

### Out of scope here, but worth someone's attention

These surfaced while reading for identity and coherence. They are not detection findings and do not belong in this document's thesis, but they are larger risks than most of what is above and should not be lost:

- **A *present* `CI` variable silently disables the Chrome sandbox.** `should_disable_sandbox` (`chrome.rs:1321-1359`) adds `--no-sandbox` on `env::var("CI").is_ok()`, which fires for any value at all — including empty, `0`, and `false` — among other heuristics. An env var is not evidence that an equivalent isolation boundary exists.
- **Plugins are unsandboxed child processes with inherited environment and same-user filesystem and network authority.** `invoke_plugin_process` (`plugins.rs:201-217`) spawns `plugin.command` with the daemon's environment, and plugins may be installed from npm or GitHub. Capability checks, a timeout, and `kill_on_drop` exist — none of them is an OS sandbox or an environment allowlist. Combined with the `LaunchMutation` surface from §2.1, that is a direct code-execution and secret-exposure boundary — a bigger deal than any page-visible fingerprint here.
- **Appium launches with `--relaxed-security`.** `launch_appium` (`appium.rs:166-188`) runs unpinned `npx appium --relaxed-security` with no explicit bind address, and iOS sessions built by this manager use `noReset: true`. Which insecure features that actually enables, and whether the listener is externally reachable, depend on the unpinned Appium version — do not infer reachability from the missing bind flag alone. Separately, any TCP listener on `127.0.0.1:4723` is accepted as Appium with no `/status` validation.
- **Named-profile temp copies are best-effort.** Cleanup runs in `Drop` with three removal retries, so a `SIGKILL` bypasses it entirely and can leave a copy of a real Chrome profile — containing authentication and session material — on disk.

The first two would be my priorities if someone writes the security companion.

The property worth protecting through all of it is that agent-browser's *local* path is honest by default — `--remote-debugging-port=0` arrived at the cooperative behavior by accident, and every finding above is fixable without giving that up.

The provider paths do not currently have that property, and that is the single most consequential thing in this document. `BROWSERLESS_STEALTH` defaulting to `true` means the honest-by-default story is a statement about one backend rather than about the tool, and a user reaching for a remote provider crosses into pile 3 without a prompt, a log line, or a word in the output. Whichever way that default goes, it should be a decision someone made on the record.
