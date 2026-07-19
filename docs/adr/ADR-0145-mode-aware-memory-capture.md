# ADR-0145: Mode-aware memory capture

## Status

Accepted (Issue #2546, Epic #2537, Memory M1.1, 2026-07-19).

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
gap. The companion Memory Journal (#2547, M1.2) will render the `proposed` vs. `accepted`
distinction this ADR establishes, so the distinction must be meaningful before the Journal ships.

This ADR establishes memory capture as a governed autonomy-capable surface and fixes the one
open design question: what does mode *do* to a capture outcome, and where does that decision sit
relative to the content-based hard denials that already exist.

## Decision

### D1 — Memory capture reuses the canonical mode vocabulary; no memory-local autonomy model

Memory capture consumes `CodingWorkbenchMode` from `@oscharko-dev/keiko-contracts`
(`coding-workbench.ts`) via a type-only import, exactly as ADR-0129 D5 requires of a non-coding
surface borrowing the coding-flavored contract home. No memory-local mode type, approval
vocabulary, or parallel authority stack is introduced.

The effective mode for a captured turn is the caller's validated, server-owned coding-runtime
deployment ceiling: `deps.codingRuntimeDeploymentCeiling`. This is the same posture signal
`keiko-server` already threads through the coding-runtime routes (established read pattern:
`deps.codingRuntimeDeploymentCeiling ?? "governed-assist"`, `codingRuntimeRoutes.ts:182`); memory
capture reads it rather than inventing a second one. Consistent with ADR-0124 D2's fail-closed
effective-mode rule and ADR-0138's fail-closed restatement, an unknown, missing, or malformed
ceiling resolves to `governed-assist` — the strictest posture — never to a permissive default. A
chat turn carries no mode of its own; the resolution happens once per turn, server-side, from the
already-threaded `deps`, so both the desktop and voice call sites inherit it consistently without a
new wire field.

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

This is a deliberate reuse decision, not an optimization: it keeps memory capture to **one** capture
path (`collectMemoryActions` → `captureSalientFromTurn`), **one** policy module
(`memory-capture-policy.ts`), and **one** promotion lever (`planMemoryMaintenance`/`shouldPromote`).
No second acceptance rule is fabricated outside governance, per §5 of `AGENTS.md` ("do not introduce
a parallel policy or memory subsystem when an existing one can be shaped for the need").

### D5 — Capture stays failure-contained and diagnostics stay content-free

Mode resolution cannot throw (it is a `??` fallback over an already-validated field) and
`planMemoryMaintenance` is a pure function; if either path ever throws, it is caught by
`captureSalientFromTurn`'s existing try/catch boundary, which yields `[]` and leaves the chat
response unaffected — capture failure never breaks a turn, mode-aware or not. Where mode
resolution cannot determine an effective mode (D1's fail-closed fallback), the outcome is
byte-identical to today's pre-mode-aware behavior: `proposed`.

Diagnostics emitted for a captured turn stay strictly content-free, per the evidence-redaction
invariant in `AGENTS.md` §1/§7: mode plus per-status counts and hashes only, never candidate
bodies or user text.

## Consequences

### Positive

- Memory capture now means what the product's autonomy model says it means: Ask for approval holds
  routine memories for review; Supervised workspace and Full access let them through, subject to the
  same confidence gate the maintenance sweep already enforces.
- The Memory Journal (#2547, M1.2) has a real `proposed` vs. `accepted` distinction to render,
  driven by mode, instead of a distinction that was previously a fixed function of content alone.
- Legacy callers that never provisioned `codingRuntimeDeploymentCeiling` are byte-identical to
  pre-change behavior (fail-closed to `governed-assist`, i.e. always `proposed` for routine
  candidates) — no silent behavior change for existing integrations.
- No new capture path, policy module, promotion mechanism, or memory-local autonomy model is
  introduced; the wire/contracts surface for chat and memory is unchanged, so this lands as a
  server-only change with no `keiko-contracts`/`keiko-ui` edit and no measured-surface (D12)
  regeneration.

### Negative

- A `supervised-coding`/`autonomous-delivery` user now gets memories written and made retrievable
  without a review step they may not have anticipated from capture alone; this is the intended
  product meaning of those modes (routine work proceeds unattended) but is a real behavior change
  for existing users who select a higher mode without reading its memory implications.
- The effective mode for capture is inferred from the coding-runtime deployment ceiling, a
  Coding-Workbench-flavored signal (ADR-0129 D5's accepted "coding-flavored contract names serve
  non-coding surfaces" cost) rather than a memory-specific posture; if a future product decision
  splits per-surface mode selection from the coding ceiling, this ADR's D1 mapping needs revisiting.
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
