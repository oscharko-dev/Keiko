# ADR-0056: Regulated evidence for context assembly and compaction diagnostics

## Status

Proposed

## Version

0.2.0

## Context

PR1 (ADR-0052) declared `EvidenceManifest.contextAssembly?` and `EvidenceManifest.compaction?` as
additive attach points in the milestone delivery plan (`decision-log.md:63`). PR2 (ADR-0053)
produced `ContextCompactionRecord` in-memory and explicitly deferred evidence persistence to PR5
(ADR-0053 D6, D10). PR3 (ADR-0054) deferred evidence persistence of `ContextToolRehydrationHandle`
artifacts to PR5 (ADR-0054 D7). PR4 (ADR-0055) is the first behavior-affecting wave:
`conversationForGatewayWithCompaction` (keiko-server/src/conversation-compaction.ts:54) returns a
`ConversationCompactionOutcome` whose `.compaction?: ContextCompactionRecord` field is populated on
the slow path but is currently consumed by `buildGatewayMessages` (chat-handlers.ts:932) only for
`.messages` — `.compaction` is silently discarded. Similarly, `grounded-context-diagnostics.ts:66`
attaches a `ContextBudget` (carrying `ContextAssemblyDiagnostics`) to
`ConnectedContextPack.diagnostics.contextBudget?`; `persistGroundedAuditEvidence`
(grounded-qa.ts:797) passes `output.pack` to `persistConnectedContextEvidence`, but that function
(connected-context-evidence.ts:282) does not yet read `pack.diagnostics.contextBudget`.

PR5 closes the final in-memory-to-evidence gap: it routes both data items into the regulated,
redacted, retention-governed `EvidenceManifest` where they belong.

### What is available at each persist seam (confirmed by direct read)

**Grounded path (grounded-qa.ts:797–831 / grounded-qa-multi-source.ts:578 /
grounded-qa-hybrid.ts:677).**
`persistGroundedAuditEvidence` builds a `ConnectedContextEvidenceInput` containing `output.pack`.
`output.pack.diagnostics?.contextBudget?` is a `ContextBudget` whose `.profile` gives a
`ContextAssemblyDiagnostics`-compatible view. The `ContextAssemblyDiagnostics` itself is attached
by `observeGroundedContextDiagnostics` (grounded-context-diagnostics.ts:70–80) only when a
`ContextProfile` is threaded through `OrchestratorDeps`. Therefore:

- `pack.diagnostics?.contextBudget` is the source of the grounded `contextAssembly?` field.
- No compaction record is produced on the grounded path (the grounded path is not a chat history
  session; it has no `MAX_CONTEXT_MESSAGES` hard-drop). `compaction?` on a grounded manifest
  is always `undefined`.

**Chat/workflow path (chat-handlers.ts:924–938).**
`buildGatewayMessages` calls `conversationForGatewayWithCompaction` and reads only `.messages`.
The `.compaction?: ContextCompactionRecord` return value is never forwarded to any persist call.
The `persistModelChatTurn` function (chat-handlers.ts:941–993) does not call any evidence persist
function today — chat turns currently produce NO `EvidenceManifest`. There is no existing chat-turn
evidence file to attach `compaction?` to.

This is the honest constraint: **no pre-existing chat-turn manifest exists**. PR5 cannot attach
`compaction?` to a manifest that is not there. The correct choice is decided in D3 below.

### Evidence persist template (confirmed by direct read)

`persistConnectedContextEvidence` (connected-context-evidence.ts:318–328) is the canonical
template:

1. Build a typed `EvidenceManifest` from inputs via private helpers.
2. Apply `deepRedactStrings(manifest, redactor)` (defense-in-depth: a second full-object redaction
   pass that catches anything the field-level redaction missed).
3. Call `ctx.store.put(manifest.run.runId, JSON.stringify(safeManifest))`.
4. Call `applyRetention(ctx.store, ctx.retention ?? DEFAULT_RETENTION)`.
5. Return `{ manifest, location, report }`.

`createAuditRedactor` + `deepRedactStrings` are both re-exported from keiko-evidence/src/redaction.ts
(which re-exports from keiko-security). `workspaceRoot` becomes a `workspaceRootAuditId` (SHA-256
prefix) — no raw absolute path ever enters the manifest (connected-context-evidence.ts:100–102).

### Boundary constraints (confirmed by direct read)

- `keiko-contracts` is a strict leaf (boundary.test.ts). `ContextAssemblyDiagnostics` and
  `ContextCompactionRecord` both live in `keiko-contracts/src/context-engineering.ts`
  (confirmed: lines 124 and 231 respectively). Adding `EvidenceManifest.contextAssembly?` in
  `evidence.ts` imports them as type-only references within the SAME package. No sibling
  `@oscharko-dev/keiko-*` import is introduced. `boundary.test.ts` stays green.
