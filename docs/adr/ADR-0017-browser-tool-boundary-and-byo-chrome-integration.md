# ADR-0017: Browser Tool Boundary and BYO-Chrome Integration

## Status

Accepted (2026-06-01)

Superseded by ADR-0019 for package/file layout only — `src/tools/browser/*`, `src/ui/routes.ts`, and `ui/app/...` moved to `packages/keiko-tools`, `packages/keiko-server`, and `packages/keiko-ui`. The D1–D11 security/protocol decisions remain in force and are still cited by ADR-0100 and ADR-0113.

## Context

Issue #76 (parent epic #61, sibling to the Terminal tool in #63 and the Files explorer in #67/#75)
requires a bounded browser-automation surface in the Keiko desktop workbench. The use case is
**local development server inspection**: take a screenshot, capture page HTML, and record both in
the audit ledger so a reviewer has concrete, timestamped evidence of what the running application
looked like at a given point in the workflow.

Three forces shape the decision space.

**The ADR-0011 zero-new-runtime-dep invariant is a hard constraint.** The only runtime dependencies
in `package.json` are `node-pty` and `ws`. Every popular browser-automation library (Playwright,
Playwright-core, Puppeteer, Puppeteer-core, chrome-remote-interface) adds at least one runtime
dependency. This eliminates the standard automation libraries entirely.

**Chrome DevTools Protocol (CDP) is a plain WebSocket protocol.** `ws` is already a runtime
dependency. The loopback BFF already uses `ws` server-side for PTY byte streaming in
`src/ui/terminal.ts`. CDP over `ws` to a locally running Chrome instance does not require a new
library — it requires a thin client module that opens a WebSocket connection and exchanges CDP
JSON frames.

**The regulated-audience trust model prohibits implicit network egress.** Keiko's target users
work in banking and insurance environments where every outbound network action must be explainable
and evidence-backed. Public-internet browsing, persistent cross-session browser state, and elevated
JavaScript evaluation are all explicitly out of scope. The surface must be bounded to
project-local development servers and must produce a tamper-evident audit trail.

**The existing BFF infrastructure already supplies all required safety primitives**: the
`host-check.ts` DNS-rebinding guard, `createAuditRedactor` + `deepRedactStrings` for redaction,
`buildEvidenceManifest` + `persistEvidence` + `createNodeEvidenceStore` for evidence, and the
CSRF-guarded POST / SSE pattern from `src/ui/routes.ts`. The browser tool composes these; it does
not invent new safety mechanisms.

## Decision

### D1 — Runtime selection: BYO Chrome over CDP, using `ws` only

The user supplies a running Chrome (or Chromium) instance launched with
`--remote-debugging-port=<port> --user-data-dir=<ephemeral>`. Keiko's BFF fetches
`http://127.0.0.1:<port>/json/version` without following redirects to discover the CDP WebSocket,
then connects to the browser-level CDP target. No binary is spawned by Keiko, no binary path is
hard-coded, and no new runtime dependency is introduced.

The CDP client lives in `src/tools/browser/cdp-client.ts`. It is a thin wrapper around `ws`
(`WebSocket` from the `ws` package) that sends JSON-RPC frames, awaits responses by `id`, and
routes events by `method`. It is not a general-purpose CDP library; it exposes only the
operations MVP requires (see D4).

### D2 — Local-origin allowlist: literal-IP enforcement, no DNS resolution

The CDP endpoint host component must be one of the literal strings `127.0.0.1` or `::1`. The
hostname `localhost` is accepted in user configuration but is normalised to `127.0.0.1` by the BFF
before constructing the WebSocket URL. Keiko never resolves `localhost` at connection time; it
substitutes the literal IP. This eliminates the `/etc/hosts`-manipulation attack surface: even if
an attacker with root access edits `/etc/hosts` to redirect `localhost` to an external IP, Keiko
never sends that name to the OS resolver — it uses `127.0.0.1` directly.

