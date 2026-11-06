# ADR-0171: Gateway readiness observations and capability reconciliation

## Status

Accepted (Issue #2885, 2026-08-02). Amended by PR #3452 (2026-09-11): D5. Amended 2026-11-01
(customer 1.3.4, owner decision): D2 checks each model once per connection and on demand, with no
background renewal or recovery; D4 scopes the Workbench profile's verification to its chosen model.
Amended 2026-11-05 (owner decision): D2 retains basic-chat readiness for the configured connection
and current process; Chat operations and passive reads never initiate readiness probes. Explicit
Settings verification and connection replacement remain the refresh boundaries. Passive browser
reloads also reuse completed catalog discovery and never restart an exhausted startup burst.

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
Late results for a superseded generation are dropped. Replacing configuration resets the coarse
verification state and clears the field observations of every provider that was changed or removed;
an unchanged provider keeps its observations under the new generation, including when the list was
only reordered (D3). Observations intentionally survive separate HTTP requests in the current
process, but not a process restart; because a replacement resets the coarse verification state,
basic-chat verification starts during configuration initialization after a restart or a replacement. Successful
credential-setup chat checks populate the same generation-bound ledger and are reused. A Chat
create, send, streaming send, regeneration, or grounded question may join an already running
initialization. A successful result remains usable for that configured connection and current
process; elapsed age alone never invalidates it. Malformed or future successful timestamps remain
unknown. Configuration initialization checks each configured chat model once per connection,
through the same generation/model in-flight map and two slots. A connection is the provider entry
with its credential; a proof another model's check persists advances the generation without
changing the connection, so it repeats no check. Startup and explicit readiness probes share the
interactive gateway's five-minute silence floor (#4038), preserving larger configured timeouts.
Interactive admission may join a running startup check with the existing aggregate five-minute
wait across all candidate models, including the selected model. Its deadline only stops that
caller's wait and never authorizes an unverified model or cancels the configuration-owned probe.

Chat create, send, regeneration, grounded questions, model lists, page loads and passive Workbench
profile reads consume the stored result without scheduling provider readiness work. This includes
old failed results and unavailable observations. A passive profile read does not await background
verification. Failed startup remains visible until explicit Settings verification, connection
replacement or a process restart performs another check; the person can therefore retry a
provider that was still starting without a hidden request-time loop. The existing cooldown bounds
the internal initialization/retry helper, while the explicit Settings readiness operation remains
available. Actual inference requests surface their real provider failures and do not add a
preflight health request. The first browser catalog read joins only catalog discovery already owned
by startup, then returns its current projection without repeating discovery or awaiting conversation
and Coding verification. Explicit Settings operations retain their separate discovery and
verification paths.
Chat windows share the initial catalog read and consume existing configuration-change,
readiness-update and explicit catalog-refresh notifications thereafter. If that first snapshot
reports already-running conversation checks, one shared passive follow-up joins their settlement
and adopts the current verdict. It starts no probes and has no retry loop; configuration replacement
or the last subscriber leaving aborts the read. Both server and browser bound this metadata wait
to ten minutes independently of provider and MCP execution bounds. A failed wait remains visible
until an explicit refresh. Time passing, tab visibility
and window focus do not schedule catalog reads. A failed read remains an honest failed observation
until an explicit refresh or a configuration/readiness notification supplies a new result.
Native Node HTTP cancellation wraps the signal reason in `AbortError` with `ABORT_ERR`; readiness
unwraps its `DOMException` reason before classification and diagnostics. Deadline expiry and owner
cancellation remain inconclusive, including on the native transport, and never become a conclusive
capability rejection. The existing readiness completion event
records the inconclusive-probe count without request or response bodies.
The Coding Workbench's tool-calling and long-context probes follow the same rule (customer 1.3.4).
A probe the gateway never answered is no verdict: it gets no six-hour cooldown, does not count as
pending once it settled, and the profile reports `tool-calling-unverified`, never
`no-tool-calling`. Neither a passive profile read nor a timer retries it; startup, a page load and
a profile read that asks (`check=1`, sent when the Workbench opens or a model is chosen) retry it
after a one-minute quiet. A proof that succeeded while the configuration changed under it is
stale and runs again once, at once. The startup timer retries only an unreachable catalog.
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
replaced configuration. A long run retains its basic-chat admission without a competing readiness probe; completion
still records its serving observation time.
`coding-sidecar.gateway.outcome` records `readinessRenewal` (`renewed`, `not-renewable`) on accepted
answers. The Workbench profile describes the model chosen in its picker (`modelId` query; an id
the gateway does not configure falls back to the elected default). Choosing a model reads it with
`check=1`, sent when the Workbench opens and on selection changes: this may explicitly request the
separate tool-calling/context capability verification and join a running startup chat check, but
never starts another basic-chat readiness check. Passive profile reads only describe the current
cached state and return without waiting for provider verification. An observed chat failure is
`conversation-not-ready`; `model-verification-pending` applies exactly while that model has a check
running. A never-settled observation is `unverified`; elapsed age alone does not change a successful
observation or disable Start. A coding run start may await existing configuration-owned readiness
before the unchanged positive-result admission. The profile's `verification` is that model's own
current basic-chat observation (`verified`, `failed`, `unverified`), never the gateway-wide result
last overwritten by another model. The Workbench narrates an actual pending check as progress,
never as an unavailable source or an alert.

Every conversation provider dispatch checks the current generation-bound cached observation.
The model id, configuration generation, positive result and valid non-future timestamp must still
match. Cleared observations, explicit failed probes, replacement, a different requested model and
cancellation deny dispatch. A long call or bounded follow-up needs no completion witness or
additional provider health request merely because five minutes elapsed. This never extends the
caller's deadline, attempt or token grants, nor weakens tool-calling capability or task authority.
The legacy five-minute age boundary is diagnostic only: admission records `allowed-fresh` or
`allowed-cached` for the same valid success. Skill selection and authority refusals are evaluated
before waiting for model initialization and again at turn admission after asynchronous work, so
an already-known refusal neither waits on provider work nor persists a user turn.
`gateway.conversation.admission` records the closed decision and admitted/current generations under
the request correlation. A known refusal before the model port is invoked incurs no physical
synthesis attempt or uncertain output reservation.

Configured embedding connections likewise initialize their default profile's capability and
embedding-space identity once at startup or connection replacement. A genuinely different stored
embedding profile (dimensions parameter, instruction or normalization) obtains its own proof once
on first active use; a default profile never grants another embedding space access. Retrieval
consumes that same connection-owned proof;
elapsed time, Chat creation, focus and reload never renew it. Metadata-only refinements retain the
adapter and proof within the current configuration generation. Each pod still checks its own stored
embedding identity and dimensions locally, and actual query responses retain the existing finite-vector,
normalization, dimension and model validation. A hard credential, model, response or identity failure
retires the positive proof without scheduling passive retries. A transient query transport failure,
timeout, rate limit or HTTP 5xx still refuses that query but retains the already verified identity;
the next actual query may dispatch normally without another capability or fingerprint probe.
A same-alias provider swap with unchanged dimensions and no changed response model or revision
cannot be detected from ordinary query vectors: the measured space fingerprint remains the
connection's observation until explicit Settings verification or connection replacement. This is
the deliberate limit of startup-only verification; no elapsed-time or passive probe is scheduled.
Changed response dimensions, model/revision and invalid vectors still encounter the actual-query
identity/response guards. A stale Pod identity alone refuses that Pod and does not retire another
Pod's otherwise valid connection proof.
An unsuccessful initial capability check retains its original closed failure reason and remains
unavailable until explicit recovery. A caller's cancellation never records provider failure and
cancels only that caller's wait on shared startup work. Explicit Settings model verification (whose
standard probes include the selected retrieval embedding connection) renews its default proof and,
after success, permits failed custom profiles to verify once on their next active use. Connection
replacement and process restart also provide recovery. The existing correlated readiness lifecycle and embedding request operations record startup,
explicit verification and failures without source bodies or credentials. No separate health store or
periodic embedding check is introduced.

