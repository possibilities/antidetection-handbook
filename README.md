# The Antidetection Handbook

**Browser identity coherence, fingerprint testing, and reliable authorized automation**

> **Research snapshot:** 2026-07-25
>
> **Kernel case-study snapshot:** [`kernel/kernel-images@3be26fc`](https://github.com/kernel/kernel-images/tree/3be26fcbcdbed7e615d57217ee8db8f9dac00ee3)
>
> **Audience:** browser-platform engineers, automation developers, QA/security teams, and coding agents.

“Antidetection” is informal industry jargon, not a Web standard and not a promise of invisibility. In this handbook it means:

> **Build an authorized browser client whose network, protocol, browser, rendering, profile, and interaction signals are internally coherent; remove framework artifacts only where expressly authorized; measure drift; and stop rather than evade when a site denies or challenges the automation.**

This is deliberately narrower than defeating bot controls. It does **not** authorize CAPTCHA solving, credential abuse, fake engagement, account farming, quota evasion, bypassing access controls, or rotating identities after a denial. Use it on systems you own, systems that expressly permit the method as well as the work, or engagements with written authorization. Legal notes are informational, not legal advice.

**Authorization is method-specific.** Permission to access a site, account, or API does not by itself authorize concealing automation status from third-party bot controls. Suppressing standard automation signals, patching control artifacts, engineering transport/protocol fingerprints to impersonate another client, or generating human-like input against those controls requires express permission from the site or system owner. Without it, use truthful WebDriver state, cooperative allowlisting, or an official API. Stopping on a challenge is a minimum safeguard—not permission to evade controls until a challenge appears.

The document is intentionally self-contained. Linked sources establish provenance, expose version-sensitive details, and provide deeper verification; reading them should not be required to understand the implementation model here.

### Scope and non-goals

Knowing this handbook's edges prevents misapplying it:

- **Primary subject:** desktop Chromium-family browsers driven by CDP or WebDriver on Linux container hosts. Firefox and WebKit appear mainly where they illustrate a contrast.
- **Not covered:** native mobile app automation, Android/iOS browser automation, device farms, and emulator fingerprinting. The constraint-graph model transfers; the specific surfaces and controls do not.
- **Not covered:** building a detector. The observation inventory exists so an automation engineer can find their own contradictions. Defenders should start from the OWASP references in the source library.
- **Not covered:** any technique whose purpose is defeating a bot control the reader neither owns nor has written permission to test against. Where such techniques are inventoried, it is to explain why they fail, what they cost, and what authorization they require.
- **Perishable by construction.** Every version-specific claim below is a hypothesis to re-measure, not a constant. See [Refreshing this snapshot](#refreshing-this-snapshot).

## Contents

1. [The five-minute model](#the-five-minute-model)
2. [Vocabulary that prevents design bugs](#vocabulary-that-prevents-design-bugs)
3. [What a detector can observe](#what-a-detector-can-observe)
4. [Engineering principles](#engineering-principles)
5. [Browser and device fingerprint surfaces](#browser-and-device-fingerprint-surfaces)
6. [Automation signals and control stacks](#automation-signals-and-control-stacks)
7. [Network identity and protocol coherence](#network-identity-and-protocol-coherence)
8. [Behavior, state, and session operations](#behavior-state-and-session-operations)
9. [Reference architecture](#reference-architecture)
10. [Implementation examples](#implementation-examples)
11. [Measurement and regression testing](#measurement-and-regression-testing)
12. [What Kernel’s public image repo implements](#what-kernels-public-image-repo-implements)
13. [Myths and recurring failure modes](#myths-and-recurring-failure-modes)
14. [Security, privacy, legal, and abuse controls](#security-privacy-legal-and-abuse-controls)
15. [Developer and agent checklists](#developer-and-agent-checklists)
16. [Annotated source library](#annotated-source-library)
17. [Refreshing this snapshot](#refreshing-this-snapshot)

---

## The five-minute model

### Detection is layered risk scoring, not one JavaScript test

A site may observe a client as a time-varying vector:

```text
observation(t) = {
  network,       // source IP/prefix, ASN, reputation, approximate geography, DNS
  transport,     // TCP/QUIC, TLS ClientHello, ALPN, resumption
  protocol,      // HTTP version, H2/H3 settings, header serialization, connection reuse
  browser,       // UA/UA-CH, navigator, Intl, permissions, storage, features
  rendering,     // fonts, canvas, WebGL/WebGPU, audio, codecs, display
  automation,    // WebDriver/CDP state, injected worlds/globals, source names, launch mode
  behavior,      // input provenance, timing, focus, visibility, paths, velocity
  state,         // cookies, caches, service workers, profile age and continuity
  account        // auth history, transactions, relationships, prior risk
}
```

A detector can apply exact rules, similarity matching, anomaly detection, reputation lookups, or a proprietary model:

```text
risk(t) = f(observation(t), prior_sessions, account_graph, site_context)
```

There is no universal “bot bit,” no public score that predicts every site, and no finite list of properties that makes a client “undetectable.” A browser can pass a public checker and still be classified by server-side history. A browser can also be obviously automated and still be allowed because it is authenticated, rate-limited, and expected.

### The main failure is contradiction

Most fragile setups alter one visible value without changing the state that produces it:

- a Windows UA over a Linux font/GPU/runtime stack;
- `en-US` in JavaScript with a different `Accept-Language`;
- a Pacific time zone, an Asian geolocation, and a European exit;
- a mobile UA with desktop screen, hover, touch, codecs, and TLS behavior;
- browser headers replayed by a generic HTTP client whose TLS and HTTP/2 stack are not Chrome;
- main-page shims that do not exist in workers, service workers, or cross-origin frames;
- a claimed GPU name whose WebGL limits and rendered output come from SwiftShader;
- cookies from one long-lived account paired with a new ASN every request.

Treat the client as a **constraint graph**. Nodes are observable values; edges encode relationships. Fixing a single node while breaking its edges makes the graph more anomalous.

### The practical hierarchy

1. **Cooperate when possible.** Prefer official APIs, test tenants, service accounts, signed test headers, sandbox challenge keys, or allowlisted CI ranges. Where the origin supports a [declared cryptographic identity](#declared-identity-signing-requests-instead-of-hiding-them), that outranks every technique in this document.
2. **Use a real, current browser.** Let its own engine produce JavaScript semantics, TLS, HTTP/2/3, headers, rendering, and events.
3. **Choose a truthful cohort.** Browser, OS, architecture, GPU/display class, locale, and network path must describe the environment actually running.
4. **Derive one identity once.** Keep it stable for a profile/session. Do not independently randomize every API.
5. **Isolate identities.** One browser profile, process boundary, egress lease, and test account per identity unless sharing is intentional.
6. **Configure before first navigation.** Early requests, workers, service workers, and origin state can escape late patches.
7. **Measure at every layer.** Capture what the origin receives, what scripts observe, and what changes across restarts/releases.
8. **Treat patches as liabilities with tests.** A patch may remove one artifact while creating semantic, security, or maintenance drift.
9. **Stop on policy signals.** A challenge, policy `403`, repeated challenge or step-up outside the documented authentication flow, or authorization failure is a stop state—not a prompt to rotate and retry.

---

## Vocabulary that prevents design bugs

The [W3C fingerprinting guidance](https://www.w3.org/TR/fingerprinting-guidance/) defines browser fingerprinting as the ability to identify or re-identify a user, user agent, or device through configuration settings or other observable characteristics. Keep these adjacent concepts separate:

| Term | Precise meaning | What it is not |
|---|---|---|
| **Fingerprinting surface** | All observable characteristics that can be combined to identify or correlate a client. | A fixed list of JavaScript properties. |
| **Fingerprint** | A particular observation or canonicalized vector from that surface. | Proof of a person, device, or malicious intent. |
| **Component** | One measured value or derived feature: UA, screen size, canvas hash, JA4, etc. | Independently meaningful in every population. |
| **Entropy** | Distinguishing information in a population. It depends on the value distribution and correlations. | Hash length, number of collected fields, or rarity on one test site. |
| **Uniqueness** | A fingerprint appears once in a particular dataset. | Global uniqueness or durable linkability. |
| **Stability / persistence** | Components remain sufficiently similar over time. | Correctness or authenticity. |
| **Linkability** | Separate observations can be associated with the same entity, even if none is unique. | Knowing the entity’s civil identity. |
| **Automation signal** | Evidence that a browser is remotely controlled: WebDriver state, CDP side effects, framework worlds, deterministic interaction, and so on. | Evidence of abuse. QA and accessibility tools are automated too. |
| **Risk score** | A contextual decision from many client, network, behavior, account, and historical features. | A browser fingerprint hash. |
| **Normalization** | Many clients expose the same bucketed values, creating an anonymity set. Tor Browser uses this strategy heavily. | Making one synthetic client resemble a chosen victim. |
| **Farbling** | Privacy-oriented, bounded variation intended to weaken stable cross-site measurements. Brave popularized the term and uses deterministic, site-scoped values for some surfaces. | Fresh random noise on every API call. |
| **Spoofing** | Deliberately reporting a value that differs from underlying state. | Automatically coherent just because the value is plausible. |
| **Emulation** | A browser-supported control changes observable behavior for testing, such as locale, viewport, media, or geolocation. | A complete replacement for OS, GPU, fonts, network, or hardware. |
| **Profile** | A browser data directory and its cookies, storage, permissions, caches, extensions, and preferences. | A harmless fixture; it often contains bearer credentials. |
| **Challenge / step-up** | A service asks for additional proof because risk is elevated. | A puzzle the automation is entitled to defeat. |

### Three different engineering objectives

Do not collapse these into one “stealth” feature:

| Objective | Typical strategy | Population requirement | Primary risk |
|---|---|---|---|
| **Privacy anti-fingerprinting** | Normalize, partition, reduce precision, or farble values to reduce tracking. | Usually depends on many users sharing browser behavior or site-scoped secrets. | Compatibility breakage or becoming a small recognizable privacy cohort. |
| **Automation fidelity** | Use native browser behavior, remove only owner-authorized test-framework anomalies, and model realistic authorized environments. | Needs representative test cohorts, not impersonation. | False confidence from narrow checkers. |
| **Synthetic identity / “antidetect browser”** | Rewrite many surfaces to present a different persona. | Must keep every dependent layer coherent; marketing often ignores this. | Security lag, impossible combinations, terms/access-control abuse. |

Tor/Firefox/Brave privacy defenses are not automation cloaks. Likewise, a patched automation framework is not a privacy browser.

### Entropy is conditional

If `X` and `Y` are correlated, their information is not additive:

```text
H(X, Y) = H(X) + H(Y | X)
```

A common screen size may add little after device class is known. A one-bit property can still identify someone if only one member of the observed population has it. Randomizing a value can **increase** uniqueness when the result is rare. Hashing alone generally does not remove practical linkability or make a fingerprint anonymous; truncation/collisions may discard information, while keying and scope determine where linkage remains possible.

Longitudinal systems do not need exact equality. Research such as [FP-STALKER](https://inria.hal.science/hal-01652021v1) links fingerprints as components drift; [Gummy Browsers](https://arxiv.org/pdf/2110.10129v1.pdf) shows that browser fingerprints can be cloned, so a matching fingerprint is not authentication.

---

## What a detector can observe

### Passive, active, stateful, and behavioral collection

| Collection class | Examples | Key property |
|---|---|---|
| **Passive** | IP, TLS ClientHello, ALPN, HTTP version, headers, connection reuse. | Arrives without page script. Hard to repair with JavaScript. |
| **Active** | Canvas draw/readback, WebGL queries, font measurement, audio graph, permission query, timing. | The page deliberately invokes an API or operation. |
| **Stateful** | Cookies, storage, caches, HSTS/Alt-Svc, service workers, permission decisions, TLS tickets. | Links activity through client-held state. Often survives a tab. |
| **Behavioral** | Pointer/keyboard/scroll sequences, focus, visibility, dwell, navigation and request velocity. | Contextual and temporal; accessibility and device differences matter. |
| **Historical/business** | Account age, failed logins, purchase velocity, payment/shipping relationships, prior abuse. | Not fixable in the browser and often more important than fingerprinting. |

[W3C’s guidance](https://www.w3.org/TR/fingerprinting-guidance/) evaluates a surface using factors including entropy, detectability, persistence, availability, and scope. Passive, cross-origin, persistent signals generally present greater linkability risk. The guidance repeatedly stresses that mitigations are mitigations—not complete solutions.

### The observation layers

| Layer | Representative signals | Appropriate owner |
|---|---|---|
| Authorization | API key, OAuth scope, test header, service account, site agreement. | Product/security/legal. |
| Network | IPv4/IPv6, prefix, ASN, reputation, geolocation, resolver, route stability. | Network platform. |
| Transport | TCP/QUIC behavior, TLS versions/ciphers/extensions, GREASE, ALPN, resumption. | Browser or origin-facing proxy. |
| HTTP | H1 casing/order, H2 SETTINGS/flow control/HPACK, H3/QPACK, pseudo-header order, Fetch Metadata, UA-CH. | Browser networking stack. |
| Browser runtime | UA, platform, language, Intl, feature set, permissions, storage, APIs. | Browser engine and context configuration. |
| Rendering/device | screen, DPR, pointer/touch, fonts, GPU, canvas, WebGL/WebGPU, audio, codecs. | OS/image/browser/GPU. |
| Automation | WebDriver flag, launch flags, protocol domains, framework globals/worlds/source names. | Driver/framework/browser launch. |
| Interaction | event provenance, pointer path, key sequence, scroll, focus/visibility, timing. | Input layer and workflow. |
| State/account | profile continuity, cookies, service workers, auth and business history. | Session/account platform. |

The server can see data unavailable to page JavaScript. A page checker cannot certify the network path, account history, or proprietary risk model.

---

## Engineering principles

### 1. Native behavior beats broad spoofing

If a stock browser can produce the desired value, configure that browser rather than replacing the API. Prefer:

- the real OS when claiming that OS;
- the browser’s own UA and UA Client Hints;
- first-class locale, timezone, geolocation, media, viewport, and permission controls;
- the browser’s own network stack end-to-end;
- actual fonts, codecs, display and graphics backend appropriate to the cohort;
- user-agent input (Playwright keyboard/mouse, WebDriver Actions, CDP Input, or OS input) rather than page-level `dispatchEvent()` when event semantics matter.

Every JavaScript shim must survive property-descriptor inspection, prototype ownership, `Function.prototype.toString`, illegal invocation, multiple realms, cross-origin frames, dedicated/shared/service workers, and early execution. Most do not.

### 2. Truthful cohorts beat arbitrary personas

Define a small set of environments that really exist and are useful for the workload:

```text
Chrome 151 / Windows 11 / x64 / hardware GPU / en-US / 1920×1080 @1x
Chrome 151 / Ubuntu 24.04 / x64 / SwiftShader / headless / en-US
Firefox ESR / Ubuntu 24.04 / x64 / X11 / de-DE
```

Do not generate the Cartesian product of every plausible value. Real values are correlated. A cohort should have a source image, binary hash, launch configuration, expected network path, and measured distribution.

### 3. Stable within identity, diverse only across justified cohorts

Within a profile/session:

- keep browser version, OS, screen, locale, timezone, network lease, and stable rendering values fixed;
- keep one random seed per QA run when stochastic interaction is required;
- preserve account/profile/equipment relationships unless the test explicitly changes them;
- do not rotate egress or reset profile state because a request was denied.

Across a fleet, diversity should come from actual test requirements and representative environments—not unconstrained randomization.

### 4. One source of truth

Create one immutable identity manifest. Derive launch options, OS/image selection, proxy lease, browser preferences, expected probe values, and test cohort from it. Reject contradictions before launch.

### 5. Configure before first navigation

The initial navigation can reveal:

- low-entropy UA Client Hints and `Accept-Language`;
- TLS/HTTP behavior;
- profile cookies, caches, HSTS and Alt-Svc;
- service-worker control;
- default screen/locale/timezone;
- startup extensions and policies.

Late `addInitScript()` patches cannot repair the initial request and can miss already-created targets.

### 6. Separate identity from behavior

A coherent browser environment and a user-interaction model are distinct subsystems. Human-like noise cannot repair an impossible platform. Conversely, a coherent environment can still execute a perfectly periodic, high-velocity loop.

### 7. Measure distributions and invariants

Use both:

- **hard invariants:** same UA family across HTTP/JS/UA-CH; no direct egress outside the proxy; page/worker timezone agreement; no shared profile lease;
- **cohort distributions:** canvas/render output, startup timing, font availability, request ordering, performance.

Do not turn every naturally varying value into an exact golden string.

### 8. Patches are release-coupled source changes

Treat a patched driver, framework, or browser as security-sensitive software:

- pin version and artifact digest;
- review the diff from upstream;
- monitor browser security releases;
- run web-platform/automation conformance and fingerprint regression tests;
- canary it;
- define a fast fallback to upstream.

“Undetected” in a README is a claim, not evidence.

---

## Browser and device fingerprint surfaces

### HTTP identity: UA and User-Agent Client Hints

The classic `User-Agent` string is only one projection of browser/platform state. Chromium also exposes low-entropy UA Client Hints by default and higher-entropy hints after origin opt-in. [RFC 8942](https://www.rfc-editor.org/rfc/rfc8942.html) defines the Client Hints framework; the [UA-CH specification](https://wicg.github.io/ua-client-hints/) defines browser-specific hints.

Important mechanics:

- A secure origin asks for hints with `Accept-CH`.
- The opt-in is bound to the origin and may persist for the user-agent-defined session.
- Cross-origin delivery requires delegation.
- `Sec-` header names indicate browser control; page script cannot freely set them.
- Clearing site data/cache/cookies must clear persisted opt-in preferences under RFC 8942.
- Active hints can still expose high entropy; opt-in improves observability, not automatic privacy.

A coherent Chromium identity aligns:

- HTTP `User-Agent`;
- `navigator.userAgent`;
- `navigator.userAgentData.brands`, platform, mobile, architecture, bitness and versions where available;
- actual feature/version behavior;
- the browser’s TLS/HTTP stack.

**Do not override only the UA string.** If a compatibility test requires a UA override, use a supported DevTools/automation API that also accepts UA metadata, then assert both request headers and JavaScript values. Chrome DevTools documents coordinated UA and Client Hint overrides in its [Network conditions guide](https://developer.chrome.com/docs/devtools/device-mode/override-user-agent).

### Language, locale, timezone, geolocation, and clock

These are related but not identical:

- `navigator.language` and `navigator.languages` represent browser language preferences.
- `Accept-Language` usually reflects the same ordered preferences, possibly privacy-reduced.
- `Intl` controls number/date/calendar formatting and exposes the effective IANA timezone.
- geolocation is permission-gated and can legitimately differ from IP location.
- IP geolocation is approximate; travel, VPNs, corporate networks, mobile carriers and anycast create normal mismatches.

Treat alignment as a probabilistic constraint, not a law. Reject absurd combinations, but do not demand an exact city. Use valid BCP 47 language tags and IANA timezone identifiers. Keep the OS timezone, browser context timezone, date offset, and Intl output coherent. Deny geolocation when the workflow has no real device fix or does not need it. Fabricated coordinates are appropriate only as declared emulation in an owned test scenario—not to manufacture third-party identity coherence.

### Screen, viewport, DPR, media queries, and input capabilities

Record and cross-check:

- `screen.width/height/availWidth/availHeight`;
- viewport `innerWidth/innerHeight` and `visualViewport`;
- `devicePixelRatio`, color depth and orientation;
- CSS media queries for resolution, color gamut, HDR, reduced motion, contrast, pointer and hover;
- `maxTouchPoints`, touch events and input devices;
- browser window outer/inner dimensions and display scaling.

The values need not match a famous device exactly, but they must obey rendering arithmetic and the chosen environment. Examples of contradictions include claiming a touch-only mobile device while exposing a precise mouse, hover, desktop viewport and no touch points, or setting a 2x DPR while screenshots and canvas backing stores behave as 1x.

A fixed default viewport is not intrinsically malicious, but a fleet of otherwise unrelated sessions with the same uncommon dimensions is an avoidable cluster.

### Navigator, feature set, and platform

Commonly observed components include:

- platform and architecture projections;
- `hardwareConcurrency` and `deviceMemory`;
- plugins/MIME types and PDF support;
- cookies and Do Not Track/global privacy signals;
- connection/network information;
- battery and sensor availability;
- WebAssembly, SIMD and JavaScript/runtime behavior;
- installed speech voices;
- supported image, audio and video codecs;
- PDF, printing, clipboard and file-picker behavior;
- accessibility and preference media queries.

Do not “fill in” every API. Missing or permission-gated APIs are normal. The full feature set must correspond to the browser version and platform. A UA claiming an old browser while exposing new APIs is a version contradiction.

### Permissions, media devices, and storage

Permissions form stateful relationships:

- query result (`prompt`, `granted`, `denied`);
- actual device availability;
- whether a permission prompt/user activation occurred;
- origin and top-level context;
- profile persistence;
- browser policy.

An empty camera list with a fabricated granted camera permission is suspicious and can break the application. Use native permission APIs and real/virtual media devices when testing media. Keep labels hidden until the browser would reveal them.

Storage surfaces include cookies, local/session storage, IndexedDB, Cache Storage, service workers, storage quotas, partition keys and browsing data. Modern browsers partition more third-party state by top-level site. A harness must test the current browser behavior rather than assume one global cookie jar.

### Fonts

Sites can infer fonts without an enumeration API by measuring glyph metrics and fallback behavior. Font results depend on:

- installed families and versions;
- OS/fontconfig selection;
- language packs and fallback;
- browser/graphics rasterization;
- anti-aliasing, hinting and scale;
- document font loading.

A minimal container with three fonts is unusual. Installing every font package is also unusual and can increase image size and entropy. Build a font corpus matching the declared OS cohort, include international fallback required by the workload, run `fc-cache`, and measure actual browser availability.

### Canvas

Canvas fingerprints can combine:

- fonts and text metrics;
- 2D rasterization, compositing and color management;
- image decoding;
- GPU/software backend;
- browser/OS libraries.

Naive noise injection often fails because repeated reads differ, transformed canvases do not preserve expected relationships, workers or offscreen canvases escape the patch, or related WebGL/font outputs remain unchanged. Privacy browsers that alter canvas do so as part of a broader, stable policy—not with an independent random value on every call.

### WebGL and WebGPU

Observe the entire graphics family, not only a renderer string:

- vendor/renderer (masked and debug information where exposed);
- extensions;
- limits, precision formats and shader behavior;
- WebGL 1/2 support;
- rendered pixels;
- WebGPU availability, adapter features and limits;
- crash/fallback behavior;
- canvas and CSS rendering relationships.

A single string override cannot turn SwiftShader into an NVIDIA device. The most coherent options are to use the real target GPU/driver, truthfully expose the software renderer, or select a complete measured virtual-GPU cohort.

### Audio and media

Audio fingerprinting derives output from oscillator/compressor/filter behavior, sample rates, floating-point/runtime details and the audio backend. Also inspect:

- AudioContext state and latency;
- available inputs/outputs;
- codec support and `MediaCapabilities`;
- WebRTC stack and ICE candidates;
- autoplay/user-activation behavior.

A silent container can still expose audio APIs, but its backend, devices and permissions should form a sensible combination.

### Execution realms: the patch completeness test

A patch that works only in the top-level main world is incomplete. Test:

- top page before and after navigation;
- same-origin iframe;
- `srcdoc` and `about:blank` inherited realms;
- owned cross-origin/OOPIF frame;
- popup/new page;
- dedicated worker;
- shared worker;
- service worker;
- worklet or offscreen canvas where relevant;
- extension/isolation worlds if the framework creates them.

Only compare APIs that legitimately exist in each context: workers do not have `window`, `screen`, or DOM APIs, and `webdriver` is not a `WorkerNavigator` property. Shared system-state values—UA, languages, platform, hardware concurrency, timezone—should agree where exposed.

### Property semantics matter

This common shim is an anti-pattern:

```js
// Anti-pattern: a page-local value patch is not a coherent browser implementation.
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
```

A detector or compatibility test can inspect:

- the owner prototype;
- enumerable/configurable flags;
- getter identity and native serialization;
- invocation with the wrong receiver;
- behavior in a pristine iframe/worker;
- whether the WebIDL member exists at all;
- relationships to launch and protocol behavior.

Prefer an engine/driver behavior change that preserves WebIDL semantics, or leave the standard signal truthful in cooperative automation. `navigator.webdriver` is an intentional, specification-defined automation signal—not an accidental artifact. Suppressing or falsifying it to defeat third-party bot controls without the owner’s express consent is evasion, not compatibility cleanup.

---

## Automation signals and control stacks

### The standards contract

The [WebDriver specification](https://www.w3.org/TR/webdriver2/) defines a user-agent-wide **webdriver-active flag**. `navigator.webdriver` returns that Boolean; creating a WebDriver session sets the flag and deleting the final session clears it. [WebDriver BiDi](https://www.w3.org/TR/webdriver-bidi/) adds bidirectional event transport but does not define a second JavaScript “BiDi” bit.

The specification is candid about what this signal is worth. Its non-normative note says `navigator.webdriver` “[d]efines a standard way for co-operating user agents to inform the document that it is controlled by WebDriver,” and then adds: “It is acknowledged that this is complementary to the Evil Bit [RFC3514].” [RFC 3514](https://www.rfc-editor.org/rfc/rfc3514.html) is the April Fools' RFC in which attackers are asked to set a header bit announcing malicious intent. The standards body is saying plainly that a declared-automation flag only means anything among parties who choose to declare. Treat it accordingly: it is the correct thing to expose in cooperative automation and worthless as a defense, which is precisely why the cryptographic mechanisms below exist.

As of the research snapshot, Chromium enables its Blink `AutomationControlled` feature for these launch paths:

- `--enable-automation`;
- `--headless`;
- `--remote-debugging-pipe`;
- `--remote-debugging-port=0`.

A fixed nonzero debugging port alone deliberately does not enable it—the [wiring](https://chromium.googlesource.com/chromium/src/+/main/content/child/runtime_features.cc) special-cases port `0` and comments that a specific port "is more likely for attaching a debugger, so we should leave `EnableAutomationControlled` unset." `--disable-blink-features=AutomationControlled` changes that feature state but does not remove CDP control, injected code/worlds, protocol serialization, launch configuration, environment differences, or behavior. Current WebIDL still contains `Navigator.webdriver`; a natural disabled value is generally `false`, not a deleted/`undefined` member.

The runtime feature is not the only input. [`Navigator::webdriver()`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/frame/navigator.cc) returns `true` when the feature is enabled and otherwise consults a DevTools probe override:

```cpp
bool Navigator::webdriver() const {
  if (RuntimeEnabledFeatures::AutomationControlledEnabled())
    return true;

  bool automation_enabled = false;
  probe::ApplyAutomationOverride(GetExecutionContext(), automation_enabled);
  return automation_enabled;
}
```

Two consequences follow. Suppressing the launch-time feature does not pin the value, because an attached client can still set it at runtime. More usefully, that override is a supported way to make an authorized session report itself **truthfully** even when the launch path would otherwise leave the flag clear—the cooperative option in tier 1 below, not merely the absence of a suppression flag. Verify both paths against current Chromium source rather than trusting this summary.

### Headless is now the normal Chrome implementation—but not a normal desktop

Chrome unified headless and headful code in Chrome 112. Since Chrome 132, the old alternate implementation is a separate `chrome-headless-shell` binary. See [Chrome Headless mode](https://developer.chrome.com/docs/chromium/headless).

Unified code removes many old differences, but headless still has environmental signals:

- the headless launch switch and webdriver-active behavior;
- no displayed platform windows;
- Xvfb/virtual display choices;
- GPU, SwiftShader and software-compositing configuration;
- fonts and audio devices;
- screen/window/focus/visibility lifecycle;
- framework viewport defaults;
- timing/resource differences.

“Headful” under a dummy X server with software rendering is likewise not automatically a consumer desktop.

One of those signals is now a first-class control rather than something to patch around. Since Chrome 142, headless uses a **virtual screen** independent of any physical display, configurable at launch with [`--screen-info`](https://developer.chrome.com/blog/screen-configuration-with-chrome-headless) (origin, size, scale factor, orientation, work area, and multiple displays) and mutable at runtime through CDP `Emulation.addScreen` and `Emulation.removeScreen`. Historically, degenerate headless screen geometry was a common contradiction, and the usual response was a JavaScript shim over `screen`—which the *Property semantics matter* section explains is the wrong layer. Configure the real screen instead, then measure it. This is the general pattern worth internalizing: when the browser grows a supported control for a surface, the shim for that surface becomes a liability rather than a shortcut.

### Chrome for Testing is reproducibility, not concealment

[Chrome for Testing](https://developer.chrome.com/blog/chrome-for-testing/) is an official, versioned flavor released with matching ChromeDriver, without auto-update, and intended to be as close to regular Chrome as testing permits. Using a matched, pinned Chrome for Testing browser and ChromeDriver prevents independent browser/driver version drift. It does not by itself guarantee framework compatibility, artifact integrity, or reproducible builds—and it is not an antidetection browser.

Since Chrome 136, regular Chrome ignores remote-debugging switches against its default data directory unless a non-default `--user-data-dir` is supplied; Chrome for Testing preserves the automation use case. Never expose a debugging endpoint or automate a daily-use profile. See Chrome’s [remote debugging security change](https://developer.chrome.com/blog/remote-debugging-port).

### CDP effects are version-sensitive

CDP’s [`Runtime.enable`](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/) reports execution contexts and forwards Runtime events. Playwright and Puppeteer have historically enabled it during page initialization. That can alter object preview/serialization and expose framework worlds or source names.

The once-popular detector that logs an `Error` with a custom `stack` getter relied on console serialization invoking that getter. V8’s May 2025 changes to prevent side effects during [object preview](https://chromium.googlesource.com/v8/v8/+/61a907540d4c1dda4733476e54c977910f31041d) and [error preview](https://chromium.googlesource.com/v8/v8/+/e08e97347454255a337dcea361808fb25ca09077) guarded user-defined getters, so the classic snippet is not reliable on current Chrome. Opening genuine DevTools can also produce CDP effects. Treat every CDP probe as a versioned hypothesis with false positives—not folklore carved into a detector.

Current examples worth measuring rather than assuming:

- ChromeDriver source still injects a set of `cdc_...` page globals on new documents.
- Playwright’s `__playwright__binding__` globals are installed when binding-dependent features are used, not necessarily on every plain page; old `__pwInitScripts` advice is stale.
- Puppeteer evaluation source URLs use `pptr:` and its utility-world name contains a version.
- isolated-world names are execution-context metadata, not automatically ordinary `window` properties.

### Tool landscape at the snapshot date

Versions move quickly; these are a dated map, not evergreen endorsements. Every version below was resolved against its package registry on the snapshot date. Publication dates matter as much as version numbers—two of these projects have not shipped in years, which is a maintenance finding rather than a stability signal.

| Tool | What it changes | Limits and maintenance risk |
|---|---|---|
| **Selenium 4.46 / ChromeDriver** | Standards-based WebDriver/BiDi; ChromeDriver launches Chrome and injects driver support. | Stealth is not its goal. WebDriver state, driver globals, CDP and behavior remain observable. |
| **Playwright npm 1.62.0** | Cross-browser control, isolated worlds, context emulation, deterministic launch flags; Chromium via CDP. | Emulation does not rewrite OS, TLS, fonts, GPU or every realm. Headful still uses a control pipe. |
| **Puppeteer 25.3** | Chrome-focused CDP control with Chrome for Testing and unified headless defaults. | CDP/source-world artifacts remain; defaults can cluster. |
| **Patchright 1.61.x** | Chromium-only Playwright fork; avoids ordinary `Runtime.enable` discovery, changes flags/Console behavior, and patches selector/shadow-root internals. | Does not change Chrome engine, network, hardware or behavior; sacrifices some semantics and must track Playwright closely. |
| **rebrowser-patches 1.0.19** | Patches context discovery, source URLs and utility-world labels in particular Playwright/Puppeteer versions. | Narrow library-layer repair; published packages lag current frameworks and source-layout drift breaks patches. |
| **puppeteer-extra-plugin-stealth 2.11.2** | JavaScript evasions for webdriver, UA/language/platform, plugins, permissions, codecs, `window.chrome`, iframe, WebGL and dimensions. | Last npm release in 2023; cannot fix network/native rendering/all realms; shims can become their own fingerprint. |
| **Camoufox 152 beta / Python 0.5.x** | Custom Firefox with C++-level fingerprint interception, patched control layer and generated profiles. | Still Firefox, not Chrome; network/account/behavior remain; rebasing and browser-security lag are major risks. |
| **undetected-chromedriver 3.5.5** | Patches ChromeDriver injection and launch/session handling. | Last released in 2024; still ChromeDriver/CDP and highly version-sensitive. |
| **nodriver 0.50.x** | Removes Selenium/ChromeDriver and controls Chrome directly over CDP with fresh profiles. | Removes driver-specific artifacts, not CDP, launch, environment or network signals; review AGPL obligations. |
| **Fingerprint generators** | Generate plausible header/JS vectors from observed distributions. | Not browser engines or controllers; cannot guarantee worker, native, transport, GPU, font or codec coherence. |

Primary repositories: [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright), [rebrowser-patches](https://github.com/rebrowser/rebrowser-patches), [puppeteer-extra stealth](https://github.com/berstend/puppeteer-extra/tree/master/packages/puppeteer-extra-plugin-stealth), [Camoufox](https://github.com/daijro/camoufox), [undetected-chromedriver](https://github.com/ultrafunkamsterdam/undetected-chromedriver), [nodriver](https://github.com/ultrafunkamsterdam/nodriver), [Playwright](https://github.com/microsoft/playwright), and [Puppeteer](https://github.com/puppeteer/puppeteer).

### Declared identity: signing requests instead of hiding them

Everything above concerns what an automated client *leaks*. A parallel line of standards work concerns what it can *assert*. For a handbook whose first rule is "cooperate when possible," this is the most important development to track, because it converts "prove you are not a bot" into "prove which bot you are"—a question authorized automation can actually answer.

**Web Bot Auth** applies [RFC 9421 HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421) to automated traffic. The client signs outbound requests with a private key; the origin verifies the signature and learns a verified operator identity rather than guessing from fingerprints. The IETF chartered a [`webbotauth` working group](https://datatracker.ietf.org/group/webbotauth/) (Web and Internet Transport area) for exactly this. The two principal documents are:

- [`draft-meunier-webbotauth-httpsig-protocol`](https://datatracker.ietf.org/doc/draft-meunier-webbotauth-httpsig-protocol/) — the signing model.
- [`draft-meunier-webbotauth-httpsig-directory`](https://datatracker.ietf.org/doc/draft-meunier-webbotauth-httpsig-directory/) — how a verifier discovers an operator's public keys.

**Read the status carefully, because it is easy to overstate.** A working group exists, but as of the snapshot date *nothing has been adopted*: there is no `draft-ietf-webbotauth-*` document, and every draft above is still an individual submission carrying the usual "no formal standing" boilerplate. Both documents were also **renamed in mid-2026**—they replace `draft-meunier-web-bot-auth-architecture` and `draft-meunier-http-message-signatures-directory`, which now sit in datatracker state *Replaced*. Anything citing the old names is stale. Cite the version-less datatracker URL rather than a pinned revision, and re-read before implementing.

Mechanically, a signing agent sends `Signature` and `Signature-Input` per RFC 9421 with `tag="web-bot-auth"`, plus a `Signature-Agent` header naming the host of its key directory. The directory is served from the well-known URI `/.well-known/http-message-signatures-directory` as a JWKS; `keyid` is a base64url JWK SHA-256 thumbprint ([RFC 7638](https://www.rfc-editor.org/rfc/rfc7638.html)) and Ed25519 is the algorithm in practice.

Two traps worth knowing before writing code:

- **`Signature-Agent` changed shape between drafts.** It was a bare structured string (`Signature-Agent: "https://signer.example"`) and became a dictionary keyed to the signature label (`Signature-Agent: sig="https://signer.example"`). Deployed verifiers do not all track the drafts, so the form that validates in production may be the older one. Test against the verifier you actually need, not against the newest draft.
- **Sign the directory response itself.** Otherwise anyone can mirror your JWKS and enroll as you.

A detail worth quoting to anyone arguing that standards bodies are building better detectors: the working group's charter puts "techniques for distinguishing non-participating bots from non-bot clients" explicitly *out of scope*. The IETF declined to standardize adversarial detection and standardized cooperative identification instead.

**Privacy Pass** is the mirror-image mechanism and is genuinely standardized: [RFC 9576](https://www.rfc-editor.org/rfc/rfc9576.html) (architecture, Informational), [RFC 9577](https://www.rfc-editor.org/rfc/rfc9577.html) (HTTP authentication scheme), and [RFC 9578](https://www.rfc-editor.org/rfc/rfc9578.html) (issuance protocols), all June 2024. It lets a client present an anonymous, unlinkable token attesting that some issuer vouched for it, so an origin can reduce challenges without fingerprinting. Private Access Tokens are the best-known deployment. Privacy Pass attests *a property* without identifying the client; Web Bot Auth identifies *an operator* deliberately. They solve opposite halves of the same problem, and neither is an evasion technique.

Why this belongs in an engineering handbook rather than a policy appendix:

- **It changes the target.** If a site accepts a signed operator identity, the correct engineering investment is key management, directory hosting, and operator registration—not fingerprint coherence. Coherence work remains necessary for fidelity testing; it stops being the mechanism by which you obtain access.
- **It is auditable.** A signing key is an authorization artifact. It fits the identity manifest and the authorization record directly, and it fails closed when revoked.
- **It does not make suppression legitimate.** Holding a signing key for one origin authorizes nothing at another. Signed identity and concealed identity are opposites; a system that signs where it is welcome and suppresses where it is not has not adopted this model.
- **Verification is the origin's choice.** Major CDNs run verified-bot programs with their own enrollment; participation is a business relationship, not a header you can set. Treat vendor-specific programs as deployment detail on top of the standards above, and confirm current requirements directly with the provider.

Prefer a declared identity wherever the origin supports one. Where it does not, the cooperative options in tier 1 below still rank above anything that conceals automation status.

### Choosing a stack

Use the least invasive stack that meets the authorized requirement. Tiers 3 and 4 require the site or system owner’s express consent to conceal automation status; permission merely to access the system is insufficient.

1. **Cooperative QA:** upstream Playwright/Selenium/Puppeteer, truthful webdriver state, test-side allowlisting.
2. **Browser-fidelity research:** stock browser attached with controlled CDP/WebDriver and a measured, isolated environment.
3. **Artifact regression research:** a narrowly scoped framework patch, quarantined and compared with upstream through conformance plus selector/shadow-DOM regression tests.
4. **Source-patched browser:** only when a full browser build, security-update pipeline, conformance suite, supply-chain review, and rollback are funded.

Do not stack several stealth libraries blindly. Their assumptions can conflict.

---

## Network identity and protocol coherence

### Network identity is a tuple

At minimum:

```text
network_identity = {
  ipv4, ipv6, prefix, asn, reputation, approximate_geo,
  resolver_path, proxy_topology,
  tls_client_hello, alpn,
  http_version, framing, header_serialization,
  connection_pool_and_resumption
}
```

JA3/JA4 identify implementation behavior probabilistically, not a person. Shared libraries collide; browser releases drift; TLS extension ordering changes; intermediaries replace the observed stack. Never use a fingerprint hash as authentication.

**Two shipped changes make "a golden ClientHello" an untenable baseline.** Both are already default-on, so a fingerprint recorded before them is not comparable to one recorded after:

- **Post-quantum key agreement.** Chrome 131 moved from hybrid Kyber to ML-KEM, changing the advertised group from X25519Kyber768 (`0x6399`) to X25519MLKEM768 (`0x11EC`). Chrome deliberately does not offer both at once—the key shares are too large—so this was a substitution, not an addition. See Google's [*A new path for Kyber on the web*](https://security.googleblog.com/2024/09/a-new-path-for-kyber-on-web.html). Observed directly in a Chrome 150 ClientHello: `supported_groups` carries `0x11ec`, and `key_share` offers it as a real share of **1216 bytes** against X25519's 32—which is what "too big to offer two at once" costs on the wire. Any JA3/JA4 baseline captured before M131 is invalid, and the group list will move again as PQ deployment matures.
- **Encrypted ClientHello.** [Enabled by default since Chrome 117](https://chromestatus.com/feature/6196703843581952) on desktop and Android. Server opt-in travels in an HTTPS DNS record, which means ClientHello shape is now partly a function of *the destination's DNS*, not only the client. The same browser can present different observable handshakes to different origins.

The operational consequence: treat unexplained protocol-fingerprint drift as a browser-release or destination-configuration question **before** treating it as a regression in your own stack. Record the browser build alongside every captured fingerprint, or the capture cannot be interpreted later.

### Topology determines what the origin sees

```text
Blind HTTPS CONNECT:
Browser --TCP--> Proxy --TCP--> Origin
          Browser TLS/HTTP travels inside tunnel
Origin sees: proxy source IP + browser TLS/HTTP

TLS-intercepting proxy:
Browser --TLS A--> Gateway --TLS B--> Origin
Origin sees: gateway source IP + gateway TLS/HTTP

Generic replay:
Browser request observed --> Python/Go/curl sends new request
Origin sees: generic client's TLS/HTTP, whatever browser headers were copied
```

A browser request is not a header dictionary. Before headers, TLS exposes cipher suites, extensions, groups, signatures, GREASE, SNI and ALPN. HTTP/2 adds ordered SETTINGS, flow control, priority and HPACK. HTTP/3 adds QUIC parameters, connection IDs, H3 SETTINGS and QPACK. Fetch Metadata and Client Hints encode browser state and request context. Connection pools encode history.

If browser wire fidelity matters, use a blind `CONNECT` tunnel for browser TLS and H1/H2, or a full network tunnel that carries the required transports. Traditional `CONNECT` is a TCP tunnel and cannot preserve QUIC/H3; that requires explicitly supported UDP tunneling such as CONNECT-UDP/MASQUE or another UDP-capable path. If interception is the test objective, label the origin-facing identity as the gateway’s and never claim the capture represents the browser.

### Coherence matrix

| Signal | Expected engineering relationship | Normal caveat / failure |
|---|---|---|
| IP/ASN/reputation | Stable, authorized egress; IPv4 and IPv6 covered. | Cloud, VPN, enterprise and privacy exits are legitimate but may carry different reputation. |
| IP geography | Broadly plausible with intended locale/timezone. | City precision is unreliable; travel, mobile, anycast and corporate egress are normal. |
| DNS | Resolve at/near the intended egress; document DoH/bootstrap. | Local DNS or direct DoH can select a CDN far from the exit and leak the client network. |
| HTTPS proxy | Blind `CONNECT` preserves browser TLS and H1/H2; secure client-to-proxy credentials. | Traditional `CONNECT` is TCP-only. H3 needs explicit UDP tunneling/browser support or a full network tunnel; TLS interception replaces the origin-facing browser stack. |
| SOCKS | Proxy-side target resolution; explicitly test auth and UDP limitations. | Chromium’s SOCKS5 client proxies only TCP-based URL requests, always resolves target names proxy-side, supports no authentication methods (although SOCKS5 defines some), and does not carry QUIC/WebRTC UDP. |
| WebRTC | ICE candidates use the permitted path; relay-only TURN or non-proxied-UDP policy when required. | mDNS hides local numeric host candidates but does not stop direct public STUN candidates. |
| TLS/JA3/JA4 | Native browser emits ClientHello; ALPN agrees with subsequent protocol. | JA3 is brittle; JA4 groups more broadly; neither uniquely identifies a device. |
| HTTP/2 | Browser’s SETTINGS, flow control, priorities, HPACK and pseudo-header order stay together. | Copied headers cannot repair a different H2 stack. |
| HTTP/3 | Browser’s QUIC/H3 stack and UDP path stay together. | Ordinary TCP proxies cannot preserve H3; H3 absence alone is weak evidence because UDP is often blocked. |
| Headers | Browser generates `Host`, `Sec-Fetch-*`, `Sec-CH-*`, cookies and context metadata. | Manually copied values can describe a navigation/platform that never happened. |
| Reuse/state | One browser context keeps normal H2/H3 pools, TLS resumption, Alt-Svc, DNS and cookies on stable egress. | Fresh generic connections per resource or egress changes mid-session destroy these relationships. |

Primary protocol references: [Chromium proxy behavior](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md), [TLS 1.3](https://www.rfc-editor.org/rfc/rfc8446.html), [ALPN](https://www.rfc-editor.org/rfc/rfc7301.html), [GREASE](https://www.rfc-editor.org/rfc/rfc8701.html), [HTTP/2](https://www.rfc-editor.org/rfc/rfc9113.html), [QUIC](https://www.rfc-editor.org/rfc/rfc9000.html), [HTTP/3](https://www.rfc-editor.org/rfc/rfc9114.html), and [CONNECT-UDP](https://www.rfc-editor.org/rfc/rfc9298.html).

### Safe topology patterns

**Highest-fidelity regional QA**

- Put an isolated VM/container host behind an organization-controlled full tunnel.
- Cover IPv4, IPv6, DNS, UDP/QUIC and WebRTC.
- Firewall direct egress; fail closed rather than `DIRECT` fallback.
- Keep one egress lease per profile/session.
- Let the browser own UA, TLS, ALPN and headers.

**TCP-only HTTPS proxy**

- Configure through browser policy or framework launch options.
- Prefer an encrypted client-to-proxy connection.
- Do not intercept destination TLS when measuring browser behavior.
- Expect HTTP/3 to be unavailable unless UDP tunneling is explicit.
- Use a WebRTC non-proxied-UDP policy or approved TURN relay if direct candidates are forbidden.
- Keep proxy credentials out of URLs, command lines, PAC files, screenshots, HARs and repositories.

**Inspection gateway**

- Use disposable profiles and a test CA.
- Treat all origin-facing protocol fingerprints as gateway properties.
- Separate inspection results from fidelity results.

### Diagnostics

At a first-party origin record:

- public IPv4 and IPv6;
- prefix/ASN and approximate geo with confidence radius;
- TLS version, ClientHello and normalized JA3/JA4;
- ALPN and HTTP version;
- H2/H3 connection settings and header order;
- request headers after redacting cookies/auth/query identifiers.

In the page record language, Intl timezone, geolocation permission/result, and ICE candidate types. Capture clean startup plus controlled navigation and inspect unexpected DNS, DoH, STUN, QUIC, IPv6 and direct destination traffic. Chrome NetLog and packet captures can contain secrets—sanitize and expire them.

---

## Behavior, state, and session operations

### `isTrusted` means user-agent dispatched, not human

The [DOM specification](https://dom.spec.whatwg.org/#dom-event-istrusted) initializes constructed/dispatched events as untrusted. [WebDriver Actions](https://w3c.github.io/webdriver/#actions) require trusted events. CDP documents browser-level [`Input`](https://chromedevtools.github.io/devtools-protocol/tot/Input/) commands but does not make a cross-browser normative promise about trust.

A 2026-07-25 spot-check with Chrome `150.0.7871.187` found:

- `dispatchEvent()` and page-level `element.click()` → `isTrusted === false`;
- CDP mouse/key input → `true`;
- `Input.insertText` represents insertion not originating from a keypress.

Framework `fill`, paste, direct assignment, keyboard and OS input produce different event sequences. Choose the path that tests the real requirement. Do not treat `true` as proof of a physical human.

### Behavioral systems observe trajectories and histories

Potential features include:

- pointer sample continuity, velocity, acceleration, curvature and pauses;
- scroll deltas, cadence, viewport state and lazy-load interaction;
- keydown/input/keyup/composition ordering and inter-key timing;
- focus, visibility, user activation and field state;
- navigation path, dwell and request velocity;
- retries, concurrency and session/account history.

Peer-reviewed studies show behavioral data can discriminate evaluated bots, but results are dataset/task-specific and accessibility users are diverse. A single Bézier curve, Gaussian jitter, fake typo, or fixed “think time” has no general guarantee.

### Use semantic state machines, not sleep scripts

Model workflows as explicit states with postconditions:

```text
OPEN_LOGIN
  -> wait for owned app readiness
  -> ENTER_AUTHORIZED_TEST_CREDENTIALS
  -> wait for authenticated marker
  -> PERFORM_BOUNDED_ACTION
  -> verify business postcondition
  -> CLOSE

Any state:
  third-party challenge / policy 403 -> STOP
  401 -> reauthenticate only through an expressly authorized workflow; otherwise STOP
  owned-app challenge -> approved test hook/key, never solve the production challenge
  429 -> honor Retry-After or schedule later
  deadline/action budget exhausted -> FAIL_CLOSED
```

Every state needs a deadline, action budget, allowed origins, and idempotency classification. Wait for semantic conditions—not fixed sleeps. Keep focus and visibility truthful. Test background behavior as a separate scenario.

### Challenges and human-in-the-loop boundaries

When a third-party site presents a challenge, stop the job and preserve only the minimum diagnostic evidence. Do not ask an operator or external service to complete the challenge so automation can continue. Human-in-the-loop continuation is appropriate for an owned application only when the application exposes an expressly authorized test hook, provider test key, or non-production verification flow; it is not a license to solve the production safeguard.

For your own app, use test bypass hooks or provider test keys. Selenium explicitly [discourages CAPTCHA automation](https://www.selenium.dev/documentation/test_practices/discouraged/captchas/); hCaptcha provides [test keys](https://docs.hcaptcha.com/#integration-testing-test-keys). Human review remains appropriate for ordinary ambiguous business decisions outside challenge solving, using short-lived authenticated live view with sensitive-field redaction and an explicit resume postcondition.

### Retries and concurrency

- Apply per-origin and per-account concurrency limits.
- Honor [`Retry-After`](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after).
- Retry only transient failures and idempotent operations.
- Use supported idempotency keys for mutations.
- Never blindly retry payments, submissions, account changes, auth failures or challenges.
- Trip a circuit breaker when fleet-wide challenge, `429`, or error rates rise.

### Profiles and state

Use isolated contexts by default. Persist only when continuity is part of the requirement or avoids repeatedly authenticating an authorized account.

Rules:

- one profile directory has one active owner/lease;
- never automate a personal/default profile;
- never clone live auth state across concurrent identities;
- treat cookies/storage state as bearer credentials;
- encrypt at rest, restrict access, set TTLs and revoke;
- close contexts and release profile/account/egress leases in `finally`;
- use one test account per parallel state-mutating worker;
- separate fresh-profile, returning-profile and long-lived-session tests.

Playwright’s [authentication guide](https://playwright.dev/docs/auth) explicitly warns that storage-state files can impersonate an account.

### Stochastic QA without cargo cults

Randomness is useful for race coverage and load spreading—not for declaring a bot human. If interaction variation is necessary:

- use bounded distributions based on consented aggregate QA data;
- persist a unique seed and model version for each run;
- log random draws without sensitive content;
- replay failures with the same seed;
- never reuse one seed fleet-wide;
- never imitate an individual’s biometric signature.

```yaml
model: qa-interaction-v1
seed: unique-per-run-and-persisted
qa_only: true
limits:
  per_origin_concurrency: 2
  mutating_sessions_per_account: 1
  max_actions: 200
  session_ttl_seconds: 900
retry:
  require_idempotency_class: true
  allowed_operation_classes:
    - read_only
    - idempotent
    - mutation_with_service_idempotency_key
  max_attempts: 3
  deadline_seconds: 60
  base_ms: 500
  cap_ms: 8000
  transient_statuses: [429, 502, 503, 504]
  honor_retry_after: true
```

Do not infer that cookie farming, synthetic search history, “aged” profiles, warm-up calendars, random browsing, fake mistakes, or universal mouse curves produce trust. No controlled general evidence supports those rituals.

---

## Reference architecture

### Components

```text
Authorization registry
  └─ allowed origins, accounts, actions, data classes, expiry, rate limits

Identity compiler
  ├─ validates one manifest and coherence constraints
  ├─ selects OS/browser/image/font/GPU/display cohort
  ├─ leases profile + test account + egress
  └─ emits launch configuration + expected observations

Browser runtime
  ├─ isolated process/container/VM
  ├─ native browser networking and rendering
  ├─ loopback-only authenticated control plane
  └─ fail-closed network policy

Workflow engine
  ├─ semantic state machine
  ├─ idempotency/deadline/action budgets
  ├─ third-party challenge stop + separate ordinary-review HITL state
  └─ seeded QA interaction model (optional)

First-party probe and release harness
  ├─ origin-side TLS/HTTP observation
  ├─ page/frame/worker observation
  ├─ cohort baselines and hard invariants
  └─ privacy-minimized release telemetry
```

### Identity manifest

The manifest is an assertion about a real environment, not a bag of spoof values:

```json
{
  "schema": 1,
  "id": "qa-us-west-chrome-linux-001",
  "authority": {
    "purpose": "checkout regression on owned staging",
    "approvalRef": "authz://owned-staging/change-1234",
    "authorizedMethods": [
      "playwright",
      "truthful-webdriver",
      "native-browser-transport",
      "qa-input-variation"
    ],
    "approvedPatchDigests": [],
    "allowedOrigins": ["https://shop.staging.example"],
    "expiresAt": "2026-08-01T00:00:00Z",
    "maxOriginConcurrency": 2
  },
  "browser": {
    "family": "chromium",
    "distribution": "chrome-for-testing",
    "version": "PINNED_FULL_VERSION",
    "artifactSha256": "PINNED_SHA256",
    "executablePath": "/opt/chrome-for-testing/chrome",
    "control": "playwright",
    "headless": false
  },
  "platform": {
    "os": "linux",
    "osImageDigest": "sha256:PINNED_IMAGE",
    "arch": "x86_64",
    "gpuClass": "swiftshader",
    "fontCohort": "ubuntu-24.04-desktop",
    "screen": {"width": 1920, "height": 1080, "deviceScaleFactor": 1},
    "viewport": {"width": 1365, "height": 900}
  },
  "regional": {
    "locale": "en-US",
    "languages": ["en-US", "en"],
    "timezoneId": "America/Los_Angeles",
    "geolocation": null,
    "expectedCountry": "US",
    "expectedRegion": "US-CA"
  },
  "network": {
    "mode": "https-connect",
    "proxySecretRef": "secret://browser-qa/us-west",
    "dnsAtEgress": true,
    "failClosed": true,
    "webrtcPolicy": "proxy_only",
    "egressLease": "stable-per-session"
  },
  "profile": {
    "directory": "/profiles/qa-us-west-chrome-linux-001",
    "persistence": "per-identity",
    "maxConcurrentOwners": 1
  },
  "interaction": {
    "model": "qa-interaction-v1",
    "seed": "UNIQUE_PERSISTED_RUN_SEED"
  }
}
```

Do not put proxy credentials, cookies, tokens, or real account secrets in the manifest. Resolve secret references only inside the runtime.

### Manifest invariants

At minimum, reject:

```text
browser version != UA/UA-CH expected version
browser platform != selected OS image
arch != binary/image architecture
locale primary != languages[0]
timezone not valid IANA identifier
screen/viewport/DPR arithmetically impossible
mobile cohort without matching touch/pointer/display model
GPU claim != actual configured graphics backend
profile owner count > 1
profile identity != account lease identity
egress changed during a continuity session
proxy mode without IPv6/DNS/WebRTC policy
origin not in authorization registry
requested control/patch/network/input method not explicitly authorized
authorization missing, invalid, or expired
mutation without idempotency/confirmation policy
```

Classify constraints as normative, measured cohort invariants, or soft heuristics. Travel, multilingual preferences and enterprise proxies are legitimate; do not overfit a fictional “normal human.”

---

## Implementation examples

### Launch a coherent persistent Playwright context

This baseline intentionally does **not** override UA, Client Hints, platform, WebGL, canvas, fonts, or headers. It uses first-class controls and leaves the browser engine in charge.

```ts
import { chromium, type BrowserContext } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const PROFILE_ROOT = '/profiles'; // pre-created, trusted, and not workload-writable

interface RuntimeIdentity {
  executablePath: string; // verified, pinned Chrome for Testing binary
  profileDir: string;
  authorizedMethods: ReadonlySet<string>;
  allowedOrigins: string[];
  geolocationOrigins?: string[];
  locale: string;
  timezoneId: string;
  viewport: { width: number; height: number };
  screen: { width: number; height: number };
  deviceScaleFactor: number;
  proxy?: {
    server: string;
    username?: string;
    password?: string;
  };
  geolocation?: { latitude: number; longitude: number; accuracy: number };
}

function requireMethod(identity: RuntimeIdentity, method: string) {
  if (!identity.authorizedMethods.has(method))
    throw new Error(`automation method not authorized: ${method}`);
}

async function prepareProfileDir(profileDir: string): Promise<string> {
  const trustedRoot = await fs.realpath(PROFILE_ROOT);
  const candidate = path.resolve(profileDir);
  if (path.dirname(candidate) !== trustedRoot)
    throw new Error('profile must be one direct child of the trusted profile root');

  try {
    const existing = await fs.lstat(candidate);
    if (!existing.isDirectory() || existing.isSymbolicLink())
      throw new Error('profile path is not a real directory');
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
    await fs.mkdir(candidate, { recursive: false, mode: 0o700 });
  }

  const resolved = await fs.realpath(candidate);
  if (path.dirname(resolved) !== trustedRoot)
    throw new Error('profile escapes the trusted profile root');

  const info = await fs.stat(resolved);
  if (typeof process.getuid === 'function' && info.uid !== process.getuid())
    throw new Error('profile owner does not match runtime user');
  await fs.chmod(resolved, 0o700); // mkdir mode does not repair an existing directory
  if (((await fs.stat(resolved)).mode & 0o077) !== 0)
    throw new Error('profile permissions are not private');
  return resolved;
}

export async function launch(identity: RuntimeIdentity): Promise<BrowserContext> {
  requireMethod(identity, 'playwright');
  requireMethod(identity, 'native-browser-transport');
  if (identity.geolocation) requireMethod(identity, 'geolocation-emulation');

  const allowedOrigins = new Set(identity.allowedOrigins);
  const geolocationOrigins = identity.geolocationOrigins ?? [];
  if (geolocationOrigins.some(origin => !allowedOrigins.has(origin)))
    throw new Error('geolocation origin is not in the navigation allowlist');

  const profileDir = await prepareProfileDir(identity.profileDir);
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: identity.executablePath,
    headless: false,
    locale: identity.locale,
    timezoneId: identity.timezoneId,
    viewport: identity.viewport,
    screen: identity.screen,
    deviceScaleFactor: identity.deviceScaleFactor,
    proxy: identity.proxy,
    geolocation: identity.geolocation,
    // Deliberately omitted: userAgent, extraHTTPHeaders, broad stealth args.
  });

  if (identity.geolocation) {
    for (const origin of geolocationOrigins)
      await context.grantPermissions(['geolocation'], { origin });
  }

  return context;
}
```

Important limits:

- `connectOverCDP()` attaches to a browser whose process, default context, profile, proxy and initial targets already exist. Configure identity at browser launch, not after attachment.
- Playwright emulation changes supported browser-visible behavior; it does not turn Linux into Windows or SwiftShader into a physical GPU.
- Browser locale controls commonly align `navigator.language` and `Accept-Language`, but always measure the version in use.
- The profile helper assumes a trusted parent plus an externally enforced exclusive lease; use OS-level containment to prevent path-replacement races.
- Keep the control endpoint on loopback or behind authenticated, authorized transport.

### Authorization assertion and terminal denial state

```ts
type Outcome =
  | { kind: 'ok' }
  | { kind: 'stopped'; reason: string }
  | { kind: 'retry_later'; at: Date }
  | { kind: 'failed'; reason: string };

function assertAuthorized(url: URL, allowedOrigins: ReadonlySet<string>, expiresAt: Date) {
  const expiry = expiresAt.getTime();
  if (!Number.isFinite(expiry) || Date.now() >= expiry)
    throw new Error('authorization missing, invalid, or expired');
  if (!allowedOrigins.has(url.origin)) throw new Error(`origin not authorized: ${url.origin}`);
}

async function classifyResponse(
  response: globalThis.Response,
  latestRetryAt: Date, // min(operation deadline, session TTL, authorization expiry)
): Promise<Outcome> {
  if (response.status === 401 || response.status === 403)
    return { kind: 'stopped', reason: `authorization/access response ${response.status}` };

  if (response.status === 429) {
    const now = Date.now();
    const latest = latestRetryAt.getTime();
    if (!Number.isFinite(latest) || latest <= now)
      return { kind: 'failed', reason: 'retry deadline is invalid or expired' };

    const raw = response.headers.get('retry-after')?.trim();
    let requestedAt = now + 60_000;
    if (raw) {
      if (/^\d+$/.test(raw)) {
        const seconds = Number(raw);
        requestedAt = Number.isSafeInteger(seconds) ? now + seconds * 1000 : Number.NaN;
      } else {
        requestedAt = Date.parse(raw);
      }
    }

    const policyLatest = Math.min(latest, now + 15 * 60_000);
    if (!Number.isFinite(requestedAt) || requestedAt > policyLatest)
      return { kind: 'failed', reason: 'Retry-After exceeds the current authorized deadline or policy' };

    const at = new Date(Math.max(now, requestedAt));
    if (!Number.isFinite(at.getTime()))
      return { kind: 'failed', reason: 'Retry-After is outside the supported date range' };
    return { kind: 'retry_later', at };
  }

  return response.ok
    ? { kind: 'ok' }
    : { kind: 'failed', reason: `HTTP ${response.status}` };
}
```

These helpers are defense in depth, not a navigation guard: enforce the origin allowlist independently at the browser routing layer and a fail-closed network boundary, including redirects, popups, frames, workers, service workers, and browser-initiated traffic. `globalThis.Response` above means a Fetch/DOM response; adapt Playwright’s method-based `Response` explicitly rather than copying the function unchanged. The example intentionally stops on `401`; an expressly authorized reauthentication workflow should start separately rather than turning the failed request into an automatic retry. A site-specific challenge detector must return `stopped`; it must not hand a third-party challenge to an operator, select a new proxy/profile, or retry. Owned applications should use authorized test hooks or test keys instead.

### Bounded, replayable UI motion for QA

Use this only when intermediate pointer states are part of the test (hover, drag, menus, drawing). It is not proof of humanity.

```ts
function minimumJerk(t: number): number {
  // Smooth position with zero velocity and acceleration at both ends.
  return 6 * t ** 5 - 15 * t ** 4 + 10 * t ** 3;
}

async function moveForUiTest(
  page: import('playwright').Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  durationMs = 240,
) {
  const steps = Math.max(2, Math.min(120, Math.ceil(durationMs / 16)));
  for (let i = 0; i <= steps; i++) {
    const q = minimumJerk(i / steps);
    await page.mouse.move(
      from.x + (to.x - from.x) * q,
      from.y + (to.y - from.y) * q,
    );
    if (i < steps) await page.waitForTimeout(durationMs / steps);
  }
}
```

For ordinary form QA, `locator.fill()` is faster and deterministic. For key/composition/accessibility tests, use keyboard input and assert the expected event sequence. Do not add fake typos unless typo correction itself is the feature under test.

### Container/image baseline

```Dockerfile
# Illustrative only: pin the base by digest and verify downloaded browser hashes.
FROM ubuntu:24.04@sha256:REPLACE_WITH_APPROVED_DIGEST

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates fontconfig \
      fonts-dejavu-core fonts-liberation fonts-noto-core \
      fonts-noto-cjk fonts-noto-color-emoji \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

# Install an exact Chrome for Testing + matching ChromeDriver version here.
# Verify SHA-256, record it in the cohort manifest, and never use "latest".

RUN useradd --create-home --shell /bin/bash browser \
    && install -d -o browser -g browser -m 0700 /profiles
USER browser
```

Guidelines:

- install the font corpus the selected OS cohort should expose, not every package available;
- pair browser and driver versions;
- run as an unprivileged user and retain browser sandboxing whenever the environment supports it;
- at container runtime, drop unnecessary capabilities, use a default-or-stricter seccomp/AppArmor/SELinux policy, restrict mounts and egress, and avoid privileged mode;
- do not copy `--no-sandbox` from container examples without an equivalent isolation boundary;
- provide actual audio/display services when the cohort claims them;
- pin globally installed automation packages too, not only Chrome;
- bind DevTools to loopback and front remote access with strong auth and authorization.

### First-party JavaScript probe

Run this only at an owned diagnostic origin. It intentionally gathers data that may be identifying; keep raw output short-lived.

```js
async function browserObservation() {
  const uaData = navigator.userAgentData;
  // LAB ONLY: identifying high-entropy values; never forward raw output to general telemetry.
  const highEntropy = uaData?.getHighEntropyValues
    ? await uaData.getHighEntropyValues([
        'architecture', 'bitness', 'fullVersionList',
        'model', 'platformVersion', 'wow64',
      ])
    : null;

  const permissionNames = ['geolocation', 'notifications', 'camera', 'microphone'];
  const permissions = {};
  for (const name of permissionNames) {
    try {
      permissions[name] = (await navigator.permissions.query({ name })).state;
    } catch (error) {
      permissions[name] = `unsupported:${error.name}`;
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = 240;
  canvas.height = 60;
  const ctx = canvas.getContext('2d');
  ctx.font = '16px Arial, sans-serif';
  ctx.fillStyle = '#123456';
  ctx.fillText('owned-lab-probe Ω नमस्ते', 4, 24);

  const gl = document.createElement('canvas').getContext('webgl');
  const debug = gl?.getExtension('WEBGL_debug_renderer_info');

  return {
    ua: navigator.userAgent,
    uaData: highEntropy,
    webdriver: navigator.webdriver,
    platform: navigator.platform,
    languages: [...navigator.languages],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null,
    screen: {
      width: screen.width, height: screen.height,
      availWidth: screen.availWidth, availHeight: screen.availHeight,
      colorDepth: screen.colorDepth,
      dpr: window.devicePixelRatio,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
    },
    input: {
      maxTouchPoints: navigator.maxTouchPoints,
      hover: matchMedia('(hover: hover)').matches,
      finePointer: matchMedia('(pointer: fine)').matches,
    },
    permissions,
    canvasSample: canvas.toDataURL(),
    webgl: gl ? {
      vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
      renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
      version: gl.getParameter(gl.VERSION),
      shadingLanguage: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    } : null,
  };
}
```

Do not export raw canvas data, IPs, cookies or stable identifiers into general production telemetry. The release harness can compute an allowlisted category/result in the secure lab and discard raw evidence after the retention window.

---

## Measurement and regression testing

### A golden cohort, not a golden fingerprint

Define a cohort by provenance:

```text
cohort = browser binary hash + OS image digest + architecture + GPU/display class
       + headful/headless + locale/timezone + profile class + network path
```

For each cohort store:

1. immutable provenance and exact launch arguments;
2. raw lab-only observations;
3. normalized observations with GREASE/volatile IDs separated;
4. expected distributions and hard cross-surface invariants;
5. first-seen and last-validated releases;
6. owner, authorization and rollback path.

A pass means “inside the expected cohort and coherent,” not “identical to a popular laptop.”

### Release matrix

| Axis | Minimum useful coverage |
|---|---|
| Browser | Production current and N−1; Beta/canary as nonblocking early warning. Add Firefox ESR/WebKit only if supported. |
| Platform | Every production OS/architecture plus a stock control. |
| Rendering | Real/hardware GPU, software renderer, and virtual display only where deployed. |
| Profile | Fresh ephemeral, returning persistent, private context. |
| Locale | At least one baseline plus every production regional cohort. |
| Display | Common 1x and HiDPI cohorts actually deployed. |
| Network | Direct lab control, real proxy path, H1/H2/H3 where supported. |
| Context | Page, same-origin frame, owned cross-origin/OOPIF, dedicated/shared/service workers. |
| Lifecycle | First request, post-`Accept-CH`, warm connection, cold launch, browser restart. |
| Repetition | PR: 3 cold runs; nightly: 20; release: 50 plus soak for production cohorts. |

Include privacy/accessibility configurations as false-positive controls. Include ordinary WebDriver with `navigator.webdriver === true` as a positive control proving the probe can see an intentional automation signal; do not label it malicious.

### Origin-side capture

At an owned endpoint capture and securely retain for the lab:

- HTTP method/version and ordered headers;
- UA, UA-CH, Accept, encoding, language, Fetch Metadata and priority;
- H2 SETTINGS/order/flow control/pseudo-header order;
- H3/QUIC parameters when applicable;
- raw and normalized TLS ClientHello, GREASE, groups, signatures, ALPN, JA3/JA4;
- first and second navigation after `Accept-CH`;
- cold and resumed connections.

A self-hostable starting point is [TrackMe](https://github.com/pagpeter/TrackMe), which reports raw TLS/header order and Akamai-style HTTP/2 fingerprints. Audit and pin it before use.

Authorized packet capture example:

```sh
sudo tcpdump -i "${CAPTURE_INTERFACE:?set the interface carrying the test traffic}" \
  -s0 -w run.pcap 'tcp port 443 or udp port 443'

# If the FoxIO JA4 Wireshark plugin is installed:
tshark -r run.pcap \
  -Y 'tls.handshake.ja4' \
  -T fields \
  -e tcp.stream -e ip.src -e ip.dst -e tls.handshake.ja4
```

Choose the interface from the actual topology: loopback is correct only when the tested traffic traverses it; ordinary remote traffic usually requires the relevant physical, tunnel, bridge, or namespace interface. Packet captures contain sensitive traffic metadata and sometimes payload depending on the environment. Encrypt, restrict and delete them promptly.

### Cross-context test

```ts
import { test, expect } from '@playwright/test';

const shared = () => {
  const nav = self.navigator as typeof self.navigator & { deviceMemory?: number };
  return {
    ua: nav.userAgent,
    platform: nav.platform,
    languages: [...nav.languages],
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemory: nav.deviceMemory ?? null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
};

test('shared system surfaces agree across contexts', async ({ page, context }) => {
  test.skip(
    context.browser()?.browserType().name() !== 'chromium',
    'Playwright service-worker inspection is Chromium-only',
  );
  await page.goto(`${process.env.LAB_ORIGIN}/contexts`);

  const observations: Record<string, ReturnType<typeof shared>> = {
    page: await page.evaluate(shared),
  };

  for (const [index, frame] of page.frames().entries())
    observations[`frame-${index}`] = await frame.evaluate(shared);

  const workerCreated = page.waitForEvent('worker');
  await page.evaluate(() => new Worker('/fp-worker.js'));
  observations.worker = await (await workerCreated).evaluate(shared);

  const serviceWorkerURL = new URL('/fp-sw.js', page.url()).href;
  const serviceWorkerScope = new URL('/contexts/', page.url()).href;
  let serviceWorker = context.serviceWorkers().find(
    worker => worker.url() === serviceWorkerURL,
  );
  if (!serviceWorker) {
    const swCreated = context.waitForEvent('serviceworker', {
      predicate: worker => worker.url() === serviceWorkerURL,
      timeout: 10_000,
    });
    await page.evaluate(async ({ scriptURL, scope }) => {
      const registration = await navigator.serviceWorker.register(scriptURL, { scope });
      registration.active?.postMessage('wake'); // start a persisted but dormant worker
    }, { scriptURL: serviceWorkerURL, scope: serviceWorkerScope });
    serviceWorker = await swCreated;
  }
  observations.serviceWorker = await serviceWorker.evaluate(shared);

  const keys = Object.keys(observations.page) as Array<keyof ReturnType<typeof shared>>;
  for (const key of keys) {
    const values = Object.values(observations).map(value => JSON.stringify(value[key]));
    expect(new Set(values).size, `${String(key)}: ${JSON.stringify(observations)}`).toBe(1);
  }
});
```

The shared probe deliberately contains only fields exposed across the tested realms; keep page-only surfaces such as `webdriver`, permissions, screen, and DOM APIs in context-specific probes. It matches the complete worker URL, reuses a live target, and otherwise arms the event before registration and sends a benign message to start a persisted but dormant active worker. Run the probe in a fresh disposable context if the target engine/lifecycle cannot expose such a worker—`unregister()` does not synchronously terminate an old target—and explicitly skip unsupported engines. In production code, type the observation map explicitly and normalize unsupported fields. Also assert cross-layer relationships: HTTP/JS language, UA/UA-CH/browser build, screen/DPR arithmetic, GPU cohort, protocol signature, and stable network lease.

### Metrics

- required-surface coverage;
- eligible cross-context consistency;
- hard coherence violations;
- repeat stability by component;
- normalized component drift;
- outlier rate within cohort;
- false-positive rate on stock/privacy/accessibility controls;
- public-checker disagreement;
- harness flake rate;
- startup/navigation latency and crash rate.

Report confidence intervals for proportions, predeclare the interval, and define the independent experimental unit; use cluster-aware analysis when runs share a profile, host, account, or egress. Suggested initial gates—not universal constants:

| Class | Initial gate |
|---|---|
| Provenance | Zero unapproved binary/image/lockfile/launch changes. |
| Required capture | 100% on production cohorts. |
| Hard invariants | Zero violations. |
| Same pinned browser + network path | Zero unexpected deterministic protocol drift. |
| Stable JS components | 20 cold runs with no unexpected drift are a smoke gate, not evidence of 99% population stability. |
| Flake rate | Exact one-sided 95% Clopper–Pearson upper bound <1%; with zero failures this requires at least 299 qualified independent observations. |
| False positives | Predeclare the interval method and sample size; do not enforce ≤1% or ≤3% bounds from the 20/50-run smoke matrices. |
| Release | Gate degradation only when concurrent treatment/control samples have adequate power for the declared effect size. |

Baseline and revise these numbers from clean internal controls. [FP-Inconsistent](https://arxiv.org/html/2406.07647v3) reported a nonzero false-positive rate on real-user data; “zero false positives” claims deserve skepticism.

### CI and rollout

1. **PR:** schema/unit checks, exact provenance diff, three cold production-cohort runs.
2. **Nightly:** all cohorts, 20 runs, longitudinal comparisons and nonblocking diagnostics.
3. **Release candidate:** 50 runs, protocol capture, current/N−1/Beta comparison.
4. **Canary:** 1% → 5% → 25% → 50% → 100%, with a hold covering at least one workload cycle.
5. **Auto-pause:** any hard invariant, sample-ratio mismatch, crash/error-budget breach or false-positive gate.

The 50-run release-candidate matrix is a smoke test; confidence-bound and degradation gates need a larger predeclared sample or accumulated comparable evidence.

Randomize canary assignment within cohorts, compare concurrent treatment/control, run A/A first, and keep rollback automatic. See Google SRE’s [canarying guidance](https://sre.google/workbook/canarying-releases/).

### Public diagnostics are indicators, not certificates

| Tool | Useful for | Cannot prove |
|---|---|---|
| [CreepJS](https://abrahamjuliot.github.io/creepjs/) / [source](https://github.com/abrahamjuliot/creepjs) | Broad JS surfaces, tampering/prototype “lies,” rendering/runtime anomalies. | Commercial acceptance, Internet-wide uniqueness, TLS correctness or human behavior. |
| [BrowserLeaks](https://browserleaks.com/) | Headers, WebRTC, canvas/WebGL, fonts and component diagnostics. | One valid bot verdict, durable identity or representative rarity. |
| [Sannysoft](https://bot.sannysoft.com/) | Fast legacy WebDriver/headless smoke test. | Modern coverage or known false-positive/negative rates. |
| [FingerprintJS OSS demo](https://fingerprintjs.github.io/fingerprintjs/) / [source](https://github.com/fingerprintjs/fingerprintjs) | Client-side component and hash stability. | Bot status or unique device identity; client-side results are spoofable. |
| [AmIUnique](https://amiunique.org/) | Population-relative rarity and longitudinal research visualization. | Internet-wide uniqueness; its population is voluntary. |
| [Cover Your Tracks](https://coveryourtracks.eff.org/) | Simulated tracker blocking and observed-cohort uniqueness. | Bot detection, TLS fidelity or universal privacy. |

Public tools change code, datasets and scoring independently. Use them as nonblocking canaries unless self-hosted at a pinned, reviewed commit. Never run production credentials through a third-party checker.

### Privacy-minimized telemetry

General release telemetry should look like:

```text
release_id, coarse_cohort_id, test_id, pass_or_fail,
reason_enum, latency_bucket, checker_availability
```

Do not export raw IPs, headers, UA strings, URLs, cookies, fingerprints, canvas/audio/WebGL values, or stable per-browser IDs. Do not assume hashing alone makes a fingerprint anonymous when practical linkage remains. Keep raw lab artifacts encrypted, access-controlled and short-lived; export only aggregate findings. See OpenTelemetry’s [sensitive-data guidance](https://opentelemetry.io/docs/security/handling-sensitive-data/).

---

## What Kernel’s public image repo implements

This section is a source audit of the public repository at commit [`3be26fcbcdbed7e615d57217ee8db8f9dac00ee3`](https://github.com/kernel/kernel-images/tree/3be26fcbcdbed7e615d57217ee8db8f9dac00ee3). It does not claim visibility into Kernel’s hosted control plane or private image layers. Inclusion is descriptive, not endorsement: automation-signal suppression and humanized-input features are dual-use, require express owner consent when aimed at third-party controls, and do not prove fidelity or undetectability.

### Implemented primitives

| Primitive | Public implementation | What it provides |
|---|---|---|
| Headless launch hardening | [`server/cmd/wrapper/chromium.go#L8-L61`](https://github.com/kernel/kernel-images/blob/3be26fcbcdbed7e615d57217ee8db8f9dac00ee3/server/cmd/wrapper/chromium.go#L8-L61) | A default list explicitly called “headless+stealth”: `--accept-lang=en-US,en` (which sets `Accept-Language`), pointer/hover Blink settings, `--disable-blink-features=AutomationControlled`, disabled `AcceptCHFrame`, SwiftShader/ANGLE and many stability/performance flags. |
| Default scope | [`server/cmd/wrapper/main.go#L93-L97`](https://github.com/kernel/kernel-images/blob/3be26fcbcdbed7e615d57217ee8db8f9dac00ee3/server/cmd/wrapper/main.go#L93-L97) | The default stealth list is applied only for the headless profile and only when `CHROMIUM_FLAGS` is empty. Headful defaults are caller-supplied. |
| Browser launcher | [`server/cmd/chromium-launcher/main.go#L48-L100`](https://github.com/kernel/kernel-images/blob/3be26fcbcdbed7e615d57217ee8db8f9dac00ee3/server/cmd/chromium-launcher/main.go#L48-L100) | Merges base/runtime flags, uses a persistent `/home/kernel/user-data`, a configurable internal remote-debugging port (default `9223`), and unified `--headless=new` for headless. It also forces `--remote-allow-origins=*`; the CDP endpoint must remain private or behind authenticated, authorized transport. |
| Version-paired browser/driver | [headful Dockerfile](https://github.com/kernel/kernel-images/blob/3be26fcbcdbed7e615d57217ee8db8f9dac00ee3/images/chromium-headful/Dockerfile#L286-L303), [headless Dockerfile](https://github.com/kernel/kernel-images/blob/3be26fcbcdbed7e615d57217ee8db8f9dac00ee3/images/chromium-headless/image/Dockerfile#L168-L185) | Selects Chrome for Testing `148.0.7778.97` and the same-version ChromeDriver; downloads are not digest-verified here, so this is version pairing rather than a fully reproducible supply chain. |
| In-image Playwright code executor | [`server/runtime/playwright-daemon.ts#L122-L175`](https://github.com/kernel/kernel-images/blob/3be26fcbcdbed7e615d57217ee8db8f9dac00ee3/server/runtime/playwright-daemon.ts#L122-L175), [`server/cmd/api/api/playwright.go#L39-L69`](https://github.com/kernel/kernel-images/blob/3be26fcbcdbed7e615d57217ee8db8f9dac00ee3/server/cmd/api/api/playwright.go#L39-L69) | `/playwright/execute` selects Patchright unless configured for `playwright-core`, attaches over CDP, then compiles caller-supplied TypeScript and executes it with `AsyncFunction` in the daemon’s Node realm—not a page sandbox. The child inherits the API environment. |
| Font normalization | [`images/chromium-headful/Dockerfile#L203-L234`](https://github.com/kernel/kernel-images/blob/3be26fcbcdbed7e615d57217ee8db8f9dac00ee3/images/chromium-headful/Dockerfile#L203-L234) | Installs a broad Ubuntu-style font set specifically because a minimal container was a reCAPTCHA/fingerprinting signal. |
| Headless fonts | [`images/chromium-headless/image/Dockerfile#L150-L160`](https://github.com/kernel/kernel-images/blob/3be26fcbcdbed7e615d57217ee8db8f9dac00ee3/images/chromium-headless/image/Dockerfile#L150-L160) | Installs a smaller international font subset, so headful/headless font surfaces differ. |
| Humanized pointer movement | [`server/lib/mousetrajectory/mousetrajectory.go`](https://github.com/kernel/kernel-images/blob/3be26fcbcdbed7e615d57217ee8db8f9dac00ee3/server/lib/mousetrajectory/mousetrajectory.go), [`server/cmd/api/api/computer.go#L105-L203`](https://github.com/kernel/kernel-images/blob/3be26fcbcdbed7e615d57217ee8db8f9dac00ee3/server/cmd/api/api/computer.go#L105-L203) | Randomized Bézier trajectories, distortion/easing and Gaussian inter-event timing through X11 input. The trajectory code credits Camoufox/HumanCursor. |
| Humanized typing | [`server/cmd/api/api/computer.go#L450-L665`](https://github.com/kernel/kernel-images/blob/3be26fcbcdbed7e615d57217ee8db8f9dac00ee3/server/cmd/api/api/computer.go#L450-L665), [`server/lib/typinghumanizer/typinghumanizer.go`](https://github.com/kernel/kernel-images/blob/3be26fcbcdbed7e615d57217ee8db8f9dac00ee3/server/lib/typinghumanizer/typinghumanizer.go) | Variable word/chunk delays, sentence pauses and optional corrected QWERTY typo injection through `xdotool`. |
| Humanized drag | [`server/cmd/api/api/computer.go#L1200-L1288`](https://github.com/kernel/kernel-images/blob/3be26fcbcdbed7e615d57217ee8db8f9dac00ee3/server/cmd/api/api/computer.go#L1200-L1288) | Multi-segment curves, smoothstep velocity and Gaussian delays. |
| Dynamic flags/policies/extensions | [`server/cmd/api/api/chromium_configure.go#L103-L168`](https://github.com/kernel/kernel-images/blob/3be26fcbcdbed7e615d57217ee8db8f9dac00ee3/server/cmd/api/api/chromium_configure.go#L103-L168), [`#L717-L788`](https://github.com/kernel/kernel-images/blob/3be26fcbcdbed7e615d57217ee8db8f9dac00ee3/server/cmd/api/api/chromium_configure.go#L717-L788), [`server/lib/chromiumflags/chromiumflags.go`](https://github.com/kernel/kernel-images/blob/3be26fcbcdbed7e615d57217ee8db8f9dac00ee3/server/lib/chromiumflags/chromiumflags.go) | Runtime Chromium flags plus managed policy and extension installation, applied on the stop/start configuration path. |
| Browser policy defaults | [`shared/chromium-policies/managed/policy.json`](https://github.com/kernel/kernel-images/blob/3be26fcbcdbed7e615d57217ee8db8f9dac00ee3/shared/chromium-policies/managed/policy.json) | Disables password/address/card autofill, notifications and geolocation by default; configures search and extension policy. |
| xDS control path | [`shared/envoy/bootstrap.yaml#L12-L72`](https://github.com/kernel/kernel-images/blob/3be26fcbcdbed7e615d57217ee8db8f9dac00ee3/shared/envoy/bootstrap.yaml#L12-L72) | ADS sends the instance bearer JWT as gRPC metadata. The public upstream TLS context sets SNI but has no certificate-validation context. |
| Image-baked proxy CA | [`shared/envoy/bake-certs.sh#L29-L47`](https://github.com/kernel/kernel-images/blob/3be26fcbcdbed7e615d57217ee8db8f9dac00ee3/shared/envoy/bake-certs.sh#L29-L47) | The image build generates and retains a private CA key, then trusts its certificate in the system and root/kernel NSS stores. The CA certificate’s localhost SAN does not constrain names on leaf certificates it signs. |
| Private proxy additions | [`shared/envoy/bake-certs.sh#L49-L60`](https://github.com/kernel/kernel-images/blob/3be26fcbcdbed7e615d57217ee8db8f9dac00ee3/shared/envoy/bake-certs.sh#L49-L60) | The public script says Bright Data certificates are supplied by `install-proxy.sh` in private images, so production proxy identity remains partly private. |
| Profile/session persistence | [`server/cmd/chromium-launcher/main.go#L88-L99`](https://github.com/kernel/kernel-images/blob/3be26fcbcdbed7e615d57217ee8db8f9dac00ee3/server/cmd/chromium-launcher/main.go#L88-L99) | One persistent user-data directory supports cookies and continuity across browser restarts/snapshots. |

Relevant intent is also visible in snapshot ancestry: `cba3f77` added fonts after CreepJS showed only three; `a0cfe0a` added smooth typing; `c058cb0` added Gaussian mouse delays; `e35232f` paired Chrome and ChromeDriver.

### Security-critical public-source findings

These are facts about the pinned public image source, not claims about unobserved hosted edge controls or private image overrides. Treat production impact as conditional, but do not assume a private layer repairs them.

1. **The public xDS TLS client does not authenticate its server.** [`bootstrap.yaml#L23-L25`](https://github.com/kernel/kernel-images/blob/3be26fcbcdbed7e615d57217ee8db8f9dac00ee3/shared/envoy/bootstrap.yaml#L23-L25) sends a bearer JWT, while [`#L57-L63`](https://github.com/kernel/kernel-images/blob/3be26fcbcdbed7e615d57217ee8db8f9dac00ee3/shared/envoy/bootstrap.yaml#L57-L63) supplies only SNI—an `UpstreamTlsContext` with no `common_tls_context` or `validation_context`. Envoy 1.32 documents that [server-certificate verification is disabled by default](https://www.envoyproxy.io/docs/envoy/v1.32.11/api-v3/extensions/transport_sockets/tls/v3/tls.proto.html); SNI is not validation. The block's own comment reads "Uses TLS to verify xDS server, and SNI hostname for TLS handshake"—it asserts verification the configuration does not implement, which is the more instructive half of the finding. Configure a trusted CA plus exact DNS SAN verification—or an equivalent verified SDS context, preferably mTLS—before sending the token.
2. **`/playwright/execute` is container-level code execution.** Caller code runs in the daemon’s Node global realm; the [API launches it with the full environment](https://github.com/kernel/kernel-images/blob/3be26fcbcdbed7e615d57217ee8db8f9dac00ee3/server/cmd/api/api/playwright.go#L62-L65), and the public [headful final stage](https://github.com/kernel/kernel-images/blob/3be26fcbcdbed7e615d57217ee8db8f9dac00ee3/images/chromium-headful/Dockerfile#L383-L391), [headless final stage](https://github.com/kernel/kernel-images/blob/3be26fcbcdbed7e615d57217ee8db8f9dac00ee3/images/chromium-headless/image/Dockerfile#L229-L279), and [API supervisor entry](https://github.com/kernel/kernel-images/blob/3be26fcbcdbed7e615d57217ee8db8f9dac00ee3/images/chromium-headful/supervisor/services/kernel-images-api.conf) do not select a non-root API user. The abort path races the promise but does not terminate underlying asynchronous code, and synchronous code can block the timer. Outer authorization is necessary but not a sandbox: use a killable, resource-limited, unprivileged per-request process/container with a sanitized environment and no profile, CA-key, or control-plane-secret access.
3. **The proxy CA private key is shared in the image trust domain and is not hostname-constrained.** The [public build script](https://github.com/kernel/kernel-images/blob/3be26fcbcdbed7e615d57217ee8db8f9dac00ee3/shared/envoy/bake-certs.sh#L29-L47) under Ubuntu/OpenSSL produces a `CA:TRUE` certificate; its localhost SAN identifies the CA certificate but is not an [RFC 5280 name constraint](https://www.rfc-editor.org/rfc/rfc5280.html#section-4.2.1.10) on issued leaves. `openssl req -x509 -nodes` leaves the key unencrypted in the image, and `certutil -t "C,,"` installs the certificate as a trust anchor in both NSS databases and the system store. Generate isolated per-instance credentials outside image layers, keep signing keys inaccessible to workloads, rotate them, and pin or otherwise constrain the intended localhost endpoint.

**Findings 2 and 3 compose, and that composition is the actual risk.** Neither image Dockerfile contains a `USER` directive, so the API runs as root; the daemon inherits `os.Environ()`. Caller-supplied code submitted to `/playwright/execute` therefore runs as root inside the container and can simply read the CA private key, then mint leaf certificates for any origin that the same container's Chromium already trusts. The build script carries an in-repo rebuttal—"Sharing the key across containers built from the same image does not widen the threat model"—which holds only while nothing untrusted executes in the container. Finding 2 establishes that something untrusted does. This is the general lesson, not a Kernel-specific one: a trust-store assumption and a code-execution surface are each defensible in isolation and jointly fatal, so audit privilege boundaries as a graph rather than a checklist.

### Other important limits

1. **Headless and headful are asymmetric.** The built-in stealth list is headless-only. Local headful `run-docker.sh` supplies its own flags, but production callers control headful defaults.
2. **Any nonempty `CHROMIUM_FLAGS` replaces the headless default list.** Runtime flag merging occurs later; callers can accidentally discard the baseline.
3. **Patchright’s scope is narrow.** It changes the in-image daemon’s browser-control behavior; it does not sandbox caller Node code. An external Playwright/Puppeteer/Selenium client connecting to the public CDP/ChromeDriver proxy uses its own framework behavior.
4. **Patchright and Playwright packages are installed without explicit npm versions** in the Dockerfiles, while Chrome is pinned. Rebuilding at different times can change the control layer unless the image build resolves from an external lock/cache.
5. **The repo uses ordinary Chrome for Testing, not a source-patched fingerprint browser.** There is no public C++ engine patch for navigator, canvas, WebGL, audio, worker realms, UA-CH or TLS.
6. **No public identity compiler is visible.** There is no per-profile manifest constraining UA/platform/locale/timezone/geolocation/screen/GPU/font/network relationships.
7. **No complete origin-side fingerprint regression harness is visible.** Existing tests validate infrastructure and behavior, not a cohort-based TLS/HTTP/JS consistency matrix.
8. **Proxy identity is partly private.** Public Envoy/xDS and trust plumbing exist, but the comment about private image installation means this repo cannot establish the production proxy topology, sourcing, DNS, WebRTC or geographic policy.
9. **Humanized input is a UX/behavior primitive, not evidence of undetectability.** The distributions are hand-designed and site-independent; no general detector-validity claim follows.
10. **A fixed persistent profile is useful but sensitive.** It needs single ownership, encryption/access controls and explicit account/egress lifecycle outside this repo.
11. **The managed policy denies geolocation by default.** Regional identity alignment would require authorized runtime policy/context configuration.
12. **`--no-sandbox` appears in the headless default.** That is a container/isolation tradeoff, not an antidetection technique, and should not be copied into less isolated deployments.
13. **The launcher forces `--remote-allow-origins=*`.** This relaxes the WebSocket origin check; exposing the debugging port is a control-plane vulnerability, not a fingerprint issue. Keep it on a private boundary or front it with authenticated, authorized transport.
14. **The wrapper attempts a global IPv6 shutdown and ignores failure.** [`server/cmd/wrapper/main.go#L110-L112`](https://github.com/kernel/kernel-images/blob/3be26fcbcdbed7e615d57217ee8db8f9dac00ee3/server/cmd/wrapper/main.go#L110-L112) writes both `all/disable_ipv6` and `default/disable_ipv6` without checking errors. Assert at runtime whether IPv6 is actually disabled and whether the intended IPv4-only policy holds.
15. **More supply-chain inputs remain mutable.** Public Docker stages use tag-only base images, unversioned apt packages, an Envoy package branch, and `latest` FFmpeg assets. The downloaded FFmpeg archive is checked against a fetched checksum, but both move together. Record immutable base digests, dated repositories, exact package/artifact versions, and independently pinned hashes.

### Bottom line

The public repo contains several **image/runtime primitives**: real Chrome, same-version browser/driver pairing, headless automation-flag suppression, Patchright for one execution path, a more realistic headful font corpus, persistent state, proxy plumbing, and humanized input APIs. This inventory is not a recommendation to use signal suppression or input simulation against third-party controls. It also exposes the security-sensitive xDS, code-execution, CA-key, debugging-port, and privilege boundaries above; private layers may mitigate them, but the public source cannot establish that. It does **not** publicly implement a complete, cross-layer antidetection product. The missing system is the identity compiler, full network policy, realm-complete browser behavior, cohort regression harness, and operational authorization/profile/account lifecycle described in this handbook.

---

## Myths and recurring failure modes

| Myth | Reality |
|---|---|
| “Set `navigator.webdriver` to undefined and you are done.” | It is one standardized signal. Deleting it can itself violate current WebIDL semantics; launch, CDP, network, realms and behavior remain. |
| “Headful means human.” | A headful browser in Xvfb with SwiftShader, minimal fonts and deterministic CDP input is still an automated environment. |
| “Unified headless is identical to headful.” | It shares Chrome code, not display/GPU/audio/window/input conditions. `--headless` still affects automation state. |
| “A real Chrome UA makes a client Chrome.” | TLS, H2/H3, Client Hints, features, rendering and connection reuse must come from a compatible stack. |
| “Copy browser headers into `requests`/curl.” | Header values cannot reproduce browser TLS, protocol framing, Fetch Metadata context, compression or pools. Measured against a TLS-terminating origin with curl carrying Chrome's exact headers: 16 cipher suites versus 49, 17 extensions versus 6, GREASE present versus absent, different JA3. Nothing below the header layer matched. |
| “Randomize everything.” | Independent randomness breaks correlations, destroys session stability and often creates rare values. |
| “Canvas noise solves fingerprinting.” | It can be unstable, realm-incomplete and inconsistent with fonts/WebGL/GPU. |
| “Install every font.” | The resulting corpus can be as implausible as a minimal image. Match an OS cohort. |
| “Residential IP equals trust.” | Reputation, account history, authorization and behavior still matter. Opaque residential sourcing creates ethical/security risk. |
| “Rotate after a block.” | That is enforcement evasion, destroys identity continuity and can raise legal/contractual risk. Stop or obtain permission. |
| “Patchright/stealth/Camoufox is undetectable.” | Each changes a bounded layer and inherits version, network, hardware, behavior and supply-chain limits. |
| “Passing CreepJS/Sannysoft proves success.” | Public checkers cover known client-side probes, not a site’s server-side model. |
| “`isTrusted=true` means human.” | It means the user agent dispatched the event; automation protocols can produce trusted events. |
| “Human-like delay means human.” | Simple distributions are easy to cluster and have no universal empirical guarantee. |
| “Aged profiles/cookie farming create trust.” | No controlled general evidence supports synthetic warm-up rituals; state also adds secrets and linkability. |
| “A unique fingerprint is bad, a common one is good.” | Uniqueness is dataset-relative; authenticity, stability, linkability and risk are separate. |
| “A fingerprint is authentication.” | Fingerprints can collide, drift and be cloned. Use real authentication such as WebAuthn. |
| “robots.txt grants access.” | [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html) says its rules are requested crawler behavior and **not access authorization**. |
| “Detection is an arms race, so evasion is the only strategy.” | Signed operator identity ([RFC 9421](https://www.rfc-editor.org/rfc/rfc9421) and the Web Bot Auth drafts) and attestation tokens (Privacy Pass) let a client be identified rather than guessed at. Where an origin supports either, evasion is the strictly worse engineering choice. |

---

## Security, privacy, legal, and abuse controls

### Authorization record

Every production automation job should resolve an immutable authorization record containing:

- owner and approving party;
- purpose;
- immutable approval/evidence reference;
- enumerated authorized methods and capabilities—including control stack, signal suppression, framework/browser patch digests, protocol emulation, and synthetic-input model;
- exact origins and environments;
- allowed accounts/actions/data classes;
- rate/concurrency limits;
- credential source;
- third-party challenge stop policy and separate owned-app test/ordinary-review HITL policy;
- logging/retention policy;
- start and expiry;
- emergency stop contact.

If the record is missing, invalid, expired, ambiguous, or does not explicitly authorize a requested method, fail closed. Before launch, compare the requested image, patch digests, launch flags, network mode, permission grants, and input model with this record.

### Protect the browser control plane

CDP/WebDriver can execute code, navigate, inspect network traffic, and access cookies/storage. Treat them like remote code execution:

- bind to loopback by default;
- use mutually authenticated and authorized transport for remote access;
- isolate each tenant/session;
- firewall the port from untrusted networks;
- issue short-lived scoped control tokens;
- never expose the browser-level WebSocket URL in logs or client-side pages;
- close sessions and invalidate tokens on job completion;
- do not attach automation to a personal/default profile.

### Protect profiles and proxy credentials

- profile directories, `storageState`, cookies and session tokens are secrets;
- encrypt at rest and in transit;
- confine them under a trusted root, reject symlinks/owner mismatches, explicitly repair and verify mode `0700`, and enforce per-job identity plus least privilege;
- prohibit repository commits, HAR inclusion and general logs;
- prevent concurrent profile use;
- expire and revoke;
- avoid secrets in proxy URLs, command lines and environment dumps;
- audit third-party proxy sourcing and subprocessors;
- use organization-controlled egress where possible.

### Browser fork and package supply chain

A custom browser has the attack surface of a browser plus a rebasing pipeline. Require:

- signed/reproducible artifacts and checksums;
- immutable base images, dated package repositories/snapshots, and locked dependency versions;
- upstream security-release SLA;
- source diff review;
- SBOM and dependency pinning;
- sandbox and exploit-mitigation conformance;
- browser/web-platform tests;
- automatic rollback;
- clear license review.

Do not accept anti-detect vendor claims without artifact provenance, patch inventory, update history, and repeatable measurements.

### Privacy and data protection

Fingerprints, IPs, cookie IDs and behavioral traces may be personal data or online identifiers because they can single out or link people. In the EU/EEA:

- [GDPR Article 5](https://eur-lex.europa.eu/eli/reg/2016/679/art_5/oj) requires lawfulness/fairness/transparency, purpose limitation, minimization, accuracy, storage limitation, security and accountability;
- [Article 6](https://eur-lex.europa.eu/eli/reg/2016/679/art_6/oj) requires an applicable lawful basis; accountability and related compliance duties generally require documenting that assessment;
- Recital 30 recognizes IP addresses, cookie identifiers and similar online identifiers as potential means to create profiles and identify people;
- the final [EDPB Guidelines 2/2023](https://www.edpb.europa.eu/documents/guideline/guidelines-22023-on-technical-scope-of-art-53-of-eprivacy-directive_en) explain the technical scope of ePrivacy Article 5(3), including terminal access beyond traditional cookies.

Guidance is not itself the statute, implementations and national transpositions differ, and security/fraud purposes do not automatically exempt a system. Obtain counsel for the actual jurisdiction and purpose. Operationally:

- collect only components needed for a declared test/security purpose;
- do not export raw lab fingerprints into analytics;
- avoid logging actual typed content or mouse biometrics;
- separate security from advertising/analytics purposes;
- use short retention and documented deletion;
- do not call a hash anonymous if it remains practically linkable;
- document the applicable ePrivacy Article 5(3) consent or transmission/strict-necessity analysis separately from the GDPR Article 6 lawful-basis analysis;
- provide transparency and rights handling where required;
- perform DPIA/LIA or equivalent review where appropriate.

### Robots, terms, and US authorization

[RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html) asks crawlers to honor service instructions and explicitly says they are not access authorization or a substitute for security controls. Respect it as a minimum crawler policy, then separately verify terms, API agreements and written authorization.

In the United States, `hiQ v. LinkedIn` concerned particular facts and publicly accessible data in the Ninth Circuit; it is not blanket permission to scrape. Contract, privacy, copyright, trespass, state law and technical-control facts remain relevant. The [DOJ CFAA charging policy](https://www.justice.gov/jm/jm-9-48000-computer-fraud) is enforcement guidance, not a change to the statute and not protection for profit-driven circumvention. Get legal advice rather than deriving authorization from technical accessibility.

### Accessibility and false positives

Privacy browsers, enterprise interception, assistive technology, unusual input devices, travel and multilingual configurations can look anomalous. Never equate “unusual” with “malicious.” Challenges need accessible alternatives consistent with [WCAG 2.2](https://www.w3.org/TR/WCAG22/). Measure false positives with privacy/accessibility cohorts and use step-up/manual review rather than irreversible action from one client fingerprint.

### Explicitly prohibited operating patterns

This handbook must not be used to implement:

- credential stuffing, account takeover or card testing;
- fake ad impressions/clicks, reviews, likes, follows or engagement;
- mass synthetic accounts or account farming;
- scraping private/authenticated data without permission;
- bypassing login walls, paywalls, geographic controls or quotas;
- CAPTCHA/challenge outsourcing or token replay;
- profile/proxy/fingerprint rotation after denial;
- impersonating a particular person/device;
- collecting or retaining user fingerprints beyond the authorized purpose;
- using compromised, deceptive or non-consensual residential proxy endpoints.

A job that reaches one of these conditions must stop and alert its operator.

### Incident response

Have one switch that stops the fleet. Trigger it on:

- authorization expiry or revocation;
- unexpected target origin;
- challenge/`403`/`429` spike;
- profile or secret leak;
- direct-egress/DNS/WebRTC leak;
- unapproved binary/package drift;
- detector false-positive regression;
- origin load or error-budget impact;
- suspected policy/terms violation.

Preserve only the minimum forensic evidence, rotate exposed credentials, notify the owner/site when required, and add a regression before restart.

---

## Developer and agent checklists

### Design

- [ ] Written authorization, immutable evidence, approved methods/artifact digests, allowed origins/actions/accounts and expiry exist.
- [ ] Requested control, patch, network, permission and input methods are machine-checked against that authorization.
- [ ] Official API/test mode/allowlisting was considered before browser hardening.
- [ ] Declared-identity options (signed requests, verified-operator enrollment) were checked before any signal-suppression work.
- [ ] A real OS/browser/GPU/display/font/network cohort is selected.
- [ ] One identity manifest derives all configuration.
- [ ] Hard constraints and soft heuristics are distinguished.
- [ ] Profile, account and egress have single-owner leases.
- [ ] Direct egress, IPv6, DNS, QUIC and WebRTC paths are designed explicitly.
- [ ] Control-plane and profile secrets have a threat model.
- [ ] Challenge, retry, idempotency, rate and emergency-stop behavior are defined.
- [ ] Data inventory, GDPR lawful basis, separate ePrivacy Article 5(3) analysis, retention and deletion are reviewed.

### Build

- [ ] Browser, driver, framework, packages, OS image, package repository snapshot and patches are pinned by version/digest.
- [ ] Browser/driver versions match.
- [ ] Browser runs unprivileged with sandboxing or a documented equivalent isolation boundary.
- [ ] Fonts/codecs/audio/GPU/display match the cohort.
- [ ] UA, UA-CH, TLS and browser-controlled headers remain native unless a specific compatibility test requires otherwise.
- [ ] Configuration occurs before first navigation/target creation.
- [ ] Page, frame and worker realms are covered.
- [ ] Proxy secrets are injected at runtime and redacted.
- [ ] CDP/WebDriver bind to loopback or authenticated transport.
- [ ] Workflow is a bounded semantic state machine, not sleeps and blind retries.

### Verify

- [ ] Origin captures IPv4/IPv6, TLS, ALPN, HTTP version/settings and redacted headers.
- [ ] Browser probe covers runtime, rendering, permissions and context consistency.
- [ ] No direct DNS/IPv6/WebRTC/QUIC leak exists outside policy.
- [ ] Stock, privacy and accessibility controls are present.
- [ ] Fresh, returning and persistent profile cases are distinct.
- [ ] Cold/warm/restart and post-`Accept-CH` cases run.
- [ ] Hard invariants have zero violations.
- [ ] Drift/flake/false-positive metrics include confidence intervals.
- [ ] Public checkers are nonblocking and never receive production credentials.
- [ ] Raw fingerprints and packet captures are short-lived and access-controlled.

### Operate

- [ ] Authorization is checked at job start and each cross-origin navigation.
- [ ] Egress/profile/account leases remain stable and unique.
- [ ] `Retry-After`, concurrency and action budgets are honored.
- [ ] Third-party challenges and policy `403`s stop; `401` reauthentication and owned-app test hooks follow explicit authorization.
- [ ] Mutations are idempotent or explicitly confirmed.
- [ ] Release is canaried by cohort with automatic rollback.
- [ ] Browser/framework security updates meet SLA.
- [ ] No one rotates identity to evade a service decision.
- [ ] Fleet-wide stop and incident contacts are tested.

### Agent rules

An autonomous agent using this handbook should follow these invariants:

```text
MUST verify authority and requested methods before launch or navigation.
MUST stay inside allowlisted origins and actions.
MUST use the assigned identity/profile/account/egress lease.
MUST preserve identity continuity during a session.
MUST stop on third-party challenges and access denials; human review is only for separately authorized, non-challenge decisions.
MUST honor rate limits, deadlines and idempotency.
MUST redact secrets and minimize fingerprint telemetry.
MUST report uncertainty and version-specific claims.
MUST NOT rotate identity after enforcement.
MUST NOT solve or outsource challenges.
MUST NOT create accounts, engagement or transactions outside explicit scope.
MUST NOT expose CDP or profile state.
MUST NOT interpret a public checker as authorization or proof of invisibility.
```

---

## Annotated source library

Live `main`, `tot`, registry, and specification URLs are verification entry points, not frozen evidence. For a reproducible audit, archive resolved commit/schema versions, registry metadata, retrieval dates, and content hashes alongside the research snapshot.

### Standards and browser semantics

- **[W3C — Mitigating Browser Fingerprinting in Web Specifications](https://www.w3.org/TR/fingerprinting-guidance/):** canonical terminology, severity factors and mitigation principles; explicitly says mitigations are not complete solutions.
- **[RFC 8942 — HTTP Client Hints](https://www.rfc-editor.org/rfc/rfc8942.html):** `Accept-CH`, origin binding, persistence, privacy/security and entropy guidance.
- **[WICG — User-Agent Client Hints](https://wicg.github.io/ua-client-hints/):** UA-CH fields and algorithms.
- **[WHATWG HTML — system state](https://html.spec.whatwg.org/multipage/system-state.html):** navigator/platform/language/user-agent behavior.
- **[W3C WebDriver](https://www.w3.org/TR/webdriver2/):** webdriver-active flag, sessions, actions and trusted input requirements.
- **[W3C WebDriver BiDi](https://www.w3.org/TR/webdriver-bidi/):** bidirectional session/event protocol.
- **[Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/):** Runtime, Input, Network and emulation semantics.
- **[Chrome Headless](https://developer.chrome.com/docs/chromium/headless):** unified headless history and current modes.
- **[Chrome for Testing](https://developer.chrome.com/blog/chrome-for-testing/):** official rationale and versioned browser/driver artifacts.
- **[Chrome remote debugging security](https://developer.chrome.com/blog/remote-debugging-port):** non-default profile requirement and control-plane hardening rationale.
- **[Chrome UA-CH developer guide](https://developer.chrome.com/docs/privacy-security/user-agent-client-hints):** practical negotiation and JavaScript/header behavior.
- **[Chrome UA override guide](https://developer.chrome.com/docs/devtools/device-mode/override-user-agent):** coordinated UA string and UA metadata emulation.
- **[DOM `isTrusted`](https://dom.spec.whatwg.org/#dom-event-istrusted):** event trust semantics.

### Privacy-browser strategies

- **[Tor Browser fingerprinting protections](https://support.torproject.org/tor-browser/features/fingerprinting-protections/):** normalization, letterboxing, language/font and UA buckets; useful for understanding anonymity sets, not automation stealth.
- **[Tor Browser design](https://spec.torproject.org/torbrowser-design):** cross-origin unlinkability and fingerprinting-defense architecture.
- **[Mozilla Resist Fingerprinting](https://support.mozilla.org/en-US/kb/resist-fingerprinting):** aggressive normalization and compatibility tradeoffs.
- **[Brave fingerprinting protections](https://github.com/brave/brave-browser/wiki/Fingerprinting-Protections):** farbling and site-scoped privacy design.
- **[WebKit Tracking Prevention Policy](https://webkit.org/tracking-prevention-policy/):** WebKit’s anti-tracking objectives and classification.

### Fingerprinting research

- **[Eckersley — How Unique Is Your Web Browser?](https://coveryourtracks.eff.org/static/browser-uniqueness.pdf):** Panopticlick entropy/uniqueness study; remember its self-selected population.
- **[FP-STALKER](https://inria.hal.science/hal-01652021v1):** longitudinal matching while fingerprint components change.
- **[Long-term ground-truth study](https://petsymposium.org/popets/2020/popets-2020-0041.pdf):** appearance uniqueness, entity uniqueness, stability and trackability as separate properties.
- **[Cross-browser OS/hardware fingerprinting](https://www.ndss-symposium.org/wp-content/uploads/2017/09/ndss2017_02B-3_Cao_paper.pdf):** WebGL/audio/CPU features across browsers.
- **[FP-Inspector](https://arxiv.org/abs/2008.04480):** detecting fingerprinting scripts through syntactic/semantic analysis.
- **[Taming the Shape Shifter](https://pmc.ncbi.nlm.nih.gov/articles/PMC7338203/):** empirical evaluation and detection of anti-fingerprinting browsers; historically useful, not a current tool benchmark.
- **[Gummy Browsers](https://arxiv.org/pdf/2110.10129v1.pdf):** fingerprint cloning and why fingerprints are not authentication.
- **[FP-Inconsistent](https://arxiv.org/html/2406.07647v3):** cross-attribute inconsistency detection and false-positive evidence.
- **[Beyond the Crawl](https://arxiv.org/abs/2502.01608):** automated crawls miss fingerprinting that appears after real interaction/auth/consent; useful measurement caveat.
- **[Behavior + web-log bot detection](https://doi.org/10.1145/3447815):** combined behavioral/server features in a bounded dataset.
- **[BeCAPTCHA-Mouse](https://doi.org/10.1016/j.patcog.2022.108643):** mouse-trajectory classification; do not generalize its benchmark accuracy to all sites.
- **[ReMouse](https://doi.org/10.3390/jcp3010007):** repeat-session variability and replay detection in a guided dataset.

### Automation and patch projects

- **[Playwright](https://github.com/microsoft/playwright)** and **[browser docs](https://playwright.dev/docs/browsers):** upstream behavior, bundled browser/version coupling and emulation APIs.
- **[Puppeteer](https://github.com/puppeteer/puppeteer):** Chromium CDP implementation and defaults.
- **[Selenium](https://github.com/SeleniumHQ/selenium):** WebDriver/BiDi reference implementation ecosystem.
- **[Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright):** Playwright fork; inspect actual patches and version relationship rather than relying on “undetected” claims.
- **[rebrowser-patches](https://github.com/rebrowser/rebrowser-patches):** targeted Playwright/Puppeteer CDP context patches.
- **[puppeteer-extra stealth](https://github.com/berstend/puppeteer-extra/tree/master/packages/puppeteer-extra-plugin-stealth):** instructive catalog of JS evasions and their maintenance/realm limits.
- **[Camoufox](https://github.com/daijro/camoufox):** source-patched Firefox approach and generated profiles; audit beta/security/update state.
- **[undetected-chromedriver](https://github.com/ultrafunkamsterdam/undetected-chromedriver)** and **[nodriver](https://github.com/ultrafunkamsterdam/nodriver):** driver-patching versus direct-CDP approaches; both remain version-sensitive.

### Network and protocol

- **[Chromium proxy documentation](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md):** HTTP/HTTPS/SOCKS behavior, DNS, auth, bypass and fallback.
- **[RFC 9110 — HTTP semantics/CONNECT](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.3.6)**, **[proxy auth](https://www.rfc-editor.org/rfc/rfc9110.html#section-11.7)**, and **[RFC 9298 — CONNECT-UDP](https://www.rfc-editor.org/rfc/rfc9298.html)**.
- **[RFC 1928 — SOCKS5](https://www.rfc-editor.org/rfc/rfc1928.html)** and **[RFC 1929 — username/password](https://www.rfc-editor.org/rfc/rfc1929.html)**.
- **[RFC 8446 — TLS 1.3](https://www.rfc-editor.org/rfc/rfc8446.html)**, **[RFC 7301 — ALPN](https://www.rfc-editor.org/rfc/rfc7301.html)**, and **[RFC 8701 — GREASE](https://www.rfc-editor.org/rfc/rfc8701.html)**.
- **[JA3](https://engineering.salesforce.com/tls-fingerprinting-with-ja3-and-ja3s-247362855967/)** and **[JA4 specification](https://github.com/FoxIO-LLC/ja4/blob/main/technical_details/JA4.md):** implementation fingerprints and limitations.
- **[Cloudflare JA4 signals](https://blog.cloudflare.com/ja4-signals/)** and **[operational docs](https://developers.cloudflare.com/bots/additional-configurations/ja3-ja4-fingerprint/):** modern normalization and probabilistic treatment.
- **[RFC 9113 — HTTP/2](https://www.rfc-editor.org/rfc/rfc9113.html)** and the original [HTTP/2 implementation fingerprinting study](https://blackhat.com/docs/eu-17/materials/eu-17-Shuster-Passive-Fingerprinting-Of-HTTP2-Clients-wp.pdf).
- **[RFC 9000 — QUIC](https://www.rfc-editor.org/rfc/rfc9000.html)**, **[RFC 9001 — QUIC TLS](https://www.rfc-editor.org/rfc/rfc9001.html)**, and **[RFC 9114 — HTTP/3](https://www.rfc-editor.org/rfc/rfc9114.html)**.
- **[Fetch standard](https://fetch.spec.whatwg.org/)** and **[Fetch Metadata](https://www.w3.org/TR/fetch-metadata/):** browser-controlled request-context headers.
- **[RFC 8828 — WebRTC IP handling](https://www.rfc-editor.org/rfc/rfc8828.html#section-5.2)** and **[WebRTC ICE transport policy](https://www.w3.org/TR/webrtc/#dom-rtcconfiguration-icetransportpolicy)**.
- **[MaxMind geolocation accuracy](https://support.maxmind.com/knowledge-base/articles/maxmind-geolocation-accuracy):** why city-level matching is not a hard invariant.

### Diagnostic tools

- **[CreepJS](https://github.com/abrahamjuliot/creepjs):** broad JS/realm/rendering/tamper diagnostics.
- **[BrowserLeaks](https://browserleaks.com/):** component-by-component network and browser tests.
- **[FingerprintJS OSS](https://github.com/fingerprintjs/fingerprintjs):** client-side component collection and stability; not bot detection/authentication.
- **[AmIUnique](https://amiunique.org/):** research-oriented population rarity and longitudinal study.
- **[Cover Your Tracks](https://coveryourtracks.eff.org/):** tracker-blocking simulation and observed-cohort uniqueness.
- **[TrackMe](https://github.com/pagpeter/TrackMe):** self-hostable origin-side TLS/header/H2 inspection starting point.

### Declared identity and token standards

- **[RFC 9421 — HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421):** the signing mechanism Web Bot Auth builds on; covers signature bases, `Signature-Input`, and key identification.
- **[IETF Web Bot Auth working group](https://datatracker.ietf.org/group/webbotauth/):** charter and current documents. Check here first—this area moves faster than anything else cited in this handbook, and draft names have already changed once.
- **[`draft-meunier-webbotauth-httpsig-protocol`](https://datatracker.ietf.org/doc/draft-meunier-webbotauth-httpsig-protocol/):** signing model for cryptographically identifying automated traffic. Individual submission, not yet WG-adopted. Replaces `draft-meunier-web-bot-auth-architecture`.
- **[`draft-meunier-webbotauth-httpsig-directory`](https://datatracker.ietf.org/doc/draft-meunier-webbotauth-httpsig-directory/):** public-key directory discovery via the `Signature-Agent` header. Replaces `draft-meunier-http-message-signatures-directory`.
- **[RFC 7638 — JSON Web Key Thumbprint](https://www.rfc-editor.org/rfc/rfc7638.html):** the `keyid` construction used above.
- **[RFC 9576 — Privacy Pass Architecture](https://www.rfc-editor.org/rfc/rfc9576.html)**, **[RFC 9577 — Privacy Pass HTTP Authentication Scheme](https://www.rfc-editor.org/rfc/rfc9577.html)**, and **[RFC 9578 — Privacy Pass Issuance Protocols](https://www.rfc-editor.org/rfc/rfc9578.html):** anonymous, unlinkable attestation tokens; the counterpart to identifying an operator.

### Security, policy, and responsible automation

- **[OWASP Bot Management and Anti-Automation](https://cheatsheetseries.owasp.org/cheatsheets/Bot_Management_and_Anti-Automation_Cheat_Sheet.html):** defender’s layered model and automated-threat taxonomy. Some response tactics are context-specific; do not copy blindly.
- **[OWASP Automated Threats](https://owasp.org/www-project-automated-threats-to-web-applications/):** credential stuffing, scraping, scalping, fake accounts, carding and related abuse categories.
- **[RFC 9309 — Robots Exclusion Protocol](https://www.rfc-editor.org/rfc/rfc9309.html):** requested crawler behavior and explicit non-authorization semantics.
- **[Playwright authentication security](https://playwright.dev/docs/auth):** storage-state credential warning and worker isolation patterns.
- **[Selenium CAPTCHA testing guidance](https://www.selenium.dev/documentation/test_practices/discouraged/captchas/):** use test hooks/keys rather than automating challenges.
- **[NIST SP 800-63B](https://pages.nist.gov/800-63-4/sp800-63b.html):** session/authenticator security.
- **[Envoy 1.32 upstream TLS context](https://www.envoyproxy.io/docs/envoy/v1.32.11/api-v3/extensions/transport_sockets/tls/v3/tls.proto.html):** server-certificate verification is opt-in through a validation context.
- **[RFC 5280 name constraints](https://www.rfc-editor.org/rfc/rfc5280.html#section-4.2.1.10):** the extension that constrains namespaces certified by a CA; a CA certificate’s own SAN is not equivalent.
- **[GDPR full text](https://eur-lex.europa.eu/eli/reg/2016/679/oj)** and **[EDPB Article 5(3) guidance](https://www.edpb.europa.eu/documents/guideline/guidelines-22023-on-technical-scope-of-art-53-of-eprivacy-directive_en)**.
- **[WCAG 2.2](https://www.w3.org/TR/WCAG22/):** accessible interaction and authentication requirements.
- **[DOJ CFAA charging policy](https://www.justice.gov/jm/jm-9-48000-computer-fraud):** enforcement guidance and good-faith research definition; not statutory authorization.

---

## Refreshing this snapshot

This document asserts dated, version-sensitive facts. Without a refresh procedure those assertions decay silently and the handbook becomes confidently wrong—the failure mode it warns about everywhere else. Re-run this checklist when the snapshot date is more than a quarter old and record the outcome in the header.

**Mechanically verifiable—automate these:**

- [ ] Every tool version in the stack table resolves against its registry (`registry.npmjs.org/<pkg>/latest`, `pypi.org/pypi/<pkg>/json`, GitHub releases). Record last-publish dates, not only version numbers; an abandoned project is itself a maintenance finding.
- [ ] Current Chrome Stable and Chrome for Testing versions from [`last-known-good-versions.json`](https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json). Cohort examples must name a version that actually exists.
- [ ] Every source-library URL returns 200. Distinguish hard 404s from bot-blocked 403s—several cited sites deliberately reject non-browser clients, which is a fact worth recording rather than a broken link.
- [ ] Cited source line ranges in the case-study section still contain the quoted code at the pinned commit.
- [ ] Citation titles still match their DOIs and arXiv identifiers.

**Requires judgment—do these by hand:**

- [ ] Re-measure the automation-signal claims against current Chromium source rather than trusting this document: `content/child/runtime_features.cc` for `AutomationControlled` wiring and `third_party/blink/renderer/core/frame/navigator.cc` for the `webdriver` member and its probe override.
- [ ] Re-run the `isTrusted` spot-check on the current build and update both version and date, or delete the claim. A silently aging empirical claim is worse than no claim.
- [ ] Re-check whether the transport baseline moved. Post-quantum key agreement and Encrypted ClientHello both change what an origin observes, so a JA3/JA4 baseline recorded before such a rollout will drift for reasons that have nothing to do with the automation stack. Treat unexplained protocol-fingerprint drift as a browser-release question before treating it as a regression.
- [ ] Re-read the standards in the cooperative-identity material; that area moves faster than anything else here.

**Provenance rule.** When updating a claim, replace its citation in the same edit. A claim whose source has moved is unverified, whatever its history in this file.

---

## Closing rule

The durable advantage is not a bigger pile of evasions. It is a controlled browser supply chain, a truthful identity model, native protocol behavior, stable profile/network ownership, explicit authorization, and a regression harness that catches contradictions before someone else does.