The port must be an integer in the range 1024–65535, supplied explicitly by the user. There is no
default port and no port scanning. Keiko constructs the CDP version endpoint as
`http://127.0.0.1:<port>/json/version` (or `http://[::1]:<port>/json/version` for IPv6).

**DNS-rebinding defence (two layers):**

1. The existing `isAllowedHost` check in `src/ui/host-check.ts` applies to all `/api/browser/*`
   BFF requests. A browser tab from a non-loopback origin cannot drive the browser API because the
   Keiko BFF rejects any request whose `Host` or `Origin` header is not a loopback authority on
   the bound BFF port. This is the same guard that protects every other BFF route.
2. After a successful `Page.navigate`, the BFF validates the effective main-frame URL from the
   `Page.frameNavigated` CDP event: the origin must exactly match the requested loopback origin
   (scheme + host + port). Subframe navigations are ignored for this top-frame gate. If a page
   redirects to a non-loopback host or another loopback port, the BFF immediately sends a CDP
   `Page.stopLoading` command and returns a typed `ORIGIN_NOT_ALLOWED` error. Navigation to any URL
   whose scheme is not `http:` or `https:` (including `javascript:`, `data:`, `vbscript:`, `file:`)
   is rejected before the CDP `Page.navigate` command is issued.

### D3 — Trust model for BYO Chrome: isolated profile + fresh target only

Two requirements are imposed on the Chrome instance the user connects to Keiko:

1. **Ephemeral user data directory**: the documented launch command is
   `chrome --remote-debugging-port=<port> --user-data-dir=$(mktemp -d) --no-first-run --no-default-browser-check`.
   Using a fresh directory ensures no pre-existing authenticated sessions, no stored passwords, and
   no saved cookies. Keiko cannot enforce this at runtime without broadening the CDP allowlist, so
   it emits a `browser:trust-warning` event when command-line metadata is unavailable or does not
   show `--user-data-dir`.
2. **Fresh target via `Target.createTarget`, never `Target.attachToTarget` on existing targets**:
   when a session is opened Keiko calls `Target.createTarget({ url: "about:blank" })` to create a
   new blank tab, attaches only to that target via `Target.attachToTarget`, and never enumerates or
   attaches to any other open target. This prevents Keiko from seeing or interacting with the
   user's other open tabs.

Even with an isolated profile, the fresh-target restriction means `Network.getAllCookies` would
return an empty jar for the new profile. As defence in depth, `Network.*` cookie-reading methods
are in the explicitly forbidden CDP method list (see D4), so this is guaranteed at the protocol
level regardless of profile isolation.

### D4 — CDP method allowlist: narrow allow, broad deny

The BFF CDP client issues only the following CDP commands. All other methods are not called; the
client raises a `CDP_METHOD_FORBIDDEN` error if the caller attempts to invoke any unlisted method.

**Permitted CDP commands (MVP):**

| Domain | Method | Purpose |
|--------|--------|---------|
| Target | createTarget | Create a blank new tab |
| Target | attachToTarget | Attach to the tab Keiko created |
| Target | closeTarget | Close the tab on session delete |
| Page | enable | Enable Page domain events |
| Page | navigate | Navigate to a loopback URL |
| Page | stopLoading | Abort a redirect away from the requested loopback origin |
| Page | captureScreenshot | PNG capture (gated, see D5/D6) |
| DOM | getDocument | Fetch the document root node |
| DOM | getOuterHTML | Fetch serialised HTML for a node |
| Browser | getVersion | Read browser metadata for D3 trust warning |

**Explicitly forbidden (never called by this surface):**

- `Runtime.*` — all methods (blocks `Runtime.evaluate`, `Runtime.callFunctionOn`,
  `Runtime.compileScript`, `Runtime.runScript`).
- `Page.addScriptToEvaluateOnNewDocument` — persists JS injection across navigations.
- `Page.handleJavaScriptDialog` — auto-accepting dialog boxes could bypass application logic.
- `Network.getAllCookies`, `Network.getCookies`, `Network.setCookie`, `Network.deleteCookies` —
  cookie exfiltration and injection.