A deliberate conversation-eligible human selection remains remembered and unsendable while
unready, then restores on recovery; ready alternatives remain selectable. Automatically elected
choices may fall back to ready alternatives. Actual removal or structural ineligibility permits
the existing fallback, including when a persisted chat is opened or its metadata is upserted.
In-flight requests are coalesced; a configuration or readiness notification invalidates the prior
catalog before adopting its new result. Changed catalogs notify the existing window bus, so an
already open Coding Workbench refreshes its source and runtime posture. This notification adopts
the catalog already read; it neither invalidates the picker nor triggers a recursive catalog fetch.
Recognized LiteLLM connections reuse setup discovery at startup and explicit Settings operations to reconcile their
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
and an older completion cannot clear or attribute its retry. Passive reloads never restart an
exhausted burst or reset an in-flight retry; they consume the current configuration-owned result.
Explicit Settings discovery and connection replacement remain available for recovery. Conversation readiness keeps its own startup and explicit-verification
path (D2); the burst never re-checks basic chat. Rejected credentials and
conclusive invalid catalog responses stop scheduled discovery until the connection changes or an
explicit Settings operation requests a new check. Startup catalog
completion records the applied, unchanged, stale, cancelled or failed disposition and the
configured, changed, added, removed and redeployed model counts under a fresh correlation linked to
the triggering request. A changed count includes the added and removed models; a redeployed model is
one whose observed deployment identity (D5) was first recorded or replaced. Real
completions include the current initialization ordinal and generation. An explicitly tagged
retry-decision phase on the same operation records scheduling, delay/deadline, exhaustion,
coalescing and cache-skip dispositions without claiming another catalog request. Failed completion
and exhausted-burst evidence remain diagnostic through the original incident reader. Catalog retries retain a connection-bound deadline across readiness refinements, so a
successful probe cannot trigger immediate repeated discovery during a catalog outage. Successful
discovery is reused until the connection changes or an explicit Settings operation requests a new
check. The compatibility `refresh=1` workspace model request joins already-running startup catalog
discovery, returns the current projection and records the cached discovery disposition without
starting provider work or awaiting a scheduled retry. Concurrent
reloads share configuration-owned startup state, retry deadlines remain effective, and projection
reads never trigger another gateway discovery. Completion uses the existing correlated, body-free
catalog operation. Completed discovery is reused across nonconnection bounds refinements through
the existing connection comparator, independent of representative model identity or ordering;
endpoint, credentials, effective protocol, credential header
and API-version changes invalidate it. Automatic onboarding treats the key-scoped `/models` listed IDs as the model
inventory and uses management metadata only to enrich exact matching IDs; a successful management
response cannot invent a selectable deployment or replace a forbidden or empty model list.
This listing does not prove a live deployment: LiteLLM may retain names from key/team grants after
a router deployment is removed. Live reachability remains a separate readiness observation.
New Coding run admission and the passive Coding profile use the original selector over the same
current holder's positively observed serving candidates. An explicit failed chat observation yields
`conversation-not-ready`; unknown, malformed or future successful observations remain unverified.
`model-verification-pending` describes actual in-flight verification. This check occurs when the new run's context is minted. An already
admitted gateway request retains its captured profile and admission-time feature proof (F73), so
elapsed basic-chat observation age does not strand its task. The Coding picker excludes only explicit negative
serving observations, preserves selected or saved unknown choices as pending, and elects a default
over ready candidates only when no human choice remains, with the election Chat uses
(`electConversationDefault`: gateway-declared chat models first, special-purpose engines last,
wire order only as the tie-break). A human choice whose forced tool-call proof lapsed or was
withdrawn is also kept pending while the server renews it: the models wire reports
`toolCallingRenewalPending` for a LiteLLM chat model whose automatic verification is open, and the
browser holds only such a choice (`isCodingWorkbenchProofRenewing`). A choice that is refuted,
never proven, not a chat model, observed unready or not being renewed still falls back to a usable
alternative. The compatibility wire field `conversationReadinessStale` is no longer emitted for
elapsed basic-chat observation age: cached success stays ready. Explicit verification or a changed
connection can replace that result. Repeated pending-profile timer reads reuse the catalog
already held; existing configuration, readiness and explicit-refresh notifications deliver subsequent
catalog changes through the window bus.
Catalog adoption, held/restored/fallback/refused selections and profile refresh use the existing
routine client-stage transport. Decisions carry closed outcomes and actual bounded catalog counts;
selection identity uses an optional digest. Profile reads carry their actual HTTP correlation,
validated original catalog parent, measured elapsed time and whether a catalog reread was requested,
skipped or absent; they cannot invent model counts. The first bootstrap requests discovery once
per document lifetime, and an unchanged catalog does not rebroadcast an update. A
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

The existing coarse `GatewayVerificationState` continues to drive reachability-oriented editor
surfaces. It is neither replaced by nor inferred from the per-field ledger. Every probe of any model
overwrites it, so it never describes one model: the Coding Workbench profile instead publishes its
chosen model's own basic-chat observation (D2). The two
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
- Basic-chat readiness runs once per configured connection at initialization after restart or
  connection replacement and reuses successful credential checks. Requests and passive reads
  consume that result without age-based renewal or automatic recovery traffic. Explicit Settings
  verification remains available; actual provider requests report runtime failures normally.
- Passive Workbench profile reads return the current projection immediately, even when a provider
  verification is still running. Capability proof, configuration and authority denials remain intact.
- A coding run admitted with a fresh tool-calling proof is not stranded when the proof ages out
  mid-run; a new run still needs a fresh proof.

## References

- [ADR-0003](ADR-0003-model-gateway-boundary.md)
- [ADR-0129](ADR-0129-product-wide-authority-and-autonomy-model.md)
- [Issue #2885](https://github.com/oscharko-dev/Keiko/issues/2885)
