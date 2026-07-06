# ADR-0113: Governed documentation browser trust model and first-release host strategy

## Status

Accepted (Epic #1851, Issues #1859–#1864, 2026-07-06).

## Context

Epic #1851 delivers the first product milestone for HTML manual work: a governed documentation
browser surface, openable from the Keiko desktop shell, that lets a user inspect a customer manual
(for example a DynS technical handbook) before any crawler, indexing, or retrieval behavior exists.
The milestone is deliberately browser-only. It must be usable and trustworthy first; indexing,
Knowledge Pod creation, and grounded answers arrive through later, separately governed epics.

Child issue #1859 required an audit that records the exact Keiko surfaces to reuse, a first-release
host strategy, and the web-platform constraints (`frame-ancestors`, `X-Frame-Options`) the UI must
respect without attempting a bypass. This ADR is that recorded decision and the browser trust model
referenced by the epic's target outcomes.

### Existing surfaces inspected

- `packages/keiko-tools/src/browser/*` — CDP-backed `BrowserSessionManager`, URL validators, typed
  `BrowserToolError` codes, redaction, and evidence events. The navigation policy is **loopback-only**
  (`127.0.0.1` / `::1`, `localhost` rewritten before use — ADR-0017 D2); intranet and public hosts are
  rejected by design.
- `packages/keiko-server/src/browser.ts` — the eight `/api/browser/*` BFF handlers, a 64 KB body cap,
  the CSRF/state-changing-request gate, and the SSE framer.
- `packages/keiko-ui/src/lib/browser-api.ts` — the typed, same-origin BFF wrapper conventions.
- `packages/keiko-ui/.../widgets/cards/BrowserWidget.tsx` — the existing screenshot-based browser
  widget, its component-scoped CSS (`.bw-*` under a single `lazyWidgetScope`), and its accessibility
  patterns (aria-disabled controls, persistent `role="status"` mirror, `role="alert"` errors).
- `packages/keiko-server/src/csp.ts` and `headers.ts` — the application's own Content-Security-Policy:
  `default-src 'none'`, `frame-ancestors 'none'`, `connect-src 'self'`, plus `X-Frame-Options: DENY`.
- `packages/keiko-contracts/src/bff-wire.ts` (canonical browser wire types) and
  `packages/keiko-contracts/src/text-safety.ts` (`stripUnsafeFormatChars`, `redactAbsolutePaths`).

### The two constraints that decide the strategy

1. **Keiko's own CSP forbids embedding.** `default-src 'none'` (no `frame-src` fallback),
   `frame-ancestors 'none'`, and `X-Frame-Options: DENY` mean an `<iframe>` to any origin —
   same-origin, loopback, or intranet — is blocked by the application itself. Child issue #1861
   forbids widening CSP or Permissions-Policy without security review, so inline frame embedding is
   not viable in this milestone.
2. **Rendering fetched HTML is out of scope.** Injecting a manual's HTML into the Keiko DOM is
   "rendered capture" — the epic gates that separately behind explicit scope, policy, and security
   review. `connect-src 'self'` also blocks the UI from fetching arbitrary targets directly.

## Decision

The first release is a **governed documentation navigation and target-classification surface with
deliberate rendering deferral**, not an inline content renderer and not an unrestricted browser.

1. **Contracts (`keiko-contracts/src/documentation-browser.ts`).** Additive, browser-safe wire types:
   a `DocumentationTargetClass` union (`local-file`, `loopback`, `intranet-http`, `external-http`,
   `unsupported-scheme`); a closed `DocumentationNavigationReason` set with a machine `severity`; a
   pure `classifyDocumentationTarget` (WHATWG URL, no filesystem, no network) that emits only redacted
   origin/path summaries; `mapBrowserErrorToDocumentationReason` mapping low-level browser/network
   codes and auth-shaped HTTP statuses to governed reasons; a request validator; and a result builder
   that re-applies text-safety redaction. Fails closed: unknown schemes, hosts, and error codes
   resolve to unsupported/degraded, never to a loaded state.
2. **BFF (`keiko-server/src/docs-browser.ts`).** One additive product-level route,
   `POST /api/docs-browser/navigate`. It is an adapter rather than a reuse of `/api/browser/*`
   directly because those routes are CDP-session-coupled and loopback-only and too low-level for the
   product state model, and because `connect-src 'self'` forbids the UI from reaching targets itself.
   The route validates and classifies the target and returns a redacted, UI-owned outcome. It performs
   **no egress to the documentation target**. Its only network touch reuses the existing session
   manager's non-mutating `checkStatus` probe to confirm the loopback CDP backend for the preview
   path — the same already-permitted loopback egress the browser routes use.
3. **UI (`keiko-ui/.../DocumentationBrowserWidget.tsx`).** A first-class desktop widget (window type
   `docbrowser`, openable from the New Window palette) that renders each governed reason with precise,
   short copy, distinguishes navigation from indexing, exposes a disabled "Prepare for indexing"
   affordance, and handles every failure state calmly without stack traces or token-bearing URLs.

## Browser trust model

- **Allowed target classes.** Local file manuals, loopback documentation servers, and intranet
  HTTP(S) manuals are classified and navigated. Only a loopback server with a configured browser
  backend is preview-eligible in this milestone.
- **Denied / limited classes.** Public/external HTTP(S) targets are declined; non-http(s)/file schemes
  are unsupported; credentials embedded in a target are rejected and collapsed into a generic
  `invalid-target` so the response never hints a credential was present.
- **Opening is never consent to crawl or index.** No route crawls, follows links, captures, persists,
  refreshes, or sends any content to a model. Indexing is a disabled, clearly future affordance.
- **Evidence redaction.** Only `scheme://host[:port]` origin summaries and a `/` or `/…` path shape
  cross the wire. Query strings, fragments, credentials, and local paths never appear in results,
  diagnostics, or UI copy. Result construction re-applies `stripUnsafeFormatChars` +
  `redactAbsolutePaths`.
- **CSP is not weakened.** The application CSP (`frame-ancestors 'none'`) is unchanged. Embedding is
  surfaced as a governed limitation, never bypassed.
- **Enterprise policy is respected.** The surface adds no proxy bypass, tunnel, or direct-internet
  escape; proxy/firewall outcomes are reported as governed reasons that never suggest disabling a
  control.

## Consequences

- The customer pilot can open and classify a real local or intranet manual and collect redacted
  load/navigation evidence. For loopback targets with a configured backend the outcome is
  preview-eligible; for intranet/local targets the honest outcome is "opened for inspection, inline
  rendering deferred"; for embedding/auth/proxy/scheme cases the outcome is a precise governed
  limitation. This satisfies the epic's "navigate the manual OR produce a precise governed
  limitation" contract without weakening a gate.
- The classification and reason model is authoritative on the server, so a later crawler/indexer epic
  reuses the same governed target gate rather than growing a parallel one.

## Risk register

- **CDP backend availability is developer-configured.** Loopback preview needs a BYO-Chrome CDP
  endpoint. Absence is surfaced as `browser-backend-unavailable`, not a crash.
- **Intranet host classification is heuristic** (private IPv4 ranges, ULA/link-local IPv6, single-label
  and `*.local`/`*.internal`/… names). Because the surface performs no egress, a misclassification
  only changes copy, never a network action. Public-vs-intranet precision can tighten later.
- **Rendering deferral is a product limitation, stated plainly.** Later inline rendering or rendered
  capture must arrive as a separately security-reviewed, CSP-scoped path.

## Handoff notes for later #1851 epics

- Indexing/Knowledge Pod work must consume `classifyDocumentationTarget` and the
  `DocumentationNavigationResult` gate rather than re-parsing targets, and must reuse
  `keiko-local-knowledge` ingestion/indexing rather than adding a parallel pipeline.
- Any move to actually render or capture a manual requires a new ADR, explicit user-approved scope,
  and security-reviewer sign-off, and must not widen the application CSP silently.

## Extension: consent boundary for indexable HTML manuals (Epic #1852)

Accepted as an extension of this ADR (Epic #1852, Issues #1865–#1870, 2026-07-06). Epic #1852 turns the
browser from a passive viewer into a governed Knowledge Pod source _candidate_ without weakening any
constraint above. It adds detection, a bounded scope preview, explicit consent, and a redacted handoff —
and no crawler, indexer, model call, or new egress.

- **No new egress; detection is pure over the target URL.** There is no safe pre-consent probe that
  reads a page's title, links, or headings (`checkStatus` is reachability-only). So manual detection
  (`detectIndexableManual`, `keiko-contracts`) is a pure, deterministic heuristic over the WHATWG-URL
  _shape_ only — scheme, host class, path pattern (index entry, `.html` extension, documentation path
  tokens, directory style, action-page tokens). It fetches nothing and executes no page JavaScript.
- **The scope preview is a declaration, not a sample.** `POST /api/docs-browser/propose` classifies +
  detects + builds a bounded scope preview (explicit page/depth/byte/link/timeout caps, `followRedirects:
  false`, denied link classes, a redacted proposed pod name, and `estimatedPageCount: null` because
  sampling is deferred to post-consent). The only local touch is a **read-only** Knowledge Pod summary
  lookup for already-indexed detection; it opens no indexing job and writes nothing.
- **Consent is explicit and never pre-granted.** Every proposal is typed `approvalRequired: true` /
  `approved: false` (compile-time literals). `POST /api/docs-browser/approve` re-derives the proposal
  server-side, refuses anything non-approvable or already-indexed, and returns a minimal, redaction-safe
  `DocumentationIndexingApproval` handoff (source kind, an opaque `sourceFingerprint` hash of the
  normalized root, redacted summaries, and the governed limits) for the future crawler epic (#1853).
  Producing a proposal or an approval starts no crawl or index.
- **Capability widening.** `DocumentationBrowserCapability.indexingProposalAvailable` widens from a hard
  `false` to a boolean that is true only for proposal-eligible classes (local file, loopback, intranet).
  It gates whether the UI may _offer_ to check a target — never whether a manual was indexed.
- **Duplicate prevention.** `KnowledgePodSummary` gains an optional, content-free `manualSourceFingerprint`
  so an existing HTML-manual pod can be matched by normalized-root hash (never a raw path). The match is
  a pure contract function; the fingerprint is computed downstream in `keiko-server` (the leaf contracts
  layer cannot hash). A future manual pod (#1853) sets it; until then detection safely reports "not
  indexed".
- **Redaction is unchanged and re-proved.** No proposal, preview, approval, diagnostic, or UI state
  carries a raw HTML body, query, fragment, credential, cookie, private path, or provider endpoint.
  Issue #1870 is the hard gate: a regression suite runs the propose/approve routes against a hostile
  target battery on a real store and fails if any capsule, indexing job, model-port request, or leaked
  secret/path appears.

Actual rendering or capture of a manual, and the crawler/indexer that consumes the approval handoff,
remain out of scope and still require the separately security-reviewed, CSP-scoped path noted above.

## References

- ADR-0017 (browser tool over CDP), ADR-0019 (package boundaries), ADR-0029 (workspace descriptor
  metadata).
- MDN `Content-Security-Policy: frame-ancestors`, MDN `X-Frame-Options`, OWASP SSRF Prevention Cheat
  Sheet, OWASP Top 10 A10 (SSRF), RFC 9309 (Robots Exclusion Protocol).