- `Security.setIgnoreCertificateErrors` — would allow MITM on a local TLS dev server.
- `Emulation.*` — device spoofing is out of scope.
- `Fetch.enable` with request modification — intercept-and-modify is out of scope.
- `Input.*` — click/form-fill is a follow-up (see D11), not MVP.

The `javascript:` URL scheme is additionally rejected by the navigate-origin check in D2 before
any CDP call is made, providing a second barrier even if the D4 method list were bypassed.

### D5 — Evidence shape for screenshots: side-file with relative path and SHA-256

The audit ledger is text-only JSON (`EvidenceManifest`, ADR-0010). Embedding a base64-encoded PNG
in the manifest body adds ~33% size inflation and breaks the "small JSON" assumption that the
ledger's atomic write and the UI's evidence-list route both rely on.

Screenshots are written as side-files:

- Path: `<evidenceDir>/<runId>/browser-<seq>.png`
- Written via a new `writeSideFile(dir, name, data: Buffer)` helper in `src/audit/side-file.ts`
  that reuses the same `O_EXCL + rename` atomic write pattern as `EvidenceStore.put`, with
  `assertContainedRealPath` to keep the write inside the evidence directory.
- The additive manifest field for captured browser evidence is `browser`. A captured screenshot is
  represented in `browser.screenshots[]` as:
  ```
  { seq: <n>, path: "browser-<seq>.png", sha256: "<hex>", bytes: <n>, capturedAt: <epoch-ms>, viewportPx: { width, height } }
  ```
  The `path` value is relative to the run's evidence subdirectory, not an absolute filesystem path,
  so manifests remain portable if the evidence directory is moved.

The SHA-256 is computed over the raw PNG bytes before writing, providing tamper-evidence. The PNG
bytes are never included in the `EvidenceManifest` JSON itself.

`evidenceSchemaVersion` stays `"1"`. The new `browser` section is additive to the manifest
structure, which ADR-0010 designed to be open for extension.

### D6 — Redaction of page content and screenshot gating

**HTML/text content** captured via `DOM.getOuterHTML` flows through `createAuditRedactor` +
`deepRedactStrings` before it is included in any manifest field or SSE event, exactly as workflow
output does in ADR-0010.

**Screenshots** cannot be content-redacted without OCR, which is out of scope. Two controls
compensate:

1. **Opt-in gating**: screenshots are only captured when the user explicitly triggers them via the
   `POST /api/browser/sessions/:id/screenshot` route (gated by CSRF token). They are not captured
   automatically on navigation.
2. **Persist-on-apply only**: screenshots are written to the side-file location only when the
   user has confirmed capture via a gated apply step, mirroring the dry-run/apply gate in
   workflows. In dry-run mode the PNG is returned to the caller and held in a one-entry pending
   cache; browser events carry metadata only, never base64 image bytes.

A `browser:screenshot-captured` event carries `{ persisted: false }` in dry-run mode and
`{ persisted: true, path: "browser-<seq>.png" }` after apply. The UI renders a visual warning
when screenshots are pending persist.

### D7 — Harness event shape

New `HarnessEvent` union members (each extends `BaseEvent` with `schemaVersion: "1"`, `runId`,
`fingerprint`, `seq`, `ts`):

| Event type | Key fields |
|------------|------------|
| `browser:session-opened` | `sessionId`, `cdpPort` (number), `targetId` |
| `browser:navigated` | `sessionId`, `originOnly: string` (scheme + authority, never path), `httpStatus` |
| `browser:screenshot-captured` | `sessionId`, `seq`, `persisted: boolean`, `viewportPx` |
| `browser:page-content-captured` | `sessionId`, `seq`, `byteLength` (redacted HTML byte count) |
| `browser:session-closed` | `sessionId`, `reason: "explicit" \| "process-exit" \| "chrome-disconnected" \| "idle-timeout"` |
| `browser:trust-warning` | `sessionId`, `warning: string` |
| `browser:error` | `sessionId`, `code: BrowserErrorCode`, `message: string` |

