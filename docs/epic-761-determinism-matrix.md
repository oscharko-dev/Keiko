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

| Capability set                            | Outcome                                |
| ----------------------------------------- | -------------------------------------- |
| chat + structured-output (single tier)    | selected                               |
| chat + structured-output (multiple tiers) | lowest-cost structured tier selected   |
| chat only (no structured-output)          | selected, tolerant-parser path         |
| no model configured                       | successful no-model baseline run       |

## Determinism-first contract (Issue #763)

- Structural stages are model-free and replayable. Coverage mapping, deduplication, validation,
  and candidate-id derivation never call a model. Every candidate id is a content hash
  (`sha256(runId | ordinal | title)`), so identical model text yields identical ids regardless of
  model tier.
- Model output is an attributed delta. The evidence manifest records `modelId`, request parameters
  actually used (`modelParameters`, for example `responseFormat` and `seed`), and `seedUsed`.
- Graceful degradation is explicit:
  - response format is sent only when the chosen model advertises `supportsResponseFormat=true`
  - seed is sent only when the chosen model advertises `supportsSeeding=true`
  - no configured model still yields a succeeded baseline run with zero model calls

## Reproducibility (Issue #764)

| Property                                          | Guarantee                                                |
| ------------------------------------------------- | -------------------------------------------------------- |
| Same inputs, different model tier → candidate ids | identical (content-hashed, model-independent)            |
| Evidence attribution for model runs               | `modelId` recorded; `seedUsed` is number or `null`       |
| No-model baseline                                 | run succeeds; `modelId` and `seedUsed` are both omitted  |
| Explicit seeded run                               | requested seed is persisted only when actually applied   |

This means seeded reproducibility is now a real end-to-end path, not a placeholder field: a valid
start request can carry `seed`, the gateway request carries it when supported, and evidence records
the applied value. Unseeded model runs persist `seedUsed: null`; baseline runs omit `seedUsed`
entirely because no model participated.