- `keiko-evidence` currently imports from `keiko-contracts` and `keiko-security` only
  (confirmed: connected-context-evidence.ts imports). No new package edge is needed for PR5.
- `.keiko` is deny-listed (`ignore.ts` DEFAULT_DENY_PATTERNS). The evidence store at
  `.keiko/evidence` is written via the node adapter (`store.ts:55`, `DEFAULT_EVIDENCE_DIR`), not
  via `readExcerpt` — the deny-list applies to workspace reads, not to the evidence store writes.
  The evidence store is the governed, audited output channel; this is the correct path for
  compaction records.

## Decision

We will deliver PR5 as four additive waves. PR5 does NOT change any live model-facing output,
prompt assembly, or context selection. It is a pure persistence and validation wave.

### D1 — Additive EvidenceManifest fields: contextAssembly? and compaction?

We will add two additive optional fields to `EvidenceManifest`
(`keiko-contracts/src/evidence.ts:313`), placed after `governedHandoff?` (line 330), following the
exact `connectedContext?` / `governedHandoff?` additive-optional precedent:

```ts
// keiko-contracts/src/evidence.ts — additive fields after governedHandoff? (line 330)

// Context-assembly diagnostics produced by the grounded or harness context observer (PR4/PR5).
// Absent on legacy manifests and on manifests where no ContextProfile was threaded.
readonly contextAssembly?: ContextAssemblyDiagnostics | undefined;

// Compaction records for sessions that exceeded MAX_CONTEXT_MESSAGES (chat/harness path only).
// Absent on grounded-path manifests and on short sessions. Redacted at persist time.
readonly compaction?: readonly ContextCompactionRecord[] | undefined;
```

Both fields are typed using imports already present in `keiko-contracts/src/context-engineering.ts`
(same package). No new import from a sibling `@oscharko-dev/keiko-*` package is added.
`evidenceSchemaVersion` stays `"1"` — this is the established additive-optional pattern (same
justification as `connectedContext?` and `governedHandoff?` on the existing manifest).

The field is `readonly ContextCompactionRecord[]` (an array) rather than a single record because
a single long session can produce multiple compaction events if compaction fires on multiple sends.
Each distinct call to `conversationForGatewayWithCompaction` that activates the slow path produces
one record; multiple records are possible within a session.

### D2 — No new EvidenceTaskType

We will NOT introduce a new `EvidenceTaskType` value (e.g. `"context-assembly"`).

Context-assembly diagnostics and compaction records are diagnostic metadata ABOUT an existing run,
not a new kind of run. The correct model is additive fields on the existing manifest, not a new
manifest type. The `connectedContext?` field on a grounded manifest is the exact precedent: it is
diagnostic audit data about the connected-context run, not a separate task type. `compaction?` is
analogous diagnostic audit data about the chat turn's history management.

A new task type would require: a new producer that writes a new manifest type, a new `loadEvidence`
branch, new `listEvidence` filtering, and a new report renderer. All of this is unjustified
complexity for what is fundamentally a new diagnostic field on an existing run. The additive-field
pattern is simpler, backward-compatible, and consistent with the existing manifest vocabulary.

### D3 — Persist seam: grounded path is live; chat path is contract-ready with a unit-tested helper

**Grounded path — live in PR5.** The three grounded persist call sites
(`grounded-qa.ts:805`, `grounded-qa-multi-source.ts:578`, `grounded-qa-hybrid.ts:677`) all call
`persistConnectedContextEvidence` passing `pack`. The `pack.diagnostics?.contextBudget?` field
carries the `ContextBudget` (populated by `observeGroundedContextDiagnostics` in PR4). We will
extend the `ConnectedContextEvidenceInput` struct and the `buildConnectedContextEvidenceManifest`
helper in `keiko-evidence/src/connected-context-evidence.ts` to accept and persist an optional
`contextAssembly?: ContextAssemblyDiagnostics | undefined` drawn from
`input.pack.diagnostics?.contextBudget`. The three call sites are unchanged — the data flows
from the pack they already pass.

The grounded path never produces a `compaction?` record (no chat history compaction occurs in the
grounded orchestrator path). The `compaction?` field is `undefined` on all grounded manifests.

**Chat path — contract-ready with a unit-tested helper; no live persist wire in PR5.**
`persistModelChatTurn` (chat-handlers.ts:941) does not write any `EvidenceManifest` today. Wiring
a full per-turn chat evidence manifest (with redaction, retention, `runId` minting, and store write)
is a new persist path — not a small additive extension. Introducing it in PR5 would exceed the
stated scope ("evidence for context assembly and compaction") and risks introducing a new per-request
IO write path with unreviewed side effects on chat latency and storage.

