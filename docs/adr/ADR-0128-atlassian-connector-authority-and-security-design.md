# ADR-0128: Atlassian connector authority and security design

## Status

Accepted (Issue #2239, Epic #2238, 2026-07-11).

> **Narrowed by [ADR-0138](ADR-0138-monotonic-product-wide-autonomy-semantics-and-code-task-terminology.md).**
> The D4 **Approve for me** column (now **Supervised workspace**) is recomputed under the ADR-0138
> matrix: every connector action is `review-required` in `supervised-coding`. Scope gating,
> envelope admission, risk tiers, and all other decisions remain unchanged.

ADR-0128 was allocated after refreshing `origin/dev` and checking all open pull requests on
2026-07-11. The product-wide authority record it builds on was drafted as ADR-0127 and renumbered to
[ADR-0129](ADR-0129-product-wide-authority-and-autonomy-model.md) during this epic's integration,
because `origin/dev` had meanwhile accepted its own ADR-0127 (editor Git reads and conflict
semantics, Epic #2093). ADR-0128 keeps its number — no committed `origin/dev` ADR claims 0128 — and
this epic renumbers only its own not-yet-committed authority record; no existing ADR was renumbered.

## Amends

This decision does not amend or supersede any existing record. It is the first forward-citation
consumer of [ADR-0129](ADR-0129-product-wide-authority-and-autonomy-model.md) (D6): it maps the
Confluence/Jira connector lane onto the shared three-mode authority model instead of inventing a
connector-local autonomy vocabulary. It extends
[ADR-0046](ADR-0046-local-credential-vault.md)'s local secret vault to a new credential namespace
and extends [ADR-0038](ADR-0038-outbound-egress.md)'s shared proxy/CA-aware egress transport to a
new connector family, in both cases by composition, not by re-implementation.

## Context

Epic #2238 adds a governed Atlassian connector lane: explicit, user-triggered synchronization of
Confluence spaces and Jira projects into Local Knowledge pods, an ad-hoc live Jira JQL read action
(#2248), and governed Confluence/Jira write actions (#2244) — create/update/transition/comment.
Every later child issue in the epic (contracts in #2240, custody in a follow-on, HTTP adapters,
write-action wiring, live search, evidence, UI) depends on this record fixing the trust boundaries
first, mirroring the role Epic #1857's ADR (#1896) played for the editor-agent docking work.

Three architectural risks are unique to this lane and must be decided before any implementation
child starts:

1. **Long-lived third-party credentials.** Unlike the editor or workspace surfaces, this lane holds
   a durable Atlassian API token or PAT that must never leave the local machine in cleartext, in a
   log line, in a model prompt, or in an evidence record — while still being usable, at execution
   time, to authenticate outbound HTTPS calls.
2. **A second class of outbound egress.** Keiko already has one hardened, proxy- and
   custom-CA-aware outbound transport (`gatewayFetch`, ADR-0038) living inside
   `keiko-model-gateway`, and one egress-free crawl leaf (`keiko-local-knowledge`, ADR-0019
   trust-9) whose network calls are supplied by an injected port that `keiko-server` implements
   with that same transport. The Atlassian connector needs the identical trust shape (a leaf
   package with no direct network capability, real egress supplied by the composition root) without
   creating a second proxy/CA/redirect implementation.
3. **A policy vocabulary gap.** `CodingWorkbenchConnectorScope` in
   `packages/keiko-contracts/src/coding-workbench.ts` currently defines only
   `source-control.read|write` and `issue-tracker.read|write`. Confluence read/write operations have
   no scope to attach to. Issue #2240 is blocked on this ADR resolving that gap before the contract
   module can be written.

Existing reuse anchors verified in this repository (read before writing this record, not assumed):

- `packages/keiko-contracts/src/coding-workbench.ts` — `CodingWorkbenchActionClass`
  (`connector-access`, `connector-write` is a `CodingWorkbenchSupervisedActionKind`, not an action
  class — see D4), `CodingWorkbenchConnectorScope`, `CodingWorkbenchNetworkMode`
  (`connector-scoped-egress` already exists), `CODING_WORKBENCH_MODE_POLICIES` (the `internet`
  resource-scope row is the one this lane composes with), `decideCodingWorkbenchActionForMode`,
  `strictestCodingWorkbenchPolicyEffect`.
- `packages/keiko-contracts/src/editor-agent-governance.ts` — the effect-class →
  action-class/resource-scope/risk mapping-table pattern (`EDITOR_AGENT_ACTION_EFFECT_CLASS`,
  `EDITOR_AGENT_WORKBENCH_ACTION_CLASS`, `EDITOR_AGENT_WORKBENCH_RESOURCE_SCOPE`,
  `EDITOR_AGENT_ACTION_APPROVAL_RISK`) that D4 mirrors for connector actions, and the tri-state
  disposition vocabulary (`allowed | review-required | denied`) with exactly one content-free
  reason.
- `packages/keiko-security/src/secret-vault.ts` — `resolveLocalVaultKey` (env → macOS Keychain →
  `0600` keyfile, namespaced per domain) and `createLocalSecretVault` (`get`/`set`/`replaceAll`/
  `delete`/`has`/`list` over a sealed, atomically-written multi-entry store), already generalized
  by [ADR-0046](ADR-0046-local-credential-vault.md) for model-gateway provider keys and reused
  as-is here for a new credential domain — no new crypto, no new package.
- `packages/keiko-model-gateway/src/http.ts` (`gatewayFetch`, exported at the
  `@oscharko-dev/keiko-model-gateway/internal/http` subpath) — the single hardened proxy-,
  custom-CA-, and DNS-rebinding-aware outbound transport (ADR-0038). It is already consumed
  **outside** `keiko-model-gateway` by `keiko-server`'s Figma connector port
  (`packages/keiko-server/src/qualityIntelligence/figma/figmaHttpPort.ts`), which builds its
  concrete transport from this subpath import while the Figma connector's own request/response
  typing stays independent. This is the direct, working precedent for composing a connector's
  network calls without giving the connector's own code a Model Gateway dependency.
- `packages/keiko-local-knowledge/src/crawl/types.ts` (`ManualCrawlFetcher` port) and its
  accompanying comment: `keiko-local-knowledge` performs no network egress by construction
  (ADR-0019 trust-9); for a local manual the port reads through `WorkspaceFs`, and for an intranet
  manual `keiko-server` supplies a `gatewayFetch`-backed implementation. This is the second,
  independent precedent for the same shape: pure leaf + injected transport port + `keiko-server`
  composition.
- `packages/keiko-local-knowledge/src/manual-page-fingerprints.ts` and
  `manual-refresh-change-summary.ts` (Epic #1856) — per-item SHA-256 content fingerprinting,
  atomic fingerprint-set replacement per run, and a body-free `added/changed/removed/unchanged`
  change-summary with a closed outcome/reason-code vocabulary. D5 generalizes this pattern (by
  shape, not by literal reuse of the HTML-manual-specific table, since Atlassian items are keyed by
  stable provider identifiers, not crawled paths).
- `packages/keiko-contracts/src/local-knowledge-pods.ts` (`KnowledgePodReadiness`:
  `draft | indexing | ready | stale | degraded | unavailable | error`) — the readiness vocabulary
  D5 maps sync job states onto, rather than inventing a connector-local readiness taxonomy.
- `packages/keiko-security/src/hashing.ts` (`sha256Hex`, `canonicalise`) — the deterministic
  hashing primitives D5 and D6 reuse for item fingerprints and hashed JQL, already reachable from
  `keiko-connectors` because both depend on `keiko-security`.
- `packages/keiko-local-knowledge/src/crawl/scope-guard.ts` and
  `packages/keiko-server/src/qualityIntelligence/figma/figmaHttpPort.ts` — the fail-closed,
  no-redirect-follow, credentialed-URL-refusing posture D3 adopts for the connector transport.
- `docs/adr/ADR-0038-outbound-egress.md` — proxy/CA composition, coded failure taxonomy
  (`OutboundHttpEgressError`), and the explicit statement that proxy URLs must not embed
  credentials.
- `docs/adr/ADR-0046-local-credential-vault.md` — the credential-vault pattern and its explicit
  "no new package" alternative-rejection, reused verbatim in D2.

## Decision

### D1 — Package home: a new `keiko-connectors` leaf, egress supplied by `keiko-server`

A new package `@oscharko-dev/keiko-connectors` is the home for the Atlassian connector lane's
domain logic. It depends on `@oscharko-dev/keiko-contracts` and `@oscharko-dev/keiko-security`
only — the same dependency shape as `keiko-memory-vault`, `keiko-memory-capture`,
`keiko-memory-consolidation`, `keiko-memory-governance`, `keiko-memory-retrieval`, and
`keiko-quality-intelligence` today. It holds:

- connector descriptor and sync-scope validation (base-URL, space-key/project-key/JQL bounds);
- the deterministic plain-text→ADF (Jira) and →storage-format (Confluence) composers (#2244);
- response normalization into the shared document/metadata mapping (#2243);
- bounded pagination orchestration as a pure state machine over an injected transport port;
- the credential-custody helpers built on `keiko-security/secret-vault` (D2);
- typed, content-free error classification for transport, auth, and scope failures; and
- an injectable `AtlassianHttpPort` transport-port interface. **`keiko-connectors` never imports
  `undici`/`fetch` directly and never imports `@oscharko-dev/keiko-model-gateway`** — it has no
  concrete network capability, exactly mirroring `keiko-local-knowledge`'s trust-9 no-egress
  posture. A future `check-import-policy.mjs` rule
  (`adr-0128-connectors-no-direct-egress`, mirroring `adr-0019-trust-9-local-knowledge-no-egress`)
  is the intended enforcement mechanism for the implementing child issue.

`keiko-server` is the sole composition root:

- it implements the concrete `AtlassianHttpPort` using `gatewayFetch` from
  `@oscharko-dev/keiko-model-gateway/internal/http` (the same subpath already consumed by
  `figmaHttpPort.ts`), closing over the resolved credential and the connector's egress
  configuration (D3);
- it owns the credential vault instance (D2), the connector descriptor store, the sync-job
  orchestration and BFF routes, and the projection of synced content into Local Knowledge pods
  (`keiko-local-knowledge`'s `KnowledgePodSummary`, per #2240 Scope 6);
- it resolves the Authority Envelope and composes the D4 decision helper with the central matrix
  before any action executes, mirroring the existing editor-agent route composition
  (`composeEditorAgentActionPolicyDecision`).

`keiko-connectors` does **not** depend on `keiko-local-knowledge`, and `keiko-local-knowledge` does
not depend on `keiko-connectors`. Both stay independent leaves; `keiko-server` is the only package
permitted to depend on both, matching the existing rule that the composition of a
`keiko-memory-*` package with `keiko-model-gateway` is `keiko-server`-only
(`.dependency-cruiser.cjs:639-641`, cited by ADR-0120).

No provider model SDK (`openai`, `@anthropic-ai/*`) is imported anywhere in this lane, and no
Model Gateway routing, prompt, or model call is involved in connector execution. `gatewayFetch` is
a shared HTTP transport primitive, not a provider SDK; reusing it does not create a Model Gateway
dependency for the connector's own domain logic, which never imports it.

### D2 — Credential custody: a dedicated secret vault, opaque `authRef`, write-only surface

**Auth scheme is a closed enum, not a fork:** `AtlassianConnectorAuthScheme = "basic-api-token" |
"bearer-pat"`. Cloud connectors use `basic-api-token`
(`Authorization: Basic base64(email:api_token)`). The additive Jira Data Center variant
uses `Authorization: Bearer <PAT>` and requires explicit `deployment: data-center` with
`provider: jira`; it has no account-email field. Absent deployment on legacy metadata
continues to mean Cloud. Both variants use the same custody, encrypted vault and execution-only
resolver. Data Center metadata starts at credential generation 1 (#4082).

**Storage construction (fixed, no alternative left open for the implementing child):** a new,
dedicated instance of the existing `@oscharko-dev/keiko-security/secret-vault` primitives —
`createLocalSecretVault` sealing entries with the existing AES-256-GCM `secretbox` construction
(`sealString`/`openString`/`isSealed`), keyed by `resolveLocalVaultKey` with:

- `vaultDir`: `<config-dir>/credentials/`
- `storePath`: `<config-dir>/credentials/atlassian-connector-credentials.vault`
- `envVarName`: `KEIKO_ATLASSIAN_CONNECTOR_CREDENTIALS_KEY`
- `keychainService`: `keiko-atlassian-connector-credentials-vault`
- `keyfileName`: `atlassian-connector-credentials-vault.key`

This is a **new vault domain with its own key**, not a shared key with the provider-credentials
vault (ADR-0046) or the Figma PAT vault (ADR-0037). Per ADR-0046's key-separation rationale, a
ciphertext sealed for one vault fails GCM authentication under another vault's key regardless of
AAD, so no cross-domain replay is possible even before considering reference-namespacing. Key
resolution tier (`env` > `keychain` > `keyfile`) is unchanged from the existing primitive; the
weakest tier (keyfile beside the store) is the documented floor for machines without a keychain,
exactly as ADR-0046 already documents for provider credentials.

**`authRef` indirection:** the connector descriptor (`AtlassianConnectorDescriptor`, #2240) carries
an opaque `authRef` string, generated server-side at credential-write time as
`atlassian-cred:<16 random bytes, base64url>` — independent of the connector's display id, provider,
or base URL, so renaming or re-pointing a connector's non-secret metadata never requires rekeying
the vault. `authRef` is the vault's reference key (`vault.set(authRef, secret)`); the descriptor
never carries the secret itself, matching the existing `apiKeySecretRef` pattern from ADR-0046 D2.

**Write-only-after-creation is an API-surface rule, not a new vault primitive.** The existing
`LocalSecretVault.get()` must remain available — the outbound HTTP adapter needs the live secret to
build the `Authorization` header — but exactly one caller in the whole system may invoke it: the
concrete `AtlassianHttpPort` adapter in `keiko-server`, immediately before issuing the outbound
request, mirroring the existing comment in `figmaHttpPort.ts` ("materialised into that header ONLY
by the default adapter, immediately before the platform `fetch` call — it is never logged here and
never re-emitted by the port"). Every other server route that creates, lists, updates, or reads a
connector descriptor returns only the non-secret projection (`id`, `provider`, `displayName`,
`baseUrl`, `authScheme`, `authRef`); none of them may call `vault.get()`. The create/rotate route
accepts the raw secret in the request body exactly once, calls `vault.set(authRef, secret)`, and
discards the request-body value after that call returns.

Both concrete HTTP ports materialize that header through the gateway's final preparation callback,
after pinned DNS/body preparation and, when proxied, CONNECT/TLS. A server-owned synchronous
admission callback runs before credential resolution against the immutable request snapshot. Only
an explicit `true` admits; custody/admission exceptions retain their identity instead of becoming
retriable network failures. POST and PUT use the gateway's single-attempt transport with configured
CA trust from the first attempt. An optional synchronous response observer records the HTTP status
before body consumption, so truncated or failed body reads cannot erase an observed acknowledgement.
Observer failures release the unread body, emit a content-free server diagnostic and propagate.
These callbacks do not themselves grant authority: the composing owner must supply the current
binding, mode, approval, budget and durable mutation checks before exposing a write operation.

**Deletion:** removing a connector calls `vault.delete(authRef)` and deletes the descriptor row in
the same server-side operation; `LocalSecretVault.delete` is already atomic and crash-safe.

**Exfiltration is a mode-independent hard denial (ADR-0129 D3).** By construction, the resolved
secret exists only inside the `AtlassianHttpPort` adapter's closure in `keiko-server` — it is never
passed into `keiko-connectors`' pure domain logic, never enters a model prompt or context pack,
never enters an evidence or audit record (D6), and never appears in an error message (transport
errors carry status codes and typed reasons, never response headers or request bodies that could
carry a reflected `Authorization` value). This holds in every mode, including Full access: no
autonomy mode can request or receive the raw credential.

### D3 — Governed egress: single-host allowlist, shared transport, fail-closed redirects

**Allowlist derivation:** at connector creation, the base URL is validated (HTTPS only; no
userinfo; no query string; no fragment — mirroring the #2240 AC for `AtlassianConnectorDescriptor`)
and its host is extracted as the connector's **sole** allowlisted egress host. A connector's
requests may only target that host; there is no cross-connector or wildcard allowlist. This is
enforced twice: once at connector-creation validation, and again at request-construction time in
the `AtlassianHttpPort` adapter (defense in depth, mirroring the existing
`outboundTargetBlockedReason` literal hostname/address-shape re-check in
`keiko-model-gateway/src/http.ts`, applied by the connector adapter before credential resolution). That literal-shape check runs unconditionally, proxied or not; the
gateway's *DNS-resolved* address re-check (`enforceOutboundTargetPolicy` with `resolveDns: true`)
additionally requires `egress.pinProxiedConnectTarget` when this connector's traffic is proxied
(ADR-0038 D6) — proxied deployments are first-class for this lane (below).

**Exact Data Center admission (#4082, 2026-10-26).** The file-owned
`atlassian.privateTargets` block may admit at most 64 canonical HTTPS base URLs, including
port and context path, with an explicit `private` or `loopback` address class. It applies only
to explicitly selected Jira Data Center connections. Setup request bodies, environment variables
and global permissive egress flags cannot create this admission; setup saves preserve the
operator block. Every request rechecks the current entry. DNS results must all match the declared
class, and direct/proxied connects retain address pinning. Metadata/link-local targets and the
active BFF listener port stay denied. Request paths must remain inside the configured context
path; noncanonical paths, encoded traversal/separators and fragments fail before credentials
are resolved. Safe configuration projections omit private target addresses.

**Correction (#3156, 2026-08-15).** The platform-level default for `pinProxiedConnectTarget` stays
off for a generic `gatewayFetch` caller (ADR-0038 D6: a caller must construct it explicitly, exactly
like `denyLoopback`) — nothing about that default changes here. This connector is one such caller,
and it opts in on every call: `connectorEgressConfig` in `httpPort.ts` unconditionally sets
`pinProxiedConnectTarget` to `true`. `denyLoopback` is also true except for the exact operator-owned
Data Center admission described below, so a proxied connector's DNS-resolved address is independently re-validated after
resolution against the same loopback/private/link-local/metadata policy as the direct path, not
merely covered by the literal-shape check. This text previously said the connector left that
opt-in off in v1, covering a proxied deployment's resolved address by the literal check alone; two
independent reviewers flagged that a DNS name classified as safe by its literal shape but resolving
into blocked address space was therefore unvetted whenever this connector was proxied — a live
SSRF and internal-reconnaissance path, not a theoretical one, since operators commonly point
connectors at internal reverse proxies.
The accepted trade-off is that a corporate proxy filtering CONNECT by hostname rather than by
resolved address could reject the now-pinned, IP-literal CONNECT authority; that is an
operator-visible, diagnosable failure, weighed as preferable to a silent internal-address bypass for
a lane whose target is already a single, operator-configured host. See `httpPort.ts`'s comment above
`isBlockedLoopbackTarget` for the full reasoning and ADR-0038 D6 for what the two flags do and do
not permit individually.

**Transport:** the concrete adapter is built from `gatewayFetch` (ADR-0038), reusing its existing
proxy/CA composition unchanged — no connector-specific proxy or CA logic is introduced. Proxy
configuration (`KEIKO_HTTPS_PROXY` > `HTTPS_PROXY` > `https_proxy`, `NO_PROXY` rules) remains
operator-level configuration. When an HTTP(S) proxy resolves a hostname, the gateway configuration
file must additionally set `egress.acknowledgeProxiedHostnamePolicy: true`; that explicit
acknowledgement records the delegated-resolution risk and is never inherited from an environment
variable. Trusted CAs (Node bundled roots ∪ OS trust store ∪ `NODE_EXTRA_CA_CERTS` ∪ configured
bundle) remain part of the existing operator-level configuration; this connector does not gain its
own proxy/CA settings surface. Both enterprise-proxied and direct-internet deployments are
first-class because the transport is unchanged from the model-gateway/Figma path that already
supports both.

**Redirects and protocol downgrade fail closed.** The adapter issues requests with no redirect
following (mirroring `figmaHttpPort.ts`'s `redirect: "manual"`): any 3xx response is surfaced as a
typed transport error, never followed. A redirect target on a different host, a non-`https:`
target, or an `http:` downgrade is refused before any connection is attempted — the single-host
allowlist and the HTTPS-only base-URL validation make this the same check twice, which is
intentional (fail-closed defense in depth, not redundant complexity to remove).

**URL-embedded credentials are refused,** consistent with ADR-0038's proxy-URL rule: a base URL or
any derived request URL containing `username`/`password` userinfo is rejected at validation time
and, as defense in depth, at request-construction time.

**Connection identity verification (#4082).** Cloud verification reads at most 64 KiB of
JSON from the authenticated current-user endpoint within one 30-second deadline. Jira Cloud
requires a nonempty account ID and an active user; Confluence Cloud requires a nonempty
account ID and a known user. HTML/SSO pages, malformed or truncated JSON and anonymous
identities fail closed. Data Center uses the same bounded parser for REST-v2 `serverInfo`
and `myself` within a shared deadline. Remote identities and bodies are neither logged nor
returned; only the closed verification outcome enters the existing Activity Log.
The endpoint contracts are the official
[Jira Cloud current-user API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-myself/)
and [Confluence Cloud current-user API](https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-users/).

**Bounded timeouts:** 30 000 ms per request for interactive write/read actions (issue and page
CRUD, transitions, comments); 60 000 ms per paginated fetch for bulk sync requests (matching
`FigmaHttpPort`'s existing `DEFAULT_TIMEOUT_MS`); 15 000 ms for the live JQL search action (#2248),
matching the existing per-page timeout convention in
`DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS.timeoutMs`. Sync-run timeouts are additionally bounded
by the overall `maxDurationMs` run budget (D5).

**Bounded read backoff for 429/5xx:** GET requests use exponential backoff starting at 500 ms, factor 2, capped at 8 000
ms per attempt, maximum 5 attempts, honoring a `Retry-After` response header when present (itself
capped at the same 8 000 ms ceiling so a hostile or misconfigured upstream cannot stall a run past
its budget). 4xx responses other than 429 are not retried; they fail immediately as typed,
content-free errors (`auth-failed`, `permission-denied`, `malformed-payload`, per the #2240 job
failure-reason vocabulary).
POST and PUT mutations are dispatched at most once, including responses carrying
`Retry-After`. HTTP method idempotency does not establish that no effect occurred:
a committed mutation may lose its response, and a repeated PUT may overwrite an
intervening actor's change. The invocation owner retains the original intent and
reconciles observed remote state; uncertain effects never trigger an automatic resend
(#4081/#4083). A transport failure reason does not prove absence of a mutation. The durable Chat
journal treats a post-dispatch non-2xx response as an unknown effect, and a status alone never
proves otherwise: a proxy may replace a response after an upstream commit. The one exception
(amended 2026-11-01, #4176 AC4) is a definitive rejection. Data Center validates a whole request
before it applies anything, so a 4xx other than 408, 409 and 429 that carries Jira's own parsable
error document (`errors` and/or `errorMessages`, kept as the failure detail) applied nothing. The
composing caller then settles the write as `rejected` and passes the document as proof
(`settle(..., { jiraErrorDocument: true })`); without that proof, or for any other status, the
journal refuses `rejected` after a response. A rejected write is not a held write and does not
block the turn, so the model corrects the refused fields and retries in the same turn. The line on
the Activity Log carries the closed `rejection: jira-error-document`, never the document. A 4xx
without a parsable Jira error document, 408/409/429, every 5xx, a lost answer and a 2xx without a
parsable body stay `unknown` and fail closed (#2953: no automatic replay), as does a crash between
the response and the settlement. A known local rejection before dispatch is unchanged; its settled
line carries Keiko's own closed `refusalReason` (the connector write-failure vocabulary) and, for a
field refusal, the closed `fieldValidation` class, never the field or its value (#4173). Neither
field appears once Jira answered, so a local refusal and Jira's own rejection stay distinguishable.
The shared HTTP transport and existing action Activity Log remain the
owners of per-request and terminal evidence. The managed catalog envelope retains its own
cancellation/denial and settlement status; a matching journal outcome is projected separately as
`exchange.mutationOutcome`, with exact actor, Chat, binding, credential, canonical-turn, action and
argument identity checks. Transcript reload and model-history projection keep that outcome paired
with the original call/result IDs. A later abort or authority loss cannot erase an already observed
remote effect or imply rollback, and an orphaned pending record never authorizes takeover/replay.


**Bounded Jira field validation (#4083).** The connector owns one metadata-driven field matrix
for its managed Jira provider. It admits standard text, finite numbers, calendar dates,
millisecond datetime values, user/option references and explicit bounded list types. Core Jira
custom-field types are named explicitly; a core custom type without an explicit entry takes the
kind its declared schema type states only when that type is a plain scalar (string, number, date,
datetime) and is otherwise `opaque`, so a choice, user or composite type whose full shape is not
implemented is never narrowed to a simpler validator. Jira's cascading select is the exception that
is implemented: an `option` field whose `schemaType` is `option-with-child` takes `{ id }` for the
parent (checked against the allowed parents) with an optional `child` of the same one-`id` shape and
no other key; a grandchild, another key or a non-object child is refused, and Jira validates that
the child belongs to the parent. Every field Jira offers is writable (owner decision
2026-10-31, #4176): a plugin field (any custom type outside Jira's own namespace, e.g. Epic Name,
Epic Link, Sprint) and a non-routing system field without an explicit entry are `opaque`. Their
meaning is never guessed from a familiar base schema: an opaque value is bounded plain JSON
(depth 4, 100 items, 50 keys, 4096 characters per string, 16 KiB serialized, no control characters
or prototype keys), forwarded as given, never converted to rich text, and Jira's own validation is
authoritative; read-back confirms presence or clearing, not equality, because Jira reshapes such
values on read. The system `parent` field is an `issue` reference (`{ key }`, `{ id }` or a bare
key, canonicalized to one identity). `attachment`, `issuelinks`, `comment`, routing and computed
system fields stay outside plain field writes and are written through their own tools or
arguments. Issue links are the `links` kind: `jira.create` and `jira.edit` take a bounded `links`
argument (at most 20 `{ type, direction, issueKey }` entries; duplicates collapse) only when current
metadata offers `add` on the canonical `array:issuelinks` field; `outward` means this issue →
`issueKey`. Jira Data Center and Cloud both refuse a create or edit with more than one `issuelinks`
operation (JRASERVER-66329, unresolved; a Data Center 10.3 answers 400 "We support at most 1
operation for this field"), so the request itself carries at most one `update.issuelinks` add
and every further link is its own `POST /rest/api/2/issueLink` (`inwardIssue` is the link's source:
an `outward` link names this issue there) after the issue exists, in order, each dispatched at most
once. Those calls are the same approved mutation, not new ones: no new operation or approval path
exists, the server dispatches them only after the invocation's own write was acknowledged and under
the same current-authority and approval guards (at most the approved count, the journal record
unchanged), and the connector writes only the approved links, none that the read before an edit
already shows (Jira does not de-duplicate links). A failure stops the sequence, nothing is resent,
and the issue is read back: if it was created or edited, the result is `succeeded-unconfirmed`,
names the issue and lists the requested links that are missing (`linksMissing`; `linksUnconfirmed`
when the links could not be read back), so the model repairs the links instead of creating the
issue again. That result is declared within the encoded worst case of what it can carry (twenty
missing links whose type names are 255 UTF-16 units of any script, beside the usual result), so a
non-ASCII link type cannot make the catalog reject the receipt after the issue was created. A
replayed invocation returns its journal outcome and sends nothing. Jira validates the
link type and the target; read-back confirms every requested link in its requested direction (a
symmetric link type, whose inward and outward names are equal, has none), existing links are kept,
and a link read returns `{ type, direction, issueKey }` JSON text only for the complete set:
more than 100 links, or one entry that cannot be read, leaves the field `unavailable` (never a
truncated `value`), so a caller treats the links as unknown rather than absent. The Activity Log records only
link counts (requested, present afterwards, missing) on the existing mutation line. Field
metadata projects Jira's declared `schemaType` so a caller can shape an opaque value. A refused
write returns, to the model only, the refused field with Keiko's closed validation reason, or
Jira's own bounded field errors and messages (at most 8 and 3, each cut on code-point boundaries
to 200 UTF-8 bytes of its JSON encoding, control characters removed, so quotes and non-ASCII text
cannot push the detail past the 4 KiB result bound); none of it is logged. A field error also
carries the field's display name (`fieldName`) when the request's current metadata knows it, so the
model and the person see "Risk class", not only `customfield_10000`. Every result also carries a
fixed `guidance` sentence, never derived from remote text: after a definitive rejection it tells the
model to correct the named fields and send the corrected change once, and to explain in plain
language which field is the problem if Jira refuses again; after an uncertain outcome
(`unknown`, `succeeded-unconfirmed`, or a write blocked behind one) it tells the model not to
repeat the change, to make no further change in the turn, and to tell the user in plain language
that the change may or may not have been applied and what to check in Jira. Keiko's users are
knowledge workers: a refused or uncertain write ends the turn with a usable answer, never a stall. A choice list above 500 entries makes only that field
unsupported; other fields remain usable, and a required field without a server default still
blocks creation. Plugin choice structures are not interpreted. Known-field structural errors
remain malformed metadata. Offered verbs are intersected with the implemented field/verb matrix;
opaque and issue fields offer only `set`, links only `add`, and unsupported fields advertise no operations. Choice labels are display-only and never replace the deployment-specific identity in mutation arguments. Current metadata operations and allowed references constrain values.
A bare string is accepted for a user and for a choice and is canonicalized to the one reference the
deployment admits (lab S05, #4176): a user name becomes `{ name }` on Data Center and
`{ accountId }` on Cloud and stays bound by any listed users; a choice matches the offered
`allowedValues` by exact id, value or name, only when exactly one entry matches, and becomes
`{ id }` (a string that is one choice's id and another's value or name is refused as ambiguous,
with a message for the model; without a list, only a numeric id is taken; anything else is
refused). The
object forms are unchanged. Omission preserves an edit; null/empty clearing requires an optional field and an allowed set.
Create may leave a Jira-declared default omitted without copying or fabricating it. The system
`reporter` is the one required field Keiko also lets a create omit: Jira assigns the authenticated
caller as reporter when the field is absent although create metadata lists it as required without a
default (lab S17, #4176). A supplied reporter is validated like any user; every other required
field still blocks the create, and edit and transition are unaffected. Add/remove is
limited to labels; replacement and additive changes cannot target the same field in one action.
Cloud rich text uses the existing ADF composer; Data Center uses plain text, and user references
respect each deployment's identity scheme. A rich-text value written to Jira without any real line break, with at
least two escaped ones (the two characters `\n`) that would produce a heading or a list item at the
start of a line, is refused with one fixed sentence for the model, on both deployments (lab S07,
#4178): some models escape line breaks twice inside tool arguments, and Jira would store the escapes
as visible text and collapse the document's sections into one line. Keiko never rewrites the value;
one literal escape, escapes beside real line breaks, and escapes in prose (a description of the
pattern `/\n\n/`) remain ordinary text and are accepted, and single-line text fields are unaffected.
The rule judges what is written only: a stored description is projected by a read exactly as stored. Fresh metadata, authority and dispatch remain separate
provider obligations; the pure validator grants no execution authority.

Issue reads may select at most 20 additional field IDs. Their `names`/`schema` expansion is
interpreted by the same field matrix and value validator; no edit permission is inferred from
readable values. Missing values or schemas remain unavailable, null/empty values remain empty,
and opaque values are returned as bounded serialized JSON text; an issue reference reads as its
key; a cascading select reads as its parent reference followed by its child reference, and any other
shape is unavailable. User/option
references retain only the deployment identity and bounded display label; email addresses and
self links are omitted. Datetimes accept both ISO offsets and Jira's compact offset representation.
The expanded `jira.issue` input/result contract is version 3; its ordinary unexpanded read remains
compatible. The transport's overall byte bound still applies to the selected result.


The Data Center mutation executor refreshes create metadata through the post-9.0 paginated
endpoint (at most ten pages and 500 fields), edit metadata through `editmeta`, and transition fields
through `transitions.fields`. Duplicate or inconsistent pages fail closed. A selected transition and
its validated fields are sent together. Creation binds numeric project/issue-type identities;
editing those routing fields or adding undeclared compound effects is unsupported. Assignment of a
named active user checks the current issue-scoped assignable-user endpoint without requiring edit
permission; unassignment additionally requires metadata that permits clearing. Comments remain
Data Center plain text. The executor snapshots inputs before metadata I/O, shares one aggregate
deadline across phases, and rechecks admission for every request. The HTTP response observer
records a successful status in the durable journal before response-body consumption. Only the
operation's documented 201/204 response, required identity and successful bounded direct readback
establish a confirmed result. Confirmation checks the affected resource: returned creation/comment identity and
requested content, edited field values, assignment identity, or the transition's current target
status and requested fields. Edit/assignment/transition capture the relevant state before dispatch.
A state that already matched before dispatch does not establish a new effect; a self-transition
therefore remains unconfirmed. Label updates compare only the requested membership changes, while
replacement sets ignore ordering and reference labels never substitute for identities. Failed or
contradictory readback remains acknowledged-but-unconfirmed in the server composer and never permits
automatic mutation replay. These checks observe the requested result; they do not promise exclusive
causation or atomic protection against concurrent Jira updates. Managed-provider defaults expose
reads. Write declarations require an explicitly injected server executor that composes the durable
journal, current admission and final HTTP port; the connector cannot dispatch through its read
connection instead. Arguments and connection selection are captured before asynchronous execution.
The five canonical write descriptors use closed top-level arguments and result states. Dynamic
field values are additionally validated against fresh Jira metadata, while additive updates are
restricted to implemented label verbs. Assignment clearing is explicit (`clearAssignee: true`),
mutually exclusive with `assigneeName`; absence never means clearing. This composition does not
confer normal Chat binding, read-consent or approval authority on its own.

Authorized tool results include instance-qualified issue links derived from the private selected
connection and validated issue keys, preserving the context path. Jira-supplied `self` URLs are never
used for them. Links are added after journal composition and stay out of receipts, journal rows and
Activity Log evidence. A replay of a create without a retained issue identity does not fabricate a
link. Read and mutation descriptors carry the additive result field in their new contract versions
(reads v2, issue read and mutations v3). Mutation schemas share the connector validator's
50-update bound. Complete read-page byte accounting includes the links and
reserves the existing catalog envelope budget. When a page exceeds that budget, a fitting prefix
is returned with `nextStartAt` pointing to its first unreturned item; an item that cannot fit alone
produces the existing bounded failure instead of a misleading empty page.

The existing private credential metadata owner also holds optional Jira Live-Pod identity:
an independent Pod UUID, server-supplied owner digest, creation-request UUID and bounded verification
revision/status. The creation intent is unique within its owner and is checked before another vault
write; reuse returns an explicit conflict, never a claim that a different submitted token was applied.
No Pod identity or verification status confers Chat authority. Verification completion is single-use
and checks the current credential generation and latest probe revision against the retained record;
it cannot recreate deleted metadata. Failed verification advances the authorization generation.
Starting a new check retains previously observed readiness until that check has a result.

Authenticated credential creation obtains the existing local operator identity from the server;
the request cannot select an owner. List, verify and delete enforce that owner for Live Pods.
The legacy credential GET/Create responses use an explicit public field projection and exclude
the entire private Live-Pod block, including owner and creation-intent digests. Listing emits
only the visible count; unavailable or foreign records share the existing not-found rejection.
The ordinary Chat consumer needs no Coding session to establish this server-owned actor identity.

The existing Verify route starts a generation-checked ticket and completes only that current
revision. A successful check retains its generation; failed checks and internally aborted probes
advance it. Aborted probes return to unverified readiness. Late answers after a newer check or
deletion return conflict and cannot overwrite current state. The existing connection-check event
distinguishes applied and stale observations without response content. This verification state
does not itself grant Chat read or mutation authority.

The custody owner notifies server composition when a current failed/aborted probe advances the
credential generation, or after retaining a durable deletion intent and before removing ciphertext.
This also covers the direct credential-management routes. The existing UI store atomically advances every matching Chat's
binding generation, retaining its Pod association on credential invalidation and disconnecting on
removal. Older/repeated generation notifications are harmless. The existing Chat turn serializer
then interrupts affected generations; other Pods' Chats remain untouched. Applied scope changes
and requested cancellation use the registered `chat.scope.update` event. Request correlation passes
through custody and invalidation, linking the HTTP result, binding effects and cancellation; only
operations outside a request mint a fresh server correlation. Cleanup failure cannot restore access: incomplete token replacement
and deletion are retained in private metadata, with a new generation and unverified readiness, before ciphertext changes.
Execution and verification refuse these pending records before reading the vault. Token replacement
settles only after the new sealed value and metadata are both written; a failed replacement requires
an explicit replacement at the current generation. Deletion may retry its retained intent. Rename
keeps authorization stable. These custody primitives preserve Pod identity and reject stale updates.
The authenticated credential resource accepts PATCH with `expectedGeneration` and `displayName`,
`apiToken`, or both. The existing CSRF and owner checks apply before custody mutation; the response
uses the same public metadata allowlist and cannot expose the private lifecycle block or token.
Applied rename/replacement events record only action and generation on the existing Activity Log.
A logging fault after commit produces a diagnostic without converting success into a retryable
mutation failure. The Knowledge Pods hub's rename, token replacement, reverify and removal controls
use these same authenticated owners. Public metadata is refetched after a lifecycle request settles
(including an uncertain failure) and on window focus; a browser notification carries no credential,
readiness or authority. Matching Chat bindings and grants/approvals are invalidated by the same
lifecycle owner, including mutations through the direct credential routes. The current qualification
coverage, including restart cases, remains explicit in the epic evidence matrix.

Both outbound HTTP factories forward the private dispatch/response hooks so the same current
policy guard can run after transport preparation and before credential materialization. A
response observer captures the selected Live Pod generation and verification revision by value.
An observed 401 invalidates only that still-current verified credential, advances its generation
and notifies the existing dependent-Chat lifecycle owner. A newer/pending verification, rotation,
deletion or 403 permission denial cannot revoke another/current credential. Response acknowledgement
runs before invalidation and body consumption; the existing Activity Log distinguishes observed
request status from an explicit verification probe. Probe construction marks its server-owned
purpose explicitly and omits the observed-request handler; its existing verification owner records
the result once. This classification does not depend on a possibly stale metadata snapshot.
This does not introduce credential polling.

Both outbound HTTP factories capture the selected credential generation by value. The custody
resolver checks it against current private metadata before reading ciphertext, so an old transport
cannot silently materialize a replacement credential. The existing typed rejection event and 409
mapping cover creation conflicts and changed credentials. The authenticated Pod lifecycle routes
compose these primitives with owner checks and invalidation; the ordinary Chat consumer separately
admits its current binding, read grant and exact mutation approval before execution. The metadata
and transport primitives alone confer none of that authority.

### D4 — Action-class mapping table

**Shared deployment ceiling (#4083).** Production composition resolves one ceiling for Coding and
connector consumers: absent configuration permits `autonomous-delivery`; the selected human mode
still defaults to Ask for approval. Explicit configuration and the retained compatibility option
can narrow the ceiling; invalid values fail closed. Connector calls use that same resolved value
for authority admission and budget reservation, and include it in the content-free action outcome.
Memory retains its separate explicit-or-`governed-assist` default. This availability change does not
itself grant a Chat read consent, mutation approval, connector scope or authority envelope.


This is the normative mapping for every v1 governed connector operation. Rows are derived from
`CODING_WORKBENCH_MODE_POLICIES`'s `internet` resource-scope row (all connector actions reach an
external system over HTTPS) composed with `decideCodingWorkbenchActionForMode`'s scope gate
(stricter-wins: `denied` beats `review-required` beats `allowed`), exactly as
`editor-agent-governance.ts` composes `envelopeModeEffect`. Every action maps to exactly one
governance identifier from the shared `keiko-contracts` vocabulary — `connector-access`
(`CodingWorkbenchActionClass`) for read operations and `connector-write`
(`CodingWorkbenchSupervisedActionKind`, which maps back to the `connector-access` action class in
`actionKindToPerm` for the shared policy matrix while carrying the higher approval risk on the
supervised-action path) for write operations — one connector scope, and one
`CodingWorkbenchApprovalRisk`, and the disposition columns are the corresponding tri-state effect
(`allowed | review-required | denied`) **assuming the required connector scope is present in the
Authority Envelope.** The `Action class / kind` column below records both identifiers
uniformly: reads name the `CodingWorkbenchActionClass`, writes name the
`CodingWorkbenchSupervisedActionKind`.

| # | Action | Provider | Action class / kind | Connector scope | Approval risk | Ask for approval | Supervised workspace | Full access |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `sync-space` | Confluence | `connector-access` | `knowledge-base.read` | low | review-required | review-required | allowed |
| 2 | `sync-project` | Jira | `connector-access` | `issue-tracker.read` | low | review-required | review-required | allowed |
| 3 | `search-issues-live` | Jira | `connector-access` | `issue-tracker.read` | low | review-required | review-required | allowed |
| 4 | `create-issue` | Jira | `connector-write` | `issue-tracker.write` | high | review-required | review-required | allowed |
| 5 | `update-issue-fields` | Jira | `connector-write` | `issue-tracker.write` | medium | review-required | review-required | allowed |
| 6 | `transition-issue` | Jira | `connector-write` | `issue-tracker.write` | high | review-required | review-required | allowed |
| 7 | `add-issue-comment` | Jira | `connector-write` | `issue-tracker.write` | low | review-required | review-required | allowed |
| 8 | `create-page` | Confluence | `connector-write` | `knowledge-base.write` | high | review-required | review-required | allowed |
| 9 | `update-page` | Confluence | `connector-write` | `knowledge-base.write` | medium | review-required | review-required | allowed |
| 10 | `add-page-comment` | Confluence | `connector-write` | `knowledge-base.write` | low | review-required | review-required | allowed |
| 11 | `jira.projects` | Jira | `connector-access` | `issue-tracker.read` | low | review-required | review-required | allowed |
| 12–14 | `jira.issue-types`, `jira.create-fields`, `jira.edit-fields` | Jira | `connector-access` | `issue-tracker.read` | low | review-required | review-required | allowed |
| 15–17 | `jira.search`, `jira.issue`, `jira.comments` | Jira | `connector-access` | `issue-tracker.read` | low | review-required | review-required | allowed |
| 18–19 | `jira.transitions`, `jira.assignable-users` | Jira | `connector-access` | `issue-tracker.read` | low | review-required | review-required | allowed |
| 20 | `jira.report` | Jira | `connector-access` | `issue-tracker.read` | low | review-required | review-required | allowed |
| 21 | `jira.draft-stage` | Jira | `connector-access` | `issue-tracker.read` | low | review-required | review-required | allowed |
| 22 | `assign-issue` | Jira | `connector-write` | `issue-tracker.write` | medium | review-required | review-required | allowed |

The shared action vocabulary and registered outcome event include all twenty-two rows. The managed
tools map to this same table: `jira.create` → `create-issue`, `jira.edit` → `update-issue-fields`,
`jira.assign` → `assign-issue`, `jira.comment` → `add-issue-comment`, and `jira.transition` →
`transition-issue`, and `jira.attach` → `update-issue-fields`. The eleven read tools retain their
names. Assignment has the same medium risk
as a bounded field edit; no separate policy subsystem or broader connector scope is introduced.

**Attachments (#4176, 2026-10-31).** `jira.attach` maps to `update-issue-fields` (medium): it
changes an existing issue exactly as an edit does and is governed, approved, journaled and
confirmed as one. The file never comes from a host path the model names: the model gives a
`connected-file` source, a path relative to a folder or file selection the human connected to the
Chat, and the server admits it like a Files read (realpath containment, the deny list, no
managed-task root, a descriptor bound to the admitted file). The selection is matched on the path
asked for and again on the real location once symbolic links are resolved, so a link inside a
selection cannot lead outside it. The bytes are raw, unredacted and unconverted, bounded by Keiko's
20 MiB ceiling and by the instance's own `attachment/meta` switch and upload limit, whichever is
lower; the limit is read before the review, so a file the human approves is never refused afterwards
as too large. An empty file is refused. The name shown and sent is the name the model used (the
link's own name, never its target's), unless it is not a plain file name.

*Credential floor.* Attached bytes skip the redaction every other egress applies, and secret
exfiltration is a mode-independent hard denial, so the content is classified and scanned at both the
review and the send with the credential floor the redaction layer already uses
(`containsCredentialShape` and `redactCredentialShapes`, plus a search for the configured secret
literals in the raw bytes): text (valid UTF-8 without binary control characters) is scanned whole;
PDF, Word and Excel documents are scanned through the Local Knowledge extractors, and a document
whose text is clipped, absent or unreadable is refused. Because an extractor reads only what a page
shows or the body parts a parser needs, the whole file is read as well: every part of a Word or Excel
package (comments, headers, footers, properties, embedded media, any other entry) is inflated with
the shared bounded OOXML reader and scanned as text or checked as an image, and a part that is
neither refuses the file, and the ZIP container's own bytes (archive and entry comments, names,
extra fields) are scanned too. Text is scanned as written and as a reader recovers it: XML character
and entity references decoded, tags, comments and processing instructions removed (quoted attribute
values may hold `>`), CDATA unwrapped, so an escaped value or a text run that tags split is the
credential it spells; a part that declares an entity is refused. A PDF is read as object syntax in
one bounded pass, not by pattern: dictionary names are decoded (`/F#69lter` is `/Filter`), every
string is decoded (hexadecimal, escaped literal, UTF-16 and UTF-8 text strings) and scanned, also
inside inflated and unfiltered streams, and a stream's filter is read from its own dictionary. The
file's own bytes are scanned and every Flate stream (object streams, annotations, form values,
metadata) is inflated and scanned; a JPEG (`DCTDecode`), inflated first or not, gets the whole image
admission below. A stream under any other filter, a filter stated unreadably (an indirect value), a
`stream` keyword the reader did not take for a stream, syntax the reader cannot interpret, an
encrypted PDF (`/Encrypt`, however spelled) and a PDF carrying an embedded file are refused. PNG and JPEG images, recognized by their signature, are allowed only when nothing hides in
or behind them: their raw bytes are scanned like text, a PNG's chunks are walked from IHDR to a
final IEND against a known set (a fixed-size Apple `iDOT` included) and its compressed text carriers
(`zTXt`, compressed `iTXt`, `iCCP`) are inflated and scanned, and a JPEG's segments are walked from
SOI through its entropy-coded data to a final EOI; an unknown chunk, a malformed structure or any
byte after the image is refused as `unscannable`, since trailing data has no lawful use in an
attachment. Every inflation must consume its carrier exactly, so a second stream behind the first
is refused, and all inflation shares one 64 MiB budget per file. GIF and WebP, archives, databases,
key stores, executables and unknown binary are refused as `unscannable`, and a detected credential
as `contains-credential`. The human therefore never approves such a file, and the tool description
tells the model so. The scan finds credentials where a file naturally carries text; it does not
claim to find a secret deliberately encoded into pixel data or another opaque representation
(independent review of #4176, 2026-10-31).

*Review and send.* When the approval is requested the server reads the file and attaches its
**name, size and SHA-256** to the approval view and so to the approval proof; the human is shown
those, never the content. At send time the file is read again and must match the approved name, size
and digest, otherwise nothing is sent and the model is told the file changed after review
(`conflict`). Where policy requires a review and no approval is found (an expired record), the send
is refused as `unreviewed`; a file that cannot be read for review gets no approval at all; under
Full access the same admission, scan and bounds apply without a review. A refused or never-sent
attachment leaves no remote effect and is not replayed: the journal retires its record (migration 57
widens the operation check; the old record keeps its outcome under a retired action digest), so the
retry in the same turn is a new attempt with a new review, while the replay of a dispatched or
succeeded attachment is unchanged.

*Upload.* One multipart `POST /rest/api/2/issue/{key}/attachments` with
`X-Atlassian-Token: no-check`, dispatched at most once by the journal and built into a single
pre-sized buffer (the file is held about twice at send: its bytes and the body). A name outside ASCII
travels as an ASCII-sanitized `filename` plus the RFC 5987 `filename*`; whether a given Jira Data
Center honours the extended form is not assumed, and the readback accepts the stored name spelled
either way. Success needs Jira's reply and a direct readback of the stored attachment's id, name
and size. The readback does not fetch the stored bytes, so it confirms Jira's record, not byte
equality; the digest binds the bytes Keiko read, not the bytes Jira stored. The connector package
performs no filesystem access: the server injects the source port. Source reads are recorded
body-free on `jira.attachment.source` (stage, closed refusal, size; never path, name or content).
Coding runs do not offer `jira.attach` and the Coding risk map neither lists nor defaults it: their
files are governed by the run's own workspace authority, which this source does not consult.

**Field-selectable search (#4176).** `jira.search` accepts the same bounded `fields` list as
`jira.issue` (1–20 unique ids, system or custom) and returns, for every result, typed
`fieldValues` projected through the instance's own `names` and `schema` (`expand=names,schema`); an
id the instance does not describe reads as `unavailable`, an empty value as `empty`, and a value
kind Keiko does not project as `unsupported`. Each result's field values are bounded to 16 KiB and
the page keeps its prefix bound and `nextStartAt` continuation.

**Backlog drafts (#4178, 2026-10-31; paged drafts 2026-11-01).** `jira.draft` maps to
`create-issue` (high): it proposes related issues that reference each other by a local `ref` and
are approved once, whatever their number. **There is no limit on the number of items.** The only
bound on a draft is a resource bound in bytes — 16 MiB of canonical item JSON
(`JIRA_DRAFT_STAGE_BYTES_MAX`, tens of thousands of ordinary backlog items, held in memory like a
report session, so far below what the process may safely hold). Past it the staging call is refused
whole — nothing is truncated, what was staged stays — with the closed reason `too-large`, a
body-free `atlassian.jira-draft` warning, and fixed guidance for the model
(`JIRA_DRAFT_TOO_LARGE_GUIDANCE`): tell the user in plain language that the backlog is too big to
approve in one piece, that the items already written are saved, and offer to split the rest into
several drafts (for example one per epic), each approved on its own. A count limit must not return
under another name. The earlier ceilings of 32 items (the journal's per-turn bound on single
writes) and of 500 items are superseded.

*Paged drafts.* One model call cannot carry hundreds of items, and the model's output is bounded,
so a large draft is written in pages through `jira.draft-stage`, a read-class tool (row 21: it
changes nothing in Jira, so it needs the Chat's read grant, not a write approval). Each call
appends at most 50 validated items to a server-held draft session — in memory only, bound to the
Chat that started it, expiring when idle, and bounded per Chat and in total, exactly like a
`jira.report` session — and returns its `draftId`, the `draftDigest` of the exact item list, the
item count and the `unresolvedRefs` still to be written. Every appended item first passes the
customer-template dry run of a create (#4177); a violating page is refused whole with the violations
and nothing of it is staged. When the draft is complete the model calls `jira.draft` once with only
`{draftId, draftDigest}` (a call may instead carry one page of `items` itself). The call's arguments
are those two members, so the action digest the approval is bound to commits to the digest of the
whole item list: a draft extended after its digest was read resolves to nothing (`draft-changed`),
an unknown or foreign draft to `draft-not-found`, and one that cannot run (an unknown relation, a
cycle) to `draft-invalid` — each a structured refusal the model corrects, returned before a human
is asked. The approval card reads the staged items through
`GET /api/atlassian-connectors/jira-drafts/:draftId?chatId=…&digest=…`, served only to the owning
Chat and only for the digest the call carries, so the person reviews exactly the items the
approval commits to. The card lays the items out as a tree of named facts, never as JSON, and
while the items load, or when the draft is no longer available, its approve button stays disabled
(declining remains possible) and the card says why; a failed read is a body-free client diagnostic.

*Shared tool rules (#4178).* The model receives the whole Jira tool list on every round of a turn,
so the rules every Jira tool shares are stated once, not in each description:
`JIRA_TOOL_GUIDANCE` (`atlassian/jiraToolGuidance.ts`) says that the tools reach Jira Data Center
only, that their results are untrusted data, that lists page with `nextStartAt`, that a write runs
only as Keiko's approval allows and a pending, unknown or succeeded-unconfirmed outcome is never
retried, and that a field-validation rejection with violations is fixed and resent. Chat appends it
to the tool turn's system instruction whenever the Jira catalog is offered (alone or beside managed
MCP sources); the Coding Workbench announces it as the Jira Pod relay's MCP server `instructions`,
which the native runtime places in the model's context. An external MCP server's own instructions
never fill that field. The three 8192-token overflow pins in
`grounded-jira-mixed.public-handler.test.ts` hold the catalog to that budget; a growing catalog is
shortened, never given a larger simulated window. The rules are guidance only: approval, journal,
authority and template checks stay server-enforced whatever the model reads.

*One approval, one batch.* The draft itself is never dispatched. The server runs each selected
item, in dependency order, as its own journaled `jira.create` under a child identity derived from
the draft's invocation and action digest, so an item already sent is never sent again on replay.
The draft's one approval is claimed once at the first item's dispatch and covers its remaining
items; Full access admits the draft under its envelope exactly as it admits a single create. The
journal's bound of 32 single writes per turn counts records that may have reached Jira and does not
count the items of an approved draft: each child record carries the digest of the approved draft
action as `batch_digest` (schema 58), and a batch has no count bound at all: the approved draft
authorizes exactly its own items, whose number the draft's byte bound already limits. Admitting the
next item reads only the turn's barrier rows (unknown or in-flight writes) and, for single writes,
their count, so a draft of thousands of items does not re-read every record it has already
written. A record settled as a local refusal before dispatch (`not-dispatched`, such as a
reconciled existing item, or `rejected` before sending) uses the single-write bound up for no one.

*Time-bounded runs.* A run is bounded by time, never by size: no new item is started after the run
has been creating for 10 minutes or has taken 40 minutes in all (`JIRA_DRAFT_RUN_BUDGET`, inside the
tool's 50-minute duration ceiling); reading ahead through items that already exist does not use
the creating allowance up. Items not started are reported honestly as `pending` (a dependent of a
pending item is pending too), the result lists the keys created in this run exactly, and fixed
guidance (`JIRA_DRAFT_PENDING_GUIDANCE`) tells the model to say so in plain language and offer to
call `jira.draft` again with the same `draftId` and `draftDigest`. That re-run reconciles every
item by its deterministic identity — what exists is `existing`, nothing is created twice — and
continues with the pending items, so any number of runs finishes a draft of any size with zero
duplicates. The Activity Log records `phase=progress` (every 100 attempted items) and
`phase=executed` on `atlassian.jira-draft` with the settled and pending counts and the duration,
never an item, key or ref.

*Compact results.* The tool result is bounded by the catalog (256 KiB, 1,000 rows,
`JIRA_DRAFT_RESULT_ROWS_MAX`), which bounds the report, not the draft. A draft whose item rows fit
150 KiB is reported item by item as before. A larger one is reported compactly (`compact: true`):
one row for each item that needs attention (failed, uncertain, skipped, pending), the created and
the reconciled issues as exact key ranges (`createdRanges`, `existingRanges`, such as
`SYN-3..SYN-940`, one entry for every consecutive run), and the counts for everything else; rows
that did not fit are counted in `omittedRowCount`, and `rangesTruncated` is set if the ranges
themselves did not fit. The model-history receipts and the partial answer of an ended turn read
the same ranges, so created keys are never lost to compaction. Barriers are unchanged: an `unknown` or
`succeeded-unconfirmed` record or an in-flight write blocks every further write of the turn, batch
or not, so an uncertain item still stops the draft (#2953).

*Deselection.* The approving human may deselect items; the deselection is bound into the approval
proof and extends to every item that depends on a deselected one. The stored approval view carries
it as `excludedItemRefs` (a subset of the draft, so no count of its own), and the transcript store admits exactly one
change besides the state: the pending-to-approved transition of a `jira.draft` may add a non-empty,
unique subset of the reviewed draft's own item refs. Every other difference still conflicts:
another operation, a deselection added at any other transition or on a first save, and a
deselection that is dropped or changed after it was recorded. The approval registry enforces the
subset rule before any state changes, against the draft's item refs recorded privately on the
pending entry (resolved from the staged draft the call names), so a decision naming unknown or
repeated refs is refused (409, logged as an invalid write-approval) and the registry and transcript
stay pending together. A transcript whose call names a staged draft carries no items, so its
store-level check is the form of the deselection (unique, valid refs); the
registry's subset rule is what binds it to the reviewed items. The action digest and subject
identity checks are unchanged. The tool's `maxResultCount` is the catalog's row ceiling
(`JIRA_DRAFT_RESULT_ROWS_MAX`), see compact results. Before creating an item the connector searches by a
deterministic identity label
(`keiko-draft-<20 hex>` from project, issue type, normalized summary and the item's relation
scope — its parent field and target, and its links, each resolved to the existing issue's key or to
the target draft item's own identity, never to the draft-local `ref`; items identical in all of that
are told apart by their order of occurrence — so two same-summary tasks under different parents are
two issues). When the create screen offers no labels, the exact summary plus the resolved parent key
is the identity; links and order of occurrence are invisible to that search, so items of one draft
that share project, issue type, summary and parent are refused as a `conflict` before any request
instead of being merged into one issue. The search reads every candidate page (50 per page, at most 10 pages): one match is
reconciled without a write, but only complete when the issue also carries the item's requested
links, read back and never written again (a missing one is a refusal that names the issue and the
links still missing, so a rerun after a failed further link cannot pass as done), several are refused as a conflict, and a candidate set that cannot be
read completely is refused as `bounds-exceeded` instead of creating a possible duplicate. A draft
whose items all exist (or were deselected, at least one existing) writes nothing and reports
`not-dispatched`; its result then carries `JIRA_DRAFT_EXISTING_GUIDANCE`, which tells the model that
nothing is missing and not to create the issues again with `jira.create` — the lab's S19 rerun showed
a model reading the bare outcome as a failure and creating duplicates one by one. A draft that Jira
refused only in part carries `JIRA_DRAFT_PARTLY_REJECTED_GUIDANCE` instead of the single-write "nothing
was changed": it names the items now in Jira and scopes the correction to the refused ones. Absence
requires consistent evidence: every page must state the `startAt` that was requested and a page size
and total that are counts, may not hold more issues than its page size or the total, may not be
empty while the total is not reached, and every candidate must carry a safe key and a numeric id.
A page that fails any of this, or a candidate without those identities, is refused as
`malformed-payload` before any write, never read as "no match". A replayed
item keeps its journal outcome: a created item and a reconciled (`existing`) item both recover their
key through the same read-only lookup, so dependents resolve without resending any mutation. The
draft call is an error only when an item did not settle (`failed`, `uncertain`, `skipped`,
`pending`); when
every item is created, already existing or deselected it succeeds, and a draft that wrote nothing
reports the truthful `not-dispatched` outcome. An item whose parent or linked item has no key is
skipped; an item whose outcome is uncertain stops the draft, because the journal admits no further
write in that turn, while an item Jira refused with its own error document is `failed` with the
field errors and the independent items go on. Coding runs do not offer `jira.draft`.

*Evidence.* `atlassian.jira-draft` records, body-free, each staged page (`phase=staged`: page item
count, item count, page count, canonical bytes, unresolved relation count), each submission to
approval (`phase=submitted`) and each refusal with its closed reason (`invalid-input`,
`draft-not-found`, `connection-changed`, `duplicate-ref`, `too-many-items`, `too-large`,
`template-violation`, `draft-changed`, `draft-invalid`) at warn. It never carries an item, a
summary, a ref, a key or the draft id.

**Nested drafts and refusals that say how to correct (S09 of epic #4173, 2026-11-01).** A draft
holds a parent chain of any depth in one call: an epic, a task whose `parent` names the epic by
`ref` and `fieldId` (the relation field the task's create metadata names), and sub-tasks whose
`parent` names the task, each created once its parent has a key. The relation field always comes
from create metadata; no field or application name is built in. A weaker local model must be able to
do this in one turn, so three things were made explicit. (1) The tool descriptions say how to nest
(`jira.draft`'s `parent`, `projectId` and `issueTypeId` name their sources; `jira.create` points a
child of a not-yet-existing parent, and any second issue, to `jira.draft`). `jira.create` accepts a
`project` or `issuetype` inside `fields` only when it repeats `projectId` or `issueTypeId`
exactly (`{ "id": <same id> }`); it is then dropped, because it asks for the same issue (lab S07
of epic #4173: Qwen repeated both and got four unexplained refusals). Any other value would
override the routing, so it is refused before any request. The refusal names the field, is
`invalid-field`, and says to send the change without it. The same holds for every argument Keiko
refuses before a request on `jira.create`, `jira.edit`, `jira.transition`, `jira.assign`,
`jira.comment`, `jira.attach` and a draft item: the refusal names the argument (an unknown one by the
call's accepted list), carries the closed `JiraFieldValidationFailure`, and one bounded sentence on
how to send it again, ending "Nothing was changed." A bare `field-validation` is no longer
returned for a malformed argument. The refusal reaches only the model, never the Activity Log. (2) A draft refused before any request returns
a fixed `guidance` sentence from a closed vocabulary (`JiraDraftProblem`: draft shape, missing items,
a malformed item ref, id, fields, parent, link or requirement list, a duplicate,
self or unknown ref, a cycle) with the 1-based item position where one item is at fault, ending in
"Nothing was changed"; it never echoes the model's own text, so the refusal is no longer the opaque
`field-validation` with an empty item list. (3) A `skipped` item names `blockedBy`, the refs it
waited for that have no key, so the model sees which parent failed rather than a bare state. The
Chat tool turn also asks the gateway for its one steered answer repair on every round
(`answerRepair: "steered"`, ADR-0003): the S09 turn ended `model-failure` because Qwen ended a
round after reasoning, with three metadata reads settled and no write; the repair is bounded by the
turn's own model-call envelope and logs as `gateway.retry.scheduled` with
`reason=empty-answer-repair`.
When the turn also carries connected sources (Pod or folder evidence with Jira tools), the
grounded synthesis grant (two attempt slots, one input and output token grant) used to charge the
exhausted round to that grant and then refused the repair before any HTTP dispatch
(`GATEWAY_ATTEMPT_ADMISSION_DENIED`, `authority-denied`, HTTP 502; S14 of epic #4173). The gateway
now announces every correction to the caller admission (`attemptAdmission` input
`correctsUnusableAttempt: true`, once per steered repair or tool-schema correction, never on a
provider retry of it, never on a call that did not ask for one). The grounded attempt tracker then
moves the preceding unusable attempt (an exhausted round, or a tool call rejected before execution)
out of the synthesis grant into tool-round orchestration, exactly as a confirmed tool round: its usage
stays in the reported total and the turn's Authority Envelope (`maxModelCalls`, prompt budget) still
bounds and counts the correction. The correction itself is admitted against the grant like any
attempt, so there is still exactly one steered repair per call, the gateway's schema-repair allowance
is unchanged, and a further unusable answer fails closed. Schema corrections joined this path on
2026-11-01: the lab showed a Pod-sourced turn whose second schema correction was refused
(`GATEWAY_ATTEMPT_ADMISSION_DENIED`) and logged as `invalid-shape`; a refused correction now logs
its actual cause.
A tool call the gateway rejects again after its own correction no longer ends the turn as a model
failure (S08 of epic #4173: Gemma's second `jira.create` without `links[].type` left the human a
dead end). The Chat tool turn sends one further round carrying the same body-free correction, and
announces it to the caller admission as a correction. The allowance is once per streak: a round
that dispatches a tool call restores it, and a second rejection without progress ends the turn with
its transcript answer as before. Every round stays inside the Authority Envelope's model-call and
prompt budget, the rejected call executed nothing, and a later synthesis pass of the same turn never
inherits the correction. `chat.tool-turn.corrected` records each such round with the turn's settled
exchange count.

**Customer-defined issue templates (#4177, 2026-10-31).** A project lead defines what each issue
type must look like and where in the workflow that applies; Keiko enforces it deterministically
before every Jira write, so a Markdown skill's advice the model may ignore is no longer the only
means. This adds no connector scope, action row or approval class: it is a precondition of the
existing `create-issue`, `update-issue-fields` and `transition-issue` rows, and it holds in every
autonomy mode, Full access included, because it sits in front of the Jira request rather than in
the approval.

- **Storage reuses the private Markdown skill library** (`markdown_skills` revisions, the
  `/api/skills` routes, import and export). A template is a skill whose front matter declares
  `keiko: jira-issue-template`; there is no second store, table or migration. Import and replace
  parse the document strictly and refuse a malformed template with closed error codes, key names and
  line numbers (never document text). One predicate (`isJiraIssueTemplateDocument`: the marker line
  inside a front matter at the very top, with any spacing or quotes around the value) decides what is
  listed and enforced; the storage prefilter is only a superset of it. A document that carries the
  marker line outside fenced code but has no such front matter (a leading blank line, a second
  block) is refused on upload instead of being stored as an ordinary skill that enforces nothing.
  A stored template that no longer parses fails closed (`template-unreadable`), and the model-facing
  violation names the skill to repair (never the activity log).
- **Template format** (`keiko-contracts` `jira-issue-template.ts`, exported through
  `runtime/atlassian-connectors`): flat front matter with `project`, `issueType` (name or numeric id),
  `activateOn` (`create`, `edit`, `transition`, or `transition:<transition name, id or target
  status>` for a definition of ready), `summaryMinLength`/`summaryMaxLength`/`summaryPattern`,
  `requiredFields` (instance field ids or names; a field is present when its value has any content,
  not only a name, key or id: a time-tracking estimate counts), `requiredLabels`/`labelPattern`/`minLabels`,
  `parentField` (an instance field) and `parentLink` (a link type), `optionalSections`. The
  level-2 headings of the template body (`## Title`, or a setext title underlined with `---`) are
  the required description sections, each of which must be present and carry content. One reader
  (`jira-description-sections.ts`) takes headings from the template body and from an issue's
  description alike: ATX, setext (three or more `=` or `-`) and Jira wiki (`h2.`) headings, none
  inside fenced code (``` and ~~~ fences, `{code}` and `{noformat}`), none on a line over 512
  characters, none matched by a backtracking expression. A deeper heading belongs to the enclosing
  section, so a section made only of subsections has content; a section ends at the next heading of
  the same or a shallower level. Patterns use a closed regular-expression subset (literals,
  classes, `. ^ $ \b \B`, `\d \w \s` and their negations, escapes, alternation, groups, greedy
  and lazy quantifiers, brace counts `{n}`, `{n,}` and `{n,m}` of any width up to the program
  bound, a larger count being refused instead of read as literal text; no lookaround, back-reference, named group, quantified assertion, or
  quantified group holding a quantifier or alternation). They are never handed to `RegExp`: the one
  parser validates a pattern and compiles it to an automaton program (bounded to 4096
  instructions) that is simulated in time proportional to input times program, so no pattern can
  backtrack and an accepted pattern is always matchable. Matched text is at most 255 characters.
- **One pure checker** (`keiko-connectors` `jira-issue-template-check.ts`) judges the state after
  the write: the proposed values merged over the issue's current values, resolved against the
  instance's field names. For an edit and for a transition the whole merged state is checked, not
  only the changed fields, so an issue that already violates a template is refused on its next
  edit until the edit also repairs it. A transition whose template names a transition or target
  status that Jira's metadata does not name fails closed instead of passing unchecked. Write admission, the backlog draft and the compliance report share it. It
  is deterministic, performs no I/O and emits closed rule ids (`summary-too-short`,
  `section-missing`, `field-missing`, `field-unavailable`, `label-missing`, `parent-missing`, ...)
  with a short subject and the `PROJECT/Issue type` label.
- **Enforcement points.** (1) The gate (`jira-managed-template-gate.ts`) runs inside the managed
  mutation executor for `jira.create`, `jira.edit`, `jira.transition` and every `jira.draft` item
  (each a journaled `jira.create`), after field validation and before the POST or PUT. It is shared
  by Chat and by Coding runs with a Jira Pod, in every autonomy mode. A violating write is never
  sent; the journal records it as `rejected` and the model receives `outcome: rejected`,
  `reason: field-validation` and the bounded `violations` list, with tool guidance to correct
  exactly those violations. A source that throws propagates to the executor's correlated
  diagnostic, so the write is still not sent. When no template governs the write, no request is
  added. Jira takes one `issuelinks` operation per request, so a `parentLink` rule is judged on the
  link that rides on the create or edit itself, never on one written afterwards: the gate puts a link
  of a required type first, and a state that the primary write cannot make conforming is refused
  before any request. (2) In Ask-for-approval and Supervised modes Chat additionally runs the same pipeline as a
  dry run (`checkJiraManagedMutationTemplates`) after read consent and before the write approval
  is created, so a human is never asked to approve a draft that would be refused. A failed dry run
  is recorded and falls through to the gate. Every item of a backlog draft is dry-run when it is
  staged (`jira.draft-stage`) and again before the draft's approval, staged or inline, with the
  relations the item proposes (a link to another draft item stands in as a placeholder key): a draft
  with a violating item is refused with that item's ref and violations before a human is asked, and
  the gate still refuses each item individually at dispatch. Assignment (`jira.assign`) changes the
  `assignee` field and is dry-run and gated as an edit of that field.
- **Settings surface.** `GET /api/skills/jira-templates` lists templates; `POST
  /api/skills/jira-templates/validate` validates a template against the live instance through a
  Pod the caller owns (unknown project, issue type, field, ambiguous field name, link type or
  transition target); `POST /api/skills/jira-templates/propose` drafts one template per issue type
  of an existing project from its create metadata and the description headings most sampled issues
  share. Both read Jira with GET only and never write to Jira or the library; the lead edits and
  saves what is proposed through the skill routes.
- **Evidence.** `jira.template.admission` (warn, stage `pre-approval` or `dispatch`) records the
  operation, the violation count and the closed rule ids under the write's correlation id. It
  never records a field name, section title, label or value; `ruleIds` is a closed vocabulary and
  the registration is pinned to the contract's `JIRA_TEMPLATE_RULE_IDS` by a test. The skill
  library lines gain the actions `jira-template-list`, `-validate` and `-propose`.
- **Scope.** Comments carry no field state and are not governed; an assignment is an edit of the
  `assignee` field and is. Organization-wide
  distribution is the skill library's import and export. No fixed hierarchy or issue model is
  built in.

**Deterministic project report (#4181, 2026-10-31).** `jira.report` is a tenth read tool (low risk,
`issue-tracker.read`) and the one place where Keiko, not the model, produces project numbers. For a
project (`projectKey`), a JQL scope (`jql`) or both, the connector pages Jira's search to
completion itself and computes, as plain arithmetic over what it read: issues per status category
and per issue type and status name, own estimates (`timeoriginalestimate` seconds, or a numeric
field the caller names) done/total/remaining, unassigned and overdue open issues, progress per
container (an epic, or any root issue holding non-sub-task work; hierarchy comes from `parent`,
from app-defined fields the instance lists with an opaque value shape — schema type `any`, a custom
type, no Jira system role — whose values are issue keys on the issues read, or from caller-named
`parentFieldIds`; no field id, app or plugin type key is ever named in code, so an instance whose
hierarchy app uses other type keys reads identically. Every candidate is read: there is no cap on
their number, and a field list too long for one request is split across requests of at most 4000
characters of field ids, merged by issue key. After a page, a discovered field whose values were
free text or objects besides an issue key — or never an issue key — is no longer requested and
takes back the parents it proposed, because a parent field holds issue keys everywhere or nowhere
and an app's business field that mentions an issue is no hierarchy; the field metadata cannot state
a field's role without naming an app, so a caller who knows the field names it in `parentFieldIds`
and that mapping is never narrowed, and so a crowded instance converges to its few real parent
fields; a field that stayed empty is kept), epics without members (a container is an
issue of a type that holds work for another issue and is never held itself, so an empty epic is
found without reading an Epic Name field; a scope in which nothing holds work — only new empty
epics, or a JQL that leaves out their children — cannot tell a container from a standalone issue,
and the report states that as `coverage.containerRoles: unobserved` instead of listing no empty
epic), issues without an
epic or parent (orphans; an issue link rescues an issue only when it reaches a container), the
fields the instance requires on create per issue type from current create metadata (rule
`required-field-empty`; project scope only), the deviations of the shared template checker when
one is active (`UiHandlerDeps.jiraReportChecker`, #4177; the report asks for the checker's fields
in the same reads and never interprets a template; the Jira connection's template source — the
one the write gate reads — builds the checker, so the report and the gate cannot disagree. The
report judges each issue as the state its next edit would leave. The templates that define an
issue's structure apply, which are those activated on `create` or on `edit`: the template the
product itself proposes is activated on create only, and a lead who evaluates existing issues
against it expects the issues that predate it to be named (lab S11, 2026-11-01; this amends the
earlier rule that only edit templates apply, so the report is a superset of the edit gate for a
create-only template and names an existing violation without blocking any write). A template
activated only on a transition is a definition of ready for that step and never applies to the
report. Each deviation also carries the template element it concerns (`details`, `ruleId: subject`
such as `section-missing: Abgrenzung`; a field is named by the instance's own field name), taken
from the template and never from an issue's text; an unreadable library, or a name that cannot be resolved because the instance's
field list was not read, makes the report incomplete with reason `template-unreadable` and
compliance `checker: unavailable` instead of zero deviations), and coverage of declared `requirementIds`
(a requirement is covered by an issue naming its identifier in summary, labels or description;
items traced through the covering issue's descendants and, for a container, its linked issues).
`requirementsFromPods: true` makes Keiko list the explicit requirement identifiers of the Chat's
Knowledge Pods itself (the read `knowledge.requirements` serves; derived handles are left out because
no issue can name them) and merge them with any `requirementIds` the model named, so a model with a
small window never copies dozens of identifiers into a call. A Chat without a readable list, a Pod
that is not ready, a cut list or more than 1000 identifiers is refused as
`requirements-unavailable` with a plain-words `message` that names the fix (pass `requirementIds`
yourself); no report is started.
The model supplies scope and options only and narrates the result; the digest of the report
excludes read timing so the same Jira data always yields the same digest.

Estimates are seconds of original time estimate unless the caller names a numeric field
(`estimateFieldId`), whose own unit applies; the report, its exports and the tool description state
the unit. Overdue is judged on an explicit UTC date (`asOf`, default the day of the first call),
recorded in the report and in the digest, which also covers a hash of every export row. Lists sort
by Unicode code point, never by locale.

A read is never silently partial and no absence is read as a value. A search page counts only with
Jira's own pagination coordinates (a non-negative integer `total`, a `startAt` equal to the offset
asked, no more issues than the total leaves); otherwise the read ends `read-failed` with failure
`malformed-payload`. A hit that leaves out a field the report requested (the assignee, a field
required on create) ends it `read-failed` with failure `permission`: Jira states a missing value as
`null`, so an omitted field is evidence the account could not read. A create-metadata page ends its
collection only by `isLast` or a reached total; an empty page without either is malformed. A rule's
count is the number of issues that break it, once each, however many fields or template elements
they break (`deviationCount` counts every deviation). Labels are kept whole: the trace and the
requirement identifiers are read from them and the memory budget below charges each one. The page size adapts to the 256 KiB transport cap (a truncated
body halves it; a single issue that still does not fit ends the read as `issue-too-large`); the
result of a call is `reading` (with `issuesRead`/`issuesTotal` progress and `reportId`, to be
called again), `complete`, or `incomplete` with a closed reason (`read-failed`, `scope-changed` —
the total moved, an issue repeated, or the page that starts at the last issue read did not begin with it (that start proves nothing was inserted or removed before the cursor) —, `memory-budget`, `issue-too-large`,
`template-unreadable` — the compliance section was not evaluated). Each call
reads for at most 15 s because the managed host caps a call at 30 s; there is no issue-count limit.
Hierarchy discovery and the create-metadata rules are fetched before the first page; when either
cannot be read the next call asks again and a second failure ends the report as `incomplete`
(`read-failed`), never as a complete one with silently missing rules. A failure carries a closed
word (`invalid-jql`, `auth`, `permission`, `not-found`, `rate-limited`, `timeout`, `unavailable`,
`malformed-payload`, `bounds-exceeded`) beside the reason. A caller clause must have balanced
parentheses outside quoted strings and, without a `projectKey`, must contain more than ordering, so
it can neither escape the project scope nor read the whole instance. Reports live in memory only,
bound to the Chat (or, for a Coding run, the Pod binding) that started them and to the Jira
instance and credential identity they were started with (a resume against another is refused as
`connection-changed`). They expire after four idle hours (an export does not renew that), one owner
keeps at most four and the owner holding the most is trimmed first beyond the shared byte budget, so
one Chat cannot push out another's reports. One report may hold 192 MiB of derived records, charged
at a realistic per-issue cost that includes the build peak; beyond it the read ends as
`memory-budget`. Tool results cap every per-requirement and per-epic list at 25 entries with its
true total beside it; the exports carry everything. The CSV starts with a byte order mark so a
spreadsheet reads it as UTF-8; the Markdown escapes every Markdown and HTML metacharacter in Jira
text and collapses line breaks. The bounded result carries the summary
(15 entries per list), `reportId` and `figures`: every count per issue type and status, every
container's issues and done issues, and the estimate totals (with hours beside the seconds of the
default estimate) as plain `;`-separated lines derived from the computed report, so a model that
quotes a line states exactly what the report holds instead of reshaping JSON (lab S10, #4181 AC2; a
list beyond 300 lines says how many it left out); the full lists are paged through `section` (`statuses`,
`epics`, `deviations`, `orphans`, `uncovered`, `requirements`) and `section: "comment"` returns the
exact numbers-and-keys text for `jira.comment`, so posting the report stays a normal approved write.
A new report may name the `section` (with `startAt`/`maxResults`) it wants; once the report
completes in that call the page is returned with the `reportId`, otherwise the call reports
`reading` as before. Every section page also carries `report` with only the report's identity:
`digest`, `generatedAt` and `completeness`. A model that asks for the comment on its first call
never sees the summary (lab S13 of epic #4173, 2026-11-01), yet the posted text must still be
traceable to one report version and its exports, and an incomplete report must remain visible. An `invalid-input` refusal lists `invalidArguments`: the argument names to fix
(unknown or invalid ones, or `jql`/`projectKey` when a new report names no scope), never their
values, so the model can correct the call instead of abandoning the report (lab S10/S11, #4181).
Because a weaker model picks the wrong tool when its description is the only steering (lab S11/S12:
45 `jira.issue` reads and no report), the tool description opens with the questions it answers, the
descriptions of `jira.search` and `jira.issue` point to it, and the grounded tool-turn guidance names
it for progress, template compliance and requirement coverage across a project.
`GET /api/atlassian-connectors/jira-reports/:reportId/export?chatId=…&format=markdown|csv`
renders the stored report (the model's prose is never the source) for the browser's own download;
CSV neutralizes spreadsheet formulas. Evidence is `atlassian.jira-report` (phase, status, closed
reason, scope kind, counts including `invalidArgumentCount` on a refusal, how the parent relation
was found — `hierarchyDiscovery` `complete|unavailable`, `hierarchyFieldCount` candidates and
`hierarchyObservedFieldCount` fields that held a parent, `hierarchyRejectedFieldCount` fields shown
to hold none — and rule ids; never scope text, keys, summaries or report content) beside
the existing `atlassian.action.outcome` line for the call.

**Template coverage and list continuation (#4181, 2026-11-01).** "No deviation" only describes an
issue something judged. The template checker therefore also reports whether at least one template
of the issue's project and issue type applies (`covers`, the same matching as the write gate), and
the report's compliance counts `issuesChecked` as the issues a template judged when the checker is
`applied`, with `issuesWithoutTemplate` and `withoutTemplateByType` (largest first, then by name)
for the rest, so a lab project whose Bugs and Sub-tasks have no template no longer reads as
181 compliant issues. With `none` every issue is without a template and `issuesChecked` is the
issues read (only required-field rules could have judged them); with `unavailable` coverage is not
told (0 and an empty list) and the report is incomplete. The per-issue flag `templateJudged`, the
two counts, the Markdown export and the Jira comment text carry this, and the digest covers it. A
summary list cut at 15 entries (or 60 statuses) now names its `section` and `nextStartAt`, the
offset `jiraReportSectionPage` continues from, instead of leaving a weaker model to guess (lab S11:
an answer after 40 of 46 deviating issues). Lists shown whole carry neither; caps are unchanged.

**Complete, traceable requirement derivation (#4179, 2026-10-31).** Grounded Q&A keeps its ranked
excerpts for ordinary questions, so a request for _all_ requirements of a specification would
silently miss some. No keyword rule decides when that matters: the model asks for the full list
through a deterministic read tool, `knowledge.requirements`, hosted by the existing governed Chat
tool catalog (the `jira-chat` profile) next to the Jira reads. The tool reuses the catalog's schema
admission, call budget, cancellation, transcript reservation and continuation fitting; it adds no
retrieval, citation or tool subsystem. Because the catalog is the Jira catalog, the tool is offered
to a Chat that has a Jira binding; Knowledge-only, folder and hybrid Chats are unchanged. The
model learns that it needs the tool from two facts, never from a keyword rule on the question. The
grounded tool-turn guidance states that the supplied evidence is ranked excerpts and that a task
covering every item of a document reads them all with an offered tool. When the Chat's Pods hold
more detected requirements than the sent excerpts mention, one more sentence names both counts and
the tool; the per-turn inventory read is the one the tool reuses. The live lab showed why: with the
guidance alone, a model still listed 13 of 41 requirements from the excerpts; with the counts it
paged the tool and listed 41 of 41. `chat.grounded-tool-round.completed` records both counts
(`requirementUnitCount`, `excerptRequirementCount`). The guidance replaces redundant wording, so the
mixed Jira/Data overflow pin keeps its budget. An answer built from tool results carries no excerpt
markers; the optional citation repair runs only while a synthesis attempt slot is free and otherwise
keeps the completed answer instead of failing the turn.

- _Authority._ The tool is a read: the current Chat authority admits it, exactly as it admits a
  grounded answer over an attached Knowledge Pod. No Jira read grant or consent is involved, and
  the tool never reaches Jira. The scope is the Chat's attached Pods (plural scope list first);
  indexing, stale, error, not-ready and policy-denied Pods are refused with a closed reason, as a
  grounded answer would refuse them. Document text is redacted with the Chat content policy before
  it reaches the model.
- _Inventory._ `keiko-quality-intelligence` derives, deterministically and without a model, the
  requirement units of each document in document order: identifier, title, priority, acceptance
  criteria (`<id>/AC<n>`), section path, source span, closed quality findings and a content digest
  of the normalized content only (no location, format or inventory version). The digest covers the
  complete statement and every criterion; the 4,000-character clip is presentation only, so a
  change after it still moves the digest and the revision label. A statement key (`Anforderung:`,
  `Description:`, ...) and the middle dot a slide uses to join the fields of a record on one line
  are presentation, not content, so a conversion of the same specification keeps its digests.
  An explicit identifier
  follows `[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)*-?\d+` (`LH-001`, `R-12`, `REQ-FUNC-001`, `REQ_003`);
  technical tokens (`HTTP-2`, `AES-256`, `ISO-27001`, `UTF-8`, `SHA-256`, `TLS-1`, ...) are reserved
  data, not requirements. Candidates are headings, strong lines (bracketed, separated), table rows
  with an id/statement/priority column, rows of a workbook extraction (`Sheet!2: ID=FR-1 | Titel=Foo`,
  identifier in the first column, the lines of a multi-line cell read as separate criteria), and, in
  HTML and slides, recorded section headings; a
  heading needs a body or a second identifier of its prefix. Priority, criteria, metadata keys and
  modal verbs are data in several languages (DE, EN, FR, ES, IT) and extensible through the
  vocabulary, never code branches. A definition with a body wins over a table-of-contents mention of
  the same identifier; two different bodies under one identifier in one document are reported as
  conflicting, never merged. Blocks end at the next heading or blank line, wrapped paragraphs are
  merged, and an extractor-flattened HTML block is read from its inline keys. A statement with a
  modal verb and no identifier gets `DRV-<8 letters>`, the SHA-256 of the document identity and the
  normalized statement (plus an occurrence index for exact repeats), so it survives insertion and
  renumbering and is not shared between documents. The same specification yields the same
  identifiers, titles, priorities, criteria and digests from Markdown, plain text, HTML, Word,
  PowerPoint, PDF (one extracted line per statement line) and Excel extraction
  (`requirement-inventory-formats.integration`); PDF line wrapping is only as stable as its
  extracted lines. Scanned documents (OCR) are not read. The result is a set of
  _detected units_, never claimed to be complete: the detector can miss or over-read, and says so.
- _Reading._ The tool takes `{ view?, documents?, query?, ids?, priorities?, cursor?, limit?, reportId?, projectKey? }`.
  Units are paged in document order under an item bound (25, at most 50) and a byte bound (24,000
  bytes) that fit a 32k-token model; statements, criteria and findings are clipped, never silently
  dropped. Every page states honest totals: detected and matched units, documents scanned,
  documents not text-extracted, documents and units omitted by the collection bounds (64 documents,
  4M characters per document, 16M in total, 5,000 units), the cut reasons and a cursor until the
  last page. The whole result, totals and cursor included, stays within the descriptor's byte bound:
  one unit is rendered within 12,000 UTF-8 bytes (its character caps shrink together, flagged by
  `statementTruncated` / `criteriaTruncated`), and a page budgets its items against the rest of the
  result. A cursor binds the selection and the document revisions it was issued for (the `documents`
  view binds the ordered document scopes and revisions); a changed selection, order or document
  answers `cursor-stale` instead of skipping or repeating units. Within one turn, later pages and
  the trace reuse the first read only while the resolved Pods are unchanged and still pass the
  lifecycle and model-use floor; a Pod made stale or sealed meanwhile is refused as in a new turn. The
  `documents` view lists the documents read; `change-queries` returns label-only JQL batches. When a
  tool result is later compacted, the receipt keeps each unit's scoped reference, title and
  priority so the model can still list or reference units it has read.
- _Identity and traceability._ A unit is referenced as `<documentScope>:<id>` (the first eight hex
  digits of the SHA-256 of the document identity) or, when unique, by its plain identifier. An
  identifier defined in several documents is reported as ambiguous and must be referenced with its
  scope; the last definition never wins. An identifier one document defines twice with different
  content has no single definition: a reference to it is refused as ambiguous, scoped or not.
  `jira.create`, `jira.edit` and each `jira.draft` item take
  an explicit `requirementIds` list (at most 8); a consumer with no resolver for it (a Coding run)
  has the connector refuse the list with the field named, instead of writing the issue untraced. The server validates every reference before
  anything is sent; an unknown, ambiguous or malformed reference, or unreadable Pods, refuses the
  call (the whole draft) with the closed reason and the offending references. Nothing is read from
  summaries, labels or descriptions. A valid reference adds the labels `keiko-requirement`,
  `keiko-doc-<scope>`, `keiko-req-<id>`, `keiko-rev-<12 hex of the content digest>` (and
  `keiko-ac-<id>-AC<n>`) and a plain-text footer `----` / `Keiko traceability` with the source
  location, the document and requirement digests and the closed finding codes, closed by the line
  `End of Keiko traceability`. The footer passes the Chat content redactor and is neutralized for
  Jira wiki markup. On create the connector applies them only where the create screen offers the
  fields; on edit it reads the issue, replaces `keiko-rev-*` and rewrites the footer in place: only
  the block from its start line to its end line is replaced, so the human text before and after it
  is kept, and a start without an end line is not an owned block. A description the read did not
  return is unavailable evidence (an explicit `null` is empty), so the footer is not written over
  it and `footerApplied` says so. The caller's own label intent (a replacement set or add/remove
  updates) is applied first and the trace merged into the one legal field mutation, so it neither
  conflicts with it nor removes trace labels the caller's set left out. What the instance dropped is returned in the tool
  result as `trace {labelsApplied, footerApplied, droppedLabels}` and counted on the log. The item
  identity, the journal and the approval are unaffected; `jira.draft` keeps its byte bound and no item-count limit.
  The traced labels and footer are part of the item the customer-template gate (#4177) judges, so a
  template that governs `description` or `labels` sees the final values, not the model's draft; the
  pre-approval dry run of a create or edit judges the values as the model wrote them.
- _Change check._ A new document version is compared with the backlog through the labels alone;
  no earlier inventory is kept anywhere, so the baseline is what Jira holds. `change-queries`
  returns, per document, label-only JQL batches under the JQL length bound for items whose revision
  label is outdated (`stale`; one clause per requirement and its own current revision, so a current
  revision of one requirement never hides an outdated one on the same item), the traced set per
  document (`traced`) and, only where it fits the
  bound, items whose requirement is gone (`removed`). Running those queries and merging them is
  derivation a local model's output budget does not carry (lab S14: the comparison turn ran out of
  budget after two inventory reads), so the `changes` view returns the result. The model first reads
  the backlog with `jira.report` (scope of its choice, under the Chat's own Jira read grant) and then
  calls `{ view: "changes", projectKey }`. It needs no report id (lab S14, 2026-11-01: a local model
  that had to carry one from a second tool never asked for the view at all, read the units, searched
  Jira and compared by hand in a synthesis that ended at its 300-second limit; its tool description
  named the precondition last): without `reportId` the
  baseline is the Chat's newest finished report **of this turn** (of `projectKey`, case-insensitively,
  when given), and `reportId` names one deliberately. A report read in an earlier turn is not taken
  implicitly because the backlog may have been edited since; the refusal says so. The tool reads no
  Jira itself and accepts only a report of the same Chat, so it cannot widen the Chat's authority.
  Every refusal carries a `nextStep` sentence with the exact call to make: `report-required` (no
  report of this turn: call `jira.report` with the project and repeat until `finished`, then repeat
  this call), `report-reading` (a named report is still being read: continue it with its
  `reportId`), `report-not-found` (unknown or another Chat's: omit `reportId`). The tool description
  leads with this comparison and the two-call recipe. The report row now keeps the issue's labels (bounded: 64 labels of 255
  characters). `keiko-quality-intelligence` compares them with the current inventory, purely and
  without a model: per requirement of the current document, `changed` when an item that traces it
  (document label and requirement label) lacks the current `keiko-rev-*` label (an item naming the
  requirement without any revision label counts as outdated), `unchanged` when every such item has
  it, `untraced` when no item of the report traces it; per item requirement label whose document is
  still among the Pods but whose id that document no longer states, `removed`, provided that
  document's inventory is complete: a cut inventory (units beyond its bound) has not proved a
  deletion, so such ids are listed apart as `unverifiedRemoved` and are neither removed nor
  affected. An item of a
  document that is not in the Pods proves nothing and is only counted (`unmatchedIssueCount`). Each
  requirement of an item that traces several is judged on its own revision label. The result
  carries `baseline` (report complete, issues read and total, traced and unmatched item counts),
  exact `counts`, the changed requirements (id, title, outdated item keys), the removed ones (id,
  item keys), the unchanged and untraced ids and the `affectedIssues` (every item that traces a changed or
  removed requirement, Jira-key ordered), each list bounded (60, 60, 200, 200 and 120, and 10 item
  keys under one requirement with `issueCount` stating the rest) with the cut lists named in
  `truncated`; the lists shrink together until the whole object fits the descriptor's byte bound,
  the counts always staying exact; `baseline` also states when the report was generated. The honest limits: `untraced` means no item of the compared report
  traces the requirement, which is a new requirement or one not yet derived; the labels cannot tell
  them apart, so the tool never calls it "new". A report that is incomplete (`baseline.complete`
  false) cannot prove a requirement untraced, and the scope of the report is the scope of the
  comparison. `jira.report` runs on Jira Data Center; on Cloud the `change-queries` view remains.
  Edits are proposed as a backlog draft.
- _Quality._ The existing requirement-quality checks run over every unit and add the closed code
  `missing-acceptance-criteria`; the codes reach the tool result and the footer.
- _Evidence on the log._ `knowledge.requirements.read` records each call (view, closed disposition
  `served`/`refused`/`cursor-stale`/`unavailable`, whether a cursor was used, detected, matched and
  returned counts, documents scanned, not extracted and omitted, units omitted, result bytes, next
  page; the `changes` view adds the changed, removed, untraced, unchanged and affected-item counts,
  the traced baseline item count, whether the baseline report was complete, and the closed refusal
  `report-required`, `report-reading` or `report-not-found` and the closed `baselineSource`
  `explicit`/`turn`, never an identifier or key);
  `knowledge.requirement-trace.applied` records, per create, edit or draft, the traced,
  refused and problem counts and the labels, footers and dropped labels applied. Counts and closed
  words only.
- _Limits stated openly._ The tool is available only in a Chat with a Jira binding. The `removed`
  query is omitted when it would exceed the JQL bound. HTML flattening is a heuristic. PDF
  inventories depend on the extracted line structure. The detector is evaluated on the lab corpus
  and the unit tests, not proven complete.

**Risk-tier rationale (fixed here so #2244 does not have to invent it):** reads are uniformly `low`
— every read is non-mutating, trivially reversible (re-run the query), and bounded by D5/D3.
Additive, non-destructive writes with no lasting external side effect beyond their own content
(`add-issue-comment`, `add-page-comment`) are `low`. Bounded edits to an existing artifact's known
fields (`update-issue-fields`, `update-page`) are `medium` — they mutate existing state but cannot
create new externally-visible artifacts and, for Confluence, are protected by the existing
optimistic-version conflict check (#2244 Scope 4). Actions that create a new durable,
externally-visible artifact or change workflow state with side effects Keiko does not control
(`create-issue`, `create-page`, `transition-issue` — a transition can trigger the customer's own
Jira automations/webhooks and is not guaranteed reversible) are `high`. No v1 action reaches
`critical`; that tier is reserved by the shared vocabulary for classes of action this lane does not
have (e.g. destructive/delete actions, explicitly out of scope — D7).

**Disposition derivation, spelled out once:** both `governed-assist` (Ask for approval) and
`supervised-coding` (Supervised workspace) require review for every connector action's `internet`
resource scope, regardless of risk tier (ADR-0138). Risk tiers describe the action and inform its
review; they do not exempt comments or field edits from approval. `autonomous-delivery` (Full
access) allows these actions only within a valid authority envelope, the required connector scopes
and the resolved deployment ceiling. A missing read/write scope is denied in every mode, including
Full access. Invalid explicit ceilings fail closed; narrower configured ceilings still apply.
Connector authority never grants repository delivery authority; commit/push/PR/merge remain on
the existing delivery path.

**Contract extension decided here, implemented in #2240:** `CodingWorkbenchConnectorScope` gains
two new closed values, `"knowledge-base.read"` and `"knowledge-base.write"`, added to
`CODING_WORKBENCH_CONNECTOR_SCOPES` in `packages/keiko-contracts/src/coding-workbench.ts` alongside
the existing `source-control.*`/`issue-tracker.*` pairs. This is a genuine capability gap, not a
connector-local scope: Confluence read/write operations have no existing scope to attach to, and
`knowledge-base` (rather than `confluence`) is chosen so a future wiki-like connector (e.g. Notion)
can reuse the same scope pair instead of each wiki connector inventing its own. The governance
identifiers themselves are unchanged: `connector-access` already exists as a
`CodingWorkbenchActionClass` and is the sole class the policy matrix evaluates for connector work;
`connector-write` already exists as a `CodingWorkbenchSupervisedActionKind` whose `actionKindToPerm`
mapping resolves back to `connector-access`, carrying the additional approval-risk signal on the
supervised-action path. Only the scope enum grows.

Managed Jira catalog operations use the same `connector-access` effect class. The current
project, issue-type, create/edit metadata, search, issue, comment, transition-metadata and assignable-user read capabilities map to `issue-tracker.read` (low risk). In ordinary Chat, every mode
requires the current binding's first-read grant before HTTP; a valid grant permits subsequent
read-class calls only within the current authority, binding and credential generation. That bounded
read grant supplies the standing approval for read-class calls; it never approves writes. Missing or
expired authority is denied. The ordinary buffered and streaming Chat paths compose this admission
under #4084/#4091 through the shared catalog binder and managed host described in
[ADR-0181](ADR-0181-shared-managed-mcp-host.md). The provider factory and SDK host never confer
consumer authority themselves. The descriptor keeps the catalog's conservative server-generated
invocation key requirement for external connector effects.

The authenticated Chat PATCH and serializer own the single Jira binding and saved human mode.
Responses add the server-resolved ceiling and effective mode without replacing the saved selection.
The existing Chat settings, Knowledge Pods hub and workspace ports use that same PATCH; a
presentation edge appears only after confirmation for the exact requested Chat and Pod. Replacing
a binding requires explicit confirmation. Cancelled/superseded UI requests and late replies cannot
create an edge for a different selection. A workspace node, drag payload or display of a verified
Pod never grants authority. The existing shared mode selector disables options above the ceiling.

Ask for approval and Supervised workspace require a concrete write approval. Full access omits
per-action write approval only inside current validated authority. Approvals bind the canonical turn,
action digest, arguments and current subject generations; the mutation journal claims an approval
once at actual mutation dispatch, after metadata reads. Every mode still needs first-read consent,
including the metadata reads required to prepare a mutation. Mixed Data-Pod/Jira turns preserve
existing grounding citations and attribute Jira results separately; their orchestration phases share
the accepted turn's Authority Envelope, while the grounded answer keeps its own synthesis grant
(ADR-0181, amended for #4175).

### D5 — Sync bounds and lifecycle

**Explicit, user-triggered sync only.** No scheduled, webhook-driven, or automatic background sync
ships in v1 (D7).

**Bounded, declared defaults** (narrowable but not wideneable by a later child, mirroring
`DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS`'s existing convention):

| Bound | Default | Applies to |
| --- | --- | --- |
| `maxItems` | 2 000 | issues or pages per sync run |
| `maxBytes` | 50 000 000 (50 MB) | total normalized content per sync run |
| `maxDurationMs` | 900 000 (15 min) | wall-clock budget for one sync run |
| `maxConcurrency` | 4 | concurrent paginated fetch requests |
| `maxResults` (live search only, #2248) | 100 | results per `search-issues-live` call |

**Fingerprint-based change detection generalizes the Epic #1856 model** (it is not the literal
HTML-manual table, because Atlassian items are keyed by a stable provider identifier — a Jira issue
key or a Confluence page id — not a crawled relative path): for each synced item, a content
fingerprint is computed as `sha256Hex(canonicalise(normalizedItemContent))` using the existing
`keiko-security/hashing` primitives (`sha256Hex`, `canonicalise` — already reachable from
`keiko-connectors`, no new hashing logic). The full fingerprint set for a source is replaced
atomically per completed run, mirroring `replaceManualPageFingerprints`. A completed run's diff
against the prior fingerprint set produces `addedItems | changedItems | removedItems |
unchangedItems` counts plus `failedItems` and `deniedItems` — the same closed shape as
`ManualRefreshChangeCounts` minus `movedPages`/`movedItems`, which does not apply: Atlassian item
keys are stable identifiers assigned by the provider, not resolved paths, so there is no rename/move
case to detect. A run that did not apply (cancelled, or failed before commit) reports zero for
added/changed/removed, exactly as `computeManualRefreshChangeSummary` already does for the
HTML-manual case, so a partial or aborted run can never be misread as "nothing changed upstream."

**Degradation states map onto the existing `KnowledgePodReadiness` vocabulary** rather than
inventing a connector-local status set:

| Sync job state (#2240) | Pod readiness |
| --- | --- |
| `pending` | `draft` (no completed sync yet, or queued) |
| `running` | `indexing` |
| `succeeded` | `ready` |
| `partial` | `degraded` |
| `failed` | `error` |
| `cancelled` | unchanged (the pod keeps its pre-run readiness; a cancelled run neither advances nor downgrades it, mirroring the existing "not applied" handling in `computeManualRefreshChangeSummary`) |

**Cancellation semantics:** an in-flight sync run is cancelled by aborting the underlying HTTP
requests (the same `AbortSignal` composition `gatewayFetch` already supports for `timeoutMs`).
Cancellation happens before the next page boundary; nothing is partially applied — the fingerprint
replace and the Local Knowledge index update happen once, atomically, at the end of a completed
run, so a cancelled run commits nothing and the pod's prior successful state remains fully intact
and queryable throughout.

### D6 — Evidence and audit shape

The existing server action owner also projects SyncRun completion through the registered
`atlassian.action.outcome` Activity Log operation. The connector activity ring remains the UI
projection; it is not the sole audit store. A partial sync is explicitly `partial` in the global
log, with a warning level and the actual closed failure reason rather than a governance rationale.
Partial sync-only failure reasons remain classified as failures in the global projection; governance approval reasons are not reclassified as execution failures.

Malformed list/metadata JSON, individual Jira/Confluence item bodies and live-search responses
are covered through the real routes and the existing log reader. Managed Jira tools use the shared
`mcp.managed.lifecycle` producer; HTTP/provider failures are refused through that owner. No response
body, URL, credential reference or token is copied into these registered projections.

Every connector action attempt — allowed, review-required, denied, and failed — produces exactly
one content-free audit record: action type, connector id, provider, target key/id (an issue key or
page id — an identifier, not a body), disposition, reason code, correlation id, duration, and
result status. A sync run additionally records the D5 counts, the outcome enum, and the run's
fingerprint-set digest. Rejected content in every audit and evidence record: issue/page bodies,
comment text, ADF/storage-format payloads, field values, raw JQL, tokens, and any token-bearing
URL — the same rejected-content list ADR-0124 D7 already fixes for coding evidence, applied here
without modification.

**JQL is hashed or omitted, never verbatim**, per the #2248 acceptance criterion: an audit record
for `search-issues-live` may carry `sha256Hex(jql)` (reusing the same `keiko-security/hashing`
primitive as D5) for correlation across repeated queries, or omit the field entirely; it never
carries the query text itself, since JQL is user-authored free text that may reference project or
business-sensitive terms.

**This is distinct from the synced knowledge content itself.** The audit/evidence redaction rule in
this section governs the *governance trail* — the record of what was attempted and its
disposition. It does not apply to the actual synced Confluence/Jira content that becomes the
connector pod's retrievable knowledge product: that content legitimately carries real field values,
titles, and body text, exactly as any other Local Knowledge source does, and is protected the same
way — encrypted at rest via `keiko-local-knowledge`'s existing `StoreContentCipher` construction
(ADR-0047), not by the content-free audit rule. Conflating the two would either make the connector
pod useless (a knowledge pod with no retrievable content) or weaken audit redaction (an audit trail
that leaks synced bodies); this record keeps them structurally separate, mirroring how
`editor-agent-governance.ts`'s bounded audit record is content-free while the actual file content it
describes is not redacted at the workspace layer.

### D7 — Qualified platforms and named follow-ups

Cloud REST behavior remains supported. Epic #4081 adds a bounded Jira Data Center 10.3.26
REST-v2/PAT connection path. Version and active identity are verified with bounded `serverInfo`
and `myself` JSON reads under one deadline; HTML, redirects, authentication, permission, version,
TLS and network failures have closed outcomes. Context paths are preserved. This implementation
is not a qualification claim: real lab and model acceptance is recorded in
[the epic evidence matrix](../qa/jira-chat-pods-4081.md). Other Data Center versions and
Confluence Data Center remain unsupported. The existing sync lane remains Cloud-only.

The following capabilities remain deferred:
- **OAuth 2.0 (3LO).** API-token Basic auth is sufficient for a single local user's own credential
  and requires no redirect-based consent flow, browser round-trip, or refresh-token custody. OAuth
  is deferred until multi-user or app-marketplace distribution creates an actual need for it.
- **Webhooks.** v1 sync is pull-based and explicitly user-triggered (D5); webhook ingestion would
  require an inbound listener and a different trust boundary (accepting unsolicited external input)
  that this ADR does not evaluate.
- **Attachments and worklog indexing.** Out of scope for the #2243/#2246 document/metadata mapping
  this ADR's action table assumes; deferred as a scope extension of the sync content model, not a
  policy change.
- **Scheduled/background sync.** Deferred until explicit-trigger sync (D5) has shipped and proven
  its bounds in production; a scheduler changes the "explicit user action" framing this ADR's D4
  mode dispositions assume for reads (a `review-required` disposition presumes a human is present to
  review).
- **Deletion actions** (issue deletion, page deletion/archival, comment deletion). Deliberately
  excluded from v1's action union entirely (D4 has no delete row) because a destructive, generally
  irreversible action against a customer's system of record needs its own risk-tier and disposition
  decision this ADR does not make; adding it later is an additive D4 table extension, not a
  reopening of this record.

### D8 — Honest permissions posture

A synced pod, and every live read or write action, reflects the visibility and permissions of the
**token identity at the moment of the call** — a point-in-time snapshot, not a live or continuously
re-evaluated permission set. Keiko does not replicate Confluence space permissions or Jira
project/issue-level security schemes into a local ACL over synced content. Ordinary Chat calls
additionally require the current Keiko actor-owned binding, authority, read consent and any concrete
write approval; those checks never widen the Atlassian identity's permissions. The synced-content
limitation must be documented wherever a connector or its persisted knowledge is presented.

**Guidance for regulated deployments:** use a dedicated service-account API token scoped to only
the projects/spaces the deployment intends to expose, rather than a broad personal token — the
local pod inherits that token's full read scope for every local user of the workspace the pod is
part of. Rotate the token on the organization's existing credential-rotation cadence. The `authRef`
and Live-Pod identity stay stable, while custody and matching Chat bindings advance their
generations and access remains unavailable until verification and fresh consent. Treat a synced
pod as equivalent, from an access-control perspective,
to a local export of everything that token could read at sync time, and govern its local retention
and distribution accordingly.

## Consequences

### Positive

- Every child issue (#2240 onward) has one normative mapping table, one fixed credential
  construction, and one fixed egress construction to implement against — no child re-decides a
  trust boundary this record already fixed.
- Zero new cryptographic primitives, zero new egress engines, and zero new package-graph edges to
  the Model Gateway: credential custody reuses ADR-0046's vault generalization verbatim, and egress
  reuses ADR-0038's `gatewayFetch` through the same server-composition pattern already proven by
  the Figma connector and the Local Knowledge intranet-manual fetcher.
- `keiko-connectors` stays a small, independently testable leaf (fixture-injected transport port),
  matching the dependency shape of every other domain leaf package in the repository.
- The mapping table retains concrete risk descriptions for reads/comments, field edits and
  creates/transitions. Under ADR-0138, Ask for approval and Supervised workspace require approval
  for connector writes at every tier; Full access still requires current bounded authority.

### Negative

- `keiko-connectors` cannot unit-test a real network call end-to-end within its own package; its
  tests are necessarily fixture/port-based, and the `gatewayFetch`-backed adapter can only be
  exercised inside `keiko-server`'s test suite. This mirrors the existing
  `keiko-local-knowledge`/Figma testing shape and is an accepted, not a new, cost.
- The `knowledge-base.*` connector scope is coined here for a capability (Confluence) whose
  contract does not exist until #2240 lands; until then this ADR's D4 table describes a
  not-yet-implementable scope, which is the intended and necessary order (ADR before contract, per
  ADR-0129 D6).
- The permissions posture in D8 is a genuine limitation, not a mitigated risk: a regulated deployer
  must actively choose a narrowly scoped service token, because Keiko enforces nothing beyond what
  the token already restricts.

### Neutral

- The v1 action union has ten rows and no delete action; a future delete-action extension is an
  additive table row under this same ADR's D4 pattern, not a new ADR, unless it also changes the
  credential, egress, or package-boundary decisions (D1-D3), in which case it would need its own
  record referencing this one.
- `bearer-pat` is implemented for explicitly selected Jira Data Center connections; existing
  Cloud credential envelopes and metadata remain readable without rewriting their stored shape.

## Alternatives Considered

### Alternative 1: Give `keiko-connectors` a direct `keiko-model-gateway` dependency for egress

- **Pros**: one fewer indirection; the connector package could call `gatewayFetch` directly instead
  of going through an injected port that `keiko-server` implements.
- **Cons**: violates the issue's explicit "no Model Gateway involvement" boundary for the connector
  package; blurs the isolation `keiko-model-gateway` exists to hold (AGENTS.md: it is "the only
  place provider SDKs ... may be imported" and the composition root for credentialed provider
  routing); would make `keiko-connectors` untestable without a live/mocked gateway rather than a
  plain fixture; breaks the working `keiko-local-knowledge` and Figma precedent of leaf-plus-port.
- **Why rejected**: the injected-port shape already exists twice in this codebase and is proven to
  satisfy `arch:check`; there is no capability gap it fails to cover.

### Alternative 2: A second, connector-specific proxy/CA-aware HTTP client inside `keiko-connectors`

- **Pros**: keeps the connector package fully self-contained with zero dependency on how
  `keiko-server` wires transport.
- **Cons**: directly violates the reuse-first rule (AGENTS.md §5) by duplicating ADR-0038's
  DNS-rebinding defense, CONNECT-tunnel proxy handling, and CA-fallback logic — roughly 700 lines
  of already-hardened, already-audited code — as a second implementation that would need its own
  security review and would drift from the first over time (a proxy fix applied to `gatewayFetch`
  would not propagate here).
- **Why rejected**: this is exactly the "second subsystem" AGENTS.md §5 prohibits; the injected-port
  pattern (Alternative chosen) gets the same proxy/CA correctness for zero new lines.

### Alternative 3: Store the Atlassian credential in the existing provider-credentials vault (reuse the same vault instance as model-gateway keys)

- **Pros**: one fewer vault file, one fewer key-resolution namespace to document.
- **Cons**: breaks ADR-0046's explicit key-separation security property — a leaked or
  misconfigured provider-credentials vault key would also expose Atlassian tokens, and vice versa;
  conflates two independently rotatable, independently scoped credential domains (model-provider
  API keys vs. a user's own Atlassian identity) that a regulated deployer may need to rotate,
  audit, or revoke on different schedules and by different people.
- **Why rejected**: ADR-0046 itself designs key separation as the replay defense, not the AAD;
  sharing a vault instance across unrelated credential domains defeats that defense for a marginal
  file-count saving.

### Alternative 4: Model connector writes as `CodingWorkbenchActionClass: "delivery-substrate"` instead of `connector-write`/`internet`

- **Pros**: writes to an external system of record (Jira, Confluence) feel closer to "delivery" than
  to ordinary internet access; reusing the `delivery` resource scope would make every write
  `approval-required` in every mode including Full access, which reads as maximally conservative.
- **Cons**: `delivery` is reserved by ADR-0124/ADR-0129 D4 for git commit/push/PR/merge and
  "authority widening" — actions with a categorically different reversibility and blast-radius
  profile (rewriting the project's source-control history and triggering CI/release automation) than
  adding a Jira comment. Folding connector writes into `delivery` would make Full access unable to
  create a Jira issue without a human in the loop even when the epic's explicit intent (#2244
  Purpose) is that Full access executes writes "inside the validated Authority Envelope" without
  per-action approval when the write scope is present. It would also make the mode matrix's
  low/medium/high/critical risk tiers meaningless for this action class, since every `delivery` cell
  is `approval-required` regardless of risk.
- **Why rejected**: `connector-write`/`internet` already exists, is already the action class Epic
  #2238's own issues (#2244, #2248) describe dispositions against, and preserves the risk-tier
  distinction D4 relies on. `delivery` remains reserved for source-control/release actions, per
  ADR-0129 D4's unchanged definition.

## References

- [ADR-0129](ADR-0129-product-wide-authority-and-autonomy-model.md) — the product-wide three-mode
  authority model this record maps onto (D6 forward-citation rule satisfied here).
- [ADR-0124](ADR-0124-coding-autonomy-modes-and-sidecar-runtime-authority.md) — connector scopes,
  Authority Envelope, content-free evidence rules (D7) reused unmodified.
- [ADR-0125](ADR-0125-governed-agent-docking-and-editor-changesets.md) — the effect-class mapping
  and tri-state disposition pattern D4 mirrors.
- [ADR-0019](ADR-0019-modular-package-architecture.md) — required dependency direction; trust-9
  (local-knowledge no-egress) is the direct precedent for D1's `keiko-connectors` no-egress rule.
- [ADR-0038](ADR-0038-outbound-egress.md) — the shared `gatewayFetch` proxy/CA transport reused by
  D3.
- [ADR-0046](ADR-0046-local-credential-vault.md) — the local secret-vault construction and
  key-separation rationale reused by D2.
- [ADR-0047](ADR-0047-local-knowledge-content-encryption.md) — the Local Knowledge content
  encryption-at-rest boundary D6 defers the synced-content question to.
- Epic #2238 and its children #2240 (contracts), #2243 (Jira adapter/document mapping), #2244
  (write actions), #2248 (live JQL read).
- `packages/keiko-local-knowledge/src/manual-page-fingerprints.ts`,
  `manual-refresh-change-summary.ts` — the Epic #1856 fingerprint/change-summary model D5
  generalizes.

## Date

2026-07-11
