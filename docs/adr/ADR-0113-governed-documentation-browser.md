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

## Extension: crawler trust boundary for static HTML manuals (Epic #1853)

Accepted as an extension of this ADR (Epic #1853, Issues #1871–#1877, 2026-07-06). Epic #1853 consumes
the `DocumentationIndexingApproval` handoff and turns an approved static HTML manual into a local
Knowledge Pod. It introduces the first outbound network egress into the Local Knowledge domain, so its
trust boundary is recorded here rather than in a new, collision-prone ADR number, following the pattern
Epic #1852 set for its consent boundary. No constraint above is weakened.

- **The crawler is egress-free where it lives; egress is injected.** `keiko-local-knowledge` is bound
  to zero network egress (ADR-0019 trust-9). The link-graph crawler (`crawl/crawl-runner.ts`), the scope
  guard (`crawl/scope-guard.ts`), and the link extractor (`crawl/link-extract.ts`) are therefore pure:
  they resolve, canonicalise, deduplicate, and bound the traversal, but byte retrieval is delegated to an
  injected `ManualCrawlFetcher` port — the same injection pattern the indexing layer already uses for the
  `WorkspaceFs` filesystem port and the embedding adapter. A local manual is read through `WorkspaceFs`
  (realpath-contained); an intranet manual is intended to be fetched by a `keiko-server`
  implementation backed by `gatewayFetch`, but that fetcher does not exist yet — see the "Deferred"
  note below. The crawler opens no socket itself.
- **One pure scope guard precedes every read/fetch, and fails closed.** `evaluateManualCrawlLink` is the
  single decision every candidate link is routed through before it is fetched or read. It layers an
  approved origin / path-prefix / local-root allowlist on top of the base scope and refuses every
  scope-expansion vector with a stable, body-free reason code: cross-origin links, parent-directory
  escapes in the raw link text, unsupported schemes (`mailto:`, `javascript:`, `data:`, …), credentialed
  URLs, login/logout/action links, non-HTML assets, and hidden/credential files (`.env`, `.git`,
  `.htpasswd`, `id_rsa`, …). Because every accepted http link is proven same-origin as the approved — and
  never metadata — origin, a cloud-metadata or link-local link is always refused as `cross-origin` before
  any address is contacted. Query strings and fragments are stripped during canonicalisation so
  query-token proliferation cannot expand the crawl. This guard is purely string/URL-based — it has no
  filesystem access, so it cannot and does not defend against a symlink escape.
- **Symlink escapes are refused by the WorkspaceFs-backed local fetcher, not by the scope guard.** For a
  local manual, the injected fetcher (`crawl/fetchers.ts`'s `createWorkspaceFsManualFetcher`) resolves
  every candidate path with `WorkspaceFs.realPath` and confirms the resolved path is still contained
  under the approved manual root before reading it — the same trailing-separator-safe containment check
  `discovery/walk.ts` already uses, reused here rather than re-implemented, so a symlink whose target
  merely shares a string prefix with the root (e.g. a sibling directory) is correctly refused.
- **The DNS-rebinding defence is reused, not reinvented.** The (follow-up) intranet http fetcher
  reuses the shared outbound egress engine (`gatewayFetch` / `egress-policy.ts`, ADR-0038), whose
  `enforceOutboundTargetPolicy` re-checks the DNS-resolved address on the direct path — so a hostname
  that resolves to a private/metadata address after the literal check is still blocked (rebinding
  defence). The shared engine's `allowPrivateNetwork` opt-in is intentionally all-or-nothing and MUST
  NOT be globally narrowed here: the gateway-setup flow relies on it to reach an operator-approved
  link-local or metadata-hosted model gateway. Instead, to reach an approved intranet origin while
  keeping the cloud-metadata address (`169.254.169.254`) unreachable, the fetcher must layer a
  crawler-local address check (an additive `denyMetadata` egress option or a resolved-IP re-check with
  `classifyOutboundHost`) on top of the approved-origin allowlist. Within Local Knowledge itself the
  guard needs none of this: every accepted http link is proven same-origin as the approved,
  non-metadata origin, so a metadata or link-local link is always refused as `cross-origin` before any
  address is contacted.
- **Every crawl is bounded and fails closed on expansion.** The crawler reuses
  `DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS` (200 pages, depth 4, 25 MB, 64-link sample, 15 s,
  `followRedirects: false`) and may narrow but never widen them. It executes no JavaScript and captures
  no rendered DOM — this remains the static ingestion boundary; rendered capture is still the separately
  security-reviewed path noted above. Redirects are refused, not followed.
- **Evidence stays body-free.** Crawl and indexing diagnostics report counts, statuses, redacted
  summaries, and denied-link reason codes only — never a raw URL, local path, query token, page body,
  credential, or cookie. The manual pod's redacted origin/path summary and opaque `manualSourceFingerprint`
  are the only manual-derived values that reach a browser surface, reusing the #1852 redaction guards.

The crawler consumes the pre-validated, redacted approval and never re-detects, re-summarises, or
re-approves a target. The `keiko-server` egress route and any user-facing UI that drives the crawl remain
the concern of later, separately governed work (chat-attach Epic #1854 and siblings).

**Deferred: server-side trigger route and HTTP fetcher.** `createHtmlManualPod` and
`refreshHtmlManualPod` (Epic #1856) are fully implemented, locally verified domain functions, but
neither has a live entry point in the running product today: no `keiko-server` route calls either,
no UI action triggers them, and the `gatewayFetch`-backed HTTP `ManualCrawlFetcher` for
`html-manual-http` sources described above has not been built. Wiring a governed BFF trigger route
and the HTTP fetcher is tracked in Issue #2063.

## Extension: citation-driven navigation for HTML manual chat answers (Epic #1854)

Accepted as an extension of this ADR (Epic #1854, Issues #1878-#1883, 2026-07-06). Epic #1854 turns
an indexed HTML Manual Knowledge Pod into grounded chat evidence and lets a user reopen cited manual
pages or sections through the governed documentation browser. The caller changes, but the trust model
above does not: citation opening is navigation only, never crawl, capture, indexing, refresh, or model
consent.

- **Chat retrieval reuses Local Knowledge.** HTML manual pods are projected as ordinary
  `KnowledgePodSummary` entries with additive manual source tags and an opaque
  `manualSourceFingerprint`. Chat selection, retrieval, hybrid/RRF ranking, context-pack assembly,
  grounded QA, retrieval activity, and evidence manifests continue to use the existing Knowledge Pod
  and Local Knowledge paths. No manual-specific retrieval runner, browser-side model call, or
  cross-space score mixer is introduced.
- **Manual citation targets are resolved server-side.** The Local Knowledge store persists additive
  `html_manual_sources` metadata keyed by capsule/source lineage: manual source kind, fingerprint, and
  the approved local root or http origin/path-prefix. Browser-facing citations carry safe page labels,
  section/heading path, `anchorId` when available, parsed-unit lineage, and an opaque
  `keiko-html-manual-citation:` target. Raw roots, origins with paths, query strings, credentials,
  page bodies, and virtual storage roots are not sent to the UI.
- **The docs-browser route remains authoritative.** The citation open action calls
  `POST /api/docs-browser/navigate` via `navigateDocumentation`. The BFF resolves the opaque citation
  handle against the persisted manual metadata, reconstructs the local or intranet target, and then
  uses the existing `classifyDocumentationTarget` / navigation reason model. A malformed handle,
  missing source metadata, lineage mismatch, outside-prefix target, unsupported scheme, or denied
  target fails closed with a redacted documentation-browser result.
- **Anchor precision is additive and bounded.** Section-level citations reuse the sealed `anchorId`
  field added to `ParsedUnit` and `CitationReference` by the HTML-structure work. When an anchor is
  unavailable, the UI renders a page-level-only state instead of inventing another section identifier
  or exposing a path. Setting a fragment on a resolved target never widens the approved origin/path
  scope.
- **Evidence stays body-free.** Retrieval activity and citation UI report counts, selected/cited/
  degraded states, safe labels, redacted origin/path summaries, and opaque lineage only. They do not
  expose raw query text, excerpts beyond existing grounded-answer policy, vectors, prompts, provider
  endpoints, private paths, token-bearing URLs, cookies, or customer manual content.

This extension keeps ADR-0113 as the single documentation-browser trust record. Future rendered
capture, refresh, parser-quality expansion, or customer-pilot egress changes still require their own
explicit scope and security review.

## References

- ADR-0017 (browser tool over CDP), ADR-0019 (package boundaries), ADR-0029 (workspace descriptor
  metadata).
- MDN `Content-Security-Policy: frame-ancestors`, MDN `X-Frame-Options`, OWASP SSRF Prevention Cheat
  Sheet, OWASP Top 10 A10 (SSRF), RFC 9309 (Robots Exclusion Protocol).