The `originOnly` field carries only the scheme + authority (e.g. `http://127.0.0.1:5173`), never
the path, query, or fragment. This is the same origin-only redaction applied in security audit
logs and prevents paths that might embed tokens or PII from appearing in the event stream.

`RunCounters` gains a `browserNavigations: number` field (additive, default `0`, never
decremented). In MVP this field is reserved for future harness-integrated browser sessions; the
BFF-driven browser tool (D8/D9) does not flow through the harness loop, so the counter stays at 0
in MVP. See D11 for the follow-up scope where harness integration may be introduced.

### D8 — BFF route family: separate `/api/browser/*`

Browser sessions are not harness runs. They have independent lifecycle, do not produce a
`RunRecord`, do not consume the run registry, and their SSE stream carries `browser:*` events, not
`HarnessEvent` objects. Folding them into `/api/runs/:runId/*` would couple two unrelated
lifecycles and require the run registry to track non-run entities.

The route family is `/api/browser/*`:

| Method | Pattern | CSRF | Purpose |
|--------|---------|------|---------|
| GET | `/api/browser/status` | No | Is the CDP endpoint reachable? Returns `{ reachable: boolean, version? }` |
| POST | `/api/browser/sessions` | Yes | Open a session; body: `{ port: number }`. Returns `{ sessionId }` |
| DELETE | `/api/browser/sessions/:sessionId` | Yes | Close a session |
| POST | `/api/browser/sessions/:sessionId/navigate` | Yes | Navigate; body: `{ url: string }` |
| POST | `/api/browser/sessions/:sessionId/screenshot` | Yes | Capture screenshot (dry-run by default) |
| POST | `/api/browser/sessions/:sessionId/apply` | Yes | Persist pending screenshot side-file |
| POST | `/api/browser/sessions/:sessionId/content` | Yes | Capture outer HTML (redacted) |
| GET | `/api/browser/sessions/:sessionId/events` | No | SSE stream for the session |

`GET /api/browser/status` is read-only and does not modify state; no CSRF token is required. All
six POST and one DELETE routes require the CSRF token, consistent with the existing pattern for
state-changing routes. The SSE GET follows the same STREAMING sentinel return as
`/api/runs/:runId/events`.

`src/ui/routes.ts` registers the eight routes after the existing `/api/files/*` block.

### D9 — Session lifecycle: in-memory, explicit termination

Browser sessions are held in a `BrowserSessionManager` (parallel to `TerminalSessionManager` in
`src/ui/terminal.ts`). Sessions are stored in a `Map<string, BrowserSession>` keyed by
`sessionId` (random UUID). Sessions terminate on:

1. Explicit `DELETE /api/browser/sessions/:sessionId`.
2. `keiko ui` process exit (no persistence across restarts — the Chrome process outlives Keiko
   but the session state does not).
3. Unexpected CDP WebSocket disconnect from Chrome (Chrome crashed or was closed).
4. Idle timeout: a session with no activity for 30 minutes is closed automatically (consistent
   with `SESSION_IDLE_TTL_MS` in `terminal.ts`).

No browser session state is written to the SQLite database (ADR-0013). The evidence ledger
(ADR-0010) records the additive `browser` manifest section: session metadata, audit-shaped
`browser:*` events, redacted HTML captures, and screenshot side-file references. It does not store
PNG bytes in JSON or persist any browser state outside the evidence directory.

### D10 — Typed failure modes

The following typed error codes are defined in `src/tools/browser/errors.ts`:

| Code | Trigger | Mapped HTTP status |
|------|---------|--------------------|
| `CHROME_UNREACHABLE` | CDP port not open at `GET /api/browser/status` | 503 |
| `CHROME_VERSION_MISMATCH` | `/json/version` returns a non-Chrome/Chromium user-agent | 400 |
| `SESSION_NOT_FOUND` | `sessionId` not in the active map | 404 |
| `SESSION_LIMIT_EXCEEDED` | More than 4 concurrent sessions attempted | 429 |
| `ORIGIN_NOT_ALLOWED` | Navigate URL or post-navigate `frameNavigated` host is not loopback | 403 |
| `SCHEME_NOT_ALLOWED` | Navigate URL has a non-`http:`/`https:` scheme | 400 |
| `TARGET_CLOSED` | Chrome closed the tab before screenshot/content capture completed | 410 |
| `CDP_TIMEOUT` | No response from Chrome CDP within 10 seconds | 504 |
| `SCREENSHOT_TOO_LARGE` | PNG byte count exceeds 10 MB | 413 |
| `CONTENT_TOO_LARGE` | `getOuterHTML` byte count exceeds 2 MB | 413 |
| `CDP_METHOD_FORBIDDEN` | Internal — a bug in the BFF attempted a forbidden CDP method | 500 |
| `CDP_TRANSPORT_REFUSED` | CDP metadata points away from the requested loopback endpoint | 503 |
| `BAD_PORT`, `BAD_URL`, `BAD_REQUEST` | Invalid user input | 400 |
| `NO_PENDING_SCREENSHOT` | Apply requested a missing dry-run screenshot sequence | 409 |
| `PAYLOAD_TOO_LARGE` | Browser route request body or CDP version body exceeds the size cap | 413 |

All errors produce a `browser:error` SSE event before the route returns the HTTP error response.
The `message` field in `browser:error` is a static string, never a raw Chrome error message
(Chrome error messages can contain file paths and domain names that should not reach the UI).

### D11 — MVP scope vs follow-up issues

