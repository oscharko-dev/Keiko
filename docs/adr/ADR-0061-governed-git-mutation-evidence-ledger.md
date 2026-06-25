# ADR-0061: Governed Git Mutation Evidence Ledger

## Status

Accepted

## Context

Epic #470 turns Keiko's read-only relationship to Git into a governed, end-to-end delivery
platform. Issue #471 (ADR-0058) delivered the typed contract surface. Issue #472 (ADR-0059) built
the execution kernel that drives every mutation through one repeatable lifecycle and returns a
structured `GitMutationLifecycleResult`. Issue #473 (ADR-0060) built the approval and preview
presentation layer.

Those three layers produce everything needed for a governed delivery, but they do not persist it.
Issue #474 is the durable record: **for every terminal outcome of a governed Git mutation —
succeeded, blocked, rejected, failed, or recovery-required — produce an immutable, content-free
evidence record, write it to a bounded append-only ledger, and make it exportable as an audit
packet.**

Six forces shape the design:

**Force 1 — Completeness over success-only.** The existing `GitMutationJournal` (ADR-0059, D5)
records only succeeded outcomes for idempotency. Audit coverage requires the opposite semantics:
every terminal outcome — especially failures and blocks — must be recorded, because a block or
policy denial is as auditable an event as a success. The two concerns are disjoint and must remain
structurally separate.

**Force 2 — Content-free by construction, not by discipline.** The record must be safe to write,
store, and export without widening the confidentiality boundary that the contract envelope and the
kernel snapshot hold. Sensitive identifiers (provider remote, approval token, repository path, run
correlation) must be hashed before they touch any persistence layer. Defense-in-depth redaction at
persist and re-read catches any future field that escapes the typed model.

**Force 3 — Reuse, not a parallel evidence subsystem.** The record must reuse the recovery
vocabulary already shipped by #473 (`GitDeliveryRecoveryActionHint`, `GitDeliveryRecoveryStrategyHint`)
and the failure taxonomy shipped by #472. It must not introduce a parallel policy system, a
parallel failure classification, or a second wire type that duplicates the envelope. The "no
parallel evidence/policy subsystem" gate in the PR template enforces this structurally.

**Force 4 — Boundary correctness.** The contract leaf (`keiko-contracts`) cannot import
`keiko-tools` types: it is a strict leaf under ADR-0019 rule 1. The evidence record must therefore
define its own lifecycle-phase vocabulary and recovery-disposition vocabulary, with the
`keiko-tools` builder mapping kernel types to contract types via an exhaustive switch. Drift is
then a compile error, not a runtime divergence.

**Force 5 — Bounded, fail-closed persistence.** The ledger must not grow unbounded and must not
throw into the user path. The existing `EvidenceStore` + `memory-audit-handler` pattern (bounded
date-bucketed append, fail-closed on corrupt entry, best-effort write) is the proven reuse target.
The evidence write is always best-effort: a ledger write failure must never block or fail the
mutation that triggered it.

**Force 6 — The existing idempotency journal names this ADR.** The orchestrator source
(`git-mutation-orchestrator.ts`, line 614–615) carries the comment: "A durable journal (the
evidence ledger, #474) implements the same port over persistent storage." This ADR closes that
named gap.

### Scope boundary (Issue #474)

In scope: the evidence schema (`GitDeliveryEvidenceRecord`) and its companion types
(`GitDeliveryAuditPacket`, `GitDeliveryEvidenceOutcomeClass`, `GitDeliveryRecoveryDisposition`,
`GitDeliveryRecoveryMetadata`, `GitDeliveryEvidenceLifecyclePhase`), total pure derivations for
recovery disposition, redaction rules, the pure evidence-record builder in `keiko-tools`, the
server-side bounded ledger and audit-export endpoint, negative and completeness tests, and this
documentation.

