# ADR-0024: Installable Keiko PWA Architecture

## Status

Accepted

## Date

2026-06-05

## Version

1.0

## Context

Keiko is delivered as an npm package that starts a local Node.js server and opens a
browser-based UI bound to `localhost` / `127.0.0.1`. The existing UI (packages/keiko-ui,
Next.js App Router, static export) meets no browser installability criteria out of the box:
it has no web app manifest, no service worker, no icon set, and no install guidance. Regulated
enterprise users form trust during the first five minutes. An unbranded `localhost` tab does
not communicate product identity, permanence, or safety.

Epic #121 introduces a Progressive Web App (PWA) installability layer. The goal is to allow a
user who has already started Keiko with `npm start` / `keiko start` to optionally install the
running UI as a browser-managed standalone application — giving Keiko a branded presence in the
OS application shelf, Taskbar, or Dock — without any npm postinstall side effect, without any
desktop mutation that the user has not explicitly requested, and without weakening any existing
security or privacy boundary.

This ADR governs the architecture decisions that all downstream implementation children
(#123–#128) must respect. It does not specify implementation; that is the province of each child
issue.

### Existing invariants (non-negotiable)

The following constraints from ADR-0019, ADR-0021, ADR-0022, and Epic #121 are treated as
pre-conditions for every decision in this ADR:

1. The local UI remains bound to `localhost` / `127.0.0.1`. Existing host-check and CSP
   protections in `packages/keiko-server` must not be weakened.
2. The public install remains one npm package: `@oscharko-dev/keiko`. No new published
   artifact is introduced by this epic.
3. No postinstall script may create shortcuts, write outside approved local application data
   locations, alter browser settings, or mutate the user's OS state.
4. API tokens and all credentials remain server-side (`KEIKO_PROVIDER_TOKEN_*` env vars,
   gateway config). No secret may reach the browser, the service worker cache, or any manifest
   field.
5. Evidence redaction-before-persist semantics are unchanged.
6. Productive model calls remain behind `keiko-model-gateway` only.

### The structural limitation that must propagate downstream

A browser-installed PWA cannot start the local Node.js server by itself. The OS shortcut or
browser app launcher that results from PWA installation opens a browser window to a fixed
`start_url`. If the local Keiko server is not already running, the browser will show a
connection error. This limitation is not a defect to be fixed; it is an architectural boundary
that every child issue must acknowledge. The explicit launcher command delivered in issue #125
bridges the gap by starting the server and opening the app in a single user action without
postinstall side effects.

## Decision

### D1 — Two-surface model

Keiko's installable experience separates two distinct surfaces:

**Surface A — Browser PWA installability.** The running UI presents a valid web app manifest
and a minimal service worker so that supported browsers can offer the user a browser-native
install prompt. Once installed, the app launches as a standalone window with the Keiko icon and
branding rather than as a browser tab. This surface is passive: it makes installability
available; it does not act on the user's behalf.

**Surface B — Explicit OS launcher (issue #125).** A deliberate `keiko launcher` command (or
equivalent CLI subcommand) generates a reversible OS-level shortcut that both starts the local
Keiko server and opens the app. This surface is active and requires explicit user invocation.
No postinstall script invokes it automatically.

The separation rationale: Surface A alone does not solve the server-start problem (a browser
shortcut cannot exec a Node process). Surface B alone, if delivered as a postinstall side
effect, would violate enterprise endpoint controls and the non-negotiable invariants above.
Together they cover the full use case with explicit, reversible, auditable steps.

### D2 — Postinstall behavior

`npm install @oscharko-dev/keiko` (and equivalent `yarn add` / `pnpm add` / `npx` invocations)
must not produce any desktop artifact, browser profile change, shortcut file, OS application
registration, or registry entry. The npm `postinstall` script must not be created or modified
by this epic. All installability behaviors are gated behind explicit user actions performed
after the package is installed and the server is running.

### D3 — Browser and platform matrix

The following table is the authoritative first-release support matrix. "First-class" means
Keiko ships branded assets, tests the install flow in CI and manual verification, and documents
the flow in the pilot guide. "Documented fallback" means the limitation is stated clearly in
the pilot guide; no automated verification gate is required.

| Browser / engine       | Platform(s)           | Tier                | Install prompt mechanism                              | Known limitation                                                                                                        |
| ---------------------- | --------------------- | ------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Chrome ≥ 111           | macOS, Windows, Linux | First-class         | `beforeinstallprompt` event; browser install button   | None for `localhost` origin with HTTPS not required (Chrome permits PWA install on localhost without HTTPS)             |
| Edge ≥ 111             | macOS, Windows        | First-class         | `beforeinstallprompt` event; Edge app install button  | Same as Chrome; Edge may show its own install UI chrome                                                                 |
| Chromium (open-source) | macOS, Windows, Linux | First-class         | `beforeinstallprompt` event                           | Branding depends on Chromium build; distro-packaged builds may differ                                                   |
| Firefox ≥ 124          | macOS, Windows, Linux | Documented fallback | No `beforeinstallprompt` event; no browser install UI | Firefox does not implement the install-prompt API. Users can bookmark the page; no standalone mode available.           |
| Safari ≥ 17 (macOS)    | macOS                 | Documented fallback | No install prompt; no standalone mode                 | Safari on macOS does not support PWA install or display mode `standalone` as of Safari 17.                              |
| Safari on iOS ≥ 16.4   | iOS, iPadOS           | Documented fallback | "Add to Home Screen" via Share sheet (manual)         | No `beforeinstallprompt`; standalone mode requires user to tap Share > Add to Home Screen; service worker scope applies |

Keiko is a developer tool installed via npm. The primary audience for the first release runs
Chromium-family browsers on macOS, Windows, or Linux. The Firefox and Safari limitations are
stated because enterprise users may be required to use those browsers; they must not be
surprised by a degraded or absent install flow.

### D4 — Manifest contract

Issue #123 must produce a web app manifest conforming to the following contract. The manifest
is a static JSON file served by the existing `keiko-server` BFF at a well-known path (e.g.,
`/manifest.webmanifest` or `/manifest.json`).

| Field              | Required value                                          | Rationale                                                                            |
| ------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `name`             | `"Keiko"`                                               | Full product name; used in OS application shelves                                    |
| `short_name`       | `"Keiko"`                                               | Short name for icon labels; must not exceed 12 characters                            |
| `description`      | A one-sentence product description; no customer data    | Displayed in browser install dialogs                                                 |
| `start_url`        | `"/"`                                                   | Root of the UI; must match `scope`                                                   |
| `scope`            | `"/"`                                                   | Scopes the PWA to the entire Keiko UI; no sub-path scoping                           |
| `display`          | `"standalone"`                                          | Removes browser chrome; presents as a desktop application window                     |
| `theme_color`      | `"#4EBA87"` (accent)                                    | Matches `--accent` design token; used in browser chrome and OS task switchers        |
| `background_color` | `"#1B1E23"` (matches `--bg` at `oklch(0.17 0.004 160)`) | Splash screen background before the app shell renders; must match the app background |
| `icons`            | See D5 icon contract                                    | Must include 192px and 512px raster variants plus maskable variant                   |
| `lang`             | `"en"`                                                  | Document language                                                                    |
| `dir`              | `"ltr"`                                                 | Text direction                                                                       |
| `categories`       | `["developer-tools", "productivity"]`                   | Informational; used by some OS app stores and browser extension catalogs             |

The manifest must not contain any field that encodes customer-specific data, model names,
internal endpoint URLs, API tokens, or deployment configuration. Manifest fields are
static production-build values.

### D5 — Icon contract

The source of truth for the Keiko wordmark and symbol is the existing SVG at
`packages/keiko-ui/public/keiko-logo.svg`. Issue #123 derives all required raster and
maskable variants from this single SVG source.

Required icon deliverables:

| File (illustrative path) | Size    | Purpose                                        | Maskable |
| ------------------------ | ------- | ---------------------------------------------- | -------- |
| `icon-192.png`           | 192×192 | Standard PWA icon; required by all browsers    | No       |
| `icon-512.png`           | 512×512 | High-res PWA icon; required for splash screens | No       |
| `icon-192-maskable.png`  | 192×192 | Maskable variant with safe-area padding        | Yes      |
| `icon-512-maskable.png`  | 512×512 | Maskable variant for adaptive icon systems     | Yes      |
| `favicon.ico`            | 32×32   | Browser tab favicon                            | No       |
| `favicon.svg`            | SVG     | Vector favicon for modern browsers             | No       |
| `apple-touch-icon.png`   | 180×180 | iOS/iPadOS "Add to Home Screen" icon           | No       |

Maskable icons must place the Keiko symbol entirely within the central safe area (66% of the
icon dimensions, i.e., a 127×127 px region for the 192-size variant). The background fill for
maskable icons is `#4EBA87` (accent color), which provides sufficient contrast for the
symbol when rendered on light or dark OS backgrounds. All icons use the existing brand palette;
no third-party icon library or royalty-encumbered asset may be introduced.

The manifest `icons` array must include `purpose: "maskable"` for the maskable variants and
omit the `purpose` field (or use `purpose: "any"`) for the standard variants, per the W3C
Web App Manifest specification. Both purposes should be listed to maximize OS coverage.

### D6 — Service worker caching policy

Issue #126 implements the service worker. This ADR defines its policy boundary; the
implementation is constrained to this boundary.

**Permitted to cache (install-time cache, network-fallback-first strategy for runtime):**

- Static shell assets: HTML entry point, compiled JS bundles, compiled CSS, static image
  assets (icons, SVG, fonts) that are part of the Next.js static export output.

**Prohibited from caching — never enter the service worker cache under any code path:**

- Any HTTP response from `/api/*` routes (all BFF API routes).
- Any evidence manifest or evidence artifact.
- Any file from the connected workspace or repository.
- Any model response, model prompt, or workflow event stream.
- Any value that was derived from a credential, API token, or secret-shaped string.
- Any user-generated content (chat messages, workflow inputs, run summaries).

The service worker must use a `networkFirst` or `networkOnly` strategy for all `/api/*`
requests. If a BFF request fails because the local server is not running, the service worker
must pass the failure through to the page; it must not serve a cached substitute for API
responses.

The service worker must not use `skipWaiting()` unconditionally in a way that could serve
stale shell assets alongside new API contracts. The update strategy is: prompt the user on
new service worker activation; do not auto-reload. This prevents schema mismatches between
a freshly deployed shell and an older cached bundle.

**CSP implications.** The existing CSP headers in `packages/keiko-server` that gate
`script-src`, `connect-src`, `default-src`, and `frame-src` must remain in place. The service
worker registration must conform to the same CSP as the page. Issue #126 must verify that the
service worker script URL is covered by the existing `script-src` directive.

### D7 — Local-secret boundary

The PWA layer must not weaken any of the following existing secret boundaries:

1. API tokens (`KEIKO_PROVIDER_TOKEN_*`) are read only by the BFF server process. They are
   never returned to the browser in any HTTP response, never embedded in manifest fields or
   icon metadata, and never passed to the service worker via `postMessage` or cache entry.
2. The manifest `start_url` and `scope` are generic path strings (`"/"`) that do not encode
   server address, port, tenant ID, model name, or any other deployment-specific value.
3. Service worker `Cache-Storage` is subject to browser origin isolation. Keiko's service
   worker origin is `http://localhost:<port>`. If the user changes the port, the new origin
   has an empty cache; no cross-port cache leakage is possible because browsers isolate
   `CacheStorage` by full origin including port.
4. The `beforeinstallprompt` event deferral and the user-facing install banner must not
   display any information that was derived from the user's connected workspace, running
   workflow, or evidence data.

### D8 — Launcher contract (boundary definition for issue #125)

Issue #125 owns the implementation of the explicit launcher. This ADR defines the boundary
that the implementation must satisfy.

**What the launcher command must do:**

- Start the local Keiko Node.js server process (equivalent to `keiko start`).
- Open the default browser (or a specified browser) to the running Keiko UI URL.
- Allow the user to specify a port or use the default port.
- Produce a reversible OS shortcut file on request (e.g., `.desktop` file on Linux, `.app`
  bundle shim on macOS, `.lnk` shortcut on Windows) only when the user explicitly requests
  shortcut creation via a flag or interactive prompt.
- Record the generated shortcut path so the user can find and remove it with a documented
  command (`keiko launcher remove` or equivalent).

**What the launcher command must not do:**

- Create any shortcut, Start menu entry, Dock item, or application registration automatically
  as a side effect of `npm install`, `npm start`, or any other non-explicit action.
- Write outside of approved local directories (e.g., `~/.local/share/applications` on Linux,
  `~/Applications` on macOS, `%APPDATA%\Microsoft\Windows\Start Menu` on Windows) without
  prior disclosure to the user.
- Execute shell commands derived from user-supplied strings without sanitization; generated
  launcher files must not interpolate user input into shell command arguments.
- Require administrator or root privileges on any supported platform.
- Bundle or copy the Node.js runtime; the launcher depends on the Node.js already installed
  by the user.

Generated shortcut files are human-readable text. The launcher must not produce binary
registry edits on Windows outside of standard `.lnk` creation via documented system APIs.
All generated files must be documented in the pilot guide with exact removal instructions.

### D9 — Security boundary checklist for downstream children

Every implementation child issue (#123–#128) must affirm each applicable item from this
checklist in its PR description before merge.

**#123 — Manifest and icons:**

- [ ] Manifest contains no secrets, no customer-specific URLs, no model names, no env-var values.
- [ ] Manifest `start_url` and `scope` are generic (`"/"`); no port number is hardcoded.
- [ ] All icon raster variants derived from the existing SVG source of truth; no third-party assets.
- [ ] Maskable icons meet the W3C safe-area requirement.
- [ ] Manifest served with correct `Content-Type: application/manifest+json` header.

**#124 — First-run install guidance UI:**

- [ ] Install prompt banner does not display any workspace path, model name, or run data.
- [ ] Banner dismissal state stored in `localStorage` only; no server-side persistence of install decisions.
- [ ] Banner satisfies WCAG 2.2 AA contrast and keyboard-operability requirements.
- [ ] `beforeinstallprompt` event deferred and stored; banner shown only when criteria met.
- [ ] Graceful fallback shown for Firefox and Safari (manual instructions, no broken UI).

**#125 — Launcher command:**

- [ ] No postinstall side effect; shortcut creation is explicitly user-invoked.
- [ ] No shell injection risk in generated shortcut content.
- [ ] Removal command documented and tested.
- [ ] No administrator or root privilege required on any first-class platform.
- [ ] Generated shortcut file locations documented in pilot guide.

**#126 — Caching and CSP hardening:**

- [ ] Service worker caches only static shell assets; all `/api/*` routes are `networkOnly` or `networkFirst`.
- [ ] No API response, evidence manifest, model output, or credential-derived value enters `CacheStorage`.
- [ ] Service worker update strategy prompts user on new activation; no unconditional `skipWaiting`.
- [ ] CSP headers are preserved; service worker script URL is permitted by `script-src`.
- [ ] Service worker scope matches manifest `scope` (`"/"`).

**#127 — Verification:**

- [ ] Install flow verified on Chrome + macOS, Chrome + Windows, Edge + Windows, Chromium + Linux.
- [ ] Firefox and Safari fallback behavior verified against documented limitations in D3.
- [ ] Service worker cache contents verified to contain no API response bodies.
- [ ] Manifest validated with a conformance checker (e.g., `npx pwa-asset-generator` or Lighthouse PWA audit).
- [ ] Launcher command tested for shortcut creation, server start, and removal on at least two first-class platforms.

**#128 — Pilot documentation:**

- [ ] Documented flow covers npm install → `keiko start` → browser install prompt → installed app.
- [ ] Documented flow covers `keiko launcher` shortcut creation and removal.
- [ ] Firefox and Safari limitations stated explicitly in the pilot guide.
- [ ] No customer-specific URLs, tokens, or deployment details in documentation.

### D10 — Verification evidence required before epic closure

The following evidence must exist before Epic #121 is closed. Issue #127 owns collection and
recording of this evidence.

- Manual verification log (or automated test output) confirming the install prompt appears and
  completes on each first-class browser/platform combination.
- Lighthouse PWA audit score ≥ 90 (installability category) on Chrome with the local server
  running, captured as a stored artifact.
- Service worker cache inspection output (DevTools Application > Cache Storage) confirming no
  `/api/*` response bodies are present after a full workflow run.
- Launcher command end-to-end test confirming shortcut file is created, server starts, browser
  opens, and removal command deletes the shortcut on at least macOS and Windows.
- Security review sign-off from a designated reviewer confirming the D7 local-secret boundary
  is intact.

## Consequences

### Positive

- Enterprise users receive a branded, standalone application window after a two-step flow
  (npm install + browser install prompt); first-minute trust is substantially improved.
- No npm postinstall side effect means Keiko continues to pass enterprise endpoint controls
  that block postinstall scripts.
- The two-surface model (browser PWA + explicit launcher) cleanly separates the browser-managed
  installability concern from the server-process lifecycle concern; neither surface has to solve
  the other's problem.
- The service worker caching policy is maximally restrictive: if an implementor adds caching
  for an API route, the D9 checklist and security review will flag it immediately.
- All existing architecture invariants (ADR-0019 through ADR-0023) are unaffected.

### Negative

- Firefox and Safari users cannot install Keiko as a PWA from the browser; they receive
  documented manual fallback instructions. This is a product limitation for the first release.
- The explicit launcher (Surface B) requires the user to run an additional command to get an OS
  shortcut; users who expect postinstall shortcuts will be surprised.
- Two separate surfaces (#123–#124 for the browser layer, #125 for the launcher) require
  coordination and a consistent user-facing narrative that issue #128 must document carefully.
- The service worker must be kept minimal; any accidental caching of API responses is a
  security boundary violation that must be caught in review.

### Neutral

- The `background_color` value must be derived from the design token `--bg`
  (`oklch(0.17 0.004 160)`, approximately `#1B1E23`). The exact hex is determined by
  `packages/keiko-ui/src/app/globals.css`; issue #123 must resolve the sRGB hex from the
  CSS variable rather than hard-coding an approximation.
- Keiko's existing CSP policy was not designed with a service worker in mind. Issue #126 will
  need to audit the policy; any change to `script-src` or `connect-src` requires security
  review sign-off.
- The `localhost` origin means that HTTPS is not required for PWA installability on Chromium
  (browsers exempt `localhost` from the HTTPS requirement for service workers). This is a
  documented browser behavior, not a Keiko design choice. Issue #127 must verify that this
  exemption holds on the target browser versions.

## Out of Scope

The following are explicitly outside the boundary of Epic #121 and this ADR:

- Native application installers: Electron, Tauri, MSI, DMG, PKG, Flatpak, Snap, or any
  distribution channel that produces a platform-native application bundle.
- Enterprise software distribution: SCCM, Intune, Munki, Jamf, or any MDM-based deployment.
- Customer-specific branding, white-labeling, or per-tenant manifest customization.
- Push notifications, background sync, or any service worker capability beyond static shell
  caching and cache management.
- Offline mode. Keiko requires the local Node.js server to be running; an offline-capable mode
  would require significant changes to the BFF architecture and is deferred to a future epic.
- Multiple concurrent Keiko UI origins (multiple ports on the same machine). Port multiplicity
  is a separate product decision; this ADR governs a single-origin single-port deployment.
- Any change to the model gateway, workflow execution, evidence storage, or workspace access
  layer. The PWA layer is additive and does not modify any existing package except for the
  additions to `keiko-ui` (manifest link, service worker registration, icon assets, install
  guidance component) and `keiko-server` (manifest serving route, optional SW script route).

## Alternatives Considered

### Alternative 1: Electron-based desktop application

Wrap the existing UI and server in an Electron shell, producing a native-looking application
with standard OS install behavior (`DMG` / `MSI` / `AppImage`).

- **Pros**: Native OS install artifacts; no "you need a browser" cognitive burden; full control
  over the app window chrome and lifecycle; server-start problem is solved because Electron's
  main process manages the Node server.
- **Cons**: Electron adds ~150–250 MB to the install artifact; it carries its own Chromium and
  Node.js runtimes that require independent security patching; it requires platform-specific
  code signing (Apple Developer ID, Windows EV certificate) which is not available for an npm
  package distribution model; it introduces a separate release pipeline; ADR-0021 (single
  published npm package) would need to be superseded.
- **Why rejected**: The overhead is disproportionate for the first release. The enterprise
  pilot audience is developers who already have a browser and Node.js. Electron is not
  precluded by a future native-installer epic, but it is not the correct next step.

### Alternative 2: Tauri-based desktop wrapper

Use Tauri (Rust + WebView) instead of Electron to produce smaller native application bundles.

- **Pros**: Smaller binary than Electron (~3–10 MB for the Tauri shell); uses the OS WebView
  (WKWebView on macOS, WebView2 on Windows); same native install artifact benefits as Electron.
- **Cons**: Requires a Rust toolchain and cross-platform Tauri build infrastructure; same
  code-signing burden as Electron; WebView2 (Windows) must be pre-installed or bundled;
  WKWebView versions differ across macOS releases, introducing rendering unpredictability;
  higher implementation investment than a pure PWA approach for the same first-release goal.
- **Why rejected**: Implementation cost and toolchain complexity exceed the value for the first
  release. The PWA approach reuses existing build infrastructure entirely.

### Alternative 3: Postinstall shortcut creation (convenience-first)

Create OS shortcuts automatically during `npm install` using a postinstall script, accepting
the side effect as a UX convenience.

- **Pros**: Zero-step setup; shortcut appears immediately after install; familiar behavior from
  GUI application installers.
- **Cons**: Violates the explicit non-goal in Epic #121 ("This epic does not allow postinstall
  scripts to create shortcuts, alter browser settings, write outside approved local app
  locations, or bypass enterprise endpoint controls"); fails enterprise endpoint security
  policies that block or audit postinstall scripts; creates unreversible OS state without user
  consent; the shortcut would reference an incorrect or variable port if multiple Keiko
  instances exist.
- **Why rejected**: Explicitly prohibited by the epic's non-goals and by the architecture
  invariants in this ADR. Not a viable option.

### Alternative 4: Inline service worker caching all routes

Cache all BFF API responses in the service worker for resilience, falling back to cached data
when the server is not running.

- **Pros**: Keiko would render something useful even when the server is down; improves
  perceived performance on repeat loads.
- **Cons**: Every API response that contains run data, file excerpts, workflow outputs, or
  evidence summaries would persist in `CacheStorage` — a browser-accessible, unencrypted store.
  This is a direct violation of the redaction-before-persist evidence invariant and the
  local-secret boundary. Any attacker with local browser access would have unmediated read
  access to Keiko's output history. The service worker cannot apply the `createAuditRedactor`
  redaction pipeline because it runs in a browser context with no access to the server-side
  security module.
- **Why rejected**: Security boundary violation. The correct behavior when the server is not
  running is a clear error state that tells the user to restart the server, not a stale-data
  illusion.

## Related

- ADR-0019: Modular Package Architecture
- ADR-0020: Workspace Tooling and Architecture Gate
- ADR-0021: Publish Strategy — Bundled Monorepo Product
- ADR-0022: Connected Context Privacy Contract
- ADR-0023: Quality Intelligence Migration Architecture
- Epic #121: Installable Keiko PWA
- Issue #122: Define installable PWA architecture and enterprise UX contract (this issue)
- Issue #123: Add branded PWA manifest, icons, and install metadata
- Issue #124: Implement first-run PWA install guidance in the Keiko UI
- Issue #125: Add explicit desktop launcher and shortcut command for npm pilots
- Issue #126: Harden PWA caching, CSP, and local-secret boundaries
- Issue #127: Verify installability across npm workflows, browsers, and desktops
- Issue #128: Update pilot documentation for installable Keiko PWA rollout
- W3C Web App Manifest specification: https://www.w3.org/TR/appmanifest/
- MDN — Progressive web apps: https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps
- What PWA Can Do Today (feature/browser matrix reference): https://whatpwacando.today/
