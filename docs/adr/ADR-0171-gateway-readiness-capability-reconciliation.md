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
verification state. Passed probes record `true`; only the categorical `unsupported` result records
`false`. Failed and skipped probes record no field value. A successful long-context probe may record
the tested token count. Observations contain no response body, endpoint, credential, or customer
content.

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

Settings compares the current model capability with the readiness report, renders each disagreement,
and offers an explicit **Apply verified values** action. The UI asks the local human for confirmation.
The PATCH request contains only disagreeing fields.

The server accepts a field only when its exact value exists in the current generation's observation
ledger for that model. Missing, stale, invented, or mismatched values fail closed. A successful apply
persists the sealed gateway configuration through the existing credential-safe writer, replaces the
runtime generation, and consequently clears the observations it consumed.

### D4 — Whole-gateway verification remains independent

The existing coarse `GatewayVerificationState` continues to drive reachability-oriented editor and
Coding Workbench surfaces. It is neither replaced by nor inferred from the per-field ledger. The two
signals answer different questions: whether the configured gateway answered, and which model fields
were specifically observed.

## Consequences

- Capability consumers keep using deliberate persisted configuration rather than transient traffic.
- Operators can see and reconcile contradictions without editing local files.
- A stale browser or delayed probe cannot apply values measured against another configuration.
- Readiness must be rerun after restart or configuration replacement, which is intentional because
  no current live observation exists then.

## References

- [ADR-0003](ADR-0003-model-gateway-boundary.md)
- [ADR-0129](ADR-0129-product-wide-authority-and-autonomy-model.md)
- [Issue #2885](https://github.com/oscharko-dev/Keiko/issues/2885)