The PR5 decision: ship a new `persistCompactionEvidence` helper in `keiko-evidence/` that accepts a
`ContextCompactionRecord[]`, a `chatId`, and the standard `ConnectedContextEvidenceContext`, and
produces a minimal `EvidenceManifest` with `compaction?` populated. The helper is fully unit-tested
(redaction correctness, retention applied, path-free `workspaceRootAuditId`, secret-clean manifest
verified by `deepRedactStrings`). It is NOT wired to any live request handler in PR5. The call site
wiring — threading `.compaction` out of `conversationForGatewayWithCompaction` and into
`persistCompactionEvidence` — is the explicit PR6 scope item alongside the UI panel.

This is an honest deferral: the persist seam is defined, tested, and ready; the live wiring awaits
PR6. This matches the pattern established by `ContextRehydrationHandle.kind = "tool-result"`
(ADR-0053 D5): the contract is defined and the resolution path is unit-tested; the live wire comes
in the next PR.

### D4 — Redaction posture (defense-in-depth, reusing existing stack)

Context-assembly diagnostics and compaction records must be secret-clean and path-free before
they enter the evidence store. Two layers are applied, matching the `persistConnectedContextEvidence`
pattern:

**Layer 1 — Field-level redaction at construction.** The `buildContextAssemblyEvidence` helper
applies `createAuditRedactor` (keiko-security, re-exported from keiko-evidence/redaction.ts) to
all string fields before assembling the manifest. Specifically:

- `ContextAssemblyDiagnostics.profile.*` — the profile carries a `tokenEstimatorId` string (an
  opaque identifier, not a path or secret) and `model?.id?` (a model id string). Both pass through
  `redact()` at field level.
- `ContextCompactionRecord.sourceSpans[*].scopePath` — relative workspace path; redacted at field
  level before inclusion in the manifest (same pattern as `EvidenceConnectedContextFile.scopePath`
  at connected-context-evidence.ts:143).
- `ContextCompactionRecord.preservedFacts[*].statement` — human-readable, may contain paths or
  secret-adjacent content; redacted.
- `ContextCompactionRecord.assumptions[*].statement` and `.rationale` — redacted.
- `ContextCompactionRecord.commandOutcomes[*].summary` — redacted (bounded to 200 chars per
  ADR-0053 D1, but still passes through `redact()`).
- Counts-only fields (`itemsBefore`, `itemsAfter`, `tokensBefore`, `tokensAfter`) — numeric;
  not redacted (no secret surface).
- `workspaceRoot` — hashed via `workspaceRootAuditId` (sha256Hex prefix) before inclusion. No raw
  absolute path enters the manifest.

**Layer 2 — Whole-object `deepRedactStrings`.** After manifest construction, `deepRedactStrings(manifest, redactor)` is applied (same as connected-context-evidence.ts:324). This catches
any field that Layer 1 missed due to implementation error. Defense-in-depth: the manifest that
reaches `store.put` has been redacted twice.

**Compaction bodies already have a prior pass.** ADR-0053 D4 specifies that the compaction builder
applies `scanForSecrets` (keiko-memory-capture) to `preservedFacts[*].statement` and
`assumptions[*].statement` before building the record. PR5's two-layer redaction is a third and
fourth pass on those fields. Over-redaction is the safe failure mode.

### D5 — Path-free browser summary unaffected

`buildEvidenceReport` (report.ts:49) produces an `EvidenceReport` that contains: `runId`,
`fingerprint`, `taskType`, `outcome`, `changedFiles`, `usageTotals`, `costClass`,
`verificationStatus`, and `knownLimitations`. It reads from `manifest.run`, `manifest.usageTotals`,
`manifest.model`, `manifest.patch`, and `manifest.verificationResults` / `manifest.verification`.
It does not read `manifest.contextAssembly` or `manifest.compaction`. Adding these fields to
`EvidenceManifest` is transparent to `buildEvidenceReport` — the report shape is unchanged.

`GroundedAnswerContextPackSummary` (bff-wire.ts, the browser-visible grounded answer surface) is
populated in `grounded-qa.ts` from `output.pack` before evidence is persisted. It does not read
from the evidence manifest. The new manifest fields are never injected into any browser-facing
payload. Path-free, aggregate, and content-free invariants are structurally preserved.

The regulated manifest is served only from the evidence store (accessed via `loadEvidence`), which
requires explicit local CLI access. No browser route reads the full manifest.

### D6 — index-api validateManifestShape: accept new optional fields

`validateManifestShape` (index-api.ts:100) must be extended with two calls so that manifests
written by PR5 can be loaded by `loadEvidence` without an `EvidenceSchemaError`:

```ts
// keiko-evidence/src/index-api.ts — additive calls in validateManifestShape (after line 130)
requireOptionalRecord(parsed, "contextAssembly", runId);
requireOptionalArray(parsed, "compaction", runId);
```

`requireOptionalRecord` (line 80) accepts `undefined` or an object. `requireOptionalArray` (line 90)
accepts `undefined` or an array. Both existing helpers are the correct validators for the new fields.
No existing call is modified; the two new calls are purely additive.

Legacy manifests that lack `contextAssembly` and `compaction` pass validation unchanged
(`requireOptionalRecord` and `requireOptionalArray` accept `undefined`). Manifests written by PR5
that carry both fields also pass. The schema version discriminant (`evidenceSchemaVersion: "1"`)
is unchanged — no migration, no breaking change.

### D7 — Retention

Both new fields enter the manifest before `applyRetention` is called. `applyRetention` operates at
the run level (deletes whole manifest files by age or count). It does not parse or inspect manifest
content fields. No new retention logic is needed for `contextAssembly?` or `compaction?`.

`DEFAULT_RETENTION` (`maxRuns: 50`, evidence.ts:353) applies to the grounded evidence manifest that
now carries `contextAssembly?`. The same policy applies to the `persistCompactionEvidence`-produced
manifests when they are wired in PR6.

### D8 — Measurable acceptance gates

**Gate 1 — Additive-backward-compat (keiko-contracts).** A test asserts that a `EvidenceManifest`
fixture without `contextAssembly` and `compaction` passes TypeScript compile and `validateManifestShape`
unchanged. A fixture WITH both fields also passes. Neither case requires a schema version change.
Pinned by a test in `packages/keiko-contracts/src/evidence.test.ts` (or equivalent).

**Gate 2 — index-api forward-compat (keiko-evidence).** A unit test calls `loadEvidence` on an in-memory store containing a PR5-shaped manifest (with `contextAssembly` populated and a non-empty `compaction` array). The test asserts it returns without throwing an `EvidenceSchemaError`. A legacy
manifest (no new fields) also loads without error. Pinned by a test in
`packages/keiko-evidence/src/index-api.test.ts`.

**Gate 3 — Grounded persist carries contextAssembly (keiko-evidence).** A unit test calls
`persistConnectedContextEvidence` with a fake `ConnectedContextPack` whose
`diagnostics.contextBudget` carries a valid `ContextBudget`. The returned manifest has a defined
`contextAssembly` field that validates against `validateContextAssemblyDiagnostics`. A pack with
no `diagnostics.contextBudget` produces a manifest with `contextAssembly === undefined`.

**Gate 4 — Redaction correctness (keiko-evidence).** A unit test places a known redactable string
(matching the keiko-security redact pattern) in a `ContextCompactionRecord.preservedFacts[0].statement`
and a `scopePath`. After `persistCompactionEvidence` runs, the stored manifest JSON does not contain
the raw string. The test uses `createAuditRedactor` with a known `additionalSecrets` entry and
asserts `deepRedactStrings` caught it.

