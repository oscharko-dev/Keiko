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
field cannot survive a narrower categorical result as stale evidence. A chat-only or wholly
inconclusive run produces no categorical evidence and leaves the last same-generation observation
unchanged; a failed readiness run clears it. Observations contain no response body, endpoint,
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
initialization, and never initiates a provider readiness test for a model that is ready or whose
readiness was never observed. Failed initialization remains
visible. Inconclusive transport or provider failures recover through configuration-owned background
probes with exponential backoff capped at five minutes; retries continue at that capped rate until the
provider recovers or the configuration changes. A conclusive rejection (for example a 4xx the gateway
gives while it is still starting) is retried in the background every five minutes. The first
conversation request that needs the model after the 30-second not-ready cooldown starts one fresh
probe, dated by the probe that last settled rather than by a preserved feature-observation
timestamp. Concurrent requests join that probe, a failed one refreshes the cooldown, and a
malformed observation timestamp never triggers it, so a dead gateway costs at most one bounded probe
per model per cooldown. This restores the 1.1.11 behavior that 1.1.13 removed together with the
per-question checks: without it one conclusive answer at startup left the model not-ready until a
restart or a Settings change. Visible model consumers read the local catalog every five seconds
while startup readiness is settling (a two-minute fast window), then every minute for an unchanged
catalog. Hidden tabs pause and catch up immediately on visibility or focus. Failed reads back off
from five seconds to one minute and report one correlated transport failure per outage streak.
A configured human selection remains remembered and unsendable while unready, then restores on
recovery; an actual removal still permits the existing fallback. Background reads do not clear a
usable selection. Only
in-flight requests are cached; settled model responses cannot conceal subsequent readiness results.
Changed background catalogs notify the existing window bus, so an already open Coding Workbench
refreshes its source and runtime posture without requiring Settings. This notification adopts the
catalog already read; it neither invalidates the picker nor triggers a recursive catalog fetch.
Recognized LiteLLM connections also reuse setup discovery at startup to refresh declared context
limits for configured models. Startup never expands the operator's selected deployments or copies
resolved credentials to another model. Context refinements use the current configuration and the
existing monotonic window-adoption rule, preserving declared ceilings and concurrent refinements.
Existing connections, policy, and configured models are retained. A bounded serial queue verifies missing or expired
tool-call proofs without opening Settings or the Workbench. Unknown context windows use the
existing context proof. Inconclusive discovery and tool checks retry after their one-minute
cooldown, with exponential startup backoff capped at five minutes. Rejected credentials and
conclusive invalid catalog responses stop discovery until the connection changes. Startup catalog
completion records the applied, unchanged, stale, cancelled or failed disposition and configured
and changed-model counts under a fresh correlation linked to the triggering request. Catalog retries retain a connection-bound deadline across readiness refinements, so a
successful probe cannot trigger immediate repeated discovery during a catalog outage. Successful
discovery is reused until the connection changes. Disabled Coding and subscription sources never
initiate these tool checks.
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
failure remains retryable without another provider call. A successful write replaces the runtime
generation and clears every remaining observation.

### D4 — Whole-gateway verification remains independent

The existing coarse `GatewayVerificationState` continues to drive reachability-oriented editor and
Coding Workbench surfaces. It is neither replaced by nor inferred from the per-field ledger. The two
signals answer different questions: whether the configured gateway answered, and which model fields
were specifically observed.

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

## Consequences

- Capability consumers keep using deliberate persisted configuration rather than transient traffic.
- Operators can see and reconcile contradictions without editing local files.
- A stale browser or delayed probe cannot apply values measured against another configuration.
- A failed persistence attempt leaves the generation-bound observation available for an identical
  retry; it can never cross a configuration replacement.
- A context-window lower bound cannot silently shrink a correctly configured model capacity.
- Basic-chat readiness runs at initialization after restart or configuration replacement and reuses
  successful credential checks; interactive Chat never adds a readiness request for a ready or
  never-observed model, and re-probes a failed one at most once per not-ready cooldown.
- A coding run admitted with a fresh tool-calling proof is not stranded when the proof ages out
  mid-run; a new run still needs a fresh proof.

## References

- [ADR-0003](ADR-0003-model-gateway-boundary.md)
- [ADR-0129](ADR-0129-product-wide-authority-and-autonomy-model.md)
- [Issue #2885](https://github.com/oscharko-dev/Keiko/issues/2885)
