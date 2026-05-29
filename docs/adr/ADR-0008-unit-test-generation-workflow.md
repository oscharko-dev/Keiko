# ADR-0008: Unit-Test Generation Workflow

## Status

Accepted

Implemented in `src/workflows/unit-tests/**` (issue #8). Two refinements landed during
implementation and are reflected below: (1) D3 adds a `proposedDiff` field so the report carries
the reviewable unified diff itself (not only the `renderDryRun` validation summary), redacted; and
(2) the production-code guard (D6) rejects any path containing a `..` segment or a leading slash
fail-closed, because such a path lexically appears under a `testDir` yet `resolveWithinWorkspace`
collapses it to a production file outside that directory.

## Context

Issue #8 introduces the first developer-productivity workflow in Keiko. Waves #3–#7 built
the gateway, harness, workspace, safe-tool, and verification layers. Issue #8 composes those
layers into a single coherent workflow: given a target TypeScript file (or function, module,
or changed-file set), produce a reviewable unified-diff that adds unit tests, validate the
diff through the #6 patch boundary, optionally apply it, and verify the result through the
#7 orchestrator. The workflow must be callable from the CLI, the SDK, and describable to the
future UI (issue #13) via a static descriptor.

Four forces shape the design.

**The first workflow must not modify any shipped layer.** Issues #4–#7 are accepted,
audited, and CI-green. Any change to `src/harness/**`, `src/tools/**`, `src/workspace/**`,
`src/verification/**`, or `src/gateway/**` for this workflow would mean the workflow had
reached past its layer boundary. The reuse-unchanged rule is absolute.

**Determinism, not an agentic loop.** The `createSession` / `runAgent` harness (ADR-0004)
drives an iterative model loop with tool calls. Unit-test generation is a bounded, linear
pipeline: detect conventions → build context → call model once (with bounded retries on
invalid output) → validate patch → apply or dry-run → verify. A deterministic pipeline is
simpler to test, simpler to audit, and does not require modifying the harness state machine.

**The production-code guard is a security property.** A model prompt-injected into test
generation could produce a patch that modifies source files. The workflow must reject any
patch that touches a non-test path (a path that neither matches a test-file naming pattern
nor lies under a detected `testDir`) before calling `applyPatch`. This bound limits
prompt-injection blast radius even when the model is adversarially influenced.

**The dry-run/apply distinction must be explicit in every layer.** `applyPatch` (ADR-0006
D4) is fail-closed: it throws `PatchApplyDisabledError` unless `applyEnabled === true`.
The workflow threads this flag from user input to the apply call, so the default — produce
a reviewable diff without touching files — requires no special configuration.

## Decision

### D1 — Module layout under `src/workflows/unit-tests/**`

The new layer lives entirely under `src/workflows/unit-tests/`. The existing placeholder
`src/workflows/index.ts` is replaced with a barrel that re-exports the workflow surface.
Each file has ONE reason to change, ≤ 400 LOC, and functions ≤ 50 LOC with cyclomatic
complexity ≤ 10.

| File | Responsibility |
|---|---|
| `types.ts` | All interfaces, type aliases, and frozen constant tables for this workflow. `UnitTestWorkflowInput`, `UnitTestWorkflowDeps`, `UnitTestWorkflowReport`, `WorkflowStatus`, `DEFAULT_WORKFLOW_LIMITS`. No runtime logic beyond the frozen table. |
| `descriptor.ts` | The static `UNIT_TEST_WORKFLOW_DESCRIPTOR: WorkflowDescriptor` object. Pure value, no imports beyond `./types.js`. |
| `events.ts` | The `WorkflowEvent` discriminated union and its `BaseWorkflowEvent` envelope. No runtime logic. |
| `conventions.ts` | `detectConventions(workspace, pack): TestConventions` — derives framework, test-directory, file-naming style, and assertion-style sample from `WorkspaceInfo` and a sampled `ContextPack`. Pure except for the workspace seam dependency. |
| `context.ts` | `buildTestGenContext(workspace, input, deps?): ContextPack` — assembles the context pack for the target file, nearby test files, package/test config, and relevant type definitions using `buildContextPack` from #5. Pure except for the workspace seam. |
| `prompt.ts` | `buildPrompt(input, conventions, pack): readonly ChatMessage[]` — builds the system + user `ChatMessage` array. Pure (no IO, no clock, no randomness). |
| `workflow.ts` | `generateUnitTests(input, deps): Promise<UnitTestWorkflowReport>` — the single public entry. Orchestrates the pipeline (intake → detect → context → prompt → model → validate → production-guard → [dry-run | apply] → verify → report), emits progress events, handles retries. |
| `report.ts` | `assembleReport(...)` and `renderMarkdownReport(report): string` — assembles the `UnitTestWorkflowReport` from pipeline stage outputs; renders to Markdown for the CLI text path. |
| `index.ts` | Barrel re-exporting the public surface: `generateUnitTests`, `UNIT_TEST_WORKFLOW_DESCRIPTOR`, all public types, the `WorkflowEvent` union. |

The updated `src/workflows/index.ts` re-exports the `unit-tests` barrel.

### D2 — Public entry contract (`generateUnitTests`)

```typescript
// src/workflows/unit-tests/types.ts

export type WorkflowStatus =
  | "completed"      // patch applied and verification passed (apply mode) OR dry-run produced
  | "dry-run"        // dry-run mode: diff produced, no files written
  | "rejected"       // model produced an invalid or out-of-scope patch after all retries
  | "cancelled"      // AbortSignal fired
  | "failed";        // unexpected error at an IO boundary

/** Target selection: exactly one of file/module/changedFiles must be provided. */
export type UnitTestTarget =
  | { readonly kind: "file"; readonly filePath: string; readonly targetFunction?: string | undefined }
  | { readonly kind: "module"; readonly moduleDir: string }
  | { readonly kind: "changedFiles"; readonly filePaths: readonly string[] };

export interface WorkflowLimits {
  /** Maximum model calls for this workflow run including retries. Default: 3. */
  readonly maxModelCalls: number;
  /** Maximum retries on empty / invalid / out-of-scope patch. Default: 2. */
  readonly maxRetries: number;
  /** Context pack byte budget fed to #5 buildContextPack. Default: 65_536. */
  readonly contextBudgetBytes: number;
  /** Max bytes per file in context pack. Default: 8_192. */
  readonly maxBytesPerFile: number;
}

export const DEFAULT_WORKFLOW_LIMITS: WorkflowLimits = {
  maxModelCalls: 3,
  maxRetries: 2,
  contextBudgetBytes: 65_536,
  maxBytesPerFile: 8_192,
} as const;

export interface UnitTestWorkflowInput {
  /** The workspace root (absolute path). */
  readonly workspaceRoot: string;
  /** Target selection. */
  readonly target: UnitTestTarget;
  /**
   * When true, the validated patch is written to disk and verification runs.
   * When false (default), only the diff preview and report are produced. FAIL-CLOSED:
   * applyPatch in #6 throws PatchApplyDisabledError unless this is true.
   */
  readonly apply?: boolean | undefined;
  /** Model ID to use (must be registered in the gateway config). */
  readonly modelId: string;
  /** Per-workflow resource limits. Defaults to DEFAULT_WORKFLOW_LIMITS. */
  readonly limits?: Partial<WorkflowLimits> | undefined;
}

export interface UnitTestWorkflowDeps {
  /** The model port to use for the generation call. Injected; mocked in tests. */
  readonly model: ModelPort;
  /** Workspace filesystem. Defaults to nodeWorkspaceFs. */
  readonly fs?: WorkspaceFs | undefined;
  /** Spawn function for runCommand / runVerification. Defaults to nodeSpawnFn. */
  readonly spawn?: SpawnFn | undefined;
  /** Monotonic clock. Defaults to Date.now. */
  readonly now?: (() => number) | undefined;
  /** Unique ID source for event runId. Defaults to crypto.randomUUID. */
  readonly idSource?: (() => string) | undefined;
  /** Event sink for workflow progress events. No-op by default. */
  readonly sink?: WorkflowEventSink | undefined;
  /** Process environment for runCommand env isolation. Defaults to process.env. */
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
  /** AbortSignal for cancellation. */
  readonly signal?: AbortSignal | undefined;
}
```

The import of `ModelPort` is from `src/harness/ports.js`; `WorkspaceFs` and `SpawnFn` from
their respective layers. All fields with `| undefined` use `exactOptionalPropertyTypes`
semantics.

The function signature:

```typescript
// src/workflows/unit-tests/workflow.ts
export async function generateUnitTests(
  input: UnitTestWorkflowInput,
  deps: UnitTestWorkflowDeps,
): Promise<UnitTestWorkflowReport>
```

The workflow resolves `input.limits` by spreading over `DEFAULT_WORKFLOW_LIMITS`:
`{ ...DEFAULT_WORKFLOW_LIMITS, ...input.limits }`. This frozen constant is the single source
of truth for all defaults.

### D3 — Workflow report schema (`UnitTestWorkflowReport`)

Plain JSON-serializable. All prose (coveredBehavior, knownGaps, nextActions) is redacted
via `redact()` before assembly. The diff preview (`dryRunPreview`) and the proposed diff
(`proposedDiff`) are redacted before assembly. This is the stable contract consumed by issue #10
(audit ledger) and issue #13 (UI).

```typescript
// src/workflows/unit-tests/types.ts

export interface AddedTestFile {
  /** Workspace-relative path of the test file created or modified by the patch. */
  readonly path: string;
  /** Number of test cases added (lines beginning with "test(", "it(", or "describe("). Best-effort count; not authoritative. */
  readonly estimatedTestCount: number;
}

export interface UnitTestWorkflowReport {
  readonly workflowId: "unit-test-generation";
  /** Overall outcome. */
  readonly status: WorkflowStatus;
  /** Model ID that produced the test patch. */
  readonly modelId: string;
  /** Wall-clock duration in milliseconds for the entire workflow. */
  readonly durationMs: number;

  /**
   * Dry-run preview from #6 renderDryRun (redacted).
   * Present in dry-run mode and apply mode (produced before apply).
   * Absent when the model produced no valid patch after all retries.
   */
  readonly dryRunPreview?: string | undefined;

  /**
   * The model's proposed unified diff (redacted) — the reviewable test CODE itself. `dryRunPreview`
   * from #6 `renderDryRun` is only a validation SUMMARY ("PATCH OK — 1 file, 20 changed lines"); for
   * the tests to be reviewable (AC #4) and for dry-run to "produce a diff" (AC #6) the report must
   * carry the diff. Present whenever a parseable, in-scope patch was produced; absent on rejection
   * or cancellation. Redacted via `redact()` before assembly, like all other content fields.
   */
  readonly proposedDiff?: string | undefined;

  /** Patch files that were added or modified. Empty on rejection or dry-run with no valid patch. */
  readonly addedTestFiles: readonly AddedTestFile[];

  /**
   * Model-generated prose summary of what behaviors are covered (redacted).
   * Absent on rejection or cancellation.
   */
  readonly coveredBehavior?: string | undefined;

  /**
   * Model-generated prose summary of known gaps not covered by the generated tests (redacted).
   * Absent on rejection or cancellation.
   */
  readonly knownGaps?: string | undefined;

  /**
   * UI-renderable next actions: structured suggestions the caller / UI presents to the
   * developer (e.g. "Review generated tests in X", "Run `keiko verify` to confirm").
   * Each entry is a plain string, redacted.
   */
  readonly nextActions: readonly string[];

  /**
   * Summary of the verification run. Present only in apply mode when verification ran.
   * Absent in dry-run mode (documented in report as "verification skipped: dry-run, no
   * files written").
   */
  readonly verificationSummary?: VerificationAuditSummary | undefined;

  /** Human-readable explanation of why verification was skipped. Present when no verification ran. */
  readonly verificationSkipReason?: string | undefined;

  /** Number of model calls made (including retries). */
  readonly modelCallCount: number;

  /** Number of patch rejections before a valid patch was accepted. */
  readonly patchRetryCount: number;
}
```

`VerificationAuditSummary` is imported from `src/verification/index.js` (the output-text-free
projection from ADR-0007 `summarizeForAudit`).

### D4 — Progress and audit event family (`WorkflowEvent`)

We reuse the harness `BaseEvent` envelope format exactly:
`{ schemaVersion: "1", runId, fingerprint, seq, ts }`. This ensures issue #10 and issue #13
can consume workflow events with the same envelope-narrowing logic they apply to `HarnessEvent`.
The workflow generates its own `runId` (from `deps.idSource`) and its own `fingerprint`
(SHA-256 of `workflowId + target + modelId`, truncated to 16 hex chars — same shape as the
harness fingerprinter). Workflow events are a SEPARATE discriminated union (`WorkflowEvent`)
that does NOT extend `HarnessEvent`, because the workflow does not pass through the harness
state machine. Issue #13 deals with both event families.

```typescript
// src/workflows/unit-tests/events.ts

interface BaseWorkflowEvent {
  readonly schemaVersion: "1";
  readonly runId: string;
  readonly fingerprint: string;
  readonly seq: number;
  readonly ts: number;
}

// Emitted once at pipeline start: target, modelId, limits, apply flag.
// Counts/flags only — no source text, no file content.
export interface WorkflowStartedEvent extends BaseWorkflowEvent {
  readonly type: "workflow:started";
  readonly workflowId: "unit-test-generation";
  readonly modelId: string;
  readonly applyEnabled: boolean;
  readonly limits: WorkflowLimits;
}

// Framework, testDir style, naming style. No file content.
export interface ConventionsDetectedEvent extends BaseWorkflowEvent {
  readonly type: "conventions:detected";
  readonly framework: TestFramework;
  readonly testDirs: readonly string[];
  readonly fileNamingStyle: "sibling" | "mirrored" | "unknown";
}

// How many entries were selected and bytes used. No file content.
export interface ContextSelectedEvent extends BaseWorkflowEvent {
  readonly type: "context:selected";
  readonly entryCount: number;
  readonly usedBytes: number;
  readonly budgetBytes: number;
  readonly droppedForBudget: number;
}

// Model call attempt number and context size. No content.
export interface ModelCallStartedEvent extends BaseWorkflowEvent {
  readonly type: "workflow:model:call:started";
  readonly attempt: number;
  readonly contextBytes: number;
}

// Model call result: metadata only; no content.
export interface ModelCallCompletedEvent extends BaseWorkflowEvent {
  readonly type: "workflow:model:call:completed";
  readonly attempt: number;
  readonly finishReason: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly latencyMs: number;
}

// Patch validation result. ok=false includes a rejection reason code (never message text).
// patchBytes for sizing; no diff content here.
export interface PatchValidatedEvent extends BaseWorkflowEvent {
  readonly type: "patch:validated";
  readonly ok: boolean;
  readonly patchBytes: number;
  readonly filesChanged: number;
  // Present when ok=false; stable PatchRejectionCode or "out-of-scope" for the production guard.
  readonly rejectionCode?: string | undefined;
}

// Emitted after successful apply. File counts only — no paths.
export interface PatchAppliedEvent extends BaseWorkflowEvent {
  readonly type: "workflow:patch:applied";
  readonly changedFiles: number;
  readonly created: number;
  readonly deleted: number;
}

// Verification summary at the workflow boundary. Uses VerificationAuditSummary (output-text-free).
export interface VerificationResultEvent extends BaseWorkflowEvent {
  readonly type: "workflow:verification:result";
  readonly overallStatus: VerificationStatus;
  readonly stepCount: number;
  readonly passedCount: number;
  readonly durationMs: number;
}

// Terminal event. status is WorkflowStatus.
export interface WorkflowCompletedEvent extends BaseWorkflowEvent {
  readonly type: "workflow:completed";
  readonly status: WorkflowStatus;
  readonly durationMs: number;
}

export interface WorkflowFailedEvent extends BaseWorkflowEvent {
  readonly type: "workflow:failed";
  readonly errorCode: string;
  // SENSITIVE: redacted before emit.
  readonly message: string;
}

export type WorkflowEvent =
  | WorkflowStartedEvent
  | ConventionsDetectedEvent
  | ContextSelectedEvent
  | ModelCallStartedEvent
  | ModelCallCompletedEvent
  | PatchValidatedEvent
  | PatchAppliedEvent
  | VerificationResultEvent
  | WorkflowCompletedEvent
  | WorkflowFailedEvent;

export interface WorkflowEventSink {
  readonly emit: (event: WorkflowEvent) => void;
}
```

Every `SENSITIVE` field (diff content, prose) is redacted via `redact()` before emit.
Counts and flags are never sensitive. The sink's `emit` is synchronous (matching
`EventSink.emit` from ADR-0004).

### D5 — Dry-run vs apply semantics; verification gating (D-critical)

This decision governs three interlocking behaviors:

**Dry-run is the default.** `input.apply` defaults to `false` (absent or `undefined`).
In dry-run mode the workflow:
1. Calls `validatePatch` and `renderDryRun` from #6.
2. Applies the production-code guard (D6) — even in dry-run, a patch touching source files is rejected.
3. Sets `UnitTestWorkflowReport.status = "dry-run"`.
4. Sets `verificationSkipReason = "verification skipped: dry-run, no files written"`.
5. Does NOT call `applyPatch`.
6. Does NOT call `runVerification`.

**Apply mode requires explicit opt-in.** `input.apply === true` enables apply mode:
1. `applyPatch` is called with `deps.applyEnabled: true, deps.signal: resolvedSignal`.
2. If `applyPatch` throws, the error propagates to the workflow's catch boundary.
3. Verification runs only after a successful apply AND only when a test command is
   detectable for the workspace's framework (D7). Verification uses `resolveTargetedTests`
   from #7, passing the changed test files from the patch result.
4. When `testFramework === "unknown"` or `resolveTargetedTests` returns zero steps,
   `verificationSkipReason = "verification skipped: framework unknown or no test files resolved"`.

**Why verification is gated on apply.** Running verification against a diff that has not
been written produces a result against the pre-patch state — misleading. Verification of
un-applied changes is deferred to a future wave that can run tests in a tmp clone.

**Signal threading.** The same `AbortSignal` (from `deps.signal`) is threaded to `applyPatch`
and `VerificationDeps.signal`. An abort after apply but before verification completes is
classified as `"cancelled"` in the report.

### D6 — Production-code guard (security property)

After `validatePatch` returns `ok: true`, the workflow applies an additional check before
calling `renderDryRun` or `applyPatch`: every path in `validation.files` must satisfy the
test-path predicate. A patch that fails this check is treated as a retry-eligible rejection
with code `"out-of-scope"`.

**Test-path predicate** — a file path passes if ANY of the following holds:

1. The basename (without extension) contains `.test` or `.spec` as a dot-separated segment.
   That is, splitting `basename(path, ext)` on `.` yields a token equal to `"test"` or
   `"spec"`. Examples: `foo.test.ts` → pass; `foo.spec.ts` → pass; `testUtils.ts` → FAIL
   (the word "test" is a prefix, not a dot-separated segment); `foo.test.utils.ts` → pass.
2. The directory component of the path starts with (or equals) one of
   `workspace.testDirs` (e.g. `tests/`, `test/`, `__tests__/`).

This predicate is implemented as a pure function `isTestPath(workspace, relPath): boolean`
in `conventions.ts`.

**Why this is a security property.** A model that receives prompt-injected instructions
could produce a diff that silently modifies `src/auth.ts` alongside legitimate test files.
The production-code guard ensures the workflow rejects that diff before it reaches
`applyPatch`, regardless of whether `applyEnabled` is true. Combined with #6's
`applyEnabled: false` default, this provides two independent barriers against unreviewed
source modification.

**Limitation.** The predicate is heuristic. A non-standard naming convention (e.g.
`src/auth_spec.ts` where `spec` is a suffix without a leading dot) will be rejected as
non-test even if the developer intends it as a test file. The `testDirs` fallback mitigates
this for most projects. Calibration against unconventional naming is a documented limitation,
not a blocker.

### D7 — Convention detection

`detectConventions(workspace, pack): TestConventions` is a pure function in `conventions.ts`.
It reads from `WorkspaceInfo` (populated by `detectWorkspace` from #5) and from the
`ContextPack` (for assertion-style sampling).

```typescript
export interface TestConventions {
  readonly framework: TestFramework;
  readonly testDirs: readonly string[];
  // "sibling": X.test.ts lives next to X.ts. "mirrored": under testDir with same stem.
  // "unknown": insufficient evidence.
  readonly fileNamingStyle: "sibling" | "mirrored" | "unknown";
  // Up to 2 excerpts of nearby test files sampled from the ContextPack (redacted, bounded).
  readonly assertionStyleSamples: readonly string[];
}
```

**Framework** — `workspace.testFramework` from #5 `detectWorkspace`. Already detected; no re-detection.

**Test directory and naming style** — Derived from `workspace.testDirs`. If `testDirs` is
non-empty AND the target file's sibling `.test.ts`/`.spec.ts` does NOT exist (inferred from
pack entries that include the target directory), the style is `"mirrored"`. If the sibling
pattern appears in the pack, the style is `"sibling"`. Otherwise `"unknown"`. This mirrors
the shape of `candidateTestPaths` in `src/verification/plan.ts:69–82` (same logic, not a
new dependency).

**Assertion style** — scan the `ContextPack.selected` entries whose `selectionReason ===
"test"` and take up to 2 `excerpt` strings (already redacted by #5 at the IO boundary).
These are passed into the prompt as "example test style" context.

### D8 — Limits

Three limit tables compose; the workflow does not duplicate or override them except at the
workflow level.

| Source | Table | Fields used |
|---|---|---|
| `src/workflows/unit-tests/types.ts` | `DEFAULT_WORKFLOW_LIMITS` | `maxModelCalls=3`, `maxRetries=2`, `contextBudgetBytes=65_536`, `maxBytesPerFile=8_192` |
| `src/tools/types.ts` | `DEFAULT_PATCH_LIMITS` | Used verbatim in `validatePatch`; not overridden |
| `src/verification/types.ts` | `DEFAULT_VERIFICATION_LIMITS` | Used verbatim in `buildVerificationPlan`; not overridden |

Workflow-level retry logic: if the model returns a diff that fails `validatePatch` OR the
production-code guard, the workflow retries the model call with the rejection reason appended
to the user message ("the previous diff was rejected: `<rejectionCode>`"). After
`limits.maxRetries` rejections the workflow sets `status = "rejected"` and returns without
applying anything. An empty model response (no diff in content) counts as one retry.

`maxModelCalls` is an absolute ceiling: even if `maxRetries` allows more retries, the
workflow stops when model calls reach `maxModelCalls`.

### D9 — CLI command: `keiko gen-tests`

The name `gen-tests` is chosen to:
(a) disambiguate from `keiko run generate-unit-tests` (the harness dry-run path from ADR-0004);
(b) be short and memorable.

**Flags:**

| Flag | Type | Required | Description |
|---|---|---|---|
| `--file PATH` | string | Yes (unless `--dir`) | Workspace-relative path to the target file |
| `--dir PATH` | string | Yes (unless `--file`) | Workspace-relative directory for module-level generation |
| `--function NAME` | string | No | Target function name within `--file` |
| `--changed FILE[,FILE]` | string | No | Comma-separated changed-file set |
| `--apply` | flag | No | Enable apply mode; default is dry-run |
| `--model MODEL_ID` | string | No | Model ID; defaults to first provider in gateway config |
| `--json` | flag | No | Emit `UnitTestWorkflowReport` as JSON to stdout |
| `--dir-root PATH` | string | No | Workspace root override; defaults to cwd |

`--file` and `--dir` are mutually exclusive; exactly one is required (usage error if
neither or both are given). `--changed` is composable with both.

**Exit codes:**
- `0` — status is `"completed"` or `"dry-run"` (successful workflow, regardless of apply).
- `1` — status is `"rejected"`, `"cancelled"`, `"failed"`, or a workspace/runtime error.
- `2` — usage error (missing required flag, unknown flag, mutual-exclusion violation).

**Gateway construction.** The CLI builds a `GatewayModelPort` from:
1. `loadConfigFromFile` (default path `./keiko.config.json`) → `GatewayConfig`.
2. `new Gateway(config)` → `ChatModel`.
3. `new GatewayModelPort(gateway)` → `ModelPort`.
When `loadConfigFromFile` throws `ConfigInvalidError` (no provider configured), the CLI
prints a clear message to stderr (`Error: no model provider configured — set KEIKO_DEFAULT_API_KEY
and KEIKO_DEFAULT_BASE_URL or create keiko.config.json`) and exits 1. It does NOT invent
a default provider; tests mock the `ModelPort` directly.

**Module:** `src/cli/gen-tests.ts`, registered in `src/cli/runner.ts` `dispatchCommand` and
added to `HELP_TEXT`.

### D10 — UI workflow descriptor (`UNIT_TEST_WORKFLOW_DESCRIPTOR`)

A static, frozen, JSON-serializable object in `src/workflows/unit-tests/descriptor.ts`.
Issue #13 reads this to render the workflow UI without knowing the implementation.

```typescript
export interface WorkflowInputSpec {
  readonly name: string;
  readonly type: "string" | "boolean" | "string[]" | "object";
  readonly required: boolean;
  readonly description: string;
  readonly defaultValue?: unknown;
}

export interface WorkflowDescriptor {
  readonly workflowId: string;
  readonly name: string;
  readonly description: string;
  readonly inputs: readonly WorkflowInputSpec[];
  readonly defaultLimits: WorkflowLimits;
  readonly modelSelectionOptions: {
    /** Whether the caller can specify an arbitrary modelId. Always true for this workflow. */
    readonly arbitrary: boolean;
    /** Hint to the UI: prefer fast/cheap models for test generation. */
    readonly preferredCostClass: "low" | "medium" | "high";
  };
  readonly supportsDryRun: boolean;
  readonly supportsApply: boolean;
}

export const UNIT_TEST_WORKFLOW_DESCRIPTOR: WorkflowDescriptor = {
  workflowId: "unit-test-generation",
  name: "Unit Test Generation",
  description:
    "Generates a reviewable unit-test patch for a target TypeScript file, function, or module. " +
    "Detects the project's test framework and naming conventions. Dry-run by default; " +
    "pass apply:true to write the tests and run verification.",
  inputs: [
    { name: "target", type: "object", required: true,
      description: "Target: { kind: 'file', filePath } | { kind: 'module', moduleDir } | { kind: 'changedFiles', filePaths }" },
    { name: "apply", type: "boolean", required: false, description: "Write tests to disk and run verification", defaultValue: false },
    { name: "modelId", type: "string", required: true, description: "Model ID registered in gateway config" },
    { name: "limits", type: "object", required: false, description: "Partial<WorkflowLimits> overrides" },
  ],
  defaultLimits: DEFAULT_WORKFLOW_LIMITS,
  modelSelectionOptions: { arbitrary: true, preferredCostClass: "medium" },
  supportsDryRun: true,
  supportsApply: true,
} as const;
```

### D11 — Fixture strategy: on-disk `tests/fixtures/unit-tests/` for apply+verify integration; memfs for unit tests

The repository currently has no `fixtures/` directory. Tests in `src/workspace/**` and
`src/tools/**` use an in-memory `WorkspaceFs` (see `tests/workspace/_memfs.ts`).

**Unit tests** (prompt construction, context selection, patch handling, convention detection,
production-code guard, report generation) use the memfs pattern: a `WorkspaceFs` stub and a
mocked `ModelPort` that returns a canned diff. These tests do not touch the real filesystem
or spawn processes.

**Apply-mode and verification integration test** requires real files on disk because:
(a) `applyPatch` writes through `nodeWorkspaceWriter` (sync `fs.writeFileSync`);
(b) `runVerification` spawns `npx vitest run` via `nodeSpawnFn`.

A minimal on-disk fixture project is created at `tests/fixtures/unit-tests/target-project/`
containing:
- `package.json` with `{ "scripts": { "test": "vitest run" }, "devDependencies": { "vitest": "..." } }`
  (or, if the test environment already has vitest, reference it via `npx vitest run`).
- `src/add.ts` — a trivial `add(a: number, b: number): number` function.
- `tests/` directory (empty or with one existing test for convention detection).
- `vitest.config.ts` — minimal config.

The integration test creates a `tmp` copy of this fixture (using `node:fs.mkdtempSync`),
runs `generateUnitTests` with `apply: true` against it, asserts the test file was written,
and asserts `verificationSummary.overallStatus === "passed"`. The tmp dir is cleaned up in
`afterEach` via `fs.rmSync(dir, { recursive: true })`.

This approach — a checked-in skeleton with a per-test tmp copy — keeps the fixture small and
reproducible without requiring `npm install` in CI per test (the devDependencies are already
installed at the workspace level).

### D12 — Test plan: AC → test mapping

| AC | Test | File | Mechanism |
|---|---|---|---|
| AC #1 — CLI command documented | `gen-tests CLI: prints help text`, `gen-tests CLI: exits 2 on missing --file/--dir` | `tests/cli/gen-tests.test.ts` | Inject mock `CliIo`; assert help text contains `keiko gen-tests`; assert exit 2. |
| AC #1 — CLI command with --file | `gen-tests CLI: dry-run reports diff on stdout` | `tests/cli/gen-tests.test.ts` | Mock `ModelPort` returning canned diff; assert exit 0, stdout contains `PATCH OK`. |
| AC #2 — SDK callable without stdout | `generateUnitTests: returns UnitTestWorkflowReport` | `tests/workflows/unit-tests/workflow.test.ts` | Mock `ModelPort`; assert return value shape without any stdout. |
| AC #3 — Descriptor shape | `descriptor: has all required input fields`, `descriptor: supportsDryRun and supportsApply` | `tests/workflows/unit-tests/descriptor.test.ts` | Assert frozen descriptor object shape. |
| AC #4 — Generates patch for fixture | `workflow: dry-run produces valid patch for fixture add.ts` | `tests/workflows/unit-tests/workflow.test.ts` | Memfs fixture; mock model returns a valid `.test.ts` diff; assert `status === "dry-run"` and `dryRunPreview` contains `PATCH OK`. |
| AC #5 — Detects conventions | `conventions: detects vitest from workspace`, `conventions: detects mirrored testDir naming` | `tests/workflows/unit-tests/conventions.test.ts` | Memfs `WorkspaceInfo` with `testFramework: "vitest"` and a `tests/` dir; assert `framework === "vitest"` and `fileNamingStyle === "mirrored"`. |
| AC #6 — Dry-run produces diff, no files written | `workflow: dry-run writes no files` | `tests/workflows/unit-tests/workflow.test.ts` | Recording `WorkspaceWriter`; assert zero write calls; assert `verificationSkipReason` present. |
| AC #7 — Apply writes test file | `workflow (integration): apply mode writes test file` | `tests/workflows/unit-tests/integration.test.ts` | On-disk tmp fixture; `apply: true`; real `nodeWorkspaceWriter`; assert file exists on disk after run. |
| AC #8 — Verify runs after apply | `workflow (integration): apply mode runs vitest and reports passed` | `tests/workflows/unit-tests/integration.test.ts` | On-disk tmp fixture; assert `verificationSummary.overallStatus === "passed"`. |
| AC #8 — Verify skipped in dry-run | `workflow: dry-run sets verificationSkipReason` | `tests/workflows/unit-tests/workflow.test.ts` | Assert `verificationSkipReason` present; `verificationSummary` absent. |
| AC #9 — Prompt construction mocked | `prompt: system message contains framework and assertion style` | `tests/workflows/unit-tests/prompt.test.ts` | Pure unit test; assert `buildPrompt` output contains detected framework and assertion sample. |
| AC #9 — Context selection mocked | `context: includes target file and nearby tests` | `tests/workflows/unit-tests/context.test.ts` | Memfs with target + one sibling test; assert both in `ContextPack.selected`. |
| AC #9 — Production-code guard rejects | `workflow: rejects patch touching source file` | `tests/workflows/unit-tests/workflow.test.ts` | Mock model returns diff touching `src/add.ts`; assert `status === "rejected"`, `patchRetryCount > 0`. |
| AC #9 — Report generation mocked | `report: assembleReport with mocked verification` | `tests/workflows/unit-tests/report.test.ts` | Pass canned `VerificationAuditSummary`; assert all report fields populated and redacted. |

All unit tests use mocked `ModelPort`. The integration tests (ACs #7/#8) are the ONLY tests
that touch the real filesystem and spawn processes; they are isolated to `integration.test.ts`.

## Consequences

### Positive

- The workflow adds developer productivity without modifying any audited layer (#3–#7). The
  shipped security properties (deny-by-default command allowlist, env isolation, fail-closed
  patch, redacted outputs) are inherited unchanged.
- The production-code guard adds a workflow-level safety check independent of `applyEnabled`.
  Two barriers must fail before a model-modified source file reaches disk.
- Dry-run-by-default means the first-time user sees a diff for review, not a file write.
  This matches the principle of least surprise in a regulated environment.
- The `WorkflowDescriptor` gives issue #13 a machine-readable, stable contract to render the
  UI without knowing the implementation.
- The `WorkflowEvent` family uses the same `BaseEvent` envelope as `HarnessEvent`, so the
  audit ledger (#10) and UI (#13) need only one envelope-narrowing path.
- The deterministic pipeline is trivially testable with mocked `ModelPort`: every stage is
  independently exercisable.

### Negative

- **One model call per workflow run (with bounded retries).** A complex target file with many
  functions may produce a test patch that covers only part of the surface. The workflow does
  not loop to fill coverage gaps — that is out of scope (issue scope: "reviewable" tests, not
  "complete" tests). This is a Wave-1 limitation.
- **Verification only in apply mode.** Verifying the correctness of a not-yet-applied patch
  requires either a tmp clone or a VFS overlay, both of which are out of scope. Dry-run users
  receive the diff preview but no test-run evidence. The skip reason is explicit in the report.
- **The production-code guard is heuristic.** Unconventional naming (`auth_spec.ts`,
  `test_helpers.ts`) may be incorrectly classified. The `testDirs` fallback reduces false
  rejects but does not eliminate them.
- **Integration tests require a real vitest install.** The on-disk fixture relies on `npx vitest`
  being available in the workspace's `node_modules`. If the workspace devDependencies do not
  include vitest, the integration test will be skipped with a documented skip reason.
- **No snapshot/UI test generation (by design).** Out of scope per issue #8.

### Neutral

- `DEFAULT_WORKFLOW_LIMITS` is a separate frozen table; it does not replace or overlap with
  `DEFAULT_PATCH_LIMITS` or `DEFAULT_VERIFICATION_LIMITS`. Each layer owns its defaults.
- The `WorkflowEvent` union is separate from `HarnessEvent`; issue #10 / #13 will need to
  handle both. This is preferable to contaminating the harness event union with workflow-level
  events that follow a different state machine.
- The CLI's `--dir-root` flag defaults to cwd, consistent with `detectWorkspace(startDir)`.

## Alternatives Considered

### Alternative 1: Route through the existing `createSession` / `runAgent` harness loop

Drive the workflow via the ADR-0004 `createSession` harness (the same path as `keiko run
generate-unit-tests`). The harness handles model calls, tool calls, context selection, patch
proposal, and verification in its state machine.

- **Pros**: reuses the complete harness machinery including iteration limits, retry logic,
  event emission, run manifest, and all existing `HarnessEvent` types. No new event family.
  The existing `buildGenerateUnitTests` task plan in `src/harness/tasks/generate-unit-tests.ts`
  could be extended with convention-aware context.
- **Cons**: (a) The harness `patcher.ts` (`src/harness/patcher.ts:1-3`) documents that it
  NEVER applies patches — it only checks that the diff is non-empty. Apply mode would require
  modifying the harness, violating the reuse-unchanged rule. (b) The harness loop is iterative
  (model → tools → model → ...); a single-call test-generation workflow does not need iteration,
  and forcing it into the loop adds complexity without benefit. (c) Convention detection and
  context enrichment (test-file sampling, assertion-style sampling) are not expressible as
  harness tool calls without adding new tools, which would modify `src/tools/**`. (d) The
  production-code guard has no natural insertion point in the harness state machine without
  a new harness state.
- **Why rejected**: apply mode cannot be implemented without modifying the harness, which is
  forbidden. The deterministic pipeline is simpler, more auditable, and correctly scoped.

### Alternative 2: Multiple model calls for coverage (agentic loop at the workflow level)

After the first model call, the workflow evaluates coverage and calls the model again for
each uncovered function or branch, looping until coverage is adequate or a limit is hit.

- **Pros**: higher coverage for complex targets; the model can refine tests based on
  earlier failures.
- **Cons**: (a) Coverage evaluation requires running tests between model calls, which
  requires apply+verify+undo cycles — complex and slow. (b) Issue #8 scope explicitly excludes
  "coverage enforcement". (c) Multiple model calls multiply cost and latency. (d) A loop
  with apply-undo-re-apply is difficult to make atomic and auditable. (e) Prompt injection
  risk grows with each model call in an unconstrained loop.
- **Why rejected**: explicitly out of scope per issue #8. The bounded-retry model (up to
  `maxRetries` on bad patches, hard ceiling at `maxModelCalls`) is the correct Wave-1 shape.
  A multi-call coverage workflow is a separate issue.

### Alternative 3: Use `git apply` subprocess for patch application vs. the #6 `applyPatch` path

Apply the model-generated diff by shelling out to `git apply` instead of using the
`applyPatch` function from `src/tools/patch.ts`.

- **Pros**: handles edge cases (rename detection, fuzzy matching, binary patches) that the
  bounded #6 parser does not. Less bespoke code in the workflow.
- **Cons**: (a) `git apply` is not in the #6 allowlist (only read-only git ops are allowed:
  `status/diff/log/show/rev-parse/ls-files/describe/blame/cat-file`). Adding `apply` would
  widen the allowlist, modifying `src/tools/**`. (b) `git apply` writes directly to the
  working tree without going through `WorkspaceWriter`, bypassing the path/deny/realpath gates
  and the production-code guard. (c) Atomicity and rollback guarantees of D4 (ADR-0006) would
  be lost. This was explicitly considered and rejected in ADR-0006 Alternative 3 for the same
  reasons.
- **Why rejected**: using `git apply` would require modifying the #6 allowlist, bypassing the
  `WorkspaceWriter` boundary, and abandoning the atomicity and audit properties of ADR-0006 D4.
  ADR-0006 Alternative 3 documents this rejection with the same rationale.

### Alternative 4: Pure memfs fixtures for all tests (no on-disk fixture project)

Use the existing in-memory `WorkspaceFs` pattern for all tests, including the apply-mode and
verification integration test.

- **Pros**: no dependency on vitest being installed in the test environment; no on-disk fixture
  to maintain; faster test startup.
- **Cons**: (a) `applyPatch` writes through `nodeWorkspaceWriter` (real `fs.writeFileSync`) — a
  recording writer mock can assert the write was attempted but cannot prove the file was actually
  written and readable by `vitest run`. (b) `runVerification` spawns a real `npx vitest` process
  that reads real files from disk; a memfs overlay for a spawned child process requires OS-level
  filesystem interception, which is out of scope. The on-disk integration test is the only
  evidence for ACs #7 and #8.
- **Why rejected**: the integration test for apply + verify cannot be faithfully represented in
  memfs. The on-disk fixture is small (4–5 files), reproducible, and isolated to a tmp copy per
  test run. The cost is acceptable.

### Alternative 5: Separate `WorkflowEvent` envelope vs. reusing the `BaseEvent` shape

Define a workflow-specific event envelope with different fields (e.g. `workflowRunId` instead
of `runId`, or no `fingerprint`).

- **Pros**: cleaner separation; the workflow event type is obviously distinct from harness events.
- **Cons**: (a) Issue #10 (audit ledger) and #13 (UI) would need two different envelope-narrowing
  paths instead of one. (b) The `BaseEvent` fields (`schemaVersion`, `runId`, `fingerprint`,
  `seq`, `ts`) are minimal and widely applicable; there is no benefit to reinventing them. (c)
  A `schemaVersion: "1"` literal on both event families already disambiguates narrowing on the
  `type` field.
- **Why rejected**: sharing the `BaseEvent` envelope shape (not a TypeScript import — by
  structural similarity) reduces the surface issue #10 / #13 must handle. The `WorkflowEvent`
  union is still separate from `HarnessEvent`; it only reuses the field names and types.

## Related

- ADR-0001: Project Foundation and Toolchain — zero-runtime-dependency constraint (load-bearing;
  no new npm packages); `src/workflows/` module location; strict TypeScript/ESM/LOC limits.
- ADR-0002: CI and Supply-Chain Security Baseline — CodeQL `js/polynomial-redos` gate applies to
  `isTestPath` regex (must use a single bounded character class; no nested quantifiers).
- ADR-0003: Model Gateway Boundary — `GatewayModelPort`, `Gateway`, `loadConfigFromFile`,
  `parseGatewayConfig` reused for CLI model construction. `redact()` reused for all prose and
  diff redaction in events and report.
- ADR-0004: Agent Harness Boundary and State Machine — `ModelPort` interface reused as the
  injected model seam. `GatewayModelPort` from `src/harness/adapters.ts` reused. `BaseEvent`
  envelope fields reused by structural convention.
- ADR-0005: Repository Context and Workspace Access Layer — `detectWorkspace`, `buildContextPack`,
  `readWorkspaceFile`, `WorkspaceInfo`, `ContextPack`, `DEFAULT_CONTEXT_REQUEST` consumed unchanged.
- ADR-0006: Safe Tool Execution and Sandbox Boundary — `validatePatch`, `renderDryRun`,
  `applyPatch`, `ApplyDeps`, `DEFAULT_PATCH_LIMITS` consumed unchanged. `applyEnabled: false`
  default inherited.
- ADR-0007: Verification Orchestrator and Resource Limits — `detectScripts`, `buildVerificationPlan`,
  `resolveTargetedTests`, `runVerification`, `summarizeForAudit`, `VerificationAuditSummary`,
  `DEFAULT_VERIFICATION_LIMITS` consumed unchanged.
- Issue #8: Ship unit-test generation workflow for existing code.
- Issue #10: Audit ledger — will persist `UnitTestWorkflowReport` and consume `WorkflowEvent`
  stream.
- Issue #13: UI layer — will consume `UNIT_TEST_WORKFLOW_DESCRIPTOR` to render the workflow UI
  and `WorkflowEvent` for progress display.

## Date

2026-05-29
