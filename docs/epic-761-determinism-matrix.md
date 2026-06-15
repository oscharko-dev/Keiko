# Epic #761 — Determinism & model-independence matrix

This note records the model-independence and reproducibility guarantees of the Quality
Intelligence (QI) generation backbone, and the unit matrix that pins them. The matrix runs against
a fake gateway (no network); see
[`matrix.test.ts`](../packages/keiko-server/src/qualityIntelligence/__tests__/matrix.test.ts).

## Capability routing (Issue #762)

QI selects a test-design strategy by capability, not by hard-coded model id:

1. An explicitly requested, configured chat model wins.
2. Otherwise the cheapest configured chat model with structured output wins.
3. Otherwise the cheapest configured chat-only model wins.
4. Otherwise QI runs a deterministic no-model baseline.

Structured output is therefore a preference for `qi:test-design`, not a hard blocker. The
structured path still gets `json_schema` when the chosen model advertises response-format support;
chat-only models degrade to the tolerant parser.

| Capability set                            | Outcome                              |
| ----------------------------------------- | ------------------------------------ |
| chat + structured-output (single tier)    | selected                             |
| chat + structured-output (multiple tiers) | lowest-cost structured tier selected |
| chat only (no structured-output)          | selected, tolerant-parser path       |
| no model configured                       | successful no-model baseline run     |

The table above describes the **test-design generation** strategy. A full automatic run also routes
the adversarial test-quality judge, which uses the `qi:judge-logic` profile and therefore requires a
configured **structured-output** model. When an automatic run (no explicitly requested model) selects
a chat-only generation model but no structured-output model is configured for the judge, the run is
accepted, generation uses the tolerant parser path, and the unavailable judge is skipped. The
resulting run records `qualityScore: null`, persists no `test-quality` findings, and counts only the
generation gateway dispatch. An explicitly requested chat-only generation model paired with a
separate structured-output model still runs end to end with the judged path.

The judge is selected by capability through `resolveModelForQiCapability(deps, "qi:judge-logic")`,
never by model id. The matrix pins both judge states in
[`matrix.test.ts`](../packages/keiko-server/src/qualityIntelligence/__tests__/matrix.test.ts) (the
"Epic #761 judge tier" block); the end-to-end skip (run accepted, `qualityScore: null`, no
`test-quality` findings) is pinned in `runExecution.test.ts`.

| Judge capability set                         | Outcome                                                                 |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| structured-output model configured           | lowest-cost structured-output model selected for the judge              |
| chat-only models only (no structured-output) | typed `QI_CAPABILITY_UNAVAILABLE` → judge skipped, `qualityScore: null` |

## Multimodal (vision-augmented) tier (Issue #764)

The fourth capability cell is the vision-augmented Figma snapshot stage (Issue #810). It is routed by
the `supportsImageInput` capability through `resolveQiMultimodalSelection`, never by model id, and
degrades to the deterministic IR-only baseline — a typed `unavailable` that the vision hint provider
turns into an empty hint set — when no multimodal model is configured. It never silently substitutes a
text model that would pretend to have seen the image. The matrix pins both states in
[`matrix.test.ts`](../packages/keiko-server/src/qualityIntelligence/__tests__/matrix.test.ts) (the
"Epic #761 chat+multimodal tier" block); the selection contract lives in `resolveQiMultimodalSelection`
(`modelSelection.ts`) and the fail-safe provider in `figmaSnapshotAdapter.ts`.

| Capability set                                | Outcome                                              |
| --------------------------------------------- | ---------------------------------------------------- |
| chat + multimodal (image-input model present) | lowest-cost `supportsImageInput` model selected      |
| multimodal removed (no image-input model)     | typed `unavailable` → deterministic IR-only baseline |

## Determinism-first contract (Issue #763)

- Structural stages are model-free and replayable. Coverage mapping, deduplication, validation,
  and candidate-id derivation never call a model. Every candidate id is a content hash
  (`sha256(ordinal | title | cited atoms)` for model candidates, `sha256(atom hash | ordinal)` for
  structural candidates), so identical inputs yield identical ids regardless of run id or model tier.
- Every run starts from the deterministic structural baseline. Model output is appended only as a
  non-duplicate, attributed delta. The evidence manifest records `modelId`, request parameters
  actually used (`modelParameters`, for example `responseFormat` and `seed`), and `seedUsed`.
- Graceful degradation is explicit:
  - response format is sent only when the chosen model advertises `supportsResponseFormat=true`
  - seed is sent only when the chosen model advertises `supportsSeeding=true`
  - no configured model still yields a succeeded baseline run with zero model calls

## Reproducibility (Issue #764)

| Property                                          | Guarantee                                               |
| ------------------------------------------------- | ------------------------------------------------------- |
| Same inputs, different model tier → candidate ids | identical (content-hashed, model-independent)           |
| Evidence attribution for model runs               | `modelId` recorded; `seedUsed` is number or `null`      |
| No-model baseline                                 | run succeeds; `modelId` and `seedUsed` are both omitted |
| Explicit seeded run                               | requested seed is persisted only when actually applied  |
| Multimodal model used during ingestion            | vision dispatches count toward `modelGatewayCallCount`  |
| Multimodal removed (no image-input model)         | IR-only baseline; no model id recorded for the stage    |

This means seeded reproducibility is now a real end-to-end path, not a placeholder field: a valid
start request can carry `seed`, the gateway request carries it when supported, and evidence records
the applied value. Unseeded model runs persist `seedUsed: null`; baseline runs omit `seedUsed`
entirely because no model participated.

Re-check targeted regeneration (`POST /runs/:id/regenerate-stale`) records `seedUsed: null` for its
model paths because the original run's seed is not stored in the manifest and the regeneration
request does not carry one — not because the selected model lacks seeding support. A re-checked run
still carries its own `modelId` and `modelParameters`, so it stays attributable; only the seed is not
replayed. Storing the original seed for seed-replayable re-checks is a deliberate non-goal of #763.
