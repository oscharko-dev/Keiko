# ADR-0175: Canonical governed-tool catalog and invocation contract

## Status

Accepted for implementation by [#3411](https://github.com/oscharko-dev/Keiko/issues/3411),
2026-09-04. This decision and its executable architecture gates precede runtime delivery.
The catalog package, binder and migrated consumers are **not implemented by this decision**.

Version: 1.0

## Context

The [audited inventory](../architecture/governed-tool-contract.v1.json) identifies independent
name/schema/action definitions in gateway, legacy tools, managed OpenCode, Editor and the read-only
child. Launch configuration, protocol, IPC, readiness and event sinks can disagree with those
surfaces. Catalog membership does not establish either an executable backend or permission.

The package DAG (ADR-0019), existing policy and Authority Envelopes (ADR-0124/ADR-0138), workspace
ownership (ADR-0005/ADR-0152/ADR-0165), harness (ADR-0004), disabled Codex composition (ADR-0163) and
activity log (ADR-0173) remain authoritative. This decision converges descriptive metadata and
binds it to those owners; it adds no parallel execution, policy, search or evidence subsystem.

## Decision

### D1 — One owner per responsibility

| Responsibility | Sole owner | Delivery |
| --- | --- | --- |
| Generic cross-package types and closed envelopes | `keiko-contracts` | #3406; additive invocation bridge only #3409 |
| Validated canonicalization and SHA-256 primitives | existing `keiko-security/src/hashing.ts` | #3406 reuses, validates before calling |
| Concrete descriptors, profiles, compiler and compatibility | new pure `keiko-tool-catalog` | #3406 |
| Provider schema transport | `keiko-model-gateway` using compiled projections | #3409 |
| Existing effects/handlers | existing domain owners; coding work with #3386 | handler implementations retain ownership |
| Live action, risk and Authority Envelope policy | existing policy evaluators | #3413 invokes; metadata never authorizes |
| Bound/ready/offer/dispatch and one invocation settlement | server composition | #3413 |
| Outer run counters, run AbortSignal and one run settlement | existing harness | #3409 |
| Raw search/read coordinate computation | existing workspace owner | #3386 H1 |
| Durable activity and diagnostics | existing server log/diagnostic ports | #3412 generator; #3413 runtime/analyzer |
| Adapter projection semantics | catalog compiler | consumers materialize only the compiled result |

The new pure package depends only on contracts and security. It cannot import I/O, providers,
handlers, credentials, readiness, log sinks or policy evaluators. Server composition alone injects
live authority, root, action, correlation, idempotency, handler and budget ports. Generic types do
not reference the server. Browser types remain JSON-safe BFF projections with no handlers,
Authority Envelopes, approval proofs, environment, credentials, filesystem handles or server roots.
No package or runtime scaffolding is introduced by #3411.

**#3409 catalog-B disposition (native-catalog composition).** `createNativeCatalogToolPort` and
`WorkspaceToolHost` exist and are unit-tested but were never wired into the CLI or server dry-run
compositions (`packages/keiko-cli/src/run.ts`, `packages/keiko-server/src/run-engine.ts`), which
still construct `DryRunToolPort` with no `bindToolCatalog`. This decision keeps it that way: both
call sites run their sessions with `AgentConfig.dryRun: true`, and `session.ts` binds a catalog only
when `dryRun` is false, so wiring `bindToolCatalog` there today would be dead composition — it could
never take effect without also flipping `dryRun`. Flipping it is out of scope for #3409 because
neither call site holds a server-validated Authority Envelope (ADR-0129/ADR-0138): the CLI is an
unauthenticated local process invocation and the server's `dispatchExplain` composition is a
read-only, single-model-call plan explainer with no bound/ready/offer/dispatch owner of its own —
that responsibility belongs solely to server composition under #3413 (D1's table, above), which has
not landed. Wiring a productive catalog here ahead of #3413 would let a bare invocation gain
executable tools outside any validated authority boundary, which ADR-0129's monotonic-authority
invariant forbids. The native harness therefore stays intentionally non-productive for these two
call sites: `DryRunToolPort` advertises the compiled `legacy-native@1` catalog projection for honest
discovery (`listTools()`, sourced from the real `keiko-tool-catalog` producer, never a restated
list) while unconditionally refusing every execution with a closed harness error, and its
`legacyDefinitions` constructor parameter — dead since no caller definitions could ever make it
productive — is removed. The productive path for these tasks remains the managed OpenCode runtime
(#3414) once #3413's binder exists; #3409 does not anticipate that work by pre-wiring a factory
nothing yet authorizes. `docs/architecture/governed-tool-migration.md`'s `cli-composition` and
`server-composition` rows, and the frozen inventory's identical "default dry-run remains
nonproductive" scope text, already record and gate-check this disposition (`checkInventoryProbes`
requires each row's `DryRunToolPort` probe substring to remain present).

### D2 — Identity and independent version axes

The normative version-1 table is [governed-tool-contract.v1.json](../architecture/governed-tool-contract.v1.json).
Its `owners`, `axes`, `interfaces`, `statuses`, `budgetDispositions`, `phases`, `bounds` and `consumers` sections are checked
by `check:governed-tool-contract`. Every interface lists its full field vocabulary and sole issue
owner; the rules below determine types, optionality and trust direction.

`ToolRef = {canonicalId, contractVersion}`. Canonical IDs match
`^keiko\.[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$`; contract versions are positive safe integers.
Breaking input, output, effect, idempotency or cancellation semantics require a new version.
An alias matches `^[a-z][a-z0-9_]{0,63}$`, is unique within a profile including native extensions,
and never resolves outside that profile. Restricting identifiers to ASCII rejects confusables;
normalization must not silently turn rejected text into a different valid identity.

Profile and adapter dialect are `{id, version}`. Adapter runtime is `{id, version}` with an exact
pinned version, never a range or `latest`. Catalog revision, descriptor digest and projection digest
are distinct lowercase 64-hex SHA-256 identities. A change to any relevant axis invalidates bound
sets, offers, cursors and generated artifacts. Presentation aliases may remain across versions only
inside explicitly selected immutable profiles. A run pins all axes plus workspace identity/revision
and its server-held Authority Envelope; it cannot inherit a mutable catalog singleton.

Initial identity reservations (all version 1):

| Surface | Canonical identity | Profile-local alias disposition |
| --- | --- | --- |
| Legacy file read/list/scripts/command/patch proposal/application | `keiko.file.read`, `keiko.file.list`, `keiko.package.scripts`, `keiko.command.run`, `keiko.patch.propose`, `keiko.patch.apply` | Existing six aliases only in `legacy-native@1` |
| Managed path discovery/ranged read/changeset/verification | `keiko.workspace.discover`, `keiko.workspace.read`, `keiko.changeset.edit`, `keiko.verification.run` | Existing managed aliases in `managed-opencode@1` |
| Managed research/skill/child | `keiko.research.fetch`, `keiko.skill.invoke`, `keiko.child.run` | Absent from offers unless bound, ready and authorized |
| Local content search | `keiko.repo.search` | #3414 alone owns `keiko_repository_search`; H1 owns no alias |
| Managed Git status/diff/stage and delivery proposal (propose-phase only; the model never commits, pushes or opens a pull request directly) | `keiko.git.status`, `keiko.git.diff`, `keiko.git.stage`, `keiko.git.commit`, `keiko.git.push`, `keiko.git.pullrequest` | New `keiko_git_status`/`keiko_git_diff`/`keiko_git_stage`/`keiko_git_commit`/`keiko_git_push`/`keiko_pull_request` aliases in `managed-opencode@1` (#3386/#3387) |
| Shared approved-proposal redemption and CI observation | `keiko.git.execute`, `keiko.ci.status` | New `keiko_git_execute`/`keiko_ci_status` aliases in `managed-opencode@1`; execution redemption is gated on the existing VerifiedCommitService/draft-delivery approval channel, never on model authority alone (#3386/#3387/#3388) |
| Read-only child read | `keiko.child.workspace.read` | New `keiko_child_workspace_read`; old `read_file` only in expiring old-digest profile |
| Editor | `keiko.editor.sessions`, `keiko.editor.snapshot`, `keiko.editor.navigate`, `keiko.editor.symbol`, `keiko.editor.search`, `keiko.editor.git`, `keiko.editor.edit`, `keiko.editor.changeset`, `keiko.editor.verify` | Existing nine aliases in versioned Editor profile; active subset is separately governed |

Different read contracts remain different identities; a profile cannot disguise a lossy transform as
equivalence. OpenCode-native `question` and `todowrite` are exhaustively declared native extensions,
not Keiko tools or compatibility exceptions. Arbitrary sidecar tool definitions remain transport
data and cannot register a descriptor, handler, effect or authority. Codex remains disabled.

### D3 — Digest inputs and compatibility

The `digests` table enumerates exact field sets and distinct domains. For each digest use the
existing security producer over `canonicalise({domain, ...fields})`, then `sha256Hex`. Sort sets by
ASCII identity and reject duplicates before hashing; preserve semantically ordered arrays. Reject
undefined, non-finite numbers, prototypes, accessors, functions, symbols, cycles, unsafe refs,
unknown keys and inputs exceeding the table's depth/width/byte bounds before canonicalization.
Schemas are a closed, bounded JSON Schema subset; unsupported dialect semantics are incompatibility,
never silently omitted keywords. #3406 owns the explicit keyword allowlist and equivalence tests.

Descriptor/projection/catalog digest inputs are trusted local source declarations and **never
customer content**. Description, transformed input/result schemas, effects/actions/policy references,
handler requirement, bounds, alias, profile, catalog revision and exact adapter identity all bind
the projection. Native extensions and accepted compatibility transforms bind it too. Generated
manifests expose IDs, versions, digests, bounds and enums; omit descriptions and schemas.

The request/cursor domains serve a different, transient binder purpose. Canonical arguments can
enter an invocation-scoped request digest only inside server memory; include a server nonce chosen once for that server-held idempotency binding, reused only for request comparisons inside the same binding. A new binding receives a fresh nonce. Same-key/same-arguments replay therefore retains the same request identity; low-entropy queries cannot be recovered from a stable public hash. Neither arguments, nonce nor
request/cursor digest enter the generated catalog or durable evidence. Opaque cursor tokens address
server-held entries; the catalog compiler never creates cursors or handles customer input.

Compatibility entries are `{from, to, profile, adapter, transformId, ownerIssue, expiresAt,
removalIssue}` with exact versions/digests, an explicit direction and tested non-widening transforms.
No reverse or transitive compatibility is inferred. Maximum lifetime is seven days and the removal
checkpoint may end it earlier. Unknown, expired, downgraded or stale work cannot bind to latest.
Unsupported persisted bindings yield `invalid / recovery-required`; only a human-selected restart
creates a new binding/invocation. Rollback restores an exact compatible deployed artifact; it does
not reactivate expired aliases or replay uncertain effects.

### D4 — Offer, dispatch and bounded data

`offer = profile intent ∩ representable ∩ bound-and-ready ∩ live-authority-eligible ∩ budgeted`.
An approval-required action is eligible only when the current mode/envelope permits that action
and a valid approval channel can complete the existing approval protocol; listing is not approval.
All three ADR-0138 modes preserve monotonic authority and mode-independent hard denials.
Dry-run, unsupported and unavailable backends are readiness states, never productive availability.

A descriptor redeeming multiple operation kinds declares the union of their possible effects.
In particular, `keiko_git_execute` declares workspace-write, delivery-substrate and network-egress;
its selected stage/commit/push/PR handler still performs the exact per-kind authority check.
An incomplete shared effect floor cannot substitute for that conservative advertisement.

Before every dispatch, validate the exact offer/tool/version/projection and untrusted arguments,
then recheck current authority, root/revision, readiness, cancellation/deadline, budget and
idempotency. No model/browser/adapter field may override composition-owned fields. A revoked or
unoffered call cannot reserve an effect. The binder invokes existing handlers in process through
ports, not loopback HTTP. Missing/wrong handlers fail closed before advertising; loss after offer
returns `failed / handler-unavailable` or `handler-mismatch` without effect.

Bounds in the normative table are **maximum safety ceilings, not performance targets**. Each
handler/profile may tighten them; neither model nor adapter may enlarge them. #2952 measures
performance and #3415 calibrates narrower catalog-specific thresholds. JSON object depth is root=1;
width is keys per object, byte bounds count UTF-8 serialization, and integer metrics are finite,
nonnegative safe integers. Input and output limits apply before parsing/allocation where possible.

Repository search v1 is local lexical/literal/safe-regex/symbol search through the workspace owner.
It caps query characters at 200, hits at 50, scanned files at 2,000, file bytes at 512 KiB, time at
5 seconds, snippets at 512 bytes, result at 64 KiB and discovery inventory at 50,000. Each include
and exclude list has at most 32 globs of 200 characters. Yield after at most 32 candidates. Search
must reject dangerous regexes, honor cancellation during inventory and scanning, and report omitted
coverage. Existing `repoSearch` defaults of 200 hits do not widen the coding projection's 50-hit cap.
`keiko_workspace_discover` stays path-only. Semantic reranking remains deferred to #3416/#2554.

### D5 — Version-1 result, paging and recovery table

Exactly seven **terminal** statuses exist; `statuses` enumerates all reason/status pairs.
`none` is exclusive to completed results. `recovery-required` belongs exclusively to `invalid` and
only to the persisted-binding condition in `recovery`. No unavailable, unsupported, partial,
truncated, recovery-required or running status may enter this envelope.

| Field | Required shape and condition |
| --- | --- |
| `schemaVersion` | Literal `1`, all results |
| `invocationId` | Server-generated opaque ID, all results including pre-dispatch rejection |
| `toolRef` | Exact validated ToolRef, or `null` for requests rejected before identity resolution |
| `projectionDigest` | Exact bound digest, or `null` before binding resolution; never a model-supplied value |
| `status`, `reason` | Exactly one allowed pair from `statuses` |
| `effectStarted` | Boolean; false for pre-effect rejection, conservative true if an effect may have started |
| `metrics` | `{inputBytes, outputBytes, resultCount, durationMs}` bounded integers, no content |
| `page` | Completed only: `{truncated, reason, cursor}`; otherwise `null` |
| `data` | Completed only: descriptor-schema-validated bounded JSON; otherwise `null` |

A completed empty result is valid and distinct from a failed search. `page.reason` is one of
`none`, `result-cap`, `byte-cap`, `file-cap`, `inventory-cap`, `time-cap`, `cancelled`, `oversized-file`,
`denied-file`, `stale-index`; reason `none` requires `truncated=false` and `cursor=null`. Every
incomplete result requires `truncated=true`. A handler can complete with partial data only **before**
authoritative cancellation/deadline settlement; afterward the binder discards it. A cursor is null
unless more safely repeatable work exists. No count may imply complete coverage when inventory was
capped. Error results carry no partial customer data.

Cursors are opaque random handles, capped at 4 KiB, expiring within five minutes; server-held
`CursorBinding` pins tool/version, invocation-scoped request digest, workspace identity/revision,
profile/projection, expiry, budget reservation, nonce and page sequence. Tokens are single-use;
consume/reserve atomically, reject tamper/replay/cross-root/stale revision, and reauthorize and
re-budget every page. Pages retain the original request identity and each receives a distinct reservation and exactly-one settlement receipt; neither cursor creation nor paging reuses a prior page charge. No filesystem path or query appears in the token. Restart invalidates
in-memory cursors instead of attempting implicit recovery.

### D6 — One invocation state machine, one independent outer run

The binder (#3413) owns `received → validated → reserved → running → settled`. Validation may
settle without reservation. `reserved` is the atomic server-owned approval/effect/idempotency and
budget reservation boundary; reserve before effect, then check cancellation/deadline again.
`running` means the one permitted effect may have begun. The outer harness (#3409) retains its
existing run/model/tool/command/wall-time counters, run AbortSignal and run terminal state.

The injected budget port returns an opaque `reservationId` for an `invocationId`; exactly one
`InvocationReceipt` carries `settlementId`, `budgetDisposition` (`committed`, `released`, `not-reserved`, `commit-uncertain` or `release-uncertain`),
`effectStarted` and terminal status. Pre-effect reservations release; started work commits its
charge even if cancelled/failed. Reservation and settlement are idempotent by invocation identity;
the harness consumes the receipt and never independently charges or terminalizes the invocation.
A returned commit/release acknowledgement permits `committed`/`released`; a thrown acknowledgement
produces `failed / budget-port-failed` with `commit-uncertain`/`release-uncertain`. Both require an
existing reservation; commit uncertainty requires `effectStarted=true`, release uncertainty requires
false. Neither permits another effect, a repeated accounting attempt, or compensating accounting.
The receipt reports uncertainty whether the port threw before or after changing its accounting.
A pre-reservation rejection carries `reservationId=null` and `budgetDisposition="not-reserved"`; it has no charge to release. Model/run counters remain outside this receipt. Budget-port failure before effect returns failed;
a failure after an uncertain effect cannot authorize retry and uses `effect-outcome-unknown`.

| Observation | Required transition/result |
| --- | --- |
| Pre-dispatch explicit/parent abort | `cancelled`, no effect or committed charge |
| Authoritative deadline reached | `timeout / deadline-exceeded`; check deadline before an explicit abort observed at the same clock instant |
| Mid-flight abort | Cooperatively abort; at most the already-started effect; settle once |
| Same in-flight idempotency key and same request | `busy / invocation-in-flight`, no second reservation |
| Same key, different bound request | `invalid / replay-conflict`, no effect |
| Completed key replay | Recheck exact binding and live authority, then return the immutable body-free receipt only; no cached result, second effect or charge |
| Malformed/oversize result before settlement | `failed / result-contract-failed`, data withheld |
| Throw/rejection before settlement | `failed / handler-failed` with structured sanitized diagnostics |
| Result arrives after settled | Discard content; one nonterminal observation may record the existing settlement ID |
| Cancellation arrives after settled | Ignore; no second terminal or effect |
| Restart with known terminal receipt | Return the existing receipt if exact binding and authority remain valid |
| Restart with a possibly started effect and no terminal receipt | `failed / effect-outcome-unknown`; no automated retry |
| Restart with unsupported/stale persisted binding | `invalid / recovery-required`, human-selected new invocation only |

The #3413 implementation reuses `CodingToolInvocationRegistry` for invocation payloads and bounded
cursor entries. Cursor identities occupy a reserved namespace that ordinary dispatch rejects;
issuing one never evicts an approved invocation. Both share the existing eight live entries per run,
30-second maximum lifetime, 2 MiB aggregate capacity and run revocation/zeroization. A server-only
`dispatchPage` consumes the cursor and repeats current schema, workspace, compatibility, authority
and budget admission; the model receives only the opaque token. Handler output may contain only a
cursor minted by that invocation, and discarded/failed output invalidates its unpublished cursor.
Handler context exposes `pageSequence`, `createCursor` and the existing final-effect guard. The six
initial descriptor schemas do not acquire pagination arguments until their #3414 consumer migrates.

`keiko-tool-catalog` owns the single `keiko.tool-handler-set.v1` digest over `projectionDigest` and
the ordered immutable binding identities (`toolRef`, `descriptorDigest`, `handlerId`,
`handlerVersion`, `catalogAction`; absent bindings use null handler fields). The server binder and
portable harness adapters call that same owner. `createCatalogToolBinder` retains exact raw
descriptors even when projection compilation adapts schema syntax. Portable adapters must supply an
explicit per-alias handler attestation that matches the descriptor requirement and action; a
missing, duplicate, or mismatched attestation cannot advertise a ready binding. This identifies
declared composition; readiness, policy and effect eligibility are always live checks. Authority preview is non-consuming.
The injected budget owner provides availability, reservation, reservation revalidation, commit and
release; the binder owns no outer-run counters. A retained receipt does not recreate discarded
result data. Its replay eligibility checks current authority without consuming an approval again.

Exactly-one logical settlement does not promise exactly-once external effects across a crash.
An uncertain effect fails closed. No retry may hide that uncertainty.

**Production mounting (F8, #3413 closeout).** `createCatalogToolBinder`'s public `offer`/`dispatch`
pair is shaped for a model that first receives a compiled projection and dispatches back a
catalog-schema `{toolRef, projectionDigest, offerId, arguments}` invocation -- it is not, by
itself, a drop-in wrapper for `codingToolFacade.ts`'s existing dispatch path, which already
receives a validated, IPC-shaped `CodingToolActionRequest` with no catalog offer in front of it.
`packages/keiko-server/src/tool-catalog/catalogToolFacadeBridge.ts` is the composition-owned
bridge that actually mounts the real production catalog (the same
`createOpenCodeGatewayToolCatalogAdvertisement` catalog the model-visible schema is compiled from)
onto that path: `createRuntimeCodingToolFacade` (`codingToolAuthorityPort.ts`) resolves a real
catalog descriptor for each dispatched action `catalogIdFor` covers, and settles
success/denied/handler-failed around the existing governed delegate call using the same
`tool-catalog.invocation-started` / `tool-catalog.invocation-settled` operations, receipt shape and
body-free redaction this section describes -- without a second authority check (the existing
`CodingToolAuthorityPort` admission is reused verbatim as the dispatch's authority disposition,
never re-derived) and without moving the existing admission boundary. Coverage is every action with
a real, unambiguous production catalog descriptor: `discover`, `search`, `edit`, `verification`,
`egress` (`keiko.research.fetch`), `skill`, `child-agent`, `git`'s `status`/`diff`/`stage`
(`propose` -> `keiko.git.stage`, `execute` -> `keiko.git.execute`)/`ci` operations, and `delivery`'s
`commit`/`push`/`pull-request` intents (`propose` -> their own proposal tool, `execute` -> the one
shared `keiko.git.execute` redemption tool regardless of which intent is being redeemed). An action
request this bridge does not cover -- `read` (below), `command` and `connector` (no catalog
descriptor models either one yet), `git`'s low-level `read`/`write` operations, `delivery`'s
`merge` intent (no proposal tool models it) and a `delivery` request with no `phase` (not
model-facing) -- keeps its exact prior dispatch behaviour AND now records one body-free
`tool-catalog.dispatch-unbound` line (the dispatched `action` only) instead of running with zero
catalog evidence, so an operator reading the activity log can always tell "not catalog-covered"
apart from "the catalog silently dropped this call". `read` is the one action with a real 1:1
catalog tool (`keiko.workspace.read`) left deliberately uncovered: the catalog's model-facing schema
requires `startLine`/`maxLines` (`opencode.ts`'s `readSpec`, matching the real wire schema in
`opencodeToolSchemas.ts`, which already requires both) while `CodingToolActionRequest`'s `read`
variant keeps them optional for internal callers outside this work's reach
(`codingToolIpc.ts`'s `readRequest` parser, `opencodeRuntimeAdapter.ts`); binding it without a
verified-safe default for every internal caller would risk silently changing read-window bounds, so
it is reported rather than guessed. Widening to the full offer/dispatch cursor and
idempotency-registry machinery the rest of this section describes remains open follow-up work.

The bridge does not, however, re-derive its own exception vocabulary alongside `CatalogInvocation`'s
(`catalogToolSettlement.ts`). It reuses the same lower-level primitives `catalogToolRuntimeAuthority.ts`
exports for exactly this purpose, independent of the offer/dispatch negotiation the bridge cannot
reuse: `CatalogDispatchFault` (the one exception type that carries a settled `status`/`reason` pair
out of a dispatch) and `catalogBudgetOperation` (the wrapper that turns a throwing budget-port call
into a `CatalogDispatchFault("failed", "budget-port-failed")` instead of an unclassified error). A
budget denial throws `CatalogDispatchFault("denied", "budget-exhausted")` -- the identical fault a
`CatalogInvocation.reserve()` denial raises -- so `codingToolFacade.ts` branches on one exception
class regardless of which settlement path produced it, not on a bridge-local error type. The bridge
also mirrors `CatalogInvocation.account()`'s discipline of accounting a reservation exactly once:
a commit failure after a successful handler run settles as `budget-port-failed` /
`commit-uncertain` (the same canonical `ToolBudgetDisposition` values `CatalogInvocation` emits) and
fails the call closed, rather than additionally calling `release()` on a reservation whose true
state the failed commit already left uncertain. The bridge also mirrors `executeInvocation`'s
(`catalogToolDispatch.ts`) guarantee that a failure BEFORE reservation is never silently unlogged:
if the budget port's `available()` or `reserve()` call itself throws, the bridge settles a
`failed`/`budget-port-failed` terminal record (`reservationId=null`,
`budgetDisposition="not-reserved"`) before rethrowing, exactly as it would for a handler failure
after reservation -- a pre-reservation budget-port exception used to propagate with zero
`tool-catalog.*` evidence even though the call still failed closed to the caller. What remains
genuinely unshared between the two implementations is the offer/dispatch/cursor/idempotency-registry
state machine itself -- the part that requires a prior `offer()` and a catalog-schema `arguments`
object neither of which `codingToolFacade.ts`'s already-parsed `CodingToolActionRequest` carries --
not the fault-shaping or accounting discipline, which are shared.

**Decision recorded (#3413 F8 review, finding b1-1).** `catalogToolFacadeBridge.ts` remains the one
production dispatch owner; `createCatalogToolBinder`/`CatalogInvocation` and their offer/dispatch/
cursor/idempotency-registry state machine are kept as an independently-tested reference
implementation of this section's full contract, not deleted, but are never wired into a production
composition -- reshaping either side to fit the other would reintroduce the exact shape mismatch
this section already documents, and AGENTS.md section 5 forbids growing a second parallel dispatch
path regardless. Acceptance criteria that need real production behaviour are closed inside the
bridge's own construction and dispatch path instead: a canonical id `catalogIdFor` maps a request to
but the composed catalog does not contain fails closed with a real `tool-catalog.bind-unavailable`
line (readiness `unavailable`, reason `unknown-tool`) instead of running the action unbound;
`CatalogFacadeBridgeInput.catalog` accepts a `() => ToolCatalog` provider in addition to a static
value, and `dispatchCovered` re-derives the projection identity from it before every dispatch,
settling `invalid`/`projection-mismatch` the moment a live catalog source drifts from what was
compiled at construction (a static catalog, today's only production wiring, cannot drift and this
check is a guaranteed no-op for it); and every dispatch races the handler against
`descriptor.bounds.maxDurationMs`, settling `timeout`/`deadline-exceeded` when the deadline wins and
quarantining (`tool-catalog.completion-discarded`) a handler resolution/rejection that arrives after
that settlement instead of double-settling or silently dropping it. `busy`/cross-process-restart
dedup, opaque cursors, and a result schema/size bound before `completed` remain genuinely open: they
need, respectively, the same `CodingToolInvocationRegistry` idempotency discipline
`codingToolFacade.ts` already applies to `edit` extended to every catalog-bridged action family, a
registry threaded into the bridge from its composition layer plus a page/cursor-shaped return
contract on the `search`/`discover` domain handlers, and a verified-safe result contract for each of
the ~9 covered action families individually -- each is a composition or domain-handler change
outside `catalogToolFacadeBridge.ts`'s own write scope, not a gap this file can close by itself.

### D7 — Phase-valid activity evidence

The `phases` table freezes operation names for #3412's existing generator; it is not a second
operation catalog or a runtime emission claim. #3412 produces generated provenance/fixtures;
\#3413 emits and analyzes those operations. Projection/readiness events have correlation,
catalog/profile/projection identity and readiness; they do not invent invocation IDs. Started
records use `state="started"`, `reason="none"` and a reservation ID, **no terminal status**.
Terminal records require the result pair and settlement receipt, including `reservationId`
(null only with `budgetDisposition="not-reserved"` before reservation). A discarded completion references
the prior settlement and reason `late-completion`; it is not a second terminal.
For a terminal rejection before tool identity resolution, `toolRef=null` records that absence
without inventing an identity. This requires a non-completed status, `effectStarted=false`,
`reservationId=null`, and `budgetDisposition="not-reserved"`. Started/discarded events and
completed or reserved invocations require the exact resolved ToolRef. The bound lifecycle
projection remains the server-owned identity even when a caller supplied an invalid projection.

Only `evidenceAllowed` fields can enter durable lifecycle evidence. `frames`/`causeChain` use the
existing dist-anchored sanitized stack producer, never free text. Errors require a closed existing
`errorKind`, sanitized structured frames/cause chain and correlation. Query/path/snippet/symbol/
file content and all other `evidenceForbidden` fields are rejected, including nested fields.
Opaque IDs must come from trusted composition, not be arbitrary customer strings in an ID slot.
The only fallback correlation is `UNKNOWN_CORRELATION_ID`.

Lifecycle validation runs before the existing log redactor. The primary activity-write attempt
precedes any auxiliary sink. Injected sink failures use the same structured diagnostic operation
`tool-catalog.lifecycle-sink-failed` and closed sources `tool-catalog-lifecycle-primary` or
`tool-catalog-lifecycle-auxiliary`; an auxiliary exception cannot suppress the primary attempt.
Physical file-write failure retains the existing independent stderr warning. Redactor omission of
null reservations and empty diagnostic arrays is interpreted only under the exact terminal
accounting contract; a missing event is never manufactured from those field rules.

With a healthy primary sink, one logical terminal has at most one primary durable-write attempt.
An auxiliary failure cannot suppress that attempt. Primary failure preserves ADR-0173 sequence
gap and independent stderr warning; support analysis reports unknown, never fabricates a terminal.
Transient UI/child event sinks and a sink persisting only run terminals do not satisfy this contract.

### D8 — Raw-coordinate lane and delivery dependency

ADR-0165 D2/D3 define the prerequisite lane: only workspace code computes coding-search raw
coordinates through its existing guarded reads; snippets are separately redacted afterward. A
coding server handler cannot select `contentLane`, import the raw reader, or publish raw text into
evidence. The existing Editor search route keeps its exact lane selector. The public-barrel bypass
is now rejected by the import-policy AST gate even when the lane value is a variable or shorthand.
The negative fixture is an architecture proof, not a productive H1 implementation.

The owner-selected delivery route consolidates #3411, H1 and the mandatory catalog children into
existing PR #3394. The #3411 architecture and negative gates are verified before their consumers
change shared contracts. H1 then supplies the non-advertised typed workspace/server handler,
readiness and tests under #3386; only #3414 owns its later model-visible projection. This producer
order does not require a separate dev merge, another PR or closure of #3386.

The durable H1 handoff uses `H1Provenance`: `schemaVersion`, `integrationPr` (#3394), `sourceHead`
(the actual signed H1 checkpoint commit), `treeDigest` (its Git tree identity), `verificationRef`,
`reviewRef`, `catalogRevision`, `profile`, `projectionDigest`, `handlerSetDigest` and `currentHead`
(the consuming integration head). Verification and reviewer acceptance reference the actual
producer checkpoint and its prerequisite #3411 contract. An independent agent review over those
exact source contents, retained as a durable artifact with its hash, satisfies checkpoint review;
there is no per-checkpoint external GitHub review or required-check wait. These are development
evidence, not final release qualification. The consumer verifies that checkpoint's ancestry and the owned source contents against its current tree with existing Git identity and
evidence helpers. Later producer changes invalidate earlier verification or review acceptance and
require a fresh checkpoint. A branch name, uncommitted tree, issue status, unrelated green check or
assumed cherry-pick is insufficient. No placeholder reference qualifies a consumer.

Final exact-head required-check evidence and GitHub's actual merge commit/tree are recorded only
when they exist, under the owner-controlled final PR #3394 delivery. They are not fabricated as
prerequisites to an in-PR checkpoint. H1 provenance survives removal of the temporary pending-H1
migration entry, is independently revalidated by #3415, and never enters a semantic projection
digest. #3390 consumes the retained closeout reference before live qualification.


## Migration, verification and consequences

The [migration and threat matrix](../architecture/governed-tool-migration.md) freezes bilateral
ownership and deferred scopes. #2958 had already removed the unmounted `autonomousDeliveryPolicy.ts` stack from the integration
branch. Its historical inventory row is retained; the migration pins the reviewed removal
commit and verifies absence of the old source, and current authority-port, shared monotonic-policy and mounted
Git-delivery owner probes. Missing owners, restored scaffolding and changed migration mappings fail
closed. The machine table contains these reproducible file/token probes, complete producer/consumer
interface mappings and negative consistency tests. #3406 extends the existing migration checker
and introduces the finite shrink-only duplicate register; #3415 expands it and removes all parallel definitions and the
sole #3409 compatibility bridge. #3411 neither scaffolds that runtime nor claims packaged/live
qualification from documentation fixtures.

The #3406 producer is the pure `keiko-tool-catalog` package (contracts/security dependencies only).
It generates `tool-catalog-manifest.v1.json` from validated immutable descriptors and profiles,
and separately generates `tool-catalog-migration.v1.json` for the frozen 43-source inventory.
The existing gateway `report_readiness` probe is classified separately only at its exact file,
function, alias and closed `status=ok` schema; it is not a governed dispatch tool or a 44th legacy
source. Negative tests reject changes to that classification. Initial projections preserve the
six legacy handlers; H1 remains unadvertised until its binding and migration are implemented.

Content verification and projection compilation are clock-free and prove identity, not current
compatibility eligibility. Catalog construction compares actual prior/current descriptors and a
supplied reference time. The #3413 invocation owner must select the exact directional mapping,
profile and adapter and call the exported compatibility-time validator with its trusted clock on
every invocation. A digest, a previous successful invocation or a generated migration record
cannot authorize an expired or mismatched binding.

Every later implementation must update this decision and the table if verified safe code requires a
contract correction. An incomplete owner, axis, status, bound, interface field or consumer mapping
fails the architecture consistency gate. Runtime conformance, performance and live-model proof
remain #3415/#3390 delivery criteria. This imposes explicit migration work but prevents silent
schema drift, false readiness and competing authority systems.

## Version History

| Version | Date | Change |
| --- | --- | --- |
| 1.0 | 2026-09-04 | Accept the governed-tool ownership, pure package boundary, version/digest/result/state/evidence contract and workspace-only coding raw-coordinate lane (#3411); implementation belongs to the named delivery owners. Consolidate delivery into owner-selected PR #3394 with reviewed producer checkpoints instead of dedicated dev merges. |
