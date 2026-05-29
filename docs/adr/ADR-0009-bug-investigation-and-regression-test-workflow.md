# ADR-0009: Bug Investigation and Regression-Test Workflow

## Status

Accepted

Implemented in `src/workflows/bug-investigation/**` (issue #9). Two refinements landed during
implementation and are reflected in D6: (1) the sensitive-path checks (`.github/`, `.husky/`,
lockfiles) match case-insensitively (matching #6 `isDenied`) so a case-only variant cannot bypass
the guard on case-insensitive filesystems; and (2) `.husky/` is added to the directory deny because
a prompt-injected git hook is an RCE-on-next-commit vector that #6's `.git` deny does not cover.

## Context

Issue #9 introduces the second reviewable developer-assist workflow in Keiko, the direct
sibling of the unit-test generation workflow (issue #8, ADR-0008). Waves #3–#7 built the
gateway, harness, workspace, safe-tool, and verification layers; issue #8 composed them into
the first deterministic linear pipeline. Issue #9 composes the same layers into a second
pipeline: given a bounded bug report (a description, failing command/test output, a stack
trace, and/or suspected target files), the workflow builds bounded context, asks the model
for a **root-cause hypothesis + a minimal patch + a regression-test strategy**, validates and
presents the patch through the #6 safe-patch boundary, optionally applies it and runs #7
verification, and emits a structured report that **separates verified facts from model
hypotheses**. When evidence is insufficient, the responsible outcome is a **scoped
investigation report with no patch**, never an invented fix.

Five forces shape the design.

**The reuse-unchanged rule is absolute.** Issues #3–#7 are accepted, audited, and CI-green.
No change to `src/gateway/**`, `src/harness/**`, `src/workspace/**`, `src/tools/**`, or
`src/verification/**` is permitted for this workflow. The pipeline composes them unchanged.
The single allowed minimal edit is a behavior-preserving extraction of the shared descriptor
interfaces (D12), which touches only the issue-#8 workflow layer, never #3–#7.

**Determinism, not an agentic loop.** Like ADR-0008, this is a bounded linear pipeline —
intake → parse failure evidence → build context → call model once (with bounded retries on a
malformed/out-of-scope NON-empty patch) → validate → scope-guard → [dry-run | apply → verify]
→ report. It does NOT drive the ADR-0004 `createSession`/`runAgent` loop. The harness
`patcher.ts` documents that the harness NEVER applies patches; apply mode therefore cannot be
expressed through the harness without modifying it.

**The bug-fix scope guard is the central security property.** A bug fix legitimately edits
production source, so issue #8's test-files-only guard (`isTestPath`) does NOT apply. The
guard is REPLACED by two complementary workflow-level bounds — a tighter change budget and a
sensitive-path deny predicate — that bound the blast radius of a prompt-injected "fix"
without modifying #6 (D6).

**Verified facts must be structurally separated from model claims.** The acceptance criterion
"distinguishes verified results from model hypotheses" is satisfied by the report SHAPE: a
`verified` sub-object carrying only facts the workflow itself established (did the patch
validate, did it apply, what did verification return, which failure frames did the tool
parse) and a `hypothesis` sub-object carrying redacted model output explicitly labeled
UNVERIFIED (D3).

**A no-fix outcome is a first-class success.** When the model produces a root-cause
hypothesis but no patch (insufficient evidence to fix safely), the workflow returns
`investigation-only` — a valid, non-error terminal state. An empty diff is NOT a retry when a
hypothesis was produced; inventing a fix on thin evidence is the failure mode this workflow
exists to avoid (D10).

## Decision

### D1 — Module layout under `src/workflows/bug-investigation/**`

The new layer lives entirely under `src/workflows/bug-investigation/`. Each file has ONE
reason to change, ≤ 400 LOC, with functions ≤ 50 LOC and cyclomatic complexity ≤ 10. The
existing `src/workflows/index.ts` barrel is extended to also re-export this workflow's barrel.

| File | Responsibility |
|---|---|
| `types.ts` | All interfaces, type aliases, and frozen constant tables. `BugInvestigationInput`, `BugInvestigationDeps`, `BugInvestigationReport`, `BugWorkflowStatus`, `BugWorkflowLimits`, `DEFAULT_BUG_WORKFLOW_LIMITS`, `FailureFrame`, `FailureEvidence`, `VerifiedFindings`, `Hypothesis`, `ChangedFile`. No runtime logic beyond the frozen tables. |
| `descriptor.ts` | The static `BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR: WorkflowDescriptor` object. Imports the shared `WorkflowDescriptor`/`WorkflowInputSpec` types from `../descriptor.js` (D12) and `./types.js`. |
| `events.ts` | The `BugInvestigationEvent` discriminated union and `BugWorkflowEventSink`. Envelope reuses the harness `BaseEvent` field shape by structural convention. No runtime logic. |
| `failure-parse.ts` | `parseFailureEvidence(report): FailureEvidence` (NEW seam, D7). Pure; bounded-linear string ops only (zero regex risk). Extracts candidate `{ file, line? }` frames + short messages from `failingOutput` + `stackTrace`. |
| `guard.ts` | `isSensitivePath(relPath): boolean` (NEW, D6). Pure, zero/bounded regex. The bug-fix scope guard's path predicate. |
| `context.ts` | `buildBugContext(workspace, input, evidence, limits, deps?): ContextPack` — delegates to #5 `buildContextPack`, seeding implicated files (failure frames + targetFiles) and a task hint from the description. Pure except for the workspace seam. |
| `prompt.ts` | `buildBugPrompt(input, evidence, pack, rejectionReason?): readonly ChatMessage[]` — system + user `ChatMessage` array. Pure. |
| `parse.ts` | `parseBugModelOutput(content): ParsedBugOutput` — defensive extraction of the fenced ```diff block (optional) and labeled prose sections. Zero regex; tolerates a missing diff and missing sections. |
| `model-loop.ts` | `runBugModelLoop(...)` — bounded model/validate/scope-guard retry loop with the empty-diff-is-investigation-only semantics (D10). |
| `stages.ts` | Terminal-report stages: `rejectedReport`, `investigationOnlyReport`, `dryRunReport`, `applyAndVerify`, `cancelledReport`, `failedReport`, `finishPipeline`, `emitCompleted`. |
| `verify-stage.ts` | `runBugVerification(...)` — post-apply verification via #7 `resolveTargetedTests` on changed SOURCE files with fallback to the `test` script; explicit skip reason. |
| `report.ts` | `assembleBugReport(...)` and `renderBugMarkdownReport(report): string`. All prose/diff redacted here. Pure. |
| `emit.ts` | `createBugEventEmitter(...)`, `computeBugFingerprint(report, modelId)`. Owns the seq counter and envelope stamping; reuses `canonicalise` from the harness barrel. |
| `internal.ts` | Shared private `BugRunState`, `AcceptedBugPatch`, `BugModelLoopResult`, `EMPTY_BUG_LOOP`, `buildBugRunState`, `resolveBugLimits`, `nextActionsFor`. Not re-exported. |
| `workflow.ts` | `investigateBug(input, deps): Promise<BugInvestigationReport>` — the single public entry. Stage sequencing + the top-level catch boundary. |
| `index.ts` | Barrel re-exporting the public surface. |

A new `src/workflows/descriptor.ts` holds the shared `WorkflowDescriptor`/`WorkflowInputSpec`
interfaces (D12).

### D2 — Public entry contract (`investigateBug`)

```typescript
// src/workflows/bug-investigation/types.ts

export interface BugReportInput {
  // Free-text description of the observed bug. At least ONE evidence field must be present.
  readonly description?: string | undefined;
  // Raw failing command / test-runner output (vitest/jest/node). Read from a file by the CLI.
  readonly failingOutput?: string | undefined;
  // A stack trace, if available separately from failingOutput.
  readonly stackTrace?: string | undefined;
  // Suspected target files (workspace-relative), if the developer already has a lead.
  readonly targetFiles?: readonly string[] | undefined;
}

export interface BugInvestigationInput {
  readonly workspaceRoot: string;
  readonly report: BugReportInput;
  // When true, a validated in-scope patch is written to disk and verification runs.
  // When false (default), only the diff preview + report are produced. FAIL-CLOSED via #6.
  readonly apply?: boolean | undefined;
  readonly modelId: string;
  readonly limits?: Partial<BugWorkflowLimits> | undefined;
}
```

`BugInvestigationDeps` has the SAME shape as `UnitTestWorkflowDeps` (model, fs?, writer?,
spawn?, now?, idSource?, sink?, processEnv?, signal?), with `sink?: BugWorkflowEventSink`.

**Input validation (intake).** At least one of `description`, `failingOutput`, `stackTrace`,
`targetFiles` (non-empty) must be present. When none is, the workflow returns immediately with
status `rejected` and a `nextActions` entry explaining the missing evidence — it does NOT call
the model. This is a pure precondition check at the workflow boundary.

```typescript
export async function investigateBug(
  input: BugInvestigationInput,
  deps: BugInvestigationDeps,
): Promise<BugInvestigationReport>
```

Limits resolve by spreading over the frozen default: `{ ...DEFAULT_BUG_WORKFLOW_LIMITS,
...input.limits }`.

### D3 — Report contract (`BugInvestigationReport`)

The "distinguishes verified results from model hypotheses" AC is satisfied STRUCTURALLY by two
sub-objects. Everything plain JSON-serializable (the #10 ledger persists it). All prose and
diff content is redacted via `redact()` before assembly.

```typescript
export interface FailureFrame {
  // Workspace-relative (or as-parsed) file path extracted from the failure output. Redacted.
  readonly file: string;
  readonly line?: number | undefined;
}

export interface VerifiedFindings {
  // Did the proposed patch pass #6 validatePatch AND the scope guard?
  readonly patchValidates: boolean;
  // Was the patch actually written to disk (apply mode only)?
  readonly patchApplied: boolean;
  // Post-apply verification audit summary (output-text-free). Present only when verification ran.
  readonly verification?: VerificationAuditSummary | undefined;
  // Frames the TOOL parsed from the failure evidence — a verified fact, not a model claim. Redacted.
  readonly failureFrames: readonly FailureFrame[];
}

export interface Hypothesis {
  // Model's root-cause explanation (redacted, UNVERIFIED).
  readonly rootCause?: string | undefined;
  // Model's proposed regression-test strategy (redacted, UNVERIFIED).
  readonly regressionTestStrategy?: string | undefined;
  // Model's stated uncertainty / caveats (redacted, UNVERIFIED).
  readonly uncertainty?: string | undefined;
  // Model's self-reported confidence. Parsed from a closed enum; absent if unparseable.
  readonly confidence?: "low" | "medium" | "high" | undefined;
}

export interface ChangedFile {
  readonly path: string; // redacted
  readonly kind: PatchChangeKind; // from #6 PatchFileChange
  readonly addedLines: number;
  readonly removedLines: number;
  // True when the path is a manifest/config edit (package.json, tsconfig*.json) — elevated review.
  readonly elevatedReview: boolean;
}

export interface BugInvestigationReport {
  readonly workflowId: "bug-investigation";
  readonly status: BugWorkflowStatus;
  readonly modelId: string;
  readonly durationMs: number;

  // Facts the workflow itself established.
  readonly verified: VerifiedFindings;
  // Model output, all redacted, explicitly UNVERIFIED.
  readonly hypothesis: Hypothesis;

  // The model's proposed unified diff (redacted) — the reviewable fix. Absent on
  // investigation-only / rejected / cancelled.
  readonly proposedDiff?: string | undefined;
  // #6 renderDryRun validation summary (redacted). Present when a valid patch was produced.
  readonly dryRunPreview?: string | undefined;
  // Files the patch changes. Empty when no patch was produced.
  readonly changedFiles: readonly ChangedFile[];
  // Best-effort count of regression-test cases added by the diff (added test(/it(/describe( lines).
  readonly regressionCoverage: number;
  // Why verification did not run. Present when verification was skipped.
  readonly verificationSkipReason?: string | undefined;
  // UI-renderable next actions, each a plain redacted string.
  readonly nextActions: readonly string[];

  readonly modelCallCount: number;
  readonly patchRetryCount: number;
}
```

`VerificationAuditSummary` and `PatchChangeKind` are imported from #7 / #6 respectively.

### D4 — Status and exit codes

```typescript
export type BugWorkflowStatus =
  | "fix-applied"        // apply mode: in-scope patch written, verification ran
  | "fix-proposed"      // dry-run: in-scope patch produced, no files written
  | "investigation-only" // no patch, but a root-cause hypothesis was produced (responsible no-fix)
  | "rejected"          // insufficient input OR out-of-scope/invalid patch after all retries
  | "cancelled"         // AbortSignal fired
  | "failed";           // unexpected error at an IO boundary
```

**CLI exit codes:**
- `0` — `fix-applied`, `fix-proposed`, or `investigation-only` (the workflow ran responsibly).
- `1` — `rejected`, `cancelled`, `failed`, or a workspace/runtime error.
- `2` — usage error (no evidence source, unknown flag, missing flag value).

`investigation-only` exits 0 because producing a scoped report with no fix is a successful,
intended outcome — not an error.

### D5 — Event family (`BugInvestigationEvent`)

The union reuses the harness `BaseEvent` envelope shape (`{ schemaVersion: "1", runId,
fingerprint, seq, ts }`) by STRUCTURAL convention (not a TS import), exactly like ADR-0008 D4.

**Name-collision discipline (CRITICAL).** `src/index.ts` and `src/sdk/index.ts` re-export the
workflows barrel explicitly. Every exported member of this workflow MUST have a name DISTINCT
from issue #8's, or the root re-export breaks the build. The names are:

- Entry: `investigateBug`. Report: `BugInvestigationReport`. Descriptor const:
  `BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR`. Union: `BugInvestigationEvent`. Sink:
  `BugWorkflowEventSink`. Renderer: `renderBugMarkdownReport` (aliased to
  `renderBugInvestigationReport` at the root barrel, mirroring the existing
  `renderUnitTestReport` alias).
- Member events (all prefixed): `BugInvestigationStartedEvent`, `FailureParsedEvent`,
  `BugContextSelectedEvent`, `BugModelCallStartedEvent`, `BugModelCallCompletedEvent`,
  `RootCauseProposedEvent`, `BugPatchValidatedEvent`, `BugPatchAppliedEvent`,
  `BugVerificationResultEvent`, `BugInvestigationCompletedEvent`,
  `BugInvestigationFailedEvent`.

Every member carries counts/flags only — never file content, never prose, never raw paths as
payload beyond the redacted frame paths that #8 already establishes as acceptable (the
`FailureParsedEvent` carries a frame COUNT, not the paths). `RootCauseProposedEvent` carries a
boolean `hasPatch` and `confidence` enum only — no prose. The `BugInvestigationFailedEvent`
`message` field is redacted before emit. `BugPatchValidatedEvent` carries `ok`, `patchBytes`,
`filesChanged`, and an optional `rejectionCode` (the #6 `PatchRejectionCode` or `"out-of-scope"`).

### D6 — The bug-fix scope guard (security-critical)

Issue #8's `isTestPath` (test-files-only) does NOT apply — a bug fix legitimately edits
production source. The guard is REPLACED by two complementary, workflow-level bounds, NEITHER
of which modifies #6:

**Bound 1 — Tighter change budget.** A workflow-owned `PatchLimits` is passed into BOTH
`validatePatch` (via `ValidateDeps.limits`) and `applyPatch` (via `ApplyDeps.limits`), using
their existing `limits` override seam:

```typescript
export const DEFAULT_BUG_PATCH_LIMITS: PatchLimits = {
  maxFilesChanged: 10,
  maxChangedLines: 300,
  maxPatchBytes: 65_536,
} as const;
```

This enforces "minimal fix": #6's 50-file / 2000-line default is too broad for a bug fix.
The fields are the #6 `PatchLimits` field names (`maxFilesChanged`, `maxChangedLines`,
`maxPatchBytes`) verified against `src/tools/types.ts`. The budget is overridable via
`BugWorkflowLimits` (see D2/D8) so an integrator can widen it deliberately. A patch exceeding
the budget is rejected by #6 with its own reason code (`file-limit` / `line-limit` /
`size-limit`) — that code surfaces as the retry reason.

**Bound 2 — Sensitive-path guard.** `isSensitivePath(relPath): boolean` (pure, in `guard.ts`,
zero/bounded regex — plain string ops only) rejects any changed path that is:

1. **Traversal / absolute** — fail-closed. Copies issue #8's `isTraversal` logic EXACTLY:
   `posixPath.startsWith("/") || posixPath.split("/").includes("..")`. Rationale identical to
   ADR-0008's traversal fix: a `tests/../.github/workflows/ci.yml` path lexically looks benign
   but #6 `resolveWithinWorkspace` collapses it; we reject the as-parsed path before #6 sees it.
   The traversal check runs on the raw posix path (before lower-casing) because `..` and `/` are
   case-invariant.
2. **Under `.github/`** — CI/CD supply-chain. `lower === ".github" || lower.startsWith(".github/")`.
3. **Under `.husky/`** — git-hook directory. `lower === ".husky" || lower.startsWith(".husky/")`.
   A prompt-injected `.husky/pre-commit` is an RCE-on-next-commit vector that #6's `.git` deny
   does NOT cover (`.husky` lives outside `.git`).
4. **A lockfile** — `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`
   (matched on the lower-cased POSIX basename).

**Case-insensitivity.** Checks 2–4 operate on the LOWER-CASED posix path / basename, matching
#6 `isDenied`'s case-insensitivity. Without this, `.GitHub/workflows/ci.yml` or
`Package-Lock.json` would bypass the guard on case-insensitive filesystems (macOS/Windows) yet
resolve to the protected file. The traversal check (1) needs no lower-casing.

Rationale: #6's deny-list already blocks `.git`/secrets/deps/build, but NOT `.github/`,
`.husky/`, or lockfiles. A prompt-injected "fix" must never silently alter CI workflows, install
a git hook, or pin/unpin dependencies. This is the prompt-injection blast-radius bound — the
analog of #8's production guard, the second barrier independent of `applyEnabled`.

**Manifest/config edits are ALLOWED but flagged.** `package.json`, `tsconfig*.json` (and other
non-sensitive config) may be legitimately needed by a fix. They are NOT rejected, but each is
marked `elevatedReview: true` in `ChangedFile` and surfaced in `nextActions` as an
elevated-review item ("This fix modifies build/manifest configuration — review with elevated
scrutiny before applying"). The detection is a pure basename predicate
(`isElevatedReviewPath`) in `guard.ts`.

**Failure handling.** A patch failing either bound is a retry-eligible rejection: code
`"out-of-scope"` for a sensitive path, or the #6 reason code for a budget overflow. After
`maxRetries` retries the status is `rejected`. The guard runs on `validation.files[].path` —
the SAME string #6 resolves and would write.

**Limitations (stated honestly).** The guard is heuristic. (a) A legitimate fix that
genuinely needs a denied path (e.g. correcting a broken CI workflow, or repinning a vulnerable
dependency) is rejected by design — the developer must make that change manually. (b) The
basename lockfile/manifest match does not catch lockfiles under nested package directories
with non-standard names. (c) The budget is a blunt instrument: a large-but-legitimate refactor
fix is rejected. These are accepted Wave-1 limitations; the conservative direction (reject) is
the safe one for an injection-blast-radius bound.

### D7 — Failure-output parsing (`failure-parse.ts`, NEW seam)

`parseFailureEvidence(report: BugReportInput): FailureEvidence` extracts candidate frames and
short messages from `failingOutput` + `stackTrace`. **Pure; bounded-linear string ops only —
zero regex with nested quantifiers, no `(.*)+` shapes (CodeQL `js/polynomial-redos`).** Where a
regex is used at all it is a single bounded character class on an already-line-split string.

```typescript
export interface FailureEvidence {
  // Candidate source locations parsed from the output/stack (deduped, capped). Verified facts.
  readonly frames: readonly FailureFrame[];
  // Short assertion / error messages (e.g. "AssertionError: expected 3 to equal 4"). Capped, redacted at the boundary.
  readonly messages: readonly string[];
}
```

**Parsing strategy (line-oriented, bounded).** Split input on `\n`, cap at a bounded number of
lines scanned (e.g. 2000). For each line, recognise, using `indexOf`/`slice`/`split` plus at
most a single bounded-character-class regex per shape:

- Node stack frames: `    at fn (path:line:col)` and `    at path:line:col` — locate the last
  `(` … `)` or trailing token, then split the inner token on `:` from the right to peel
  `col` then `line`, leaving the path.
- `file://` URLs in stack frames — strip the `file://` prefix before the `:line:col` peel.
- Bare `path:line:col` (vitest/jest "FAIL src/x.ts:12:3" style) — same right-split on `:`.
- Assertion/error message lines — lines beginning with a known marker (`AssertionError`,
  `Error:`, `Expected`, `expected`, `✕`, `FAIL`, `●`) captured verbatim (trimmed, length-capped).

`line` is parsed only when the peeled token is all-digits (a bounded `^[0-9]+$` single
character class is acceptable; preferred is `Number.isInteger(Number(token))` on a digit-only
check). Frames are deduped by `file + line` and capped (`MAX_FRAMES`, e.g. 25). Extracted file
paths SEED context selection (D8) and populate `report.verified.failureFrames`. `targetFiles`
from the input are merged into the frame set (as frames without a line) so a developer-provided
lead is treated as a verified seed.

### D8 — Context

`buildBugContext(workspace, input, evidence, limits, deps?)` delegates to #5 `buildContextPack`
(reusing #8's `context.ts` shape). It seeds the `ContextRequest` with:

- A `task` hint derived from `input.report.description` (or a generic "investigate failing
  test" hint when absent) — forward-compatible with a future embedding ranker; the Wave-1
  lexical strategy tolerates it.
- The implicated files (failure-frame paths ∪ `targetFiles`) appended to the task hint so the
  lexical strategy ranks them up. (The #5 `ContextRequest` is reused unchanged; we do not add a
  new "seed files" field to #5.)

It pulls implicated source, nearby tests, package scripts, and project metadata under the byte
budget; every excerpt is already redacted by #5 at the IO boundary. Uses the same
`DEFAULT_DISCOVERY_OPTIONS` + `lexicalRetrievalStrategy` deps as #8.

### D9 — Prompt and model-output contract

The system prompt instructs the model to produce:
1. A root-cause hypothesis grounded in the provided evidence.
2. A MINIMAL unified-diff fix touching only what is necessary (it MAY add a regression test in
   the same diff). The diff MAY be omitted entirely when the evidence is insufficient to fix
   safely.
3. A regression-test strategy.
4. Explicit uncertainty and a confidence level.

**Output contract:** an optional fenced ```diff block, followed by labeled prose sections
`## Root cause`, `## Regression test`, `## Uncertainty`, `## Confidence`. `parse.ts`
(`parseBugModelOutput`) extracts these defensively with ZERO regex (line split + `startsWith` +
`trim`, reusing #8's `parse.ts` section-extraction shape). It tolerates a missing diff (empty
string) and any missing section (`undefined`). `confidence` is parsed by lower-casing the
section body and matching the first of `low`/`medium`/`high` it contains; otherwise `undefined`.

```typescript
export interface ParsedBugOutput {
  readonly diff: string; // "" when no diff block / no content
  readonly rootCause: string | undefined;
  readonly regressionTestStrategy: string | undefined;
  readonly uncertainty: string | undefined;
  readonly confidence: "low" | "medium" | "high" | undefined;
}
```

The prompt explicitly tells the model: "If the evidence is insufficient to propose a safe fix,
OMIT the diff and explain what additional information is needed in `## Uncertainty`." This makes
investigation-only a deliberately reachable, prompt-supported outcome.

### D10 — Model loop

Bounded retries like #8, with the key behavioral difference around the empty diff:

| Model output | Classification |
|---|---|
| Non-empty diff, valid, in-scope | accepted → `fix-proposed` / `fix-applied` |
| Non-empty diff, malformed / oversized / out-of-scope | retry (reason appended to next prompt) |
| Empty diff + a `rootCause` (or any prose section) present | `investigation-only` — NOT a retry |
| Empty diff + NO prose at all | retry once; if still empty-and-bare → `rejected` |

The loop stops on the first accepted patch, on the first investigation-only outcome, after
`maxRetries` retries, or when model calls reach `maxModelCalls` — whichever comes first. The
`BugModelLoopResult` carries one of: `accepted` (a patch), `investigationOnly` (the hypothesis),
or neither (rejected). The model call is the one IO boundary; its failure propagates to the
workflow catch boundary. `RootCauseProposedEvent` is emitted once when a hypothesis is parsed
(with `hasPatch` and `confidence`).

### D11 — Verification gating

Post-apply ONLY (same rationale as ADR-0008 D5: verifying an un-applied diff tests the
pre-patch state and is misleading). Reuse #7 `resolveTargetedTests` on the changed SOURCE files
(non-test changed paths) so it finds the sibling/mirrored test — including the just-added
regression test — with fallback to the full `test` script. An explicit `verificationSkipReason`
is set when the framework is `unknown` or no command resolves. The `signal` is threaded to
`applyPatch` and to `runVerification`; an abort after apply but before verification completes →
`cancelled`.

DEFERRED (documented limitation): pre-patch reproduction baseline (running the failing test
BEFORE the fix to confirm it reproduces, then after to confirm it passes). Wave-1 verifies only
the post-apply state. Without the baseline, a passing post-apply verification confirms the test
suite is green but does not, on its own, prove the specific bug was reproduced-then-fixed; the
report states this honestly and the integration fixture is constructed so the regression test
fails before and passes after (giving real evidence in the test, even though the workflow does
not run the before-state).

### D12 — Descriptor types: EXTRACT shared base (the one allowed #8 edit)

The `WorkflowDescriptor` and `WorkflowInputSpec` interfaces currently live in
`src/workflows/unit-tests/descriptor.ts`. This ADR EXTRACTS them to a new
`src/workflows/descriptor.ts` and re-points the unit-tests `descriptor.ts` import to it. This is
a 1-line, behavior-preserving change to the issue-#8 layer (replace the two `interface`
declarations with a re-export from `../descriptor.js`, keeping the local `export` so #8's
existing import surface is unchanged).

**Why extract rather than lateral-import:** it keeps the dependency direction clean — both
workflows depend on a shared base (`src/workflows/descriptor.ts`), and neither workflow depends
on the other. A lateral import (`bug-investigation` importing the type from the `unit-tests`
barrel) would couple the two sibling workflows and make #8 a dependency of #9 for a pure type,
which is the wrong direction. The extraction touches ONLY the #8 workflow layer (never #3–#7),
so the reuse-unchanged rule for the audited layers is preserved. This is flagged explicitly for
approval as the single deliberate deviation from "zero edits outside the new directory."

`BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR` exposes: required/optional inputs (`report`, `apply`,
`modelId`, `limits`), `defaultLimits = DEFAULT_BUG_WORKFLOW_LIMITS`, `modelSelectionOptions`
(`{ arbitrary: true, preferredCostClass: "high" }` — root-cause analysis benefits from a
stronger model than test generation), `supportsDryRun: true`, `supportsApply: true`.

### D13 — Limits table

`BugWorkflowLimits` mirrors #8's `WorkflowLimits` PLUS the change-budget fields from D6, so the
single frozen table is the source of truth for every workflow-owned default.

```typescript
export interface BugWorkflowLimits {
  readonly maxModelCalls: number;      // 3
  readonly maxRetries: number;         // 2
  readonly contextBudgetBytes: number; // 65_536
  readonly maxBytesPerFile: number;    // 8_192
  // The tighter bug-fix change budget (D6). Passed to validatePatch/applyPatch limits.
  readonly maxFilesChanged: number;    // 10
  readonly maxChangedLines: number;    // 300
  readonly maxPatchBytes: number;      // 65_536
}

export const DEFAULT_BUG_WORKFLOW_LIMITS: BugWorkflowLimits = {
  maxModelCalls: 3, maxRetries: 2, contextBudgetBytes: 65_536, maxBytesPerFile: 8_192,
  maxFilesChanged: 10, maxChangedLines: 300, maxPatchBytes: 65_536,
} as const;
```

The model loop derives a `PatchLimits` view (`{ maxFilesChanged, maxChangedLines, maxPatchBytes }`)
from the resolved limits and passes it into `validatePatch`/`applyPatch`. The #5 context limits
(`contextBudgetBytes`, `maxBytesPerFile`) and the #7 `DEFAULT_VERIFICATION_LIMITS` are used as in
#8. `maxModelCalls` is the hard ceiling; `maxRetries` bounds retries on a non-empty bad patch.

### D14 — CLI command: `keiko investigate`

`src/cli/investigate.ts`, registered in `src/cli/runner.ts` `dispatchCommand` and added to
`HELP_TEXT`. Mirrors `runGenTestsCli`'s flag-parse / gateway-construction / typed-error-catch
structure.

| Flag | Type | Description |
|---|---|---|
| `--description TEXT` | string | Free-text bug description. |
| `--output-file PATH` | string | Read failing output from a file (safer than huge argv). |
| `--output TEXT` | string | Inline failing output (composes with / overridden by `--output-file`). |
| `--stack-file PATH` | string | Read a stack trace from a file. |
| `--stack TEXT` | string | Inline stack trace. |
| `--file PATH[,PATH]` | string | Comma-list of suspected target files. |
| `--apply` | flag | Enable apply mode; default is dry-run. |
| `--model MODEL_ID` | string | Model ID; defaults to first configured provider. |
| `--json` | flag | Emit `BugInvestigationReport` as JSON. |
| `--dir-root PATH` | string | Workspace root override; defaults to cwd. |

**At least one evidence source** (`--description`, `--output`/`--output-file`,
`--stack`/`--stack-file`, or `--file`) is required → else usage error (exit 2). `--output-file`
and `--stack-file` are read via the injected workspace FS / a small read at the CLI boundary
(the one IO point); a read failure is a runtime error (exit 1). The text path prints the
proposed diff (when present), the `dryRunPreview`, and the verified/hypothesis sections clearly
labeled (verified facts vs UNVERIFIED model hypothesis). Tests inject `deps.model` directly so
no live gateway is needed.

### D15 — Fixture strategy

**Unit tests** (failure parsing, guard, context selection, prompt, parse, model loop, report)
use the in-memory `WorkspaceFs` stub + a mocked `ModelPort` returning canned content. No real
FS, no spawned processes.

**Apply + verify integration test** (`tests/workflows/bug-investigation/integration.test.ts`)
requires real files on disk because `applyPatch` writes through `nodeWorkspaceWriter` and
`runVerification` spawns `npx vitest`. A checked-in fixture at
`tests/fixtures/bug-investigation/target-project/` contains:

- `package.json` with `{ "scripts": { "test": "vitest run" } }` and a vitest devDependency
  reference.
- `src/buggy.ts` — a function with a real bug (e.g. an off-by-one or wrong operator).
- `tests/buggy.test.ts` — a test that FAILS against the buggy source (demonstrating the bug
  reproduces).
- `vitest.config.ts` — minimal config.

The integration test uses `createRequire(import.meta.url).resolve("vitest/package.json")` →
`dirname` × 2 to locate the real `node_modules` parent, `mkdtempSync`-copies the fixture THERE
(a gitignored prefix) so the spawned `npx vitest` resolves vitest, injects ONLY a mock `ModelPort`
that returns the correct fix + regression diff, runs `investigateBug` with `apply: true`, and
asserts: (a) `src/buggy.ts` is fixed on disk, (b) `verified.patchApplied === true`, (c)
`verified.verification.overallStatus === "passed"` (the previously-failing test now passes).
`describe.skip` when vitest is unresolvable. Cleanup via `rmSync(dir, { recursive: true })` in
`afterEach`.

### D16 — Test plan: AC → test mapping

| AC | Test | File | Mechanism |
|---|---|---|---|
| AC #1 — CLI command documented | `investigate CLI: help lists command`, `investigate CLI: exits 2 with no evidence source` | `tests/cli/investigate.test.ts` | Mock `CliIo`; assert HELP_TEXT contains `keiko investigate`; assert exit 2. |
| AC #1 — CLI runs with evidence | `investigate CLI: dry-run prints diff + verified/hypothesis sections` | `tests/cli/investigate.test.ts` | Mock `ModelPort` returns canned fix diff + prose; assert exit 0, stdout has proposed diff and "UNVERIFIED". |
| AC #2 — SDK callable without stdout | `investigateBug: returns BugInvestigationReport` | `tests/workflows/bug-investigation/workflow.test.ts` | Mock `ModelPort`; assert return-value shape, no stdout. |
| AC #3 — Descriptor shape | `descriptor: required inputs + defaultLimits + dry-run/apply flags` | `tests/workflows/bug-investigation/descriptor.test.ts` | Assert frozen descriptor object shape. |
| AC #4 — Processes failing fixture output, proposes fix + regression | `workflow: parses failing output and proposes in-scope fix`, `failure-parse: extracts frames from vitest output` | `tests/workflows/bug-investigation/{workflow,failure-parse}.test.ts` | memfs; mock model returns valid fix diff incl. a regression test; assert `status === "fix-proposed"`, `regressionCoverage > 0`. |
| AC #5 — Dry-run: root-cause report + diff, no files written | `workflow: dry-run produces hypothesis + diff and writes nothing` | `tests/workflows/bug-investigation/workflow.test.ts` | Recording `WorkspaceWriter`; assert zero write calls; `proposedDiff` present; `hypothesis.rootCause` present. |
| AC #6 — Apply writes a small safe patch | `workflow (integration): apply writes the fix to disk` | `tests/workflows/bug-investigation/integration.test.ts` | On-disk tmp fixture; `apply: true`; real writer; assert `src/buggy.ts` fixed on disk. |
| AC #7 — Verified vs hypothesis separation | `report: verified holds only facts; hypothesis holds redacted UNVERIFIED model output` | `tests/workflows/bug-investigation/report.test.ts` | Pass canned stage outputs; assert `verified.failureFrames`/`patchValidates`/`patchApplied` are tool facts and `hypothesis.*` are the model strings, redacted. |
| AC #8 — Verify runs after patch when command available | `workflow (integration): apply runs vitest, verification passed`, `workflow: dry-run sets verificationSkipReason` | `tests/workflows/bug-investigation/{integration,workflow}.test.ts` | Integration asserts `verified.verification.overallStatus === "passed"`; unit asserts skip reason in dry-run. |
| AC #9 — Prompt construction | `prompt: system message requests root-cause + minimal diff + regression strategy + uncertainty` | `tests/workflows/bug-investigation/prompt.test.ts` | Pure; assert message content. |
| AC #9 — Failure-output handling | `failure-parse: node stack, file:// URL, bare path:line:col, dedupe + cap` | `tests/workflows/bug-investigation/failure-parse.test.ts` | Pure; table of inputs → frames. |
| AC #9 — Context selection | `context: seeds implicated files and includes target source` | `tests/workflows/bug-investigation/context.test.ts` | memfs; assert frame/target files ranked into `ContextPack.selected`. |
| AC #9 — Patch handling (scope guard) | `guard: rejects .github, lockfile, traversal; allows + flags manifest`, `workflow: out-of-scope patch retried then rejected`, `workflow: oversized patch rejected by budget` | `tests/workflows/bug-investigation/{guard,workflow}.test.ts` | Pure guard table; mock model returns sensitive/oversized diff → `status === "rejected"`, `patchRetryCount > 0`. |
| AC #9 — Report generation | `report: assembleBugReport with mocked verification`, `workflow: empty diff + rootCause → investigation-only` | `tests/workflows/bug-investigation/{report,workflow}.test.ts` | Canned `VerificationAuditSummary`; assert all fields populated + redacted; assert investigation-only path. |

All unit tests use a mocked `ModelPort`. The integration test (ACs #6/#8) is the ONLY one that
touches the real FS and spawns processes; it is isolated to `integration.test.ts`.

## Consequences

### Positive

- A second developer-assist workflow ships without modifying any audited layer (#3–#7). The
  shipped security properties (deny-by-default allowlist, env isolation, fail-closed patch,
  redacted outputs, symlink/traversal gates) are inherited unchanged.
- The scope guard (D6) adds two workflow-level barriers — a tighter change budget and a
  sensitive-path deny predicate — bounding prompt-injection blast radius for a workflow that, by
  necessity, edits production source. `.github/` and lockfiles are now protected even though #6
  does not block them.
- The verified/hypothesis split (D3) makes the "facts vs model claims" distinction a structural
  invariant of the report type, not a documentation convention — the #10 ledger and #13 UI can
  rely on it.
- `investigation-only` makes "no safe fix found" a first-class success, directly countering the
  invent-a-fix failure mode.
- Extracting the shared descriptor base (D12) leaves both workflows depending on a common base
  and neither on the other — a clean dependency direction for future workflows.
- The deterministic pipeline is trivially testable with a mocked `ModelPort`: every stage is
  independently exercisable.

### Negative

- **No pre-patch reproduction baseline (D11).** Post-apply verification confirms the suite is
  green but does not, by itself, prove the specific bug reproduced-then-fixed. Stated honestly in
  the report; the integration fixture's test fails-before/passes-after to give real evidence.
- **The scope guard is heuristic (D6).** A legitimate fix needing a `.github/` workflow, a
  lockfile, or more than the budget allows is rejected by design; the developer makes that change
  manually. The conservative direction is the safe one for an injection bound.
- **Single model call with bounded retries.** A multi-file root cause requiring iterative
  exploration is out of scope (Wave-1); the workflow does not loop with intermediate tool calls.
- **Failure parsing is best-effort.** Non-standard runner output may yield no frames; the
  workflow still proceeds using `targetFiles` and the description, but context seeding is weaker.
- **Integration test requires a real vitest install** (same constraint as ADR-0008); skipped with
  a documented reason when vitest is unresolvable.

### Neutral

- `DEFAULT_BUG_WORKFLOW_LIMITS` is a separate frozen table embedding the bug-fix change budget;
  it does not replace `DEFAULT_PATCH_LIMITS` (the model loop derives a `PatchLimits` view and
  passes it as the `limits` override — #6's defaults are untouched).
- `BugInvestigationEvent` is separate from both `HarnessEvent` and #8's `WorkflowEvent`; #10/#13
  handle each family but share one envelope-narrowing path.
- `preferredCostClass: "high"` differs from #8's `"medium"` because root-cause analysis benefits
  from a stronger model; this is a UI hint only.

## Alternatives Considered

### Alternative 1: Reuse issue #8's `isTestPath` guard, restricting fixes to test files

Keep the existing production-code guard and forbid the bug-fix workflow from editing source.

- **Pros**: reuses an audited predicate verbatim; zero new guard code; the strongest possible
  injection bound (no source edits at all).
- **Cons**: a bug fix's WHOLE PURPOSE is to edit production source; a test-files-only guard makes
  the workflow unable to propose any fix. It would degenerate to investigation-only always,
  failing ACs #4/#5/#6.
- **Why rejected**: incompatible with the workflow's reason to exist. The two-bound replacement
  (D6) preserves an injection bound while permitting the source edits a fix requires.

### Alternative 2: Run a pre-patch reproduction baseline before the fix

Before applying, run the failing test to confirm it reproduces; apply the fix; re-run to confirm
it passes — verifying the specific bug, not just suite health.

- **Pros**: the strongest correctness evidence; directly proves reproduce-then-fix.
- **Cons**: (a) requires running tests against the PRE-patch tree, which means either a tmp clone
  or an apply/verify/revert cycle — the same VFS-overlay/clone complexity ADR-0008 D11 deferred.
  (b) The targeted failing test is not always reliably resolvable from free-text output. (c)
  Doubles verification cost and latency. (d) The revert path adds an atomicity concern outside the
  #6 apply contract.
- **Why rejected**: out of scope for Wave-1 for the same clone/overlay reasons ADR-0008 deferred
  un-applied-diff verification. D11 documents it as a limitation and the integration fixture
  encodes fail-before/pass-after in the test itself.

### Alternative 3: Drive the investigation through the `createSession`/`runAgent` harness loop

Use the ADR-0004 agentic loop (model → tools → model …) so the model can iteratively read files,
run read-only git/commands, and refine a hypothesis before proposing a fix.

- **Pros**: richer exploration; reuses harness iteration limits, retry, events, and run manifest;
  the model can pull additional context on demand.
- **Cons**: (a) `src/harness/patcher.ts` documents that the harness NEVER applies patches; apply
  mode (AC #6) cannot be expressed without modifying the harness — forbidden. (b) The
  verified/hypothesis split and the scope guard have no natural insertion point in the harness
  state machine without new states. (c) An unconstrained tool loop multiplies prompt-injection
  surface, the opposite of this workflow's bounding goal. (d) Determinism and per-stage testability
  are lost.
- **Why rejected**: apply mode requires modifying the harness (forbidden); the deterministic
  pipeline is simpler, more auditable, and correctly scoped — identical rationale to ADR-0008.

### Alternative 4: Lateral type import instead of extracting the shared descriptor base (D12)

Have `bug-investigation/descriptor.ts` import `WorkflowDescriptor`/`WorkflowInputSpec` from the
`unit-tests` barrel rather than extracting them to `src/workflows/descriptor.ts`.

- **Pros**: zero edits to the #8 layer; smallest possible diff.
- **Cons**: couples the two sibling workflows — #9 would depend on #8 for a pure type, making #8 a
  build dependency of #9 and inverting the intended "both depend on a shared base" direction. A
  future third workflow would deepen the coupling.
- **Why rejected**: the clean dependency direction is worth a 1-line, behavior-preserving edit to
  #8's `descriptor.ts`. The extraction touches only the workflow layer (never #3–#7), so the
  audited-layer reuse rule is preserved. Flagged explicitly for approval.

### Alternative 5: Regex-driven failure parsing with a single comprehensive pattern

Parse stack traces and runner output with one rich regex (capturing path, line, col, message).

- **Pros**: concise; one expression handles many shapes.
- **Cons**: a comprehensive trace regex tends toward nested quantifiers / alternations over `.*`,
  exactly the `js/polynomial-redos` shape CI blocks (ADR-0002). Failure output is attacker-
  influenceable (it can contain arbitrary text from a failing test), making ReDoS a real risk.
- **Why rejected**: D7 uses line-oriented bounded string ops (split, `indexOf`, right-split on
  `:`, all-digit check) with at most a single bounded character class per shape — no
  super-linear backtracking surface. Correctness is validated by a table of real
  vitest/jest/node samples.

## Related

- ADR-0001: Project Foundation and Toolchain — zero-runtime-dependency constraint; `src/workflows/`
  location; strict TypeScript/ESM/LOC limits.
- ADR-0002: CI and Supply-Chain Security Baseline — `js/polynomial-redos` gate governs
  `failure-parse.ts` (D7) and `guard.ts` (D6): bounded string ops / single bounded character
  classes only.
- ADR-0003: Model Gateway Boundary — `GatewayModelPort`, `Gateway`, `loadConfigFromFile`,
  `GatewayError`, `redact`, `CancelledError`, `ChatMessage` reused for CLI construction and
  redaction.
- ADR-0004: Agent Harness Boundary and State Machine — `ModelPort` reused as the injected model
  seam; `GatewayModelPort` and `canonicalise` reused; `BaseEvent` envelope reused by structural
  convention.
- ADR-0005: Repository Context and Workspace Access Layer — `detectWorkspace`, `buildContextPack`,
  `DEFAULT_DISCOVERY_OPTIONS`, `lexicalRetrievalStrategy`, `ContextPack`, `WorkspaceInfo`,
  `WorkspaceFs`, `nodeWorkspaceFs` consumed unchanged.
- ADR-0006: Safe Tool Execution and Sandbox Boundary — `validatePatch`, `renderDryRun`,
  `applyPatch`, `PatchValidation`, `PatchFileChange`, `PatchLimits`, `DEFAULT_PATCH_LIMITS`,
  `WorkspaceWriter`, `nodeWorkspaceWriter`, `SpawnFn`, `nodeSpawnFn` consumed unchanged; the
  `limits` override seam carries the tighter D6 budget.
- ADR-0007: Verification Orchestrator and Resource Limits — `detectScripts`,
  `buildVerificationPlan`, `resolveTargetedTests`, `runVerification`, `summarizeForAudit`,
  `VerificationAuditSummary`, `VerificationStatus`, `DEFAULT_VERIFICATION_LIMITS` consumed
  unchanged.
- ADR-0008: Unit-Test Generation Workflow — the sibling workflow this one mirrors; its descriptor
  interfaces are extracted to a shared base (D12).
- Issue #9: Ship bug investigation and regression-test workflow.
- Issue #10: Audit ledger — will persist `BugInvestigationReport` and consume the
  `BugInvestigationEvent` stream.
- Issue #13: UI layer — will consume `BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR` and
  `BugInvestigationEvent`.

## Date

2026-05-29
