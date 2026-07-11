# ADR-0128: Atlassian connector authority and security design

## Status

Accepted (Issue #2239, Epic #2238, 2026-07-11).

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
(`Authorization: Basic base64(email:api_token)`); `bearer-pat` is reserved for the Data Center
follow-up (`Authorization: Bearer <PAT>`, D7) and is declared now so the credential shape never
needs a breaking change when that follow-up lands. No implementation ships for `bearer-pat` in v1.

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
`outboundTargetBlockedReason` DNS/address re-check pattern in `keiko-model-gateway/src/http.ts`).

**Transport:** the concrete adapter is built from `gatewayFetch` (ADR-0038), reusing its existing
proxy/CA composition unchanged — no connector-specific proxy or CA logic is introduced. Proxy
configuration (`KEIKO_HTTPS_PROXY` > `HTTPS_PROXY` > `https_proxy`, `NO_PROXY` rules) and trusted
CAs (Node bundled roots ∪ OS trust store ∪ `NODE_EXTRA_CA_CERTS` ∪ configured bundle) are the
existing operator-level configuration; this connector does not gain its own proxy/CA settings
surface. Both enterprise-proxied and direct-internet deployments are first-class because the
transport is unchanged from the model-gateway/Figma path that already supports both.

**Redirects and protocol downgrade fail closed.** The adapter issues requests with no redirect
following (mirroring `figmaHttpPort.ts`'s `redirect: "manual"`): any 3xx response is surfaced as a
typed transport error, never followed. A redirect target on a different host, a non-`https:`
target, or an `http:` downgrade is refused before any connection is attempted — the single-host
allowlist and the HTTPS-only base-URL validation make this the same check twice, which is
intentional (fail-closed defense in depth, not redundant complexity to remove).

**URL-embedded credentials are refused,** consistent with ADR-0038's proxy-URL rule: a base URL or
any derived request URL containing `username`/`password` userinfo is rejected at validation time
and, as defense in depth, at request-construction time.

**Bounded timeouts:** 30 000 ms per request for interactive write/read actions (issue and page
CRUD, transitions, comments); 60 000 ms per paginated fetch for bulk sync requests (matching
`FigmaHttpPort`'s existing `DEFAULT_TIMEOUT_MS`); 15 000 ms for the live JQL search action (#2248),
matching the existing per-page timeout convention in
`DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS.timeoutMs`. Sync-run timeouts are additionally bounded
by the overall `maxDurationMs` run budget (D5).

**Bounded backoff for 429/5xx:** exponential backoff starting at 500 ms, factor 2, capped at 8 000
ms per attempt, maximum 5 attempts, honoring a `Retry-After` response header when present (itself
capped at the same 8 000 ms ceiling so a hostile or misconfigured upstream cannot stall a run past
its budget). 4xx responses other than 429 are not retried; they fail immediately as typed,
content-free errors (`auth-failed`, `permission-denied`, `malformed-payload`, per the #2240 job
failure-reason vocabulary).

### D4 — Action-class mapping table

This is the normative mapping for every v1 governed connector operation. Rows are derived from
`CODING_WORKBENCH_MODE_POLICIES`'s `internet` resource-scope row (all connector actions reach an
external system over HTTPS) composed with `decideCodingWorkbenchActionForMode`'s scope gate
(stricter-wins: `denied` beats `review-required` beats `allowed`), exactly as
`editor-agent-governance.ts` composes `envelopeModeEffect`. Every action maps to exactly one
`CodingWorkbenchActionClass` (`connector-access` for reads, `connector-write` for writes — see the
scope-extension note below), one connector scope, and one `CodingWorkbenchApprovalRisk`, and the
disposition columns are the corresponding tri-state effect
(`allowed | review-required | denied`) **assuming the required connector scope is present in the
Authority Envelope.**

| # | Action | Provider | Action class | Connector scope | Approval risk | Ask for approval | Approve for me | Full access |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `sync-space` | Confluence | `connector-access` | `knowledge-base.read` | low | review-required | allowed | allowed |
| 2 | `sync-project` | Jira | `connector-access` | `issue-tracker.read` | low | review-required | allowed | allowed |
| 3 | `search-issues-live` | Jira | `connector-access` | `issue-tracker.read` | low | review-required | allowed | allowed |
| 4 | `create-issue` | Jira | `connector-write` | `issue-tracker.write` | high | review-required | review-required | allowed |
| 5 | `update-issue-fields` | Jira | `connector-write` | `issue-tracker.write` | medium | review-required | allowed | allowed |
| 6 | `transition-issue` | Jira | `connector-write` | `issue-tracker.write` | high | review-required | review-required | allowed |
| 7 | `add-issue-comment` | Jira | `connector-write` | `issue-tracker.write` | low | review-required | allowed | allowed |
| 8 | `create-page` | Confluence | `connector-write` | `knowledge-base.write` | high | review-required | review-required | allowed |
| 9 | `update-page` | Confluence | `connector-write` | `knowledge-base.write` | medium | review-required | allowed | allowed |
| 10 | `add-page-comment` | Confluence | `connector-write` | `knowledge-base.write` | low | review-required | allowed | allowed |

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

**Disposition derivation, spelled out once:** `governed-assist` (Ask for approval) makes every
`internet` risk tier `approval-required`, so every row is `review-required` regardless of risk —
this matches #2248's explicit acceptance criterion for `search-issues-live` and generalizes to
every other row without a special case. `supervised-coding` (Approve for me) allows `low`/`medium`
and requires approval for `high`/`critical`, which is exactly why the risk tiers above were chosen
to split the write set: comments and field edits proceed without interruption, while
issue/page creation and status transitions are reviewed. `autonomous-delivery` (Full access) allows
every `internet` risk tier, so every row is `allowed`, **conditioned on the connector scope being
present** — an envelope missing `issue-tracker.write` (or `knowledge-base.write`) is `denied` with
`connector-write-denied` in Full access exactly as in every other mode, per the #2240 acceptance
criterion that write actions without the write scope are denied "in every mode, including Full
access." No connector action ever reaches `delivery` resource scope; git commit/push/PR/merge stay
governed exclusively by the existing delivery-substrate path and are untouched by this lane.

**Contract extension decided here, implemented in #2240:** `CodingWorkbenchConnectorScope` gains
two new closed values, `"knowledge-base.read"` and `"knowledge-base.write"`, added to
`CODING_WORKBENCH_CONNECTOR_SCOPES` in `packages/keiko-contracts/src/coding-workbench.ts` alongside
the existing `source-control.*`/`issue-tracker.*` pairs. This is a genuine capability gap, not a
connector-local scope: Confluence read/write operations have no existing scope to attach to, and
`knowledge-base` (rather than `confluence`) is chosen so a future wiki-like connector (e.g. Notion)
can reuse the same scope pair instead of each wiki connector inventing its own. `CodingWorkbenchActionClass`
itself is unchanged — `connector-access` and `connector-write` already exist and are sufficient;
only the scope enum grows.

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

### D7 — v1 platform: Atlassian Cloud REST, with named follow-ups

v1 targets Atlassian Cloud REST APIs only, against a configurable, per-connector base URL validated
per D3. The following are explicitly deferred, each with the reason it is not v1:

- **Data Center compatibility.** Different base-path conventions, more commonly self-signed/private
  CAs (already covered by D3's CA composition, but unverified against a real Data Center instance),
  and the `bearer-pat` auth scheme (declared in D2, unimplemented). Deferred because it requires
  access to a Data Center instance to verify, which this issue does not have.
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
re-evaluated permission set. Keiko applies no additional per-user or per-team access control on top
of what the connected Atlassian token can already see; it does not replicate Confluence space
permissions or Jira project/issue-level security schemes into a local ACL model. This is a
deliberate v1 scope limitation, not an oversight, and must be documented as such wherever a
connector is configured or a synced pod is presented to a user.

**Guidance for regulated deployments:** use a dedicated service-account API token scoped to only
the projects/spaces the deployment intends to expose, rather than a broad personal token — the
local pod inherits that token's full read scope for every local user of the workspace the pod is
part of. Rotate the token on the organization's existing credential-rotation cadence (D2's
`authRef` indirection makes rotation a `vault.set` on the same reference, with no descriptor or
pod-metadata change required). Treat a synced pod as equivalent, from an access-control perspective,
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
- The mapping table's risk-tier split (low reads/comments, medium field edits, high
  creates/transitions) gives "Approve for me" a real, defensible distinction between writes that
  proceed unattended and writes that pause for review, rather than treating all writes identically.

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
- `bearer-pat` exists in the auth-scheme enum today with no implementation, matching the standard
  "declare the shape, implement the follow-up separately" pattern already used for
  `CodingWorkbenchModelSource`'s subscription-profile values before their runtimes shipped.

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
