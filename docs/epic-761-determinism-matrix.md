# Epic #761 — Determinism & model-independence matrix

This note records the model-independence and reproducibility guarantees of the Quality Intelligence
(QI) generation backbone, and the unit matrix that pins them. The matrix runs against a fake gateway
(no network); see
[`matrix.test.ts`](../packages/keiko-server/src/qualityIntelligence/__tests__/matrix.test.ts).

## Capability routing (Issue #762)

QI selects a model **purely by capability** — no QI module references a hard-coded model id. The
`qi:test-design` task profile requires `text` + `structured-output`, which maps to the model-gateway
query `{ kind: "chat", structuredOutput: true }`. Selection reuses
`selectConfiguredModel` (lowest cost wins); an unsatisfiable capability set returns the typed
`QI_CAPABILITY_UNAVAILABLE` error rather than a silent fallback.

| Capability set                            | Outcome                                     |
| ----------------------------------------- | ------------------------------------------- |
| chat + structured-output (single tier)    | selected                                    |
| chat + structured-output (multiple tiers) | lowest-cost tier selected                   |
| chat only (no structured-output)          | `QI_CAPABILITY_UNAVAILABLE` (0 model calls) |
| no model configured                       | `QI_CAPABILITY_UNAVAILABLE` (0 model calls) |

## Determinism-first contract (Issue #763)

- **Structural stages are model-free and replayable.** Coverage mapping, deduplication, validation,
  and candidate-id derivation never call a model. Every candidate id is a content hash
  (`sha256(runId | ordinal | title)`), so identical model text yields identical ids regardless of
  model, seed, or sampling temperature.
- **Model output is an attributed delta.** The evidence manifest records `modelId`, the request
  parameters used (`modelParameters`, e.g. `responseFormat`), and `seedUsed` (`null` when the model
  does not advertise seeding). These are refs/scalars only — no prompt text, no secrets.
- **Graceful degradation.** A model that advertises `supportsResponseFormat` receives a
  `json_schema` response-format hint; one that does not falls back to the existing tolerant parser. A
  seed is sent only when `supportsSeeding` is advertised. No model configured → the deterministic
  baseline still holds (the judge stage is skipped, `qualityScore` is `null`), and only the drafting
  step is unavailable.

## Reproducibility (Issue #764)

| Property                                          | Guarantee                                            |
| ------------------------------------------------- | ---------------------------------------------------- |
| Same inputs, different model tier → candidate ids | identical (content-hashed, model-independent)        |
| Evidence attribution                              | `modelId` recorded; `seedUsed` recorded (null today) |
| No-judge baseline                                 | run still succeeds; `qualityScore` null              |

Seed **values** are not yet plumbed from the run request — the infrastructure (capability flag,
`GatewayRequest.seed`, and the `seedUsed` manifest field) is in place, and `seedUsed` is recorded as
`null` until a seed source is wired. The reproducibility guarantee above does not depend on seeding,
because candidate ids are content-hashed.
