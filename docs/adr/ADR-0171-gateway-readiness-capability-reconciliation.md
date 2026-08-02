# ADR-0171: Gateway readiness observations and capability reconciliation

## Status

Accepted (Issue #2885, 2026-08-02).

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
result records `false`. Failed and skipped probes record no field value. Repeated observations in
the same generation merge by field so probing one capability does not erase another current result.
Observations contain no response body, endpoint, credential, or customer content.

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
either event the operator must run readiness again. This prevents stale point-in-time evidence from
becoming durable configuration truth.

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

## Consequences

- Capability consumers keep using deliberate persisted configuration rather than transient traffic.
- Operators can see and reconcile contradictions without editing local files.
- A stale browser or delayed probe cannot apply values measured against another configuration.
- A failed persistence attempt leaves the generation-bound observation available for an identical
  retry; it can never cross a configuration replacement.
- A context-window lower bound cannot silently shrink a correctly configured model capacity.
- Readiness must be rerun after restart or configuration replacement, which is intentional because
  no current live observation exists then.

## References

- [ADR-0003](ADR-0003-model-gateway-boundary.md)
- [ADR-0129](ADR-0129-product-wide-authority-and-autonomy-model.md)
- [Issue #2885](https://github.com/oscharko-dev/Keiko/issues/2885)
