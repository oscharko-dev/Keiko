# ADR-0022: Connected Context Privacy Contract

## Status

Accepted

## Date

2026-06-04

## Version

1.1

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

Issue #187 closes both gaps with a thin wire surface, a metadata-only evidence record,
and this ADR. It is purposely a projection of work already done in #178/#185, not new
orchestration.

## Decision

### D1 — Packs are not persisted to disk

There is no `ConnectedContextPackStore`, no `packs` table, no pack ledger, and no file
containing full connected-context packs. The orchestrator builds the pack in
`src/grounded-orchestrator.ts`, and the route projects it through
`buildGroundedAnswerContextPackSummary` and `buildCitations`.

The pack can live beyond one BFF request only inside the process-local micro-index
described in D3.1. That cache stores assembled `ConnectedContextPack` objects, including
excerpt content, so its retention contract is explicit: bounded TTL, bounded size, no
disk persistence, and deterministic cleanup hooks on chat/project lifecycle changes.

Repository search may separately persist its bounded acceleration index. That store is not a
`ConnectedContextPack`: it contains discovery metadata, fingerprints, and lexical hashes rather than
queries or excerpts, and its complete snapshot is AES-256-GCM sealed before the atomic owner-only
write. The key uses an independent `KEIKO_WORKSPACE_INDEX_KEY` → OS keychain → hardened keyfile
namespace. Missing, legacy-plaintext, tampered, or wrong-key snapshots fail closed to a live rescan.

Why: the pack carries the full excerpt content (with the raw scope-relative paths and
file bytes). Persisting it to disk would create a second redaction surface co-equal
with the evidence ledger, with no offsetting benefit. The evidence ledger records the
audited subset as metadata and hashes, not as a full pack.

### D2 — Per-answer summary is wire-only

The wire response carries `contextPack: GroundedAnswerContextPackSummary` on every
`GroundedAnswer` (REQUIRED, non-optional). The summary is structurally
counts-only-plus-enums:

- `schemaVersion`, `scopeId` (deterministic display fingerprint, not the raw
  `SelectedScope.scopeId`), `scopeKind` (enum), `fileCount` (number; `-1` sentinel for
  `workspace-root`), `queryKind` (enum)
- `usage` (full ExplorationUsage — all numbers)
- `budget` (full ExplorationBudget — all numbers)
- `citationCount`, `omittedCount`, `uncertaintyCount`, `elapsedMs` (numbers)

There is no field that can carry raw scope ids, raw file paths, query text, excerpt
content, or credentials. The builder is a pure function with no IO and no redaction
step — the type itself is the redaction contract.

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
`KEIKO_EVIDENCE_DIR` until a first-class evidence deletion control exists.

### D3.1 — Micro-index state is process-local and explicitly cleared

The grounded-answer path may reuse a small `MicroIndex` per connected chat scope. This
index stores full `ConnectedContextPack` values in memory, including query metadata,
selected files, and excerpt content. The server registry is in-memory only and bounded:
entries use the workflow micro-index TTL, the server keeps at most 32 scoped indexes
with at most 8 cached packs per scope, expired entries are swept on an unref'd
background interval and before reuse, and evicted entries call `index.clear()`.

Chat/project lifecycle hooks clear this state deterministically: deleting a project
clears indexes for that workspace root, deleting or closing a chat clears indexes for
that conversation, and replacing or clearing a chat's connected scope also clears the
conversation indexes. This gives #187 explicit cleanup behavior without adding a
persistent context-pack or index store.

### D3.2 — Grounded answers write a metadata-only evidence record

Every successful grounded answer writes an `EvidenceManifest` with
`run.taskType = "connected-context"` and a `connectedContext` section. That section
records selected-scope shape, redacted scope-relative paths, query kind plus query text
hash/byte count, tools/provenance used, citation line ranges, omitted reasons,
uncertainty counts, budget/usage, excerpt byte counts, and hashes of redacted excerpt
content. The generic evidence `context.workspaceRoot` field stores a non-path local
fingerprint for connected-context runs, not the absolute workspace root.

It deliberately does not persist the absolute workspace root, query text, excerpt text,
model prompts, provider configuration, credentials, or full `ConnectedContextPack`
objects. The BFF returns the manifest run id on `GroundedAnswer.evidenceRunId`, and the
UI links to the local evidence detail route for reviewers who need the durable audit
record.

### D3.3 — Explicit connections support bounded recursive orientation and search

An explicitly connected repository or ordinary folder is sufficient scope for a meaningful
orientation or natural-language search request. A filename or symbol is useful for precision,
but is not a prerequisite to inspect the user's accepted root. Empty and punctuation-only
requests still require clarification, and implicit roots retain their narrowing guards.
Repository orientation uses the existing recursive file-discovery facade in addition to
metadata and overview documents; a source-only folder must produce actual source evidence.
Recursive lexical search and file discovery visit the accepted scope without a default file-count
or elapsed-time cutoff. `null` limits express that policy on the wire; internal execution controls
still honor an explicit caller deadline or cancellation. Directory entries stream in bounded batches,
source bytes are processed with bounded concurrency, and only bounded best matches and diagnostic
summaries survive the scan. Text files up to and including 2 MiB are eligible regardless of extension;
images, binary content, unsafe aliases, and larger files are excluded. Ordinary folders do not inherit
Git-oriented generated-directory exclusions merely from names such as `build` or `dist`.
Files above the 2 MiB eligibility ceiling remain visible as excluded candidates and skipped counts;
they do not make an otherwise complete eligible-text scan incomplete. An explicitly narrower
caller byte cap still reports incomplete coverage when it excludes otherwise eligible text.

