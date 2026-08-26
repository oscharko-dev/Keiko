# ADR-0146: Mode-aware memory capture

## Status

Accepted (Issue #2546, Epic #2537, Memory M1.1, 2026-07-19). Amended by Issue #2549
(Memory M1.4, 2026-07-19) to add the user-selected requested-mode surface described in D1.
Amended by Issue #2864 (2026-07-31) to record that standing and opportunistic maintenance apply
the same D2 autonomy gate before unattended promotion. Amended by Issue #2885 (2026-08-02) to make
the mapping apply uniformly to salience, explicit chat intent, voice recap, and
capture-from-conversation.

## Amends

This decision extends [ADR-0129](ADR-0129-product-wide-authority-and-autonomy-model.md) D1/D6 to
the MemoriaViva memory-capture surface. It does not change any mode value, matrix cell, Authority
Envelope field, or hard denial that ADR-0124, ADR-0129, or ADR-0138 define; it maps one more
surface onto the existing vocabulary, as D6 requires.

## Context

MemoriaViva turn capture (`captureSalientFromTurn` in
`packages/keiko-server/src/memory-salience.ts:304`) is live and default-on: every desktop and
voice chat turn is scanned for salient candidates and, subject to a single boolean gate
(`request.memory.enabled` and a provisioned vault), persisted through
`persistSalienceActions` → `persistCandidate`. The persisted `status` a candidate receives today
is a fixed function of content alone — secret bodies are dropped, `restricted` sensitivity is
rejected, `confidential` sensitivity is capped at `proposed`, and every other public/routine
candidate is inserted as `proposed` — with no notion of the user's currently selected autonomy
posture.

ADR-0129 D1 declares that every autonomy-capable surface in Keiko, current and future, is governed
by the three product-wide modes (`governed-assist`, `supervised-coding`, `autonomous-delivery`)
and D6 requires new autonomy-surface decision records to cite it and document their mapping onto
the shared vocabulary. Memory capture predates that rule and never made this mapping: today a user
in **Ask for approval** and a user in **Full access** get byte-identical capture behavior, even
though the product's stated meaning of Full access is that validated, in-envelope work proceeds
without per-action review. Epic #2537 (MemoriaViva program) and its Wave 1 (#2546–#2551) close this
gap. The companion Memory Journal (#2547's capture-decision projection, rendered by #2548's
Journal UI, M1.2/M1.3) will render the `proposed` vs. `accepted` distinction this ADR establishes,
so the distinction must be meaningful before the Journal ships.

This ADR establishes memory capture as a governed autonomy-capable surface and fixes the one
open design question: what does mode *do* to a capture outcome, and where does that decision sit
relative to the content-based hard denials that already exist.

## Decision

### D1 — Memory capture reuses the canonical vocabulary and bounds a requested mode

Memory capture consumes `CodingWorkbenchMode` from `@oscharko-dev/keiko-contracts`
(`coding-workbench.ts`), exactly as ADR-0129 D5 requires of a non-coding surface borrowing the
coding-flavored contract home. No memory-local mode union, approval vocabulary, ordering, or
parallel authority evaluator is introduced.

The MemoriaViva settings surface stores one user-selected **requested mode** in the existing local
UI SQLite store and projects it with a server-owned monotonic `revision` through
`GET`/`PUT /api/memory/autonomy-policy`. Every `PUT` supplies the revision it observed. An exact
revision may apply any valid mode; a stale revision may apply only a strictly lower-authority mode.
A stale equal or authority-widening request fails with a content-free conflict. This conditional
write is atomic in the store, so a higher-authority request whose client deadline expires can never
land after and overwrite a later downgrade. Desktop chat adds that canonical value to the existing
`ConversationMemoryRequestWire.mode?` field. The field is optional: an absent field preserves the
pre-amendment request shape and behavior.

The effective mode remains server-owned. For a request that carries a mode, the server resolves
`min(requested mode, deps.codingRuntimeDeploymentCeiling)` through the canonical
`resolveEffectiveCodingWorkbenchMode` helper. A client therefore cannot widen authority beyond the
configured deployment ceiling. An unknown or malformed value is rejected at the BFF boundary; a
missing or malformed ceiling fails closed to `governed-assist`. For legacy callers that omit
`mode`, capture keeps the original #2546 behavior and uses the validated deployment ceiling. This
preserves existing integrations byte-for-byte while letting the local human choose a narrower
memory posture or request a higher posture that remains capped by server policy.

### D2 — Per-mode target-status mapping for persistable candidates

For a candidate that already survives the existing content gates (D3, unchanged), the resolved
mode decides the persisted `status`:

| Mode | Routine, public-sensitivity candidate |
| --- | --- |
| `governed-assist` (Ask for approval) | `proposed` — held for human review, suppressed from retrieval |
| `supervised-coding` (Supervised workspace) | `accepted` — routine capture proceeds unattended |
| `autonomous-delivery` (Full access) | `accepted` — routine capture proceeds unattended |

`proposed` records are held in the review queue and are excluded from retrieval, which reads only
`accepted` memories; `accepted` records are immediately retrievable. This gives capture the same
shape the coding matrix already has for effectful, non-hard-denied work: the lowest posture asks
first, the two higher postures proceed. Per ADR-0138's normative monotonicity invariant, raising
the mode may only relax or preserve this outcome, never tighten it — there is no mode in which a
routine-public candidate is accepted at a lower posture but held at a higher one.

`accepted` is not a bare status flip; D4 routes it through the existing governance promotion lever,
so a mode of `supervised-coding` or `autonomous-delivery` is necessary but not sufficient for
`accepted` — see D4.

### D3 — Mode-independent hard denials are evaluated first and stay invariant across modes

Consistent with ADR-0129 D3 ("hard denials stay mode-independent" — extended here from authority
denials to content-triggered ones), the following gates run **before** any mode decision and are
identical in every mode:

- **Secret-bearing candidate bodies** (`scanForSecrets`) are dropped during extraction; they never
  become a persistable candidate, in any mode, and produce zero persisted records.
- **`confidential`-classified candidates** (`classifySensitivity`) are marked `requiresApproval`
  and are therefore never mode-eligible for `accepted`; they are capped at `proposed` in every
  mode, including `autonomous-delivery`.
- **`restricted`-classified candidates** are rejected at persist time (`isPersistableMemoryCandidate`)
  in every mode; no record is written.

Mode changes what happens to a candidate that has already cleared these gates. It never widens
what clears them.

### D4 — `accepted` is routed through the existing governance promotion lever

When D1–D3 make a candidate mode-eligible for `accepted`, the record is **not** inserted as
`accepted` by a new, capture-local decision. It is passed to the existing promotion planner,
`planMemoryMaintenance` (`@oscharko-dev/keiko-memory-governance`, the same function the standing
maintenance sweep calls via `memory-maintenance-handlers.ts`), which applies its own unchanged
`shouldPromote` gate — `status: "proposed"`, `sensitivity: "public"`, and
`strength >= promoteStrength`, where a fresh record's strength is approximated by its provenance
confidence. Only if the plan promotes the record is it inserted with `status: "accepted"`; otherwise
it is inserted `proposed`, exactly as it would be in `governed-assist`. Mode-eligibility is
therefore a gate on top of governance, not a bypass of it: a mode-eligible but low-confidence
candidate in `supervised-coding` still lands as `proposed`.

This is a deliberate reuse decision, not an optimization. Every live capture entry point — salience,
the explicit chat-intent extractor, voice recap, and capture-from-conversation — resolves the same
mode and delegates eligible records to `promoteEligibleMemoryRecord` in
`memory-capture-policy.ts`. That helper owns the single
`planMemoryMaintenance`/`shouldPromote` lever. No entry point may persist an eligible record through
a private acceptance rule or remain permanently `proposed` merely because it entered through a
different transport, per §5 of `AGENTS.md`.

**Latent capture-time vs. maintenance divergence (KEIKO-0555).** D4's "one promotion lever" framing
is behaviourally true today because `shouldPromote` is access-history-blind. The two invocations of
`planMemoryMaintenance`, however, ask the same question against different-shaped state:

- Capture-time promotion (`memory-capture-policy.ts::promoteEligibleMemoryRecord`, called by
  `memory-salience.ts::persistCandidate`) invokes `planMemoryMaintenance([record],
  EMPTY_CAPTURE_ACCESS_STATS, { nowMs: record.createdAt })` — a synthetic single-record context with
  an always-empty access-stats map and `nowMs` pinned to the record's own `createdAt` (age always
  zero).