**Gate 4b — workspaceRootAuditId path-free.** A unit test asserts that no absolute path (containing
`/` or `\` as a non-relative prefix) appears in the serialized manifest JSON. Achieved via the
existing `workspaceRootAuditId` hashing pattern applied to any workspace root string.

**Gate 5 — secret-clean assertion (keiko-evidence).** The `persistCompactionEvidence` unit test
includes a compaction record whose `commandOutcomes[0].summary` contains a synthetic secret-shaped
string. The persisted manifest JSON does not contain the string.

**Gate 6 — boundary gate stays green.** `boundary.test.ts` (`keiko-contracts`) continues to pass.
No new sibling `@oscharko-dev/keiko-*` import is introduced in `keiko-contracts/src/evidence.ts`.
The `ContextAssemblyDiagnostics` and `ContextCompactionRecord` imports in `evidence.ts` are
same-package references (from `context-engineering.ts` in the same `keiko-contracts` package),
not cross-package imports.

**Gate 7 — build:packages + typecheck clean.** All new files compile under strict `tsconfig.json`
(no `as T`, no `!`, no ESLint suppressions, files ≤ 400 LOC, cyclomatic complexity ≤ 10). Root
`tsc --noEmit` exits 0. Full suite green (11,939 tests passing as of PR4 baseline).

### D9 — What PR5 does NOT do

- **UI disclosure.** `ContextStatusPanel`, `ConversationBudgetBreakdown` lane fields, and any
  browser-visible compaction summary are PR6.
- **Live chat-turn evidence wiring.** `buildGatewayMessages` continues to discard `.compaction`.
  The `persistCompactionEvidence` helper exists but is not wired to any live request handler. The
  chat evidence wire is PR6 scope.
- **Tool-result artifact persistence.** `ContextToolRehydrationHandle.artifactId`
  (ADR-0054 D7) — persisting the full redacted tool output keyed by `artifactId` — is deferred
  beyond PR5. This ADR covers only `contextAssembly?` and `compaction?` on the manifest.
- **Encryption at rest.** Evidence is stored as plaintext redacted JSON per ADR-0048. No new
  encryption obligation is introduced for the new fields.
- **Per-turn compaction memory consolidation.** `keiko-memory-consolidation` (long-term knowledge
  dedup) is explicitly out of scope per `decision-log.md:91–93`.

## Wave breakdown

**W1 — EvidenceManifest additive fields + index-api shape update (keiko-contracts + keiko-evidence)**

- `keiko-contracts/src/evidence.ts`: add `contextAssembly?: ContextAssemblyDiagnostics | undefined`
  and `compaction?: readonly ContextCompactionRecord[] | undefined` to `EvidenceManifest` (after
  `governedHandoff?`, line 330). Add type-only imports of `ContextAssemblyDiagnostics` and
  `ContextCompactionRecord` from `./context-engineering.js` (same package, no boundary violation).
- `keiko-evidence/src/index-api.ts`: add `requireOptionalRecord(parsed, "contextAssembly", runId)`
  and `requireOptionalArray(parsed, "compaction", runId)` in `validateManifestShape` (after line 130).
- Tests: Gate 1 (contracts backward-compat) + Gate 2 (index-api forward-compat).

**W2 — keiko-evidence persist helpers + redaction + retention + tests**

- `keiko-evidence/src/connected-context-evidence.ts`: extend `ConnectedContextEvidenceInput` with
  `contextAssembly?: ContextAssemblyDiagnostics | undefined`. Extend
  `buildConnectedContextEvidenceManifest` to read `input.contextAssembly` and apply field-level
  redaction to string fields (`profile.tokenEstimatorId`, `profile.model?.id`) before placing on
  the manifest. Extend `persistConnectedContextEvidence` to derive `contextAssembly` from
  `input.pack.diagnostics?.contextBudget` when `input.contextAssembly` is absent (grounded path
  convenience: the data is on the pack).
- New file `keiko-evidence/src/compaction-evidence.ts` (≤ 400 LOC): exports
  `persistCompactionEvidence(records: readonly ContextCompactionRecord[], ctx: CompactionEvidenceContext)`
  following the same build → deepRedactStrings → store.put → applyRetention → return pattern.
  `CompactionEvidenceContext` extends `ConnectedContextEvidenceContext` with a `chatIdHash?`
  (the SHA-256 of the chat id, pre-computed by the caller, not the raw id).
- Tests: Gate 3 (grounded persist carries contextAssembly) + Gate 4/4b (redaction) + Gate 5 (secret-clean) + Gate 6 (boundary).

**W3 — keiko-server grounded path wiring + tests**

- `keiko-server/src/grounded-qa.ts` (and multi-source / hybrid equivalents): extend
  `ConnectedContextEvidenceInput` construction in `persistGroundedAuditEvidence` to pass
  `contextAssembly: output.pack.diagnostics?.contextBudget` (the pack already carries it from PR4).
  No change to the pack assembly; no change to the prompt builders.
- Tests: an integration test that exercises the full `persistGroundedAuditEvidence` path with a fake
  pack carrying a `contextBudget`, verifies the stored manifest has `contextAssembly` defined and
  validates.

**W4 — Gate tighten (scripts / harness)**

- `scripts/check-context-quality.mjs`: add a `evidenceContextAssemblyPresent` check that, after a
  corpus scenario that activates the grounded diagnostics observer, loads the evidence manifest and
  asserts `manifest.contextAssembly !== undefined`. This is a unit-level harness assertion
  (no live model call needed; the corpus already exercises the observer path).
- Alternatively, the gate may be expressed as a keiko-evidence unit test (persist fixture → manifest
  has field, `deepRedactStrings` clean) rather than a `.mjs` harness gate — whichever the
  implementor chooses is acceptable as long as the gate is measured and not scaffolded.
- Gate 7: verify `build:packages` + `tsc --noEmit` + full suite green.

## Self-critique

### Pass 1 — Devil's Advocate

**Are the new fields truly additive/backward-compatible?** Yes. `requireOptionalRecord` and
`requireOptionalArray` in `validateManifestShape` accept `undefined`. A manifest written before PR5
(without the fields) loads without error. A manifest written after PR5 (with the fields) also
loads. `evidenceSchemaVersion` stays `"1"`. TypeScript optional fields with `| undefined` do not
change the structural type of callers that do not read them.

**Is there a contracts boundary violation?** No. `ContextAssemblyDiagnostics` and
`ContextCompactionRecord` are in `keiko-contracts/src/context-engineering.ts`. The new imports in
`evidence.ts` are same-package references. `boundary.test.ts` checks for sibling
`@oscharko-dev/keiko-*` package imports; same-package imports within `keiko-contracts` are not
sibling imports and do not trigger the boundary gate. This is identical to how `EvidenceManifest`
already imports `AuditSummary` from `./workspace.js` within the same package.

**Is the chat-path "contract-ready but not live-wired" honest?** Yes, and it is the correct choice.
The chat path has no existing evidence manifest. Wiring a full per-turn manifest would be:
(a) a new I/O path on every chat request (latency risk), (b) a new `runId` minting strategy for
chat turns (not yet defined), (c) new storage growth proportional to chat frequency. These
decisions are justified PR6 scope. Shipping a unit-tested helper that is ready to wire is the
pattern established by ADR-0053 D6 (in-memory compaction in PR2, evidence in PR5) and ADR-0054 D7
(handle defined in PR3, artifact write in PR5). The deferral is explicit and named.

**What if the grounded path's `pack.diagnostics?.contextBudget` is absent?** This happens when no
`ContextProfile` is threaded through `OrchestratorDeps` (confirmed: `grounded-context-diagnostics.ts`
observer is conditional on `deps.contextProfile !== undefined`). In that case,
`input.contextAssembly` is `undefined` and the manifest carries no `contextAssembly` field. This is
correct and expected: legacy callers and callers without a profile do not produce diagnostics.
The `DEFAULT_CONTEXT_PROFILE` is provisioned by `buildUiHandlerDeps` (ADR-0055 D5), so in normal
operation the field will be populated.

**Is the `compaction?` array vs single-record choice correct?** A chat session that triggers
compaction on multiple consecutive sends produces multiple `ContextCompactionRecord` values. Storing
only the most recent would lose historical compaction events in the same session. An array is the
correct shape. This matches `stateTransitions: readonly EvidenceStateTransition[]` and
`toolCalls: readonly EvidenceToolCall[]` — all harness-event arrays on the manifest are arrays,
not singletons.

**Could the two-layer redaction produce over-aggressive redaction on counts?** No. Numeric fields
(`itemsBefore`, `tokensAfter`, etc.) are numbers, not strings. `deepRedactStrings` walks string
fields only; numeric fields are never modified. `createAuditRedactor` returns a function that
accepts a string; it is called explicitly only on string fields.

**Is the browser summary structurally protected?** Yes. `buildEvidenceReport` (report.ts:49)
reads only `manifest.run`, `manifest.model`, `manifest.usageTotals`, `manifest.patch`, and
`manifest.verificationResults`. The new fields are never read by `buildEvidenceReport`. The
`EvidenceReport` shape is unchanged. No new field flows from the manifest to any browser-facing
response body.

**What is the failure mode if `persistCompactionEvidence` throws?** On the chat path, it is not
wired in PR5, so no failure mode. On the grounded path, `persistConnectedContextEvidence` is called
fire-and-forget in `persistGroundedAuditEvidence` (the function is synchronous and not `await`ed
by the route handler — confirmed by reading grounded-qa.ts:797–831). Errors in the persist call
are currently not propagated to the HTTP response. PR5 does not change this error-propagation
posture. A `contextAssembly` field that fails to serialize would manifest as a JSON serialization
error in the store write — which is caught and swallowed by the same error boundary that handles
any other persist failure. This is an accepted limitation documented in `KNOWN_LIMITATIONS`.

### Pass 2 — Clarity

**Is the decision concrete enough?** Yes. A developer knows: add two fields to `EvidenceManifest`
in `evidence.ts`, update `validateManifestShape` in `index-api.ts`, extend
`ConnectedContextEvidenceInput` and `buildConnectedContextEvidenceManifest` in
`connected-context-evidence.ts`, add `compaction-evidence.ts`, and update the three grounded
persist call sites. File names and line numbers are cited for every claim.

**Are the consequences honest about the costs?** Yes — the chat-path live wiring deferral is
explicit, the rationale is given (latency risk, undefined `runId` strategy, storage growth), and
the contract-ready helper approach is named.

**Are the alternatives real?** Yes — all four alternatives considered below are genuine options
that a reasonable engineer would consider.

**Is the ADR free of undefined jargon?** All referenced types are cited with file:line. All
referenced functions have full package paths.

## Consequences

### Positive

- The grounded path now produces a manifest that carries full `contextAssembly` diagnostics,
  closing the "diagnostic computed but silently discarded" gap introduced in PR4.
- The `EvidenceManifest` is the single regulated output channel for context-engineering
  diagnostics. No new storage format, no new output channel.
- `persistCompactionEvidence` provides a fully tested, redaction-proven, retention-governed persist
  helper that PR6 can wire in one call site change without any new evidence-layer work.
- Redaction is defense-in-depth: field-level + `deepRedactStrings` whole-object. The compaction
  builder's `scanForSecrets` pass (PR2) is a third prior layer on fact/assumption statements.
- Legacy manifests load without change. New manifests load without schema-version migration.
  Reversibility: removing the fields later requires only removing the optional interface fields —
  no migration needed because they were never required.

### Negative

- `EvidenceManifest.compaction?` is defined as an optional field but has no live producer on the
  chat path in PR5. A developer reading the type sees a field that is always `undefined` in
  practice until PR6 wires it. This is the "forward-defined surface" pattern established by
  `ShapedBrowserObservation` (ADR-0054 D8) and `ContextRehydrationHandle.kind = "tool-result"`
  (ADR-0053 D5); it is an honest cost of the phased delivery approach.
- The `contextAssembly?` field is populated only when `DEFAULT_CONTEXT_PROFILE` is threaded through
  `OrchestratorDeps`. Tests that do not inject a profile produce manifests with
  `contextAssembly === undefined`. This may initially appear to be a missing field in CI manifests
  if the context profile injection is not exercised by the test harness.
- `EvidenceManifest` now imports types from `context-engineering.ts`. If `ContextAssemblyDiagnostics`
  or `ContextCompactionRecord` gains a required field in a future PR, `EvidenceManifest`-consuming
  code that builds manifest fixtures must be updated. This is an acceptable coupling within the
  same package.

### Neutral

- The persist helper `persistCompactionEvidence` adds a new file to `keiko-evidence`. It is small
  (≤ 400 LOC), follows the existing template exactly, and is covered by unit tests. It does not
  add any new package dependency.
- `workspaceRootAuditId` hashing applies to any workspace root passed to the compaction persist
  helper. The chat path does not currently provide a workspace root per-turn (chat is not scoped
  to a specific workspace in the same way grounded runs are). The compaction helper can accept
  `workspaceRoot?: string` and skip the `workspaceRootAuditId` when absent rather than throwing.
- The `EvidenceReport` shape is unchanged. The CLI `renderEvidenceReport` output is unchanged.
  No downstream consumer of `buildEvidenceReport` requires modification.

## Alternatives Considered

### Alternative 1: Introduce a new EvidenceTaskType 'context-assembly' with its own manifest

Emit a separate manifest file per context-assembly event (each grounded run + each chat compaction
event) with `run.taskType = "context-assembly"`, separate from the existing grounded or workflow
manifest.

- **Pros**: clean separation of concerns; each manifest has a single purpose; the context-assembly
  manifest could carry richer compaction data without polluting the workflow manifest.
- **Cons**: breaks the principle that one run produces one manifest. A grounded run would produce
  two manifest files (one `"connected-context"` + one `"context-assembly"`) with different
  `runId` values, making correlation via `runId` impossible without a new cross-manifest join key.
  `listEvidence` would return spurious entries. The `EvidenceListEntry.taskType` filter would need
  a new branch. The existing evidence browser (if any) would show context-assembly manifests as
  independent runs. This is more complexity for less clarity.
- **Why rejected**: diagnostic data about a run belongs on the run's manifest. The
  `connectedContext?` precedent is clear: it is audit data ON the grounded manifest, not a separate
  manifest. `contextAssembly?` is the same category of data.

### Alternative 2: Persist compaction records to a side-file via writeSideFile

Use the `writeSideFile` pattern (ADR-0048) to persist the `ContextCompactionRecord[]` as a
compaction side-file alongside the primary manifest, keyed by `runId`.

- **Pros**: keeps the primary manifest small; side-files are already the pattern for large
  diagnostic artifacts (e.g. plan JSON, figma snapshot).
- **Cons**: `compaction?` is a small array of bounded records (each record is compact — counts,
  hashes, and redacted summaries). Writing a side-file for a small array adds filesystem ops
  without a proportional benefit. More importantly, `validateManifestShape` and `loadEvidence` do
  not currently load side-files — adding side-file loading would require a new `getSideFile`
  operation on `EvidenceStore`, new validation, and new `loadEvidence` branches. The additive
  optional field approach is simpler and already governed by the existing manifest read/write path.
- **Why rejected**: the complexity cost of a new `EvidenceStore.getSideFile` method plus new
  validation is disproportionate for a bounded array. Optional manifest fields are the correct
  pattern for structured diagnostic data that fits in the manifest's JSON budget.

### Alternative 3: Wire chat-turn evidence fully in PR5

Wire `persistCompactionEvidence` directly in `buildGatewayMessages` or `persistModelChatTurn` in
PR5, making the compaction record live-persisted on every chat turn that activates the slow path.

- **Pros**: the manifest has live data immediately; no deferral.
- **Cons**: introduces a new synchronous (or fire-and-forget) I/O write on every chat turn that
  hits the slow path. The `runId` for chat turns has not been defined — there is no `randomUUID`
  call in the chat handler today. The retention budget for per-turn chat evidence (potentially many
  per session) has not been analyzed. The latency impact of the store write on the chat response
  path has not been measured. These are PR6 concerns, not PR5 contracts-and-persistence concerns.
- **Why rejected**: scope creep beyond the defined PR5 goal. The helper is contract-ready; the
  live wire needs the PR6 design work (runId strategy, per-turn retention policy, latency budget).
  Shipping the live wire without those decisions produces a feature that the team cannot yet
  reason about.

### Alternative 4: Extend EvidenceManifest with a schemaVersion bump to "2"

Treat the new fields as a breaking schema change and emit `evidenceSchemaVersion: "2"`. Update
`loadEvidence` to handle both `"1"` and `"2"`.

- **Pros**: explicit versioning; clear that the schema has changed.
- **Cons**: `evidenceSchemaVersion` is a breaking change discriminant (evidence.ts:19–21, comment
  says "A breaking change produces '2' as a NEW union member rather than mutating '1'"). Adding
  optional fields is by definition NOT a breaking change — any code reading `evidenceSchemaVersion`
  `"1"` manifests today continues to work unchanged because the new fields are absent. Bumping the
  version would mean existing `loadEvidence` callers receive an `EvidenceSchemaError` on any
  manifest written by PR5, which is exactly the failure mode the optional-field pattern exists to
  prevent.
- **Why rejected**: optional fields with `undefined` are backward-compatible by construction. The
  version bump rule is for breaking changes only. Adding required fields, removing fields, or
  changing field types would warrant a version bump; adding optional fields does not.

## Related

- ADR-0052: PR1 foundation. Declares `EvidenceManifest.contextAssembly?` and `compaction?` as
  additive attach points (`decision-log.md:63`); establishes the no-schema-bump additive pattern.
- ADR-0053: PR2. Defines `ContextCompactionRecord` in-memory only; explicitly defers evidence
  persistence to PR5 (D6, D10). The in-memory-to-evidence gap PR5 closes.
- ADR-0054: PR3. Defines `ContextToolRehydrationHandle` in-memory; defers evidence artifact
  persistence to PR5 (D7). PR5 scopes tool-result artifact persistence out for a subsequent PR.
- ADR-0055: PR4. Wires `contextBudget?` onto `pack.diagnostics` and produces
  `ContextCompactionRecord` in `conversationForGatewayWithCompaction`. Both are the in-memory
  sources PR5 persists.
- ADR-0048: evidence artifact confidentiality — 0o700/0o600 mode enforcement, redaction posture,
  retention policy. PR5 reuses the existing `persistConnectedContextEvidence` stack and does not
  introduce a new confidentiality tier.
- ADR-0022: connected-context privacy contract — path-free summaries, counts-only browser surface.
  PR5 preserves these invariants: the new manifest fields are regulated-manifest only, never
  browser-surface.
- ADR-0019: modular package architecture and boundary gate. D1 justifies no new package edge.
- `keiko-contracts/src/evidence.ts:313–331` — `EvidenceManifest` (the field attachment site).
- `keiko-contracts/src/context-engineering.ts:124,231` — `ContextAssemblyDiagnostics`,
  `ContextCompactionRecord` (the imported types; same-package, not sibling-package).
- `keiko-evidence/src/connected-context-evidence.ts:282,318` — manifest builder and persist
  function (the extend site for the grounded path).
- `keiko-evidence/src/index-api.ts:100,130` — `validateManifestShape` (the extend site for
  index-api acceptance of new fields).
- `keiko-evidence/src/report.ts:49` — `buildEvidenceReport` (confirmed: does not read new fields;
  browser-surface is unchanged).
- `keiko-server/src/conversation-compaction.ts:54` — `conversationForGatewayWithCompaction`
  (the compaction record source; `.compaction` currently discarded by `buildGatewayMessages`).
- `keiko-server/src/grounded-context-diagnostics.ts:66` — `observeGroundedContextDiagnostics`
  (populates `pack.diagnostics.contextBudget?`; the grounded `contextAssembly` source).
- `keiko-server/src/grounded-qa.ts:797–831` — `persistGroundedAuditEvidence` (the live grounded
  wiring site for W3).

## Date

2026-06-23