An explicit identifier or quoted target starts an independent retrieval question even when the
question contains an anaphoric word such as "there". Literal lookup prioritizes actual lexical
content matches ahead of incidental natural-language path overlap. Files with the same basename
remain independent evidence candidates: their names alone cannot establish duplicate content or
facts. Explicit duplicate hints remain supported, and existing output/context budgets bound retained
evidence. When distinct explicit anchors identify different candidate paths, bounded selection
prioritizes coverage of those paths before additional alternatives for an already covered anchor.
Ordinary-folder factual
HTML/text lookups and complete literal absences avoid unrelated code-graph augmentation;
Git-history discovery is not attempted for a folder without Git unless the question requests
history or relationships. Requested definition, relationship, and history evidence retains its
existing retrieval path and reports genuine unavailability.
Existing path denials, explicit ignore policy, output/model budgets and redaction remain enforced.
Filesystem resource exhaustion remains a technical failure: for example, an installation's
descriptor allowance can constrain deeply nested directory traversal. Directory iterators close on
failure or cancellation; an I/O failure never becomes a complete-search claim or a silent scope cap.

The search match identifies where to read; it is not the entire context for the answer.
Connected-context assembly retains each bounded, actually read surrounding window once,
including function bodies and neighboring calls, and binds its evidence atom to the exact
source lines present in that excerpt. Metadata and listing atoms receive source ranges only
after a real read. Compaction narrows ranges to the lines sent. The default match-only
assembler mode remains available to consumers that require exact match slices. Window mode
participates in the micro-index key, so the two modes cannot reuse incompatible packs.

### D4 — The summary is structurally redaction-free, and we prove it

The wire boundary is asserted by `grounded-qa.redaction.test.ts`: an attacker-controlled
pack with secret-shaped strings (`sk-…`, `ghp_…`, `AKIA…`, `xoxb-…`, `Bearer …`, PEM
blocks) in every string field flows through `runAsk`, and the test asserts:

1. The `contextPack` summary contains none of those shapes (structural — every key is a
   count, enum, or display fingerprint).
2. The `answer.content` and `citations` carry none of those shapes (citations have no
   `content` field; assistant content is sourced from the user's own prompt and the
   orchestrator's content-production rules, not raw pack strings).
3. The one wire-visible string sourced from the pack today — `uncertainty[].claim` — is
   redacted at the BFF boundary before it reaches the wire.

The same route also redacts the user question before constructing the model prompt,
redacts citation path metadata before returning it to the browser, and redacts
assistant content before persisting/displaying it. The context-pack summary remains a
structural redaction contract; the rest of the grounded-answer wire surface is protected
by the BFF redactor as defense in depth. The evidence manifest is deep-redacted before
write, and the connected-context audit section stores hashes instead of raw query/excerpt
text.

If a future change adds a new field to `GroundedAnswer` or
`GroundedAnswerContextPackSummary` that can carry a string sourced from the pack, this
test will catch it.

## Consequences

**Positive**

- Users see "Searched 3× · Read 5 / 32 files · 12,400 / 131,072 B · 1,812 / 30,000 ms"
  on every grounded answer. They can verify that Keiko did not exfiltrate the whole
  workspace.
- The wire shape is small (well under 600 bytes serialised — pinned in test).
- The summary's privacy contract is enforced by the type system; string-bearing
  grounded-answer fields are additionally scrubbed by the BFF redactor.
- No new persistent context-pack or micro-index surface, no new redaction family, no
  new DB migration. The new persistent surface is metadata-only evidence in the existing
  ledger.

**Negative**

- The `GroundedAnswerContextPackSummary` name is one character longer than the spec's
  `ConnectedContextPackSummary`. We accept the verbosity in exchange for keeping the
  #178 contract surface stable.
- The BFF redactor only covers known credential-shaped patterns and explicit path/string
  metadata at the grounded-answer boundary. It is not a semantic privacy classifier for
  arbitrary private prose, so users must still avoid putting customer data or credentials
  in chat text.

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
- `packages/keiko-evidence/src/connected-context-evidence.ts` — metadata-only evidence
  manifest builder/persistence (D3.2)
- `packages/keiko-server/src/grounded-context-index.ts` — process-local micro-index
  registry and cleanup helpers (D3.1)
- `packages/keiko-server/src/store-handlers.ts` — chat/project lifecycle cleanup hooks
  (D3.1)
- `packages/keiko-server/src/grounded-qa.redaction.test.ts` — D4 enforcement
- `packages/keiko-ui/src/app/components/desktop/GroundedAnswer.tsx` — `ContextPackSummary`
  presentation
- `docs/connected-context-privacy.md` — user-facing privacy contract