- The standing maintenance sweep (`memory-maintenance-handlers.ts::runPromotionPhase`, Phase 1 of
  `runMemoryMaintenance`) invokes `planMemoryMaintenance(beforePromote, promoteStats,
  { nowMs, policy: planPolicy })` over the full vault snapshot with real access-stats and the
  actual current `nowMs`.

The two calls therefore evaluate the same predicate against different inputs. A future change that
adds an access-history- or age-sensitive term to `shouldPromote` must be checked against BOTH call
sites for behavioural parity — sharing the planner function alone does not currently guarantee that
capture-time and maintenance-time promotion make the same decision. Do not describe the two call
sites as "unified"; the divergence is latent, not resolved.

### D4a — Maintenance promotion uses the same unattended-acceptance gate

Both the explicit maintenance route and the bounded opportunistic maintenance pass resolve the
effective memory autonomy posture from the same persisted requested mode and server deployment
ceiling used by capture. Promotion from `proposed` to `accepted` is unattended acceptance, so the
promotion phase runs only when `memoryUnattendedAcceptanceAllowed` admits that effective posture.
In `governed-assist`, or when the posture is absent or cannot be resolved, promotion is skipped and
proposals remain available for human review. Consolidation, archive, expiry, and forgetting remain
mode-independent because none accepts a proposal on the human's behalf.

