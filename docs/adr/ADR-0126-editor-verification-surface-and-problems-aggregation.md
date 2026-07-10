# ADR-0126: Editor verification surface, problems aggregation, and structured failure locations

## Status

Accepted (Issue #2210, Epic #2092, 2026-07-10).

## Amends

This decision extends, additively, the contract vocabulary governed by ADR-0059
(agent-editor public contracts) and ADR-0062 (agent-editor action governance and audit). It adds
new wire families and one new action-effect class; it removes nothing and re-shapes no existing
type. Their unaffected snapshot, action, conflict, audit, and classification decisions remain in
force.

It composes, and does not restate, ADR-0007 (verification classification, the seven-member
`VerificationStatus` taxonomy, and `DEFAULT_VERIFICATION_LIMITS`; cited by number in prose per the
established convention for ADRs with no file under `docs/adr/`) and ADR-0011 D5/D7 (the Server-Sent
Events framing the editor verification stream reuses). It continues the ADR-0125 rule that editor
governance introduces **no editor-specific policy vocabulary** and maps every new effect onto the
existing Coding Workbench action classes and resource scopes.

ADR-0126 was allocated after refreshing `origin/dev` and checking open pull requests on
2026-07-10. `origin/dev` ended at ADR-0125 and no open pull request claimed ADR-0126.

## Context

Epic #2092 (Built-in editor M4 — run, verify, and problems) closes the edit → run → fix loop
inside the editor. The `keiko-verification` package already plans and runs
`test | targeted-test | typecheck | lint | build` through the governed `keiko-tools` command
boundary with sandboxed execution, resource limits, and redacted, classified evidence. The command
runner (Issue #1387) already streams run lifecycle over SSE. What is missing is a contract surface
that lets the editor, and a docked agent, start those runs, watch them stream, aggregate their
failures next to live language diagnostics, and jump to the failing line.

The later child issues of Epic #2092 build the route and stream (#2211), the run affordances and
status bar (#2212), the problems panel (#2213), the agent access tool (#2214), and the closeout
evidence (#2215). They must build against one agreed, versioned wire shape rather than improvising
it per issue. This ADR records that shape and the governance decisions it depends on; it changes no
route logic, no orchestrator or parsing logic, and no UI.

The existing `VerificationResult` (`packages/keiko-contracts/src/verification.ts`) carries only a
redacted `outputSummary` string — no file or line field — so failures cannot be mapped to a
location today. `keiko-verification`'s `outputDigest` deliberately discards the raw command output
into a byte-count string, so a later parser (Issue #2211) must read the already-redacted, byte-capped
`CommandResult.stdout`/`stderr` at the one point they are still available and produce the structured
locations this ADR shapes. The contract layer has no access to raw command output and cannot itself
parse anything; it only defines the shape the parser will produce.

## Decision

### D1 - Editor verification run and event envelope

A new leaf contract, `packages/keiko-contracts/src/editor-verification.ts`, wraps — and does not
restructure — the existing `VerificationPlan`/`VerificationResult`/`VerificationReport` shapes with
an editor-scoped run/event envelope under its own schema version
`EDITOR_VERIFICATION_SCHEMA_VERSION = "1"`.

- `EditorVerificationRunRequest` is the client-supplied start-run body: `kinds: readonly
  VerificationKind[]` (deduplicated, bounded by `EDITOR_VERIFICATION_MAX_KINDS`), an optional
  workspace-relative `targetPath` for file-targeted kinds, and an optional `requestId` correlation
  token mirroring `CommandTaskRunRequest.requestId`. `parseEditorVerificationRunRequest` validates it
  at the trust boundary in the throw-free, all-errors-collected style of `parseCommandTaskRunRequest`.
- `EditorVerificationRun` is the registry-tracked run identity: `runId`, the requested `kinds`, the
  optional `targetPath`, a lifecycle `state: EditorVerificationRunState`
  (`pending | running | completed | cancelled | failed`), and `startedAtMs`.
- `EditorVerificationEvent` is a **discriminated union** keyed by `kind`
  (`run-started | step-started | step-completed | run-completed | run-cancelled | run-failed`), each
  variant carrying `runId` plus a strongly typed payload. This composes the command-runner SSE
  transport pattern (framing, ref-counted `EventSource`) while intentionally giving the payload a
  discriminated union instead of `CommandRunnerEvent`'s `Record<string, unknown>` bag, satisfying the
  repository's "no `any` / model states with discriminated unions" bar. Cancellation reuses the
  existing `DELETE`-by-`runId` convention, so no new wire type is needed for the cancel request
  itself — only the resulting `run-cancelled` event.

**Content-free lifecycle events (refinement of the drafting-time envelope, load-bearing).** Every
non-terminal event carries only closed-shape, content-free fields: `run-started`
(`runId`, `kinds`, optional `targetPath`, `startedAtMs`), `step-started` (`runId`, `stepKind`),
`step-completed` (`runId`, `stepKind`, `status`, `durationMs`), `run-cancelled` (`runId`), and
`run-failed` (`runId`, a bounded `reason` code). Only the terminal `run-completed` event carries the
full, already-redacted `VerificationReport`. A `step-completed` event therefore does **not** embed
the full `VerificationResult` (which contains `outputSummary`); embedding a potentially large
redacted digest on every step event would violate the epic's "content-free lifecycle events"
Architecture Invariant and defeat the once-per-event redaction caching the SSE bridge relies on. The
UI reads failure locations from the terminal report's results, not from step events. This is the
explicit, reasoned refinement Epic #2092's invariants require over the drafting-time phrasing that
step events "carry the `VerificationResult`."

### D2 - Problems-aggregation model

A new leaf contract, `packages/keiko-contracts/src/editor-problems.ts`, models the bounded
aggregation of language diagnostics and verification failures under its own schema version
`EDITOR_PROBLEMS_SCHEMA_VERSION = "1"`.

- `EditorProblem` carries a stable `id`, `severity: "error" | "warning" | "info"`, `source:
  "language-diagnostic" | "verification"`, a workspace-relative `file`, optional `line`/`column`, a
  capped `message` (`EDITOR_PROBLEM_MESSAGE_MAX_CHARS`), and an origin `kind` (a `VerificationKind`
  or the literal `"language-diagnostic"`). Language-diagnostic severities of `hint` are normalized to
  `info` by the producing UI (Issue #2213) so the panel severity set stays three-valued; this is
  recorded here so the producer does not re-decide it.
- `EditorProblemsSnapshot` carries the bounded `problems` list, the true pre-cap `totalCount`, a
  `truncated` flag, and the applied `perFileCap`/`totalCap` values so the panel can render
  "showing N of totalCount".
- `compareEditorProblems` is a pure, exported **total order**: severity descending
  (`error > warning > info`), then file path lexical ascending, then line ascending (a missing line
  sorts after any present line), then column ascending, then `source`, then `message`, then `id`.
  The trailing tie-breaks make the order deterministic even when two problems tie at severity, file,
  line, and column, so tests assert an exact order without relying on the JavaScript sort's
  stability. `buildEditorProblemsSnapshot` applies `EDITOR_PROBLEMS_PER_FILE_CAP` and
  `EDITOR_PROBLEMS_TOTAL_CAP` over the sorted input and sets `truncated`/`totalCount`, so the
  "bounded aggregation ... a pathological workspace cannot flood the UI" invariant has one canonical,
  tested implementation the panel reuses rather than re-deriving.

### D3 - Structured failure-location extension to `VerificationResult`

`VerificationFailureLocation` (workspace-relative `file`, optional `line`/`column`, a length-capped
`message`, an optional `ruleId` for a lint/typecheck rule or diagnostic code) is added to
`verification.ts`, and `VerificationResult` gains a new **optional** `locations?: readonly
VerificationFailureLocation[]` field. The addition is additive: every existing `VerificationResult`
consumer (`postApplyVerification.ts`, `keiko-harness`, `keiko-evidence`, `keiko-workflows`) keeps
compiling unchanged, and an existing fixture without `locations` still satisfies the type. Two frozen
caps bound what the later parser (Issue #2211) may attach:
`VERIFICATION_MAX_FAILURE_LOCATIONS` (locations per result) and
`VERIFICATION_FAILURE_MESSAGE_MAX_CHARS` (characters per location message).

**Audit-projection decision (the real risk in this issue, decided deliberately).** `locations`
propagates into `VerificationResultSummary` (the UI/evidence-facing projection the problems panel
reads) **but not** into `AuditResultEntry`. `AuditResultEntry` already excludes `outputSummary` and
`detail` so that no command-derived content reaches the audit ledger; a `locations` message is
structurally command-derived text (a compiler diagnostic or lint message), so admitting it to the
audit ledger would erode that content-minimization invariant for a surface that only needs structural
counts. The summary projection exists precisely to carry UI-facing detail, so `locations` belongs
there. This decision is recorded so the parser child issue follows it without re-litigating it.

### D4 - `"execution"` editor-agent action-effect class

`EditorAgentActionEffectClass` gains an `"execution"` member (now
`navigation | layout | content-mutation | external-effect | execution`). It maps, in the existing
exhaustive governance tables, onto **existing** Coding Workbench vocabulary — no new policy words:

- `EDITOR_AGENT_WORKBENCH_ACTION_CLASS["execution"] = "verification"` (the Coding Workbench action
  class that already exists for verification runs).
- `EDITOR_AGENT_WORKBENCH_RESOURCE_SCOPE["execution"] = "workspace-contained"` (verification runs
  execute scoped to the project root; there is no dedicated verification resource scope and this ADR
  adds none).

Both mappings are non-`null`, so `composeEditorAgentActionPolicyDecision` continues to gate an
execution action through the Authority Envelope rather than short-circuiting it the way it does for
`navigation`/`layout`. Adding the member forces one new, minimal `case "execution"` branch in the
exhaustive `classifyEditorAgentAction` switch (a TypeScript exhaustiveness requirement); that branch
applies the same workspace-containment and sensitive-path denials `content-mutation` applies to a
`targetPath`, then baseline-allows. The decision logic for every pre-existing effect class is
unchanged.

### D5 - `requestVerification` agent action type

`requestVerification` is added to `EditorAgentActionType` (and its internal
`EDITOR_AGENT_ACTION_TYPES` array) as an additive variant. `EDITOR_AGENT_SCHEMA_VERSION` stays `"1"`:
this is a new action variant, not a new required field on an existing variant — the same additive
pattern `applyChangeset` used under ADR-0125 — so an existing `schemaVersion: "1"` action fixture
still parses unchanged. Its own wire shape, `EditorAgentVerificationRequest`
(`kinds`/optional `targetPath`/optional `requestId`, mirroring `EditorVerificationRunRequest`), and a
runtime guard `isEditorAgentVerificationRequest` are added in the same file, following the existing
`is*`/`parse*` validator style.

It maps to `"execution"` in `EDITOR_AGENT_ACTION_EFFECT_CLASS` and to `"low"` in
`EDITOR_AGENT_ACTION_APPROVAL_RISK`: the action is non-mutating with respect to buffer and file
content, and the executable surface stays the existing closed `VerificationKind` set (no free-form
argv). It is deliberately **absent** from `EDITOR_AGENT_WRITE_ACTION_TYPES` and
`EDITOR_AGENT_ACTIVE_BUFFER_ACTION_TYPES`, both of which are non-exhaustive tables that a new action
type is not compile-forced into. The `"low"` value is provisional in the sense that Issue #2214 is
the first real caller to compose it through `resolveForAction` in a live policy path; if that issue
finds a concrete reason to escalate the risk tier, it revises this table entry rather than routing
around it.

The new action type carries the classifier's policy meaning only. It is **not** modeled as an
`EditorAgentAction` dispatched to the browser bridge through `/api/editor/agent/actions`: a
verification run is a server-side, sandboxed spawn with no browser buffer to apply to. Issue #2214's
tool calls Issue #2211's dedicated verification route directly while reusing
`classifyEditorAgentAction` against this type purely for classification. This decoupling is
deliberate and is why the type exists in the contract layer without a new browser-bridge dispatch
path.

## Human-control invariant

None of the five decisions widens the executable command surface, enables unbounded agent-triggered
execution, or routes command-derived content into the audit ledger:

- Runs stay within the closed `VerificationKind` set and the command runner's closed
  `package.json`-script catalog; no wire shape here accepts free-form argv.
- The `"execution"` effect class is gated through the Authority Envelope by non-`null` action-class
  and resource-scope mappings, exactly like content mutation — an agent never gains a broader command
  surface than the human UI.
- `locations` reaches the UI-facing `VerificationResultSummary` but never `AuditResultEntry`, so the
  audit ledger keeps its "no command-derived content" invariant (D3).
- Lifecycle events are content-free; only the terminal event carries the already-redacted report
  (D1).
- Cancellation reuses the existing `DELETE`-by-`runId` convention; no new authority is introduced.

## Consequences

- Issue #2211 implements the route, the SSE stream, the bounded run registry, and the
  `failure-location.ts` parser that populates `VerificationResult.locations` at the one call site
  where the already-redacted output is still available; it consumes, and does not redefine, D1's wire
  shapes.
- Issue #2212 (run affordances) and Issue #2213 (problems panel) consume D1/D2/D3; Issue #2213
  normalizes diagnostic `hint` to `info` per D2 and renders unmappable failures (empty `locations`)
  as bounded summary rows without a jump control.
- Issue #2214 consumes D4/D5, classifying `requestVerification` through the existing
  `classifyEditorAgentAction`/`composeEditorAgentActionPolicyDecision` path and recording a
  content-free audit record through the existing ledger.
- `check-contract-boundaries.mjs` does not yet cover `editor-verification.ts`, `editor-problems.ts`,
  or the `locations` field; keeping these wire shapes owned by `keiko-contracts` remains a
  code-review discipline until a future issue extends that script.
