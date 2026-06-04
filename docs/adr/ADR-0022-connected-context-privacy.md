# ADR-0022: Connected Context Privacy Contract

## Status

Accepted

## Date

2026-06-04

## Version

1.0

## Context

Issue #185 ships grounded repository Q&A in the Conversation Center. The orchestrator
composes a `ConnectedContextPack` (defined in #178) carrying the connected scope, the
retrieval query, exploration usage/budget, evidence excerpts, omitted candidates, and
uncertainty markers. The pack is the in-process record of what Keiko looked at, on the
user's machine, to answer a single question.

Two pieces are missing as of `df3c336d` (dev, 2026-06-04):

1. **Visibility.** The browser surface (`GroundedAnswer`) renders the assistant content
   + citations, but tells the user nothing about scope shape, query kind, or budget
   consumption. Users cannot verify what was inspected without trusting the answer.
2. **Privacy contract.** The retention and cleanup semantics of the pack are implicit
   in the code (the pack is GC'd when the BFF route returns) but undocumented. The
   evidence ledger persists separately; users have no committed promise about which
   surface is ephemeral vs. durable, or what travels to the model provider.

Issue #187 closes both gaps with a thin wire surface plus this ADR. It is purposely a
projection of work already done in #178/#185, not new orchestration.

## Decision

### D1 — Packs are ephemeral

`ConnectedContextPack` lifecycle is the duration of one BFF request. There is no
`ConnectedContextPackStore`, no `packs` table, no pack ledger. The orchestrator builds
the pack in `src/grounded-orchestrator.ts`, the route projects it through
`buildGroundedAnswerContextPackSummary` and `buildCitations`, and the original pack
goes out of scope when `runAsk` returns. The runtime garbage collector reclaims it.

Why: the pack carries the full excerpt content (with the raw scope-relative paths and
file bytes). Persisting it would create a second redaction surface co-equal with the
evidence ledger, with no offsetting benefit — the evidence ledger already records the
audited subset.

### D2 — Per-answer summary is wire-only

The wire response carries `contextPack: GroundedAnswerContextPackSummary` on every
`GroundedAnswer` (REQUIRED, non-optional). The summary is structurally
counts-only-plus-enums:

- `schemaVersion`, `scopeId` (opaque BFF-internal id), `scopeKind` (enum), `fileCount`
  (number; `-1` sentinel for `workspace-root`), `queryKind` (enum)
- `usage` (full ExplorationUsage — all numbers)
- `budget` (full ExplorationBudget — all numbers)
- `citationCount`, `omittedCount`, `uncertaintyCount`, `elapsedMs` (numbers)

There is no field that can carry raw file paths, query text, excerpt content, or
credentials. The builder is a pure function with no IO and no redaction step — the
type itself is the redaction contract.

The spec for #187 originally named this `ConnectedContextPackSummary`. That name was
already taken by a dormant 13-field declaration in `connected-context.ts` shipped in
#178 (zero consumers). To avoid a breaking rename, the wire type is
`GroundedAnswerContextPackSummary`; the #178 type stays untouched. The two types serve
different audiences: the #178 type is the in-process UI-safe projection of the full
pack; the wire type is the grounded-answer-scoped projection that adds
`citationCount` and `elapsedMs` from the orchestrator output.

### D3 — Evidence runs survive chat deletion

Deleting a chat removes its messages but leaves any referenced evidence-run manifests
in place. This is a one-way reference: chats point at runs, runs do not point back at
chats. Removing a chat does not cascade into the evidence directory.

Why: evidence is for audit. A user who deletes a chat is signalling "I no longer want
to see this conversation," not "this run never happened." Cascading deletes would
let a user (or an attacker who took over a session) erase their audit trail by
deleting chats. Users who want to remove evidence remove the run manifest directly via
`KEIKO_EVIDENCE_DIR` (or via a future `keiko evidence rm` command tracked in #154).

### D4 — The summary is structurally redaction-free, and we prove it

The wire boundary is asserted by `grounded-qa.redaction.test.ts`: an attacker-controlled
pack with secret-shaped strings (`sk-…`, `ghp_…`, `AKIA…`, `xoxb-…`, `Bearer …`, PEM
blocks) in every string field flows through `runAsk`, and the test asserts:

1. The `contextPack` summary contains none of those shapes (structural — every key is a
   count, enum, or opaque scope id).
2. The `answer.content` and `citations` carry none of those shapes (citations have no
   `content` field; assistant content is sourced from the user's own prompt and the
   orchestrator's content-production rules, not pack strings).
3. The one wire-visible string sourced from the pack today — `uncertainty[].claim` — is
   surfaced verbatim. The pack's upstream layer is responsible for redacting `claim`
   before emitting it. The test documents this contract in-line; any future redaction
   added at the BFF boundary will flip the assertion and trigger an ADR update.

If a future change adds a new field to `GroundedAnswer` or
`GroundedAnswerContextPackSummary` that can carry a string sourced from the pack, this
test will catch it.

## Consequences

**Positive**

- Users see "Searched 3× · Read 5 / 32 files · 12,400 / 131,072 B · 1,812 / 30,000 ms"
  on every grounded answer. They can verify that Keiko did not exfiltrate the whole
  workspace.
- The wire shape is small (well under 600 bytes serialised — pinned in test).
- Redaction is enforced by the type system, not by a runtime scrubber.
- No new persistent surface, no new redaction family, no new DB migration.

**Negative**

- The `GroundedAnswerContextPackSummary` name is one character longer than the spec's
  `ConnectedContextPackSummary`. We accept the verbosity in exchange for keeping the
  #178 contract surface stable.
- `uncertainty[].claim` is the documented soft edge. It is the responsibility of
  upstream layers (the assembler / planner) to scrub `claim` text before emitting an
  uncertainty marker. If that contract ever drifts, the redaction test will not catch
  it (only the test for documented leak field flip will), so a future change adding a
  BFF-side `redact(claim)` is the recommended cleanup.

## References

- Issue #187 — connected context privacy retention & audit controls
- Issue #185 — grounded repository Q&A (introduces `GroundedAnswer`)
- Issue #178 — connected repository context surface (introduces
  `ConnectedContextPack`, `ExplorationUsage`, `ExplorationBudget`)
- Issue #154 — evidence cleanup (future: cascade-delete UX)
- ADR-0010 — evidence ledger schema versioning (the `evidenceSchemaVersion` precedent)
- ADR-0013 — UI persistence (separate concern: chat history)
- ADR-0019 — modular package architecture (the leaf-package rules this contract follows)
- `packages/keiko-contracts/src/bff-wire.ts` — `GroundedAnswerContextPackSummary` +
  `buildGroundedAnswerContextPackSummary` (D2)
- `packages/keiko-server/src/grounded-qa.ts` — `runAsk` wires the summary (D1, D2)
- `packages/keiko-server/src/grounded-qa.redaction.test.ts` — D4 enforcement
- `packages/keiko-ui/src/app/components/desktop/GroundedAnswer.tsx` — `ContextPackSummary`
  presentation
- `docs/connected-context-privacy.md` — user-facing privacy contract