Out of scope: provider/remote execution (#476–#478), recovery execution logic (#479), any external
telemetry platform, the idempotency journal migration, and any unrelated evidence redesign.

## Decision

We introduce one new strict leaf in `keiko-contracts`, one pure builder module in `keiko-tools`,
and one server module group in `keiko-server`. They form a one-directional dependency chain
(contracts ← tools ← server) that is consistent with ADR-0019 rule 1 and the existing epic stack.

### D1 — Three-layer placement respecting ADR-0019 dependency direction

**`packages/keiko-contracts/src/git-delivery-evidence.ts`** (new strict leaf): the pure, IO-free
evidence schema the other two layers consume. It exports:

- `GitDeliveryEvidenceOutcomeClass` — a six-member closed union mapping every terminal kernel
  status to an audit-legible class: `succeeded` | `blocked` | `rejected` | `failed` |
  `recovery-required` | `approval-required`.
- `GitDeliveryEvidenceLifecyclePhase` — a contract-owned mirror of the kernel's
  `GitMutationLifecyclePhase` (`resolve` | `preflight` | `preview` | `policy` | `execute` |
  `result`). Self-contained by design: the leaf cannot import `keiko-tools`, so it must own this
  vocabulary; the builder enforces correspondence via an exhaustive switch (see D5).
- `GitDeliveryRecoveryDisposition` — a four-member retrospective classification: `retryable` |
  `user-fixable` | `policy-forbidden` | `none`. The existing `GitDeliveryRemediationClass`
  (`user-actionable` | `internal`, #473) is prospective and two-way; it is reused within recovery
  metadata but is insufficient as a retrospective disposition across the five outcome classes.
- `GitDeliveryRecoveryMetadata` — carries the `disposition`, reuses the #473
  `GitDeliveryRecoveryActionHint` for the recommended next action, and carries an optional #471
  `GitDeliveryRecoveryStrategyHint` for the concrete governed recovery strategy.
- `GitDeliveryEvidenceRecord` — the top-level content-free record: `recordId`, `schemaVersion`,
  `outcomeClass`, `phaseReached` (as `GitDeliveryEvidenceLifecyclePhase`), `actionKind`,
  `riskClass`, `correlation` (see D4), `recovery` (as `GitDeliveryRecoveryMetadata`), `timestamp`
  (epoch ms integer, content-free), and the hashed identifiers from D3. No diff, path, command
  string, secret, or raw subprocess output appears in any field.
- `GitDeliveryAuditPacket` — the export envelope: a bounded array of `GitDeliveryEvidenceRecord`,
  a `generatedAt` timestamp, a `count`, and a `schemaVersion`. Used by the GET route.
- Total pure derivation functions: `gitDeliveryRecoveryDispositionForExecutionError` (maps the
  closed `GitDeliveryExecutionErrorCode` union) and `gitDeliveryRecoveryDispositionForBlockReason`
  (maps the closed `GitDeliveryBlockReason` union) — both exhaustive `Record` lookups that force a
  compile error when a new code is added to the contract without an explicit disposition.
- Frozen arrays and `isX` guards for all exported types.
- No IO, no clock, no crypto, no randomness.

**`packages/keiko-tools/src/git-mutation-evidence.ts`** (new pure builder): the single function
that projects a `GitMutationLifecycleResult` into a `GitDeliveryEvidenceRecord`.

- `buildGitDeliveryEvidenceRecord(lifecycleResult, correlation, deps)` — pure over injected
  `deps.now` (clock), `deps.newId` (id generator), and `deps.sha256Hex` (from
  `@oscharko-dev/keiko-security`). The `sha256Hex` injected dependency keeps the builder pure and
  testable without live crypto IO.
- Maps `GitMutationOutcome.status` → `GitDeliveryEvidenceOutcomeClass` via a total switch; maps
  `GitMutationLifecyclePhase` → `GitDeliveryEvidenceLifecyclePhase` via a total exhaustive switch
  (D5 compile guarantee).
- Populates `recovery` by resolving the kernel outcome's failure category via the contract's total
  disposition functions and attaching the reused #473 action-hint and #471 strategy-hint already
  present on the outcome.
- Records **every** terminal outcome (success and non-success), unlike the idempotency journal
  which records only successes.
- Hashes sensitive identifiers before they enter the record type (D3).

**`packages/keiko-server/src/gitDelivery/`** (new server module group):

- `gitDeliveryEvidenceLedger.ts` — a bounded, date-bucketed, append-only ledger that implements
  a `GitDeliveryEvidenceLedger` port (analogous to `GitMutationJournal` and the `EvidenceStore`
  port). `append(record)` uses `EvidenceStore.update` (bounded append, fail-closed on corrupt
  entry). `readAll()` returns the full contents. `buildAuditPacket()` wraps `readAll()` into a
  `GitDeliveryAuditPacket`. The ledger never throws into the caller: a storage failure is caught,
  logged at trace level, and returns void. The write is always best-effort (Force 5).
- `gitDeliveryEvidenceRoute.ts` — a capability-gated `GET /api/git-delivery/evidence` route
  registered as a sibling `ROUTE_GROUP` in `routes.ts`. Protected by `isGitDeliveryTrusted` and
  subject to the same CSRF protection as every other BFF route. Returns a `GitDeliveryAuditPacket`.
  Re-applies `deepRedactStrings(record, auditRedactor)` at read (defense-in-depth, D3).

### D2 — Reuse, not duplication

The evidence record explicitly reuses existing vocabulary:

- `GitDeliveryRecoveryActionHint` and `GitDeliveryRecoveryStrategyHint` (shipped in #473,
  `git-delivery-action-sheet.ts`) appear verbatim in `GitDeliveryRecoveryMetadata`. No new recovery
  action vocabulary is introduced.
- The #472 failure taxonomy (`GitMutationFailureCategory`, `gitMutationCategoryForExecutionError`)
  drives the disposition derivation — the builder does not re-derive severity from a string.
- The `EvidenceStore` port, `deepRedactStrings`, and the `memory-audit-handler` bounded-append
  pattern are reused at the server layer unchanged.
- The `GitDeliveryEvidenceRef` already on the contract envelope (`sourceGroundedRunId` +
  `evidenceManifestStableIdHash`) provides the forward link from the envelope to the persisted
  record; this ADR does not add a new linking scheme.

The only net-new type is `GitDeliveryRecoveryDisposition` — a four-member retrospective
classification that is structurally distinct from the two-member prospective
`GitDeliveryRemediationClass`. That distinction is honest: a disposition answers "what should
happen now given what actually occurred?"; a remediation class answers "who owns the fix?"

### D3 — Content-free record and redaction (AC2/AC5)

The record is content-free by construction: every field is a count, flag, branch name, typed code,
or SHA-256 hash.

Sensitive identifiers are hashed before they enter the record type:

- Approval token: already hash-only on the contract envelope; the record carries only the hash.
- Provider `externalId` → `externalIdHash` (SHA-256 hex via injected `deps.sha256Hex`).
- Remote alias and branch name → `remoteRefHash`.
- Repository path → `repoIdHash`.

Local branch names (`affectedBranchName`, `baseBranchName`) are retained as content-free repo
context, consistent with the #473 action-sheet projection which carries the same branch name fields.

Defense-in-depth: `deepRedactStrings(record, auditRedactor)` (injected `deps.redactor`) is applied
at persist in `gitDeliveryEvidenceLedger.ts` AND re-applied at export read in
`gitDeliveryEvidenceRoute.ts`. Any future additive field that inadvertently carries a sensitive
string is caught at both the write boundary and the read boundary, not only where the type was
written.

### D4 — Correlation (AC1)

Every evidence record carries a `correlation` field that holds the content-free, hashed triggering
workflow run id (`sourceGroundedRunId` from the envelope's `GitDeliveryEvidenceRef`, if present, or
a hash of the `actionId` as a stable fallback). This makes every attempt — succeeded, blocked,
rejected, failed, recovery-required — correlatable across a session without storing raw identifiers.
The `GitDeliveryEvidenceRef` already defined on the contract envelope (`sourceGroundedRunId` +
`evidenceManifestStableIdHash`, `git-delivery.ts` lines 394–399) is the bidirectional join key
between the envelope and the ledger record; this ADR does not add a new linking scheme.

Correlation context is in-memory on the orchestrator side. After a server restart, correlation
between a new attempt and a prior session's records is not available — this is the same limitation
the `memory-audit-handler` carries and is acceptable for a local single-host deployment (the
existing pattern sets the precedent).

### D5 — Lifecycle-phase mirroring (compile-time drift prevention)

The contract leaf defines `GitDeliveryEvidenceLifecyclePhase` as its own closed union
(`resolve` | `preflight` | `preview` | `policy` | `execute` | `result`), structurally identical
to `GitMutationLifecyclePhase` in `keiko-tools` at the time of authoring.

The builder in `keiko-tools` maps `GitMutationLifecyclePhase` →
`GitDeliveryEvidenceLifecyclePhase` with an exhaustive switch. This means:

1. The leaf is self-contained (no `keiko-tools` import, respecting ADR-0019 rule 1).
2. Any addition to `GitMutationLifecyclePhase` produces a compile error in the builder until the
   contract phase is also added and the switch is extended.

The cost — a maintained parallel of six values — is accepted because the compile-time catch is
worth more than the discipline cost, and six is a fixed, small set for a mature lifecycle.

## Consequences

### Positive

- Every terminal outcome of a governed mutation produces a durable, content-free audit record
  irrespective of whether it succeeded, was blocked, or failed — closing the coverage gap left by
  the success-only idempotency journal.
- The recovery disposition is a first-class retrospective datum: a consumer (a future UI surface, a
  recovery orchestrator, or an operator export) can route on `policy-forbidden` vs `retryable` vs
  `user-fixable` without parsing strings or re-deriving the failure category from a message.
- Sensitive identifiers are hashed at the type level before entering the record, so the
  content-free guarantee is structural, not a convention.
- The bounded ledger and best-effort write ensure that a ledger I/O failure cannot block or degrade
  the mutation path.
- The exhaustive disposition tables and phase-mirror switch make future contract additions visible as
  compile errors rather than silent coverage gaps.

### Negative

- The content-free constraint limits diagnostic fidelity. A blocked mutation's record carries the
  typed block reason code but not the stderr text or the conflicting file list; finer execution
  diagnostics require widening the confidentiality boundary, which this ADR explicitly does not do.
- Provider-side outcome classes — for example, the specific reason a merge was blocked by branch
  protection, or the PR check that failed — are not yet produced by the local-only #472 kernel.
  The outcome class `failed` or `recovery-required` will accurately classify these cases, but the
  `GitDeliveryRecoveryMetadata` will not carry a provider-specific action hint until a provider
  adapter (#476–#478) populates the outcome's extended fields.
- The schema (six phases, six outcome classes, four dispositions) must remain stable once records
  are persisted; any structural rename or removal is a migration. The `schemaVersion` field provides
  the forward escape hatch, but migration code is not in scope for this issue.
- In-memory correlation degrades after a server restart, consistent with the `memory-audit-handler`
  pattern; a durable cross-session correlation would require a persistent run-id index not in scope
  here.

### Neutral

- The `GitDeliveryEvidenceLifecyclePhase` union is a maintained parallel of the kernel's
  `GitMutationLifecyclePhase`; the exhaustive switch in the builder converts this maintenance
  burden into a compile error on mismatch.
- The server ledger module sits under `packages/keiko-server/src/gitDelivery/`, parallel to the
  existing route group introduced by #473. This is a grouping convention, not a hard package
  boundary.
- The audit-export route returns the full bounded ledger contents. Pagination and date-range
  filtering are not in scope; the bounded ledger cap is the practical size control.

## Alternatives Considered

### Alternative 1: Store evidence in the existing memory-audit subsystem, not a new module

- **Pros**: Zero new infrastructure; the memory-audit store already has bounded append, redaction,
  and a GET export path.
- **Cons**: The memory-audit subsystem is a governance stream for memory-candidate operations
  (approve/edit/reject/forget). Its retention semantics, its export key structure, and its export
  consumer are all oriented toward memory-candidate events. Conflating Git mutation evidence into
  the same stream would couple two unrelated domains at the storage layer, complicate future
  independent retention tuning, and produce a single export endpoint that mixes two semantically
  distinct event kinds. The precedent from ADR-0056 is that evidence domains are kept structurally
  separate even when their infrastructure is similar.
- **Why rejected**: Domain separation and independent retention semantics outweigh the short-term
  cost of a new ledger module.

### Alternative 2: Carry raw execution detail (stderr, conflict list) in the record for richer diagnostics

- **Pros**: A forensic investigation can determine exactly why a merge conflicted or a push was
  rejected without replaying the action.
- **Cons**: Raw stderr from git, file paths, and conflict lists are sensitive content. Storing them
  breaks the content-free guarantee that the contract envelope, the kernel snapshot, and the
  action-sheet projection all hold. It would widen the confidentiality boundary at the persistence
  layer — precisely where it should be narrowest. The existing contracts deliberately do not parse
  stderr for this reason (ADR-0059, D4 / Alternative 3).
- **Why rejected**: The content-free constraint is a hard invariant of the governed delivery epic.
  Richer diagnostics can be derived from typed failure category and disposition without raw text;
  any further detail is an operator concern, not a ledger concern.

### Alternative 3: Persist evidence in a SQLite or embedded database

- **Pros**: Native bounded retention, indexed queries, schema migrations via standard tooling.
- **Cons**: Introduces a persistent process dependency (or a driver dependency) that conflicts with
  Keiko's single-process, no-infrastructure product constraint (ADR-0019 Architecture Thesis). The
  `EvidenceStore` port already provides the bounded append semantics the ledger needs; adding a
  database engine for a bounded audit log of typed records is over-engineered for this scale.
- **Why rejected**: The `EvidenceStore` port is the correct abstraction layer. A database can
  implement that port in a later ADR if scale requires it; the schema and the port surface remain
  stable regardless.

### Alternative 4: Merge the evidence record into the idempotency journal, extending it to cover non-successes

- **Pros**: One store, one port, one lookup path.
- **Cons**: The idempotency journal's semantics are precise and intentional: it records only
  succeeded outcomes so that a retry of an already-applied mutation short-circuits rather than
  re-mutating. Recording failures in the same store would corrupt those semantics — a failed action
  would be found by the idempotency lookup and incorrectly short-circuited on retry. The
  orchestrator comment at lines 614–615 already names the evidence ledger as a separate durable
  implementation, not as an extension of the journal.
- **Why rejected**: Conflating idempotency and audit would corrupt the idempotency semantics
  (Force 1) and violate the explicit design intent in the orchestrator source.

## Related

- ADR-0058: Governed Git delivery contracts (action kinds, risk taxonomy, lifecycle envelope,
  `GitDeliveryEvidenceRef`, `GitDeliveryRecoveryStrategyHint`)
- ADR-0059: Governed Git mutation execution kernel (`GitMutationLifecycleResult`,
  `GitMutationJournal`, `GitMutationOutcome`, failure taxonomy — the projection source)
- ADR-0060: Governed Git approval and preview surface (`GitDeliveryRecoveryActionHint`,
  `GitDeliveryRemediationClass`, `GitDeliveryRecoveryHint` — reused vocabulary)
- ADR-0019: Modular Package Architecture (leaf-package rules; dependency direction contracts ←
  tools ← server; `keiko-contracts` must not import `keiko-tools`)
- Issue #474: Governed Git mutation evidence ledger, audit export, and recovery metadata (this ADR)
- Issue #470: Epic — governed end-to-end Git delivery
- Issues #476–#478: Provider execution children that will extend outcome-class coverage for
  provider-side block reasons

## Date

2026-06-25

---

## Architect Boundary Review

**Verdict: clean. No violation found.**

The three-layer placement respects ADR-0019 rule 1 and the dependency direction enforced across the
governed-delivery epic.

**`keiko-contracts/src/git-delivery-evidence.ts`** is a strict leaf. It imports only sibling atoms
within `keiko-contracts` (`GitDeliveryRecoveryActionHint` and `GitDeliveryRecoveryStrategyHint`
from `git-delivery-action-sheet.ts`, and `GitDeliveryExecutionErrorCode` / `GitDeliveryBlockReason`
from `git-delivery.ts`). It carries no IO, clock, crypto, or randomness. It does not import
`keiko-tools`, `keiko-server`, or any non-leaf package. The lifecycle-phase mirror in D5 is the
structural mechanism that preserves this invariant: instead of importing the kernel phase type, the
leaf owns its own closed union and the builder maintains the correspondence. ADR-0019 rule 1 is
satisfied.

**`keiko-tools/src/git-mutation-evidence.ts`** imports from `keiko-contracts` (the evidence record
types) and uses `sha256Hex` from `@oscharko-dev/keiko-security` via injection through `deps`. Both
are on the permitted dependency direction (`tools` may depend on `contracts` and `security`,
ADR-0019 rules 2–3). It does not import `keiko-server` or `keiko-ui`. The builder is pure: all
clock, id-generation, and hashing effects are injected, so no direct crypto IO appears in the
module. ADR-0019 rules 2–4 are satisfied.

**`keiko-server/src/gitDelivery/gitDeliveryEvidenceLedger.ts`** and
**`gitDeliveryEvidenceRoute.ts`** sit in `keiko-server`, the permitted composition and wiring layer
(ADR-0019 rule 6). They depend on `keiko-contracts` (evidence record types), `keiko-evidence`
(`EvidenceStore`, `deepRedactStrings`), and `keiko-security` (`auditRedactor`,
`isGitDeliveryTrusted`). No domain package depends on `keiko-server`. The GET route is a sibling
of the existing `git-delivery/` route group; it does not introduce a new architectural boundary,
only a new route within an established pattern.

No backward dependency is introduced: `keiko-contracts` does not import `keiko-tools`,
`keiko-tools` does not import `keiko-server`, and neither domain package imports `keiko-ui` or
`keiko-server`. The dependency graph remains a DAG.

No code has been written for #474 on this branch yet (confirmed: `find` on
`packages/*/src/git-delivery-evidence*` and `packages/*/src/git-mutation-evidence*` returns no
results), so there is no existing implementation to check for drift against this ADR.