**MVP (Issue #76):**

- Open a session by connecting to a user-supplied CDP port.
- Navigate to a loopback URL.
- Capture a screenshot (PNG, dry-run default; apply to persist side-file).
- Capture outer HTML (redacted through `createAuditRedactor` before any use).
- Emit `browser:*` events over SSE.
- Replace the `BrowserWidget` stub with a functional React component that shows the navigation
  bar, a screenshot preview, and the session event log.
- `BrowserWidget` props extend to accept `sessionId?: string` and `cdpPort?: number`; the
  `url` prop is demoted to a display hint only (actual URL state comes from the SSE
  `browser:navigated` event).

**Explicit follow-up issues (not in #76):**

- Click and form-fill interactions (`Input.*` CDP domain) — creates new issue.
- Multi-tab management (`Target.getTargets` enumeration of Keiko-created tabs) — creates new issue.
- Video/screen recording via `Page.startScreencast` — creates new issue.
- Automatic content capture on navigation (background crawl mode) — requires a separate scope and
  security review, not MVP.
- Accessibility tree capture (`Accessibility.getFullAXTree`) — follow-up.
- Network request log capture (`Network.requestWillBeSent` event stream) — requires careful
  redaction design; follow-up.

## Consequences

### Positive

- **Zero new runtime dependencies.** ADR-0011's invariant is preserved. `ws` is already in the
  dep graph; no `package.json` changes are needed.
- **All existing safety primitives are reused.** `host-check.ts`, `createAuditRedactor`,
  `deepRedactStrings`, `assertContainedRealPath`, the CSRF guard, and the SSE pattern are all
  composed unchanged. The browser tool does not introduce any new security mechanism.
- **Evidence is tamper-evident.** Screenshots are SHA-256 fingerprinted; HTML captures are
  redacted; the manifest records session-relative paths so evidence is portable.
- **User is in full control of the Chrome profile.** Keiko never spawns Chrome, never manages
  its lifecycle, and never sees the user's real browser sessions (fresh target only).
- **The narrow CDP allowlist is auditable.** A security reviewer can read the 10-entry permit list
  and verify that `Runtime.*`, `Network.getCookies`, and `Input.*` are absent.
- **Typed errors give the UI precise failure context** without leaking filesystem paths or Chrome
  internals.

### Negative

- **Manual Chrome setup is required.** The user must launch Chrome with the correct flags before
  opening a browser session. There is no one-click setup. The UI must display the launch command
  prominently.
- **Sessions are not persisted across restarts.** If `keiko ui` is restarted the user must open
  a new session. The Chrome process is unaffected but Keiko's in-memory session map is lost.
- **Screenshot redaction is incomplete.** Images containing secrets (API keys pasted into a
  form, tokens in a URL bar rendered in the screenshot) cannot be content-redacted. The opt-in
  gating and dry-run default mitigate but do not eliminate this risk. A warning is shown in the
  UI when screenshots are pending persist.
- **CDP is an internal, unstable protocol.** Chrome can change CDP method behaviour or rename
  events between major versions. The thin client is isolated in `src/tools/browser/cdp-client.ts`
  so changes are localised, but maintenance is ongoing.
- **`writeSideFile` adds a new write surface.** It must be strictly contained inside the evidence
  directory via `assertContainedRealPath`. This is one more caller of that invariant to maintain.

### Neutral

- **`evidenceSchemaVersion` stays `"1"`.** The new `browser` section is additive. Existing
  manifests that pre-date Issue #76 have no browser field; the manifest reader must tolerate its
  absence.
- **`BrowserSessionManager` is a new in-memory stateful singleton** per BFF process, consistent
  with `TerminalSessionManager`. `UiHandlerDeps` gains an optional `browser?` field so tests
  that do not exercise the browser routes are unaffected.
- **No harness session is created for browser interactions.** The browser tool is a BFF-level
  surface, not a harness workflow. It does not flow through ADR-0004's state machine.

## Alternatives Considered

### Alternative 1: Playwright-core (or `playwright` / `puppeteer-core`)

Playwright-core provides a managed CDP client, screenshot API, and page-content API with a
well-tested abstraction layer.

- **Pros**: well-maintained; handles CDP version differences automatically; supports Firefox and
  WebKit in addition to Chrome; test coverage for the client is Playwright's responsibility.
- **Cons**: adds a runtime dependency (`playwright-core` is ~7 MB installed, with optional binary
  downloads); violates ADR-0011's zero-new-runtime-dep invariant unconditionally; even
  `playwright-core` at minimum pulls in `ws` (duplicate) and its own bundled CDP client;
  Playwright's JS-evaluation surface (`page.evaluate`) would require a separate allow/deny layer
  that duplicates the D4 design at higher cost.
- **Why rejected**: hard violation of ADR-0011. The invariant exists because adding runtime
  dependencies in the `package.json` dependencies block changes the installed size and the
  supply-chain surface for every `npm install keiko` consumer, including regulated environments
  with air-gap constraints. This is a load-bearing constraint, not a preference.

### Alternative 2: Spawn Chrome from Keiko (`child_process.spawn`)

Keiko finds a Chrome binary at a known OS path, spawns it with `--headless --remote-debugging-port`,
and manages its lifecycle.

- **Pros**: one-click setup; no user launch ceremony; deterministic port assignment; Keiko can
  kill the browser on cleanup.
- **Cons**: Chrome binary location is not portable (`/Applications/Google Chrome.app/...` on
  macOS, multiple paths on Linux, requires PATH search); AppArmor / SIP (System Integrity
  Protection on macOS) restricts spawning system browsers from non-blessed applications; the
  binary itself is not a runtime dependency in the npm sense but it becomes an undocumented runtime
  requirement that breaks silently on CI or minimal container images; ADR-0006 explicitly restricts
  `child_process` use to the vetted `runCommand` / `SpawnFn` pathway, and spawning a browser is
  outside that sandbox contract (it is not a workspace-scoped command with an allowlist); managing
  a child browser process introduces a new signal-handling and cleanup surface.
- **Why rejected**: unportable binary location, sandbox contract violation (ADR-0006), and fragile
  lifecycle management. BYO-Chrome is simpler and keeps Keiko's execution surface clean.

### Alternative 3: `chrome-remote-interface` npm package

`chrome-remote-interface` is a minimal CDP client that wraps the `ws` package with a
domain/method API.

- **Pros**: thin wrapper (~100 KB); familiar API; actively maintained; does not bundle a browser.
- **Cons**: adds a runtime dependency; violates ADR-0011; its API surface covers all CDP domains
  including `Runtime`, `Network.getAllCookies`, and `Input.*`, requiring an allow/deny layer on
  top anyway; the package's permissive API makes it harder to enforce D4's narrow permit list
  in a way a reviewer can audit at a glance.
- **Why rejected**: same ADR-0011 violation as Alternative 1, with the additional drawback that
  the broad API surface creates a larger D4 enforcement burden than a purpose-built thin client.

### Alternative 4: BrowserWidget as an embedded `<iframe>` or WebView

Render the target URL directly in an `<iframe>` in the Next.js UI. No CDP, no server-side
browser automation.

- **Pros**: zero new code in `src/`; no CDP dependency; React renders live content natively.
- **Cons**: `X-Frame-Options` and `Content-Security-Policy` headers on most development servers
  block embedding in iframes; there is no server-side evidence capture (screenshots and HTML
  would have to be synthesised client-side, which cannot be part of the tamper-evident audit
  ledger); CSP on Keiko's own BFF (ADR-0011 D6) would need to be weakened to allow `frame-src`
  for arbitrary loopback origins; the regulated-audience trust model requires server-side,
  evidence-backed capture, not a live iframe that changes as soon as the tab is closed.
- **Why rejected**: does not meet the evidence-capture requirement (ADR-0010); requires weakening
  Keiko's own CSP; blocked by real-world dev server headers.

### Alternative 5: Fold browser routes into `/api/runs/:runId/*`

Represent a browser session as a harness run, reusing the existing run registry, `RunRecord` type,
and SSE run events.

- **Pros**: no new route family; reuses existing SSE infrastructure; browser capture appears in
  the chat's run-summary cards.
- **Cons**: a browser session is not a harness run; it has no `TaskType`, no `HarnessStateName`
  lifecycle, no model calls, no tool allowlist, and no patch proposal; forcing it into `RunRecord`
  would require nullable fields throughout the run model; the `RunRegistry` bounded-concurrency
  limit is sized for AI model sessions, not low-latency browser interactions; mixing the two
  makes the run model harder to reason about and increases coupling between the harness layer and
  the UI tool layer.
- **Why rejected**: violates the single-reason-to-change principle. `RunRecord` has one reason to
  change (harness run lifecycle); browser sessions have a different, independent reason to change
  (CDP protocol evolution). Separating them preserves the independence.

## Implementation Plan

The following sketch defines file ownership and the test surface. It does not specify function
signatures or implementation logic (that is the developer's responsibility).

```
src/tools/browser/
  cdp-client.ts         — Thin ws-based CDP JSON-RPC client. Permit list enforced here.
  session.ts            — BrowserSession type + BrowserSessionManager (Map + idle TTL).
  errors.ts             — BrowserErrorCode discriminated union + typed error classes.
  index.ts              — Re-exports for src/ui/* consumers.

src/audit/
  side-file.ts          — writeSideFile(dir, name, data: Buffer): Promise<string>
                          Uses O_EXCL + rename + assertContainedRealPath.

src/ui/
  browser.ts            — Eight BFF route handlers (D8). Imports BrowserSessionManager.
  deps.ts               — Add optional `browser?: BrowserSessionManager` field.
  routes.ts             — Register eight /api/browser/* routes after /api/files/*.

ui/app/components/desktop/widgets/cards/
  BrowserWidget.tsx     — Replace stub. Accepts { sessionId?, cdpPort?, url? }.
                          Shows: CDP port input → open session button → nav bar →
                          screenshot preview → SSE event log.

tests/
  src/tools/browser/cdp-client.test.ts    — Unit: permit list, origin check, scheme check.
  src/tools/browser/session.test.ts       — Unit: lifecycle, idle TTL, session limit.
  src/audit/side-file.test.ts             — Unit: containment, atomic write, sha256.
  src/ui/browser-handlers.test.ts         — Integration: full HTTP routes against a mock
                                            BrowserSessionManager. CSRF guard, SSE framing.
```

`BrowserSessionManager` is injectable (same pattern as `TerminalSessionManager`) so tests never
open a real WebSocket.

## Compliance With Prior ADRs

**ADR-0006 (Safe Tool Execution and Sandbox Boundary):** No `child_process.spawn` is used for
the browser. The CDP WebSocket connection is not a shell command and does not go through
`runCommand`. D2's loopback-literal enforcement ensures the WebSocket never leaves the loopback
interface. The `writeSideFile` helper uses `assertContainedRealPath`, the same containment
primitive ADR-0006 mandates for all writes.

**ADR-0010 (Audit Ledger and Evidence Manifests):** Screenshot side-files are stored inside the
realpath-contained evidence directory. The additive `browser` manifest section references them by
relative path and SHA-256. HTML captures flow through `createAuditRedactor` + `deepRedactStrings`
before any persist or SSE emission. `evidenceSchemaVersion` stays `"1"` with additive new fields.
The `O_EXCL + rename` atomic write pattern from `src/audit/store.ts` is reused for side-file writes.

**ADR-0011 (Wave-1 User Interface and Packaging):** Zero new runtime dependencies are added.
The `ws` package is an existing runtime dep. The BFF route shape (method + pattern + handler +
`UiHandlerDeps`) and the SSE STREAMING sentinel are used unchanged. The CSRF guard is applied to
all state-changing routes (POST + DELETE). `UiHandlerDeps` gains an optional `browser?` field
so the existing tests that do not supply it continue to compile.

## Open Questions / Out of Scope

- **HTTPS dev servers**: a local dev server running on `https://localhost:<port>` will present
  a self-signed certificate. CDP screenshot capture works regardless of TLS errors in the browser
  because Chrome is already navigated to the page. The BFF never makes an HTTPS request to the
  dev server directly; it only issues CDP commands. This is therefore in scope for MVP, but the
  UI should surface a note that certificate errors in Chrome must be accepted manually.
- **Multiple simultaneous browsers**: D2 configures one port per session. If the user has two
  dev servers running and wants to capture from both, they must open two sessions, each with a
  different port. Multi-port concurrent sessions are in scope for MVP; multi-browser-binary
  (Chrome + Firefox) is out of scope.
- **Linux / headless CI environments**: the BYO-Chrome model requires the user to have a GUI
  browser. CI use of the browser tool (for automated screenshot regression tests) is out of scope
  for Issue #76 and is tracked as a follow-up.
- **`Page.printToPDF`**: PDF capture would produce a binary artifact with the same text-vs-binary
  tension as screenshots. It is not in the D5 design and not in MVP.
- **Public-internet browsing**: explicitly out of scope. The ORIGIN_NOT_ALLOWED error code
  enforces this at the route level.

## Related

- ADR-0004: Agent Harness Boundary — confirms why browser sessions do not flow through the
  harness state machine.
- ADR-0005: Repository Context and Workspace Access Layer — `assertContainedRealPath` reused by
  `writeSideFile`.
- ADR-0006: Safe Tool Execution and Sandbox Boundary — no `child_process` for browser, sandbox
  unchanged.
- ADR-0010: Audit Ledger and Evidence Manifests — evidence schema extensibility, atomic writes,
  redaction pipeline.
- ADR-0011: Wave-1 User Interface and Packaging — zero-dep invariant, BFF route shape, CSRF
  guard, SSE pattern, host-check DNS-rebinding defence.
- ADR-0013: UI-Local Persistence — `UiHandlerDeps` extension pattern (optional `browser?` field
  mirrors optional `terminal?`).
- ADR-0014: Keiko Workspace Shell Architecture — `BrowserWidget` mount point at
  `ui/app/components/desktop/widgets/index.tsx:87`.
- ADR-0016: Deeper Files Explorer BFF Surface — sibling surface showing the same route-family
  separation rationale.
- Issue #61: Parent epic — local workspace shell.
- Issue #76: Browser tool boundary (this ADR).
- [Chrome DevTools Protocol documentation](https://chromedevtools.github.io/devtools-protocol/)
- [DNS rebinding attacks and localhost](https://bugs.chromium.org/p/project-zero/issues/detail?id=1621)

## Date

2026-06-01
