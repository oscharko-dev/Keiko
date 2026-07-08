# ADR-0117: Type-aware memory decay (semanticization) — per-type disuse half-life, env-gated rollout

## Status

Accepted (MemoriaViva forgetting-model milestone)

## Version

0.1.0

## Context

MemoriaViva's forgetting model (Epic #204) decays every memory at ONE disuse half-life (45 days),
shared between the retrieval reinforcement curve
([`strength.ts`](../../packages/keiko-memory-retrieval/src/strength.ts)) and the maintenance
archive/forget planner ([`maintenance.ts`](../../packages/keiko-memory-governance/src/maintenance.ts)).
A single rate is not how human memory forgets. The complementary-learning-systems model
(McClelland/McNaughton/O'Reilly) distinguishes a fast-learning, fast-FADING episodic store
(hippocampal — specific events) from a slow-consolidating, durable semantic/procedural store
(neocortical — gist facts and skills). "Semanticization" is the transfer between them: the specific
dinner fades in weeks; that the user is vegetarian persists for years. Under a flat half-life, an
aging episodic detail is retained exactly as long as an aging semantic fact — the model forgets the
wrong things.

## Decision

### D1 — A per-type decay half-life multiplier, in the leaf contract

`keiko-contracts` gains a frozen, TOTAL-over-`MemoryType` preset
`MEMORY_TYPE_DECAY_HALF_LIFE_MULTIPLIERS` plus a pure lookup `decayHalfLifeMultiplierForType(type,
overrides?)`. The values are MULTIPLIERS on the base disuse half-life
(`effectiveHalfLife = baseHalfLife * multiplier`): episodic `0.5` (fades fastest), procedural `2`
(most durable — skills persist), semantic-fact / preference `1.5`, decision `1.25`, and
correction / negative / pinned `1` (governance artifacts whose retention is driven by
supersession/conflict semantics, and pinned never decays anyway). The lookup is fail-safe: a
malformed override (`0`, negative, NaN, Infinity) is ignored in favour of the preset, so a
misconfiguration can never zero or invert a memory's decay. A new `MemoryType` surfaces as a
compile+runtime gap rather than silently defaulting.

### D2 — Applied at the owning forgetting layer, byte-identical by default

The maintenance planner's `effectiveStrength` gains an optional per-type multiplier map. Because
`effectiveStrength` already receives the full `MemoryRecord`, `record.type` is available with no new
plumbing. When the map is ABSENT, every type uses the flat `halfLifeMs` — byte-identical to the
pre-semanticization curve, honouring the established convention that every optional memory signal is
byte-identical when the caller does not opt in. A partial override tunes one type while untuned types
fall back to the recommended preset (never a silent `1`). Retrieval-side ranking is unchanged in this
milestone (the reinforcement subscore is keyed by access stats without record type); semanticization
is scoped to the archive/forget decision where "Vergessen" actually lives.

### D3 — Env-gated rollout (default OFF), mirroring `KEIKO_MEMORY_FUSION`

Type-aware decay is a behavioural change to forgetting with a broad blast radius on which memories
archive/forget and when. Following how RRF fusion shipped (behind `KEIKO_MEMORY_FUSION` before
becoming default), the server enables it only under `KEIKO_MEMORY_SEMANTICIZATION=1`, resolved once by
`memorySemanticizationMultipliers(env)` and threaded through both the on-demand
(`POST /api/memory/maintenance`) and the bounded autonomous (post-chat, O-V4) maintenance passes.
Default OFF keeps existing forgetting behaviour — and its retrieval/forgetting evaluation evidence —
unchanged. Flipping the default to ON is a deliberate follow-up gated on eval evidence, not a silent
behaviour change here.

## Consequences

### Positive

- Aged episodic details fade — and archive/forget — sooner than durable semantic facts, preferences,
  decisions, and skills, so MemoriaViva forgets the volatile and keeps the durable, as a human memory
  does. Demonstrated at three layers: the contract lookup, the pure `effectiveStrength`/planner (an
  episodic memory archives at an age where an identical-confidence semantic fact does not), and the
  server route under the env flag.
- Zero behavioural change and zero test churn by default (opt-in), preserving the green bar and the
  ratcheted coverage baseline.

### Negative / Neutral

- Confidence remains immutable provenance (O-V2): semanticization changes the decay RATE, never a
  memory's captured confidence.
- The preset values are a first, defensible calibration; tuning them (or flipping the default on) is a
  follow-up backed by the retrieval/forgetting evaluation gates.

## Related

- Epic [#204] — MemoriaViva governed enterprise memory vault; O-V1 outcome-driven forgetting, O-V2
  confidence immutability, O-V4 bounded autonomous maintenance.
- [`packages/keiko-memory-governance/src/maintenance.ts`](../../packages/keiko-memory-governance/src/maintenance.ts) —
  the maintenance planner where the multiplier is applied.
- [ADR-0116](ADR-0116-realtime-voice-live-memory-recall.md) — the conversational-memory sibling
  milestone (plasticity/recall); this ADR is the forgetting sibling.

## Date

2026-07-07