This is the maintenance application of D2 and D4, not a maintenance-local authority model. The
standing and opportunistic entry points both delegate to `runMemoryMaintenance`; neither may call
the promotion planner through an alternate path or infer authority from the auto-maintenance
enabled flag.

### D5 — Capture stays failure-contained and diagnostics stay content-free

Mode resolution cannot throw (it delegates to the total canonical clamp helper) and
`planMemoryMaintenance` is a pure function; if either path ever throws, it is caught by
`captureSalientFromTurn`'s existing try/catch boundary, which yields `[]` and leaves the chat
response unaffected — capture failure never breaks a turn, mode-aware or not. Where mode
resolution cannot determine an effective mode (D1's fail-closed fallback), the outcome is
`governed-assist`. A failed UI hydration also explicitly restores `governed-assist`, while a failed
persist leaves the previously persisted selection unchanged and surfaces a content-free error.
Revision conflicts are not retried as authority changes: the client retains its prior confirmed
mode and must hydrate fresh state before a widening request can be accepted. A stale downgrade
remains admissible at the atomic store boundary, preserving the safer operator intent regardless of
network completion order.

Diagnostics emitted for a captured turn stay strictly content-free, per the evidence-redaction
invariant in `AGENTS.md` §1/§7: mode plus per-status counts and hashes only, never candidate
bodies or user text.

## Consequences

### Positive

- Memory capture now means what the product's autonomy model says it means: Ask for approval holds
  routine memories for review; Supervised workspace and Full access let them through, subject to the
  same confidence gate the maintenance sweep already enforces.
- The Memory Journal (#2547's projection, #2548's UI, M1.2/M1.3) has a real `proposed` vs.
  `accepted` distinction to render, driven by mode, instead of a distinction that was previously a
  fixed function of content alone.
- Legacy callers that omit `ConversationMemoryRequestWire.mode` are byte-identical to the original
  #2546 behavior: the server-owned deployment ceiling remains the effective capture mode.
- No new capture path, promotion mechanism, mode ordering, or memory-local autonomy model is
  introduced. The additive wire field and policy route reuse the existing request, store, and
  canonical clamp seams.

### Negative

- A `supervised-coding`/`autonomous-delivery` user now gets memories written and made retrievable
  without a review step they may not have anticipated from capture alone; this is the intended
  product meaning of those modes (routine work proceeds unattended) but is a real behavior change
  for existing users who select a higher mode without reading its memory implications.
- The requested mode is surface-selected, but the effective mode is still capped by the
  coding-runtime deployment ceiling. A user can therefore persist Full access while the effective
  mode remains narrower; the policy response exposes both values so this is observable rather than
  a silent widening.
- Routing `accepted` through `planMemoryMaintenance` means a mode-eligible candidate can still land
  as `proposed` if its confidence is below `promoteStrength`; this is correct per D4 but is a subtler
  outcome than "mode decides status," and must be documented for support/triage.

### Neutral

- The confidential/restricted/secret hard denials were already mode-invariant in effect (mode did
  not exist as an input before this ADR); D3 makes that invariance explicit and normative rather
  than changing it.
- No change to the sealed-vault write path (ADR-0035): capture still persists exactly the same
  encrypted record shape through the same vault, regardless of mode.

## Alternatives Considered

### Alternative 1: A memory-local autonomy/approval model

- **Pros**: could be tuned precisely to memory's own risk profile (e.g. a fourth "review batch"
  state) without being constrained by the coding-workbench vocabulary.
- **Cons**: directly contradicts ADR-0129 D1 ("no surface may introduce an additional user-facing
  autonomy mode, a surface-local approval envelope, or a parallel authority stack"); would require
  its own UI, its own persistence, and its own drift-prevention machinery that the shared model
  already provides.
- **Why rejected**: ADR-0129 D1 is not advisory; memory capture is exactly the kind of new
  autonomy-capable surface D6 anticipates, and the shared three-mode ladder already expresses the
  needed graduation (hold for review → proceed unattended).

### Alternative 2: Mode controls a new, capture-local acceptance threshold instead of routing through governance

- **Pros**: would let mode directly set an acceptance bar (e.g. a per-mode confidence cutoff)
  without depending on the shared maintenance planner's `shouldPromote` gate.
- **Cons**: creates a second, capture-local notion of "promotable to accepted" that can drift from
  the standing maintenance sweep's notion, doubling the surface a future change to promotion
  criteria must update and violating the reuse-first rule in `AGENTS.md` §5.
- **Why rejected**: `planMemoryMaintenance`/`shouldPromote` already encodes exactly this judgment
  and already runs against every record in the system; mode-eligibility as a gate in front of it
  achieves the product outcome with one promotion lever, not two.

### Alternative 3: Apply the full ADR-0138 resource/risk matrix to memory capture (map capture onto `workspace-contained`/`external-file` resource scopes and risk tiers)

- **Pros**: maximal consistency with the coding-workbench matrix's shape; a single shared evaluator
  would decide capture the same way it decides editor and connector effects.
- **Cons**: memory capture is not a discrete user-initiated effectful action with a resource scope
  and an approval risk tier — it is a continuous, per-turn background classification of already
  content-gated candidates. Forcing it into the closed `(resource scope, risk)` matrix would require
  either fabricating a resource scope that means nothing outside coding (poor fit, per ADR-0129 D2's
  "genuinely new action classes are added to the shared contracts with an ADR note") or overloading
  an existing one incorrectly.
- **Why rejected**: ADR-0129 D2 requires new action classes to be added deliberately, not implied by
  a forced matrix fit; a direct three-mode → target-status mapping (D2 of this record) is the
  correct-sized mapping for a surface whose only decision is "hold for review, or don't," and it
  remains fully within ADR-0129 D1's product-wide model without inventing a matrix cell that would
  mean nothing to any other consumer of the shared matrix.

## Related

- [ADR-0129](ADR-0129-product-wide-authority-and-autonomy-model.md) — D1 (product-wide model), D2
  (action-class mapping requirement), D3 (mode-independent hard denials), D6 (forward citation
  rule this ADR satisfies).
- [ADR-0138](ADR-0138-monotonic-product-wide-autonomy-semantics-and-code-task-terminology.md) — the
  monotonicity invariant D2 of this record inherits, and the fail-closed-to-`governed-assist` rule
  D1 of this record restates for the capture path.
- [ADR-0124](ADR-0124-coding-autonomy-modes-and-sidecar-runtime-authority.md) — D2's fail-closed
  effective-mode rule, the deployment-ceiling signal this ADR reads.
- [ADR-0035](ADR-0035-memory-vault-encryption-at-rest.md) — the sealed vault memory capture
  continues to persist through unchanged.
- [ADR-0019](ADR-0019-modular-package-architecture.md) — dependency direction; this ADR introduces
  no new package-graph edge and no memory-package type sharing across a sideways boundary.
- [ADR-0117](ADR-0117-type-aware-memory-decay-semanticization.md) — precedent for an additive,
  env-independent, default-preserving technique inside the memory subsystem; this ADR follows the
  same "legacy path stays byte-identical" discipline for callers without a provisioned mode.
- Issue #2546 (Memory M1.1 — mode-aware memory capture); parent Epic #2537 (MemoriaViva program);
  companion Issue #2547 (Memory M1.2 — Memory Journal, renders the `proposed`/`accepted`
  distinction this ADR establishes).

## Date

2026-07-19
