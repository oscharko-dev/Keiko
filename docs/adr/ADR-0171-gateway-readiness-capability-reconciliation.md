# ADR-0171: Gateway readiness observations and capability reconciliation

## Status

Accepted (Issue #2885, 2026-08-02). Amended by PR #3452 (2026-09-11): D5.

## Context

Gateway setup persists declared and discovered `ModelCapability` values. Readiness probes measure
what one configured model can do at one point in time. Previously, the probe report exposed rich
field results to its caller but retained only one coarse whole-gateway verification state. A
categorical disagreement such as a rejected tool-calling request therefore had no queryable
per-model record and no governed reconciliation path.

A failed or unsupported probe is not by itself proof that a model can never support a feature. It
may reflect transient transport failure, rate limiting, provider parser configuration, or the
specific probe shape. Automatically rewriting configuration from probe traffic would silently
downgrade every consumer and violate the human-control invariant.

## Decision

### D1 — Readiness observations are separate from configured capability

`RuntimeGatewayConfig` owns a per-model, per-field observation ledger alongside its existing coarse
verification state. Passed categorical probes record `true`; only the categorical `unsupported`
result records `false`. Failed and skipped probes record no field value. A run with categorical
evidence replaces the model's complete usable observation set for that generation, so an omitted
field cannot survive a narrower categorical result as stale evidence. A chat-only run can update
actual serving readiness while retaining uncontradicted feature evidence with its original
`checkedAt`; its separate `conversationCheckedAt` dates the actual chat result. A chat failure
records unavailable serving without refreshing retained feature proof. Executed contradictory
feature probes replace or clear their evidence through the existing reconciliation owner.
Observations contain no response body, endpoint,
credential, or customer content.

A successful long-context probe proves only that the model accepted at least the tested token count.
It does not establish the exact context window and is therefore displayed as readiness evidence but
is never recorded or offered as a configurable `contextWindow` replacement.

Configured `GatewayConfig.capabilities` remains the durable product configuration and is never
mutated merely because readiness ran.

### D2 — Observations bind to one live configuration generation

Every readiness run captures the runtime configuration generation before asynchronous work begins.
Late results for a superseded generation are dropped. Replacing configuration clears all field
observations and the coarse verification state. Observations intentionally survive separate HTTP
requests in the current process, but not a configuration replacement or process restart; after
either event basic-chat verification starts during configuration initialization. Successful
credential-setup chat checks populate the same generation-bound ledger and are reused. A Chat
create, send, streaming send, regeneration, or grounded question may join an already running
initialization. A fresh successful observation adds no per-question readiness request. A success
expires at the exact five-minute boundary; malformed or future successful timestamps are unknown.
The existing background queue renews success after two minutes and uses the same generation/model
in-flight map, two slots and recovery timers. Automatic and on-demand probes share the interactive
gateway's five-minute silence floor (#4038), preserving larger configured timeouts: a two-minute
probe must not declare a model unavailable while an ordinary three-minute answer is still within
its supported wait. The five-minute freshness interval remains unchanged. A renewal that outlives
it remains shared by callers; expiry never grants unverified admission. Interactive admission uses
the same five-minute aggregate wait across all candidate models, including the selected model;
it must not abandon a healthy pending check after 45 seconds. Expiry stops that caller's wait,
leaves the single shared probe owned by configuration, and does not authorize an unverified model.
Reload starts unknown or expired checks immediately
in the background, independently of held catalog discovery; selected requests join that same work.
An expired success can share one selected-request renewal. Failed initialization remains
visible. Inconclusive transport or provider failures recover through configuration-owned background
probes with exponential backoff capped at five minutes; retries continue at that capped rate until the
provider recovers or the configuration changes. Background renewal and recovery run only while a model is in
use (#4103, owner decision 2026-10-29): once a model of the current generation has been verified,
no conversation request for it for 15 minutes (`CONVERSATION_RENEWAL_IDLE_MS`) stops both, and
`gateway.readiness.renewal.paused` records the pause (`renewal` or `recovery`, with the idle time).
Its success then expires at the five-minute boundary, and its next request starts the single
on-demand probe and resumes the schedule. A model never verified in this generation keeps recovering,
so a gateway that is still starting is reached without anyone asking. A conclusive rejection (for example a 4xx the gateway
gives while it is still starting) is retried in the background every five minutes. The first
conversation request that needs the model after the 30-second not-ready cooldown starts one fresh
probe, dated by the probe that last settled rather than by a preserved feature-observation
timestamp. Concurrent requests join that probe, a failed one refreshes the cooldown, and a
malformed observation timestamp never triggers it, so a dead gateway costs at most one bounded probe
per model per cooldown. This restores the 1.1.11 behavior that 1.1.13 removed together with the
per-question checks: without it one conclusive answer at startup left the model not-ready until a
restart or a Settings change. Visible model consumers read the local catalog every five seconds
through the initial two-minute window, including when cached models already look ready, then every
minute for an unchanged catalog. Hidden tabs pause and catch up immediately on visibility or focus.
Failed reads back off from five seconds to one minute and report one correlated transport failure
per outage streak.
Native Node HTTP cancellation wraps the signal reason in `AbortError` with `ABORT_ERR`; readiness
unwraps its `DOMException` reason before classification and diagnostics. Deadline expiry and owner
cancellation remain inconclusive, including on the native transport, and retain bounded recovery
instead of becoming a conclusive capability rejection. The existing readiness completion event
records the inconclusive-probe count without request or response bodies.
A busy provider is no verdict on a model already proved ready (#4115, 2026-10-28). When the chat
probe only times out or receives a transient overload status, a same-generation positive basic-chat
observation is kept with its fields and renewed at the probe's time, so a single-slot local model that
is still serving another generation stays selectable and admitted, as standalone OpenCode waits for
it. The gateway verification state is left unchanged, the probe diagnostic is a `provider-busy` warning
instead of an error, and `gateway.readiness.busy-retained` records the closed busy signal and model
digest. An unreachable provider, a model never proved ready and a replaced configuration keep the
ordinary not-ready recording.
A coding run's accepted answer is serving evidence for its model (#3907 AC3, 2026-10-30). The coding
sidecar route renews a same-generation positive basic-chat observation at the answer's completion
when the answer finished with `stop`, `tool_calls` or `length` and came from the configuration the
holder still serves. It never establishes readiness, repairs a failed observation or crosses a
replaced configuration. A long run therefore no longer lets the model's success expire while
background renewal is paused, and no probe competes with the run's turns.
`coding-sidecar.gateway.outcome` records `readinessRenewal` (`renewed`, `not-renewable`) on accepted
answers. A Workbench profile read that finds the elected model's success expired joins the running
check or starts the one on-demand check, as a Chat request does; a fresh success adds no probe. The
Workbench narrates `model-verification-pending` as a check in progress, never as an unavailable
source or an alert.
A conversation's first provider dispatch still requires fresh readiness. A completed successful
call gives only that turn's existing model-port wrapper a continuation witness, valid for the same
five-minute interval from completion. A bounded follow-up or citation repair can use it when the
original positive probe merely aged during the call. The current observation must remain positive
with a valid, non-future timestamp and the admitted model and configuration generation must still
match. Cleared observations, explicit failed probes, replacement, a different requested model and
cancellation continue to deny dispatch. Only normalized `stop`, `tool_calls` and `length` responses
can establish the serving witness; `error`, `cancelled` and `content_filter` terminal responses
cannot, even when the model promise resolves or the stream emits `done`. A streaming witness also
requires full iterator exhaustion. Failed or unfinished streams create no witness. This does not
update the shared observation ledger, admit another turn, extend a deadline or grant attempts or
tokens. The existing caller's original bounds still govern every continuation.
`gateway.conversation.admission` records the closed decision and admitted/current generations under
the request correlation. A known refusal before the model port is invoked incurs no physical
synthesis attempt or uncertain output reservation.

A deliberate conversation-eligible human selection remains remembered and unsendable while
unready, then restores on recovery; ready alternatives remain selectable. Automatically elected
choices may fall back to ready alternatives. Actual removal or structural ineligibility permits
the existing fallback, including when a persisted chat is opened or its metadata is upserted. Background reads do not clear a
usable selection. Only
in-flight requests are cached; settled model responses cannot conceal subsequent readiness results.
Changed background catalogs notify the existing window bus, so an already open Coding Workbench
refreshes its source and runtime posture without requiring Settings. This notification adopts the
catalog already read; it neither invalidates the picker nor triggers a recursive catalog fetch.
Recognized LiteLLM connections reuse setup discovery at startup and reload to reconcile their
active inventory and declared context limits. Setup records whether a model was automatically
discovered or explicitly selected by the human; legacy configurations without this evidence keep
their unspecified origin. A complete runtime listing removes omitted automatically discovered
models and admits newly listed models through the existing provider parser on the same accepted
connection. Explicit selections remain closed, and unspecified legacy rows are not removed merely
because a listing omits them. A truncated listing can add valid rows but cannot remove omitted
rows; malformed entries reject the complete update. Complete empty runtime listings are valid,
while fresh onboarding still requires a usable model.

The existing runtime configuration holder retains the accepted connection source separately from
its active inventory, including when the last active model disappears. Discovery continues from
that accepted source; metadata persistence retains its credential vault and cannot resurrect
inactive models. A human configuration replacement remains authoritative. Inventory commits require
the captured generation, reject stale credential responses, and preserve only truly unchanged live
observations with their original measurement time. Context refinements use the current
configuration and existing monotonic window-adoption rule, preserving declared ceilings and
concurrent refinements. Declared input and output ceilings retain their actual metadata provenance
independently; later metadata cannot replace a smaller accepted or concurrently refined ceiling.
Capability application clears carried observations before restoring only retained fields at their
original feature and conversation measurement times, so an unrelated tool-only proof cannot grant
conversation readiness. Missing refinement support fails as retryable rather than reporting an
applied catalog update. Existing connections and policy are retained. A bounded serial queue verifies missing or expired
tool-call proofs without opening Settings or the Workbench. Behind a gateway that is not a
recognised LiteLLM connection the same targets, including a chat model nobody has proven (#3578),
are verified through that queue when the Workbench reads its profile (ADR-0124 D5; ADR-0173). A
refuted proof and a model that is no chat model are never targets. Unknown context windows use the
existing context proof. Inconclusive discovery and tool checks share a finite three-step
initialization burst with exponential startup backoff capped at five minutes. The existing timer
and ordinal belong to the captured configuration generation: a replacement resets that burst,
and an older completion cannot clear or attribute its retry. An explicit reload after exhaustion
starts a new burst while respecting the current connection's existing backoff deadline. It does not
reset a retry already in flight. Conversation renewal and interactive readiness retain their
existing recovery paths. Rejected credentials and
conclusive invalid catalog responses stop scheduled discovery until the connection changes or a
browser reload requests a new check. Startup catalog
completion records the applied, unchanged, stale, cancelled or failed disposition and the
configured, changed, added, removed and redeployed model counts under a fresh correlation linked to
the triggering request. A changed count includes the added and removed models; a redeployed model is
one whose observed deployment identity (D5) was first recorded or replaced. Real
completions include the current initialization ordinal and generation. An explicitly tagged
retry-decision phase on the same operation records scheduling, delay/deadline, exhaustion,
coalescing and cache-skip dispositions without claiming another catalog request. Failed completion
and exhausted-burst evidence remain diagnostic through the original incident reader. Catalog retries retain a connection-bound deadline across readiness refinements, so a
successful probe cannot trigger immediate repeated discovery during a catalog outage. Successful
discovery is reused until the connection changes or a browser reload requests a fresh background
check. The initial workspace model request carries `refresh=1`; the BFF immediately returns its
current projection and does not await gateway discovery or model probes. Concurrent reloads share
in-flight discovery, retry deadlines remain effective, and ordinary background projection reads
never trigger another gateway discovery. Completion uses the existing correlated, body-free
catalog operation. Completed discovery is reused across nonconnection bounds refinements through
the existing connection comparator, independent of representative model identity or ordering;
endpoint, credentials, effective protocol, credential header
and API-version changes invalidate it. Automatic onboarding treats the key-scoped `/models` listed IDs as the model
inventory and uses management metadata only to enrich exact matching IDs; a successful management
response cannot invent a selectable deployment or replace a forbidden or empty model list.
This listing does not prove a live deployment: LiteLLM may retain names from key/team grants after
a router deployment is removed. Live reachability remains a separate readiness observation.
New Coding run admission and the passive Coding profile use the original selector over the same
current holder's freshly serving candidates. An explicit failed chat observation yields
`conversation-not-ready`; unknown, malformed, future or expired successful observations yield
`model-verification-pending`. This check occurs when the new run's context is minted. An already
admitted gateway request retains its captured profile and admission-time feature proof (F73), so
chat freshness expiry does not strand its task. The Coding picker excludes only explicit negative
serving observations, preserves selected or saved unknown choices as pending, and elects a default
over fresh candidates only when no human choice remains, with the election Chat uses
(`electConversationDefault`: gateway-declared chat models first, special-purpose engines last,
wire order only as the tie-break). A human choice whose forced tool-call proof lapsed or was
withdrawn is also kept pending while the server renews it: the models wire reports
`toolCallingRenewalPending` for a LiteLLM chat model whose automatic verification is open, and the
browser holds only such a choice (`isCodingWorkbenchProofRenewing`). A choice that is refuted,
never proven, not a chat model, observed unready or not being renewed still falls back to a usable
alternative. The same wire reports `conversationReadinessStale` for a successful serving
observation that aged out, so "was ready, needs a fresh check" is no longer folded into "never
probed"; both stay unknown for admission. Recovery restores the offered model and start
availability. Repeated pending-profile timer reads reuse the catalog
already held; the existing catalog projection poller and window bus deliver subsequent changes.
Catalog adoption, held/restored/fallback/refused selections and profile refresh use the existing
routine client-stage transport. Decisions carry closed outcomes and actual bounded catalog counts;
selection identity uses an optional digest. Profile reads carry their actual HTTP correlation,
validated original catalog parent, measured elapsed time and whether a catalog reread was requested,
skipped or absent; they cannot invent model counts. The first bootstrap requests discovery once
per document lifetime, and an unchanged background catalog does not rebroadcast an update. A
managed new Start requires an actual selected model. Pending readiness evidence retains the closed
stored shortfall as well as its pending projection.
Explicit human deployment selections preserve their metadata-only setup path for gateways without
a models route. Disabled Coding and subscription sources never initiate these tool checks.
Disposal aborts active requests, clears retries, and unsubscribes
the configuration listener.
At most two probes run concurrently per configuration holder, including across replacements;
queued probes of superseded generations are discarded. Ready models are never rechecked per
question. Settings-triggered background work carries a child correlation linked to the request
that changed the configuration. Manual Settings checks remain available. This prevents stale point-in-time evidence from becoming
durable configuration truth and removes an extra model request from interactive Chat traffic.

### D3 — Reconciliation is explicit and server-validated

Settings compares the current model capability with the readiness report, renders each categorical
disagreement, and offers an explicit **Apply verified values** action. The UI asks the local human
for confirmation in an accessible in-app dialog. The PATCH request contains only the selected
disagreeing fields; it cannot expand an inherited/default capability set into unrelated explicit
overrides.

The server accepts a field only when its exact value exists in the current generation's observation
ledger for that model. The handler parses the asynchronous request body first, then captures and
re-checks the current configuration object and generation immediately before the synchronous durable
write and runtime replacement. Missing, stale, invented, mismatched, or concurrently superseded
values fail closed. The `json_schema` observation reconciles both `structuredOutput` and the
provider-facing `supportsResponseFormat` flag because both describe the same verified request shape.
The observation is consumed only after the credential-safe atomic writer succeeds, so a storage
failure remains retryable without another provider call. A successful write that only refines the
`capability` metadata of the same ordered connections (same model ids, endpoints, credentials and
every other connection field) keeps the runtime generation, the coarse verification state and the
remaining observations, then consumes the applied fields; a conversation turn admitted against those
connections stays admitted (#4175: a readiness proof landing mid-turn refused the turn as
`generation-changed`). A write that changes any connection field, the model list or its order
replaces the runtime generation and resets the coarse verification state. It clears the remaining
observations only of providers that were changed or removed; an unchanged provider keeps its
observations under the new generation, including when the list was only reordered.

### D4 — Whole-gateway verification remains independent

The existing coarse `GatewayVerificationState` continues to drive reachability-oriented editor and
Coding Workbench surfaces. It is neither replaced by nor inferred from the per-field ledger. The two
signals answer different questions: whether the configured gateway answered, and which model fields
were specifically observed.

The forced tool-call readiness request follows the model's configured production response path:
streaming models are requested with streaming enabled, buffered models without it. Readiness uses
the production gateway assembler for fragmented native tool calls and final usage, checks the
expected function and exact probe arguments, and retains the existing strict-stream compatibility
fallbacks. A successful ordinary check needs one model request, not separate buffered and streamed
tool probes. A proxy returning a complete JSON answer to a streamed request remains the same
supported fallback as in productive calls; it is not evidence of incremental streaming. Historical
tool-call proofs retain their original timestamp and scope; changing the probe implementation does
not silently refresh them or claim a tool/result-cycle proof.

Embedding verification describes the independently selected configured retrieval model, not the
report's selected chat model. Each executed embedding probe carries its own `modelId`, and a
successful result includes `embeddingModelId` with dimensions and the norm after Keiko's existing
adapter normalization. These fields are report evidence and never add embedding capability to a
chat model or select a new route. The copied report names that retrieval model, and older reports
without its identity say so. The settings completion operation records only its model-id digest
and measured dimensions. A nonzero vector proves endpoint shape, not semantic search quality.

### D5 — An admitted coding run judges the tool-calling proof as of its admission

A forced tool-call proof (`toolCallingVerification`, probe `gateway-tool-calling-v1`) expires 24
hours after its probe (`TOOL_CALLING_VERIFICATION_MAX_AGE_MS`). A model whose proof has expired cannot
be chosen for a new Coding Workbench run, and the sidecar profile names that state
`tool-calling-unverified`, never `non-coding-capable`, because the remedy is a new probe rather
than another model. A run admitted with a fresh proof keeps its model for the life of its runtime
capability: each sidecar call judges the proof as of the instant the capability was issued, which
the capability store records. The capability's own expiry and revocation still bound the run's
access. Until PR #3452 every call judged the proof as of the call, so coding run 24 (2026-09-11),
admitted 3.5 minutes before its proof aged out, had every later call refused and could not recover.
A rule that judges an instant other than now takes it as `{ nowMs }`, never as a bare number, and
`isCodingWorkbenchModel` takes the capability alone: handed point-free to `Array.filter`, a numeric
instant receives each element's index, and coding run 25 (2026-09-11) found the Coding Workbench
judging every model as of the epoch and offering none (F76).

A proof is also bound to the deployment the gateway reports behind the alias. Alias, endpoint and
protocol do not name it: a gateway can re-point `gemma` to another underlying model without moving
any of the three. Discovery therefore digests the management record of every replica of the alias
(its deployment id, underlying model, provider and backend) into one order-independent value that
the provider records as `deploymentIdentitySha256` and the proof fingerprint
(`toolCallingConfigurationFingerprint`) includes once it is observed. A catalog refresh that
observes a different value withdraws the proof the same way a lapsed one is withdrawn: the alias
stays `tool-calling-unverified`, and the readiness queue renews it under a probe key that already
changed with the fingerprint, so the six-hour cooldown of the previous deployment's probe does not
apply. Only digests are stored or logged. A source that states no deployment (the serving list, a
group summary) never clears a recorded identity. The first observation on a provider that had none
also withdraws its proof once, because nothing proves the earlier proof was issued for the
deployment now reported. A gateway declaration such as `supports_function_calling` never grants
`toolCalling`: only the forced live probe does.

## Consequences

- Capability consumers keep using deliberate persisted configuration rather than transient traffic.
- Operators can see and reconcile contradictions without editing local files.
- A stale browser or delayed probe cannot apply values measured against another configuration.
- A failed persistence attempt leaves the generation-bound observation available for an identical
  retry; it can never cross a configuration replacement.
- A context-window lower bound cannot silently shrink a correctly configured model capacity.
- Basic-chat readiness runs at initialization after restart or configuration replacement and reuses
  successful credential checks. Fresh success adds no interactive readiness request; background
  renewal prevents indefinitely cached health, and expired selected requests share the same work.
  Failed observations are re-probed at most once per not-ready cooldown.
- A coding run admitted with a fresh tool-calling proof is not stranded when the proof ages out
  mid-run; a new run still needs a fresh proof.

## References

- [ADR-0003](ADR-0003-model-gateway-boundary.md)
- [ADR-0129](ADR-0129-product-wide-authority-and-autonomy-model.md)
- [Issue #2885](https://github.com/oscharko-dev/Keiko/issues/2885)
