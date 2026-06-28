# ADR-0054: Tool-observation shaping for context lanes

## Status

Proposed

## Version

0.2.0

## Context

ADR-0052 (PR1) established the eight-lane taxonomy, including a `tool-observations` lane, and
ADR-0053 (PR2) defined `ContextRehydrationHandle` with `kind: "tool-result"` as a typed but
unresolved variant. Both ADRs explicitly deferred the question of **how** raw tool output becomes
a shaped, bounded, redaction-proven, injection-flagged item inside the `tool-observations` lane.

The current state of the live tool flow (confirmed by direct read):

- `runCommand` in `packages/keiko-tools/src/exec.ts` caps stdout+stderr at
  `policy.maxOutputBytes = 262_144` (256 KiB, `tools.ts:67`) via the `appendCapped` helper
  (`exec.ts:275–290`). When the cap fires, both streams are replaced with the string
  `"[TRUNCATED OUTPUT REDACTED]"` (`exec.ts:130,342–343`) and `CommandResult.truncated` is set to
  `true`. The internal `buffers.total` counter is clamped to `maxOutputBytes` at line 287
  (`buffers.total = max`), so the ACTUAL count of bytes the child attempted to write above the cap
  is **discarded**. There is no `omittedByteCount` field in `CommandResult`
  (`tools.ts:201–215`).
- `redact` from `keiko-security` is applied to each stream before it leaves `buildResult`
  (`exec.ts:355–356`). Redaction happens correctly; the omitted-byte count is the gap.
- `summarizeCommand` at `packages/keiko-tools/src/registry.ts:95–104` serialises the
  `CommandResult` as a raw JSON string placed directly in `ToolCallResult.output` — the string the
  model sees. It includes `stdout` and `stderr` verbatim (already redacted+capped, but
  unstructured). No shaping, no injection scan, no size budget for the lane.
- `ToolCallResult` (`tools.ts:363–373`) carries only `toolCallId`, `output: string`,
  `durationMs`, `commandExecuted?`, and `metadata?: ToolCallMetadata`. There is no
  `shapedObservation?` field.
- `detectPromptInjectionSignals` (`keiko-security/src/promptInjection.ts:249–267`) is
  authoritative (ADR-0044): it returns `{code, severity, matchCount}[]` — content-free, ReDoS-safe,
  never echoes matched text. It is not called anywhere in the tool execution path today.
- `VerificationResult` (`keiko-contracts/src/verification.ts:79–96`) already carries `truncated`,
  `redacted`, `outputSummary`, and `appliedLimits`. The `outputDigest` function in
  `packages/keiko-verification/src/orchestrator.ts:140–153` composes the byte count into a
  human-readable string — again, no structured shaped observation type.
- `SearchResult` (`packages/keiko-workspace/src/repoSearch.ts:81–88`) carries
  `atoms: EvidenceAtom[]`, `candidates`, `filesScanned`, `elapsedMs`, `truncated`. Rich but
  unshaped for lane use.
- The harness CI gate (`scripts/check-context-quality.mjs:522–527`) emits
  `toolObservationShapingFidelity` in the `scaffolded` section with `value: null` and
  `deferredUntil: "PR3"`. Its threshold is absent from
  `scripts/check-context-quality.budget.json` (confirmed: only a `$comment_deferred` note).
- `allowsTools` on `TaskPlan` (`packages/keiko-harness/src/tasks/policy.ts:16`) is the primary
  structural anti-injection fence: when `false`, the harness never enters a tool-call state, so
  an injected payload in retrieved content cannot trigger a tool call regardless of its content.

PR3 must: (a) define the additive typed observation shapes in `keiko-contracts`; (b) add the
additive `omittedByteCount?` field to `CommandResult` captured in `exec.ts`; (c) place pure
shaper functions in `keiko-workflows`; (d) forward-define `ShapedBrowserObservation` with no live
shaper; (e) make `ContextRehydrationHandle` kind `"tool-result"` carry a meaningful opaque
`artifactId`; (f) make `toolObservationShapingFidelity` load-bearing in the CI gate.

Constraints carry over from ADR-0052 and ADR-0053: `exactOptionalPropertyTypes`,
`verbatimModuleSyntax`, `noUncheckedIndexedAccess`; no `as T`, no `!`; cyclomatic complexity ≤ 10,
function ≤ 50 LOC, file ≤ 400 LOC; `keiko-contracts` is a strict leaf (`boundary.test.ts` must
stay green); additive and backward-compatible on every existing type; no new npm dependencies;
offline, deterministic.

## Decision

We will deliver PR3 as four additive waves:

**W1** — add the shaped observation contract types to `keiko-contracts` (a new
`context-observations.ts`, or appended to `context-engineering.ts` if it stays under the 400-LOC
cap after the split into `context-engineering-validation.ts`); add `CommandResult.omittedByteCount?`
and `ToolCallResult.shapedObservation?` as additive optional fields.

**W2** — add the `omittedByteCount` capture to `keiko-tools/src/exec.ts`: an additive `attempted`
field on the internal `Buffers` interface that tracks total child bytes regardless of capping, then
set `omittedByteCount = buffers.attempted - policy.maxOutputBytes` when `buffers.truncated`. This
is the ONLY change to `keiko-tools` in PR3.

**W3** — add pure shaper functions in `keiko-workflows/src/observations/` producing the shaped
types from existing `CommandResult`, `VerificationResult`, and `SearchResult` values. No new
package edge is added.

**W4** — make `toolObservationShapingFidelity` load-bearing in the harness CI gate: move it from
`scaffolded` to `measured`, add its threshold to
`scripts/check-context-quality.budget.json`, and add corpus fixtures that exercise shaped command,
test, and search observations. Gate threshold ≥ 0.9.

### D1 — Additive contract schema

All new types live in `keiko-contracts`. All are pure readonly interfaces with no imports from
sibling `@oscharko-dev/keiko-*` packages. The discriminated union `ContextToolObservation` wraps
the three concrete shaped types plus the forward-defined browser type.

```ts
// packages/keiko-contracts/src/context-observations.ts
// Shaped observations for the tool-observations context lane. Pure readonly contracts.
// Produced by keiko-workflows/src/observations/; consumed by the lane assembler (PR4).
// No @oscharko-dev/keiko-* sibling import; boundary.test.ts stays green.

// ─── Shaped command observation ────────────────────────────────── [PR3, additive]
// A bounded, redaction-proven, injection-flagged view of a single run_command result.
// Preserves the exit-code signal and structural stderr/stdout excerpts without dumping
// the full raw output into the context window.
export interface ShapedCommandObservation {
  readonly kind: "command";
  // Stable id correlating this observation to its ContextRehydrationHandle.
  // SHA-256 hex of the ToolCallResult.toolCallId bytes (sha256Hex from keiko-workspace stableId.ts).
  readonly observationId: string;
  // Non-null only when the child exited normally; null on signal/timeout.
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
  // True when exec.ts replaced the streams with TRUNCATED_OUTPUT_MARKER (CommandResult.truncated).
  readonly truncated: boolean;
  // Bytes the child wrote above the cap; undefined when not truncated.
  readonly omittedByteCount?: number | undefined;
  // Bounded excerpts from each stream. A shaper limits the total bytes across all excerpts to
  // MAX_OBSERVATION_EXCERPT_BYTES (4 KiB). Each excerpt carries the original stream label and the
  // byte count so the lane assembler can render a compact summary.
  readonly excerpts: readonly ShapedStreamExcerpt[];
  // Count of PromptInjectionSignal items (content-free). Zero means no signals fired.
  // Present only when the shaper ran detectPromptInjectionSignals; absent on fast paths.
  readonly injectionSignalCount?: number | undefined;
  // True if any signal had severity "critical" (instruction-override / secret-exfiltration / etc.).
  readonly hasCriticalInjectionSignal?: boolean | undefined;
  // Rehydration handle for the full redacted output; absent when output intentionally not persisted.
  // The handle kind is "tool-result"; artifact persistence is PR5.
  readonly rehydration?: ContextToolRehydrationHandle | undefined;
}

export interface ShapedStreamExcerpt {
  // Which stream the text came from.
  readonly stream: "stdout" | "stderr";
  // Byte length of this excerpt (UTF-8). Sum across all excerpts ≤ MAX_OBSERVATION_EXCERPT_BYTES.
  readonly bytes: number;
  // The excerpt text — already redacted (redact() applied by the shaper).
  readonly text: string;
}

// ─── Shaped test observation ────────────────────────────────────── [PR3, additive]
// A bounded, structured view of a single VerificationResult. Captures the semantically
// important signals (counts, failing names, stack frames) without the full log.
export interface ShapedTestObservation {
  readonly kind: "test";
  readonly observationId: string;
  readonly verificationKind: string; // VerificationKind from keiko-contracts/verification.ts
  readonly status: string; // VerificationStatus
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly truncated: boolean;
  // Byte count omitted from the raw output (present when truncated).
  readonly omittedByteCount?: number | undefined;
  // Pass/fail/skip counts (always present).
  readonly counts: ShapedTestCounts;
  // Names of failing tests — capped at MAX_FAILING_TEST_NAMES (16) to bound lane size.
  readonly failingTestNames: readonly string[];
  // Bounded stack frame excerpts (last N lines per failing test) — redacted.
  readonly stackFrameExcerpts: readonly string[];
  // The VerificationResult.outputSummary (already redacted+bounded by the orchestrator).
  readonly outputSummary: string;
  readonly injectionSignalCount?: number | undefined;
  readonly hasCriticalInjectionSignal?: boolean | undefined;
  readonly rehydration?: ContextToolRehydrationHandle | undefined;
}

export interface ShapedTestCounts {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
}

// ─── Shaped search observation ──────────────────────────────────── [PR3, additive]
// A bounded view of a SearchResult. Preserves the top-scoring ranges so the lane
// assembler can render relevant citations without including all raw atom text.
export interface ShapedSearchObservation {
  readonly kind: "search";
  readonly observationId: string;
  readonly query: string; // verbatim, bounded; the shaper must cap at MAX_OBSERVATION_QUERY_BYTES
  readonly searchKind: string; // e.g. "text" | "find-files"
  // Total candidates before any limit was applied.
  readonly candidateCount: number;
  // Top-ranking file ranges included (capped at MAX_TOP_RANGES = 8).
  readonly topRanges: readonly ShapedSearchRange[];
  // Count of candidates that were omitted due to limits.
  readonly omittedCount: number;
  readonly truncated: boolean;
  // Injection signals on the query (untrusted input: user-typed or model-generated).
  readonly injectionSignalCount?: number | undefined;
  readonly hasCriticalInjectionSignal?: boolean | undefined;
  // No rehydration handle: search is re-runnable; the EvidenceAtom scopePath+lineRange
  // is sufficient for a readExcerpt re-fetch (PR2 pattern).
}

export interface ShapedSearchRange {
  readonly scopePath: string; // relative, deny-checked by the shaper before inclusion
  readonly startLine: number;
  readonly endLine: number;
  readonly score: number;
}

// ─── Browser observation (forward-defined, no live shaper in PR3) ─ [PR3, forward]
// Keiko has no live browser-tool result producer. Playwright verification results are
// VerificationResult items and map to ShapedTestObservation. This type is defined now
// for surface stability so PR6 can add a shaper without a contract change. No live
// shaper is shipped in PR3 — exactly the CompactionRecord/RehydrationHandle precedent
// from ADR-0052 D8.
export interface ShapedBrowserObservation {
  readonly kind: "browser";
  readonly observationId: string;
  // Short, structured description of the browser check (e.g. route + check type).
  readonly checkDescription: string;
  readonly passed: boolean;
  readonly durationMs: number;
  // Count of accessibility violations if the check was an axe scan.
  readonly a11yViolationCount?: number | undefined;
  // Redacted screenshot path (relative, never absolute). Not persisted in PR3.
  readonly screenshotScopePath?: string | undefined;
  readonly injectionSignalCount?: number | undefined;
  readonly hasCriticalInjectionSignal?: boolean | undefined;
  readonly rehydration?: ContextToolRehydrationHandle | undefined;
}

// ─── Discriminated union for the tool-observations lane ─────────── [PR3, additive]
export type ContextToolObservation =
  | ShapedCommandObservation
  | ShapedTestObservation
  | ShapedSearchObservation
  | ShapedBrowserObservation;

// ─── Tool-result rehydration handle ─────────────────────────────── [PR3, additive]
// An opaque, content-free pointer to the full (pre-shaping) redacted tool output.
// Extends ContextRehydrationHandle with kind === "tool-result" semantics.
// The artifactId is the sha256Hex of the ToolCallResult.toolCallId — stable and
// reproducible across the same session turn. Evidence persistence is PR5.
export interface ContextToolRehydrationHandle {
  readonly schemaVersion: "1";
  readonly laneId: "tool-observations";
  readonly kind: "tool-result";
  // Opaque stable key. sha256Hex(toolCallId). PR5 uses this as the EvidenceStore key.
  readonly artifactId: string;
  // Number of original content items (1 for a command, N for a test with N failing cases).
  readonly itemCount: number;
  // Approximate token cost of the full unshapen output (for PR4 lane-budget decisions).
  readonly approxTokens: number;
  // Set when the full output was intentionally not persisted (e.g. output exceeded cap AND
  // the redacted truncation marker is the authoritative content). No PR5 write expected.
  readonly notPersistedReason?: string | undefined;
}

// ─── Size constants (tunable, not part of the public interface shape) ─
// These are frozen defaults for the shapers; they do not appear in the
// shaped types themselves so they can be re-tuned without a contract change.
export const MAX_OBSERVATION_EXCERPT_BYTES = 4_096; // total across all stream excerpts per observation
export const MAX_FAILING_TEST_NAMES = 16;
export const MAX_OBSERVATION_QUERY_BYTES = 512;
export const MAX_TOP_RANGES = 8;
export const MAX_STACK_FRAME_LINES = 30; // total across all stackFrameExcerpts per observation
```

### D2 — Additive attach points on existing types

All fields below are optional and emitted by conditional-spread at producers. No existing field
changes type or becomes required. Legacy callers that pass no new fields and read no new diagnostics
are byte-for-byte unaffected.

```ts
// keiko-contracts/src/tools.ts — additive extension to CommandResult    [PR3-W1]
export interface CommandResult {
  // ... all PR1 fields unchanged ...
  // Bytes the child attempted to write above policy.maxOutputBytes; absent when not truncated.
  // Captured in exec.ts buildResult() from buffers.attempted - policy.maxOutputBytes.
  readonly omittedByteCount?: number | undefined;
}

// keiko-contracts/src/tools.ts — additive extension to ToolCallResult   [PR3-W1]
export interface ToolCallResult {
  // ... all existing fields unchanged ...
  // Shaped observation produced by keiko-workflows shapers; absent on legacy callers
  // and on non-shapeable tool types (read_file, list_files, inspect_package_scripts, propose_patch).
  readonly shapedObservation?: ContextToolObservation | undefined;
}
```

`ToolCallMetadata` is not extended in PR3: the `kind: "command"` branch already carries
`argCount`, `exitCode`, `timedOut`, and `sandbox` — sufficient for the audit ledger. An
`omittedBytes?` field on the metadata branch is a PR5 concern (evidence persistence layer) when
the metadata is written to the audit ledger.

### D3 — Live-flow decision: additive projection in PR3, prompt-wiring in PR4

We will NOT change the model-facing `ToolCallResult.output` (the string that `summarizeCommand`
at `registry.ts:95–104` emits) in PR3. The `summarizeCommand` function remains byte-identical.

**Rationale**: the model-facing output is the single most behavior-sensitive string in the harness.
Any change to it constitutes an agent-behavior change that affects acceptance criteria, test
expectations, and end-to-end session fidelity. PR3 is a contracts-and-shapers wave; behavior
changes belong in the orchestrator/harness integration wave (PR4) where the full context assembly
is wired and can be validated end-to-end.

Instead, PR3 shapers produce `ContextToolObservation` values as an **additive parallel
projection** alongside the existing `ToolCallResult.output`. The shaped observation is stored in
the additive `ToolCallResult.shapedObservation?` field. The context layer (PR4) will read
`shapedObservation` to populate the `tool-observations` lane; the model-facing `output` string is
unchanged until PR4 explicitly replaces it as part of the harness integration.

This approach:
- Keeps the CI gate `summarizeCommand` output invariant for PR3.
- Allows the harness CI gate's `toolObservationShapingFidelity` to become load-bearing on the
  shaped types without changing any live model-facing behavior.
- Gives PR4 a complete, tested shaped-observation surface to wire into the prompt-assembly path.

The one keiko-tools change (W2: `omittedByteCount?` in `exec.ts`) is additive. `summarizeCommand`
does not include `omittedByteCount` in the JSON it emits (only `exitCode`, `signal`, `timedOut`,
`truncated`, `stdout`, `stderr`). Legacy test expectations for `summarizeCommand` output are
unaffected.

### D4 — Shaper placement: keiko-workflows/src/observations/

Shapers live in a new `keiko-workflows/src/observations/` directory as pure, no-IO functions.
They consume `CommandResult`, `VerificationResult`, and `SearchResult` values from their respective
source packages; call `redact` and `detectPromptInjectionSignals` from `keiko-security`; and
return the shaped observation types from `keiko-contracts`.

**No new package edge is added.** `keiko-workflows` already depends on:
- `keiko-contracts` (governor, allocator, compaction types)
- `keiko-security` (cited in `decision-log.md:51` as a reuse target)
- `keiko-workspace` (allocator reuses `selectScoredTextByByteBudget` pattern; compaction reuses
  `readExcerpt`)
- `keiko-tools` (the compaction builder in PR2 consumed `AllocateContextResult` from the allocator
  in the same package; the shaper will import `CommandResult` type from `keiko-contracts` — not
  from `keiko-tools` directly — because `CommandResult` is re-exported from `keiko-contracts/src/tools.ts`)
- `keiko-verification` (compaction records `ContextCommandOutcome`; the test shaper needs
  `VerificationResult` from `keiko-contracts/src/verification.ts`)

All imports stay within the existing dependency graph. `boundary.test.ts` (`ADR-0019`) stays green.

The shaper module structure:

```
keiko-workflows/src/observations/
  index.ts          — barrel (re-exports public shaper functions)
  command.ts        — shapeCommandObservation(result: CommandResult, ...): ShapedCommandObservation
  test.ts           — shapeTestObservation(result: VerificationResult, ...): ShapedTestObservation
  search.ts         — shapeSearchObservation(result: SearchResult, ...): ShapedSearchObservation
  shared.ts         — makeObservationId(toolCallId): string; countInjectionSignals(text): {...}
```

Each shaper function signature accepts: the raw result, a `{ maxExcerptBytes: number }` options
object (defaulting to `MAX_OBSERVATION_EXCERPT_BYTES`), and an optional `toolCallId?: string`
so the caller can supply the id for the `observationId` derivation without the shaper reading it
from a mutable context. Functions are ≤ 50 LOC each; if a function exceeds that, it delegates to
private helpers in the same file.

### D5 — omittedByteCount capture in exec.ts

The `Buffers` interface at `exec.ts:123–128` gains an `attempted: number` field initialized to 0.
The `appendCapped` function at `exec.ts:275–290` increments `buffers.attempted` by `chunk.length`
unconditionally (before the cap check), in addition to the existing `buffers.total` increment.
After the cap fires, subsequent chunks still increment `attempted` (the early `truncated` return
at line 284 prevents further buffering but the stream data events stop naturally after the child
is killed by `terminate`). In `buildResult` (`exec.ts:324–362`), when `buffers.truncated` is
`true`, the returned `CommandResult` carries:

```ts
omittedByteCount: buffers.attempted - policy.maxOutputBytes
```

This is an additive optional field — existing callers that do not read it are unaffected.
`summarizeCommand` does not serialize `omittedByteCount` (it only serializes the six existing
fields), so the model-facing JSON string is unchanged.

**Important constraint**: `attempted` increments only while the data events fire. Once the child
is killed (flood protection triggers `terminate`), no further data events arrive. The computed
`omittedByteCount` will therefore undercount the true total for a child that would have produced
far more than `maxOutputBytes` — it reflects only what arrived in the stream before kill, not what
the child's process would eventually have written. This is documented in the field's comment and
accepted: any positive `omittedByteCount` is a sufficient signal for the shaper to populate
`truncated: true` and carry the handle; the exact count is advisory.

### D6 — Injection signal: content-free recording, PR4 fencing

Each shaper calls `detectPromptInjectionSignals` (`keiko-security/src/promptInjection.ts:249`) on
untrusted content (the stdout/stderr excerpts for commands, `outputSummary` for tests, the query
string for searches) and records:

- `injectionSignalCount: signals.length` — total signals fired (content-free count).
- `hasCriticalInjectionSignal: signals.some(s => s.severity === 'critical')` — boolean flag
  (content-free).

The `matchCount` from individual `PromptInjectionSignal` entries is NOT persisted on the
observation (counts content detail; the aggregate count is sufficient for PR4 gating). The matched
text is never persisted (content-free by construction, `promptInjection.ts:59–62`).

The `allowsTools` structural fence on `TaskPlan` (`keiko-harness/src/tasks/policy.ts:16`) remains
the PRIMARY anti-injection guard. PR3 adds a secondary informational signal: the shaped
observation carries the content-free injection flag so the PR4 lane assembler can make the
`allowsTools` guard observable in diagnostics without relying on the raw output. PR3 does NOT
gate or block tool calls based on the injection signal — that behavioral change belongs in PR4.

### D7 — Artifact handle: opaque key in PR3, evidence persistence in PR5

When the raw tool output is shapeable and not intentionally discarded, the shaper produces a
`ContextToolRehydrationHandle` with:

- `artifactId = sha256Hex(toolCallId)` — deterministic, stable, session-scoped.
  `sha256Hex` is already exported from `keiko-workspace/src/stableId.ts:37` and is available
  to `keiko-workflows` (the dependency already exists).
- `notPersistedReason` set when the output was truncated AND the redaction marker is the only
  available content (no point persisting `"[TRUNCATED OUTPUT REDACTED]"`).

PR3 does NOT write any file. The handle is an in-memory value attached to
`ToolCallResult.shapedObservation.rehydration`. PR5 will consume this handle to write the
redacted full output to `EvidenceStore` keyed by `artifactId`, completing the `"tool-result"`
rehydration path defined in ADR-0053 D2.

PR2's `ContextRehydrationHandle` (in `keiko-contracts/src/context-engineering.ts`) for
`kind: "tool-result"` currently returns `"unresolvable in PR2"` from `rehydrateHandle`. PR3
does not change that function — it defines the separate `ContextToolRehydrationHandle` as
the concrete shaped-observation handle. The relationship: a `ContextToolRehydrationHandle` IS
the PR3-era `"tool-result"` handle; PR5 will bridge them by making `rehydrateHandle` for
`kind: "tool-result"` look up the `EvidenceStore` by `artifactId`.

### D8 — Browser/UI decision: forward-define only, no live shaper

Keiko has NO live browser-tool result producer. Browser UI checks run through Playwright
verification (`keiko-verification`), which produces `VerificationResult` items — these map
cleanly to `ShapedTestObservation` with `verificationKind: "test"`.

We forward-define `ShapedBrowserObservation` (included in the `ContextToolObservation` union)
with no live shaper function in PR3. This is the exact pattern used for `ContextCompactionRecord`
and `ContextRehydrationHandle` in ADR-0052 D8: define the shape for surface stability, implement
when the producer exists. PR6 (in-app browser verification) will add the shaper when the
browser-tool result producer is introduced.

This choice avoids shipping speculative code (the browser shaper has no input to consume in PR3)
while keeping the discriminated union stable for PR4's lane assembler.

### D9 — Harness gate: toolObservationShapingFidelity

The gate moves from `scaffolded` (null value) to `measured` with threshold ≥ 0.9. The
`evaluateToolObservationShapingFidelity` function in `scripts/check-context-quality.mjs` verifies
that, for each corpus scenario that exercises a tool call:

1. **Signal preservation**: the shaped observation carries `exitCode`, `durationMs`, and
   `truncated` matching the source `CommandResult` exactly.
2. **Failing test names**: for a `ShapedTestObservation`, `failingTestNames` is non-empty when
   `counts.failed > 0`.
3. **omittedByteCount**: when `truncated: true`, `omittedByteCount` is present and positive.
4. **Redaction**: a corpus command fixture with an embedded secret shape in its stdout produces
   a `ShapedCommandObservation` whose excerpts do not contain the secret (redact applied).
5. **Injection flag**: a corpus fixture with an injection cue in tool output produces
   `injectionSignalCount >= 1` and the correct `hasCriticalInjectionSignal` value.

The corpus must contain at least one truncated command fixture, one failing-test fixture, and one
injection-cue fixture. The gate threshold ≥ 0.9 means at most one fixture may fail fidelity
checks. The threshold is added to `scripts/check-context-quality.budget.json` as
`minToolObservationShapingFidelity: 0.9`.

### D10 — What PR3 does NOT do

- **No prompt-wiring**: the `tool-observations` lane is not assembled into any model-facing prompt
  in PR3. That is PR4 (`buildGatewayMessages`/`conversationForGateway`/harness loop integration).
- **No evidence persistence**: `ContextToolRehydrationHandle.artifactId` is computed but nothing
  is written to `EvidenceStore`. That is PR5 (`persistContextAssemblyEvidence`).
- **No UI disclosure**: `ContextStatusPanel` grounding disclosure is PR6.
- **No change to summarizeCommand output**: `ToolCallResult.output` is byte-identical to today.
- **No live browser shaper**: `ShapedBrowserObservation` is defined but has no producer in PR3.
- **No `ToolCallMetadata` extension**: the audit-ledger metadata branch is unchanged in PR3.
- **No rehydrateHandle resolution for "tool-result"**: that resolution is PR5.

## Consequences

### Positive

- The `tool-observations` lane gains a precise typed vocabulary before the lane is wired. PR4
  can implement lane assembly against a stable, tested interface rather than discovering the
  shape during wiring.
- `omittedByteCount` closes the long-standing silent-truncation gap: the lane assembler (PR4)
  can accurately account for the budget impact of truncated outputs rather than guessing.
- Injection signals are recorded in a content-free, audit-safe way on every shaped observation.
  The PR4 lane assembler and the evidence layer (PR5) receive an honest flag without ever seeing
  the injected text.
- No new package dependencies are introduced. The shaper module is a pure, offline, no-IO unit
  fully testable with fake inputs.
- `ContextToolRehydrationHandle` makes the PR2 `"tool-result"` kind meaningful without requiring
  any persistence infrastructure, consistent with the milestone's in-memory-first approach.

### Negative

- `ToolCallResult.shapedObservation?` and `CommandResult.omittedByteCount?` add surface to the
  already-wide tool contract types. Future readers must understand that `shapedObservation` is
  absent on legacy callers and on non-command tools.
- The `omittedByteCount` value may undercount for children that would have produced far more than
  the cap if not killed — documented and accepted.
- `ShapedBrowserObservation` carries no live producer in PR3. A new reader of the
  `ContextToolObservation` union will encounter a dead branch. The `kind: "browser"` discriminant
  makes it structurally identical to PR2's `"tool-result"` placeholder pattern.

### Neutral

- The live model-facing output is unchanged in PR3. This is the correct trade-off for a
  contracts/shaper wave, but it means PR3 alone does not improve the actual context quality the
  model sees. The improvement is observable only after PR4 wires the lanes.
- The `sha256Hex` dependency on `keiko-workspace/src/stableId.ts` is already available to
  `keiko-workflows` (used by the compaction builder in PR2). No new import chain is required.

## Alternatives Considered

### Alternative 1: Mutate summarizeCommand in PR3 to emit shaped output directly

Change `summarizeCommand` in `registry.ts:95–104` to emit a structured JSON object (the shaped
observation) as `ToolCallResult.output`, replacing the raw `{exitCode, signal, stdout, stderr, ...}`
blob.

- **Pros**: immediate improvement to what the model sees; single location for the shaping logic;
  no `shapedObservation?` field needed.
- **Cons**: `summarizeCommand` output is the model-facing contract. Any change to it is a
  behavior change that invalidates test expectations on `ToolCallResult.output` across the entire
  test suite, potentially breaks session replay fixtures, and changes the model's context in ways
  that can only be validated with live model runs. PR3 has no harness integration gate on the
  assembled prompt. The shaped output may also be larger or differently structured than what the
  model has been tuned against for this codebase.
- **Why rejected**: the live-flow principle established by ADR-0052 D8 applies here. Behavioral
  changes to the model-facing output belong in the harness-integration PR (PR4), where the full
  prompt-assembly path is wired and gate-covered. Changing model-facing output in a
  contracts-and-shapers wave is the most likely way to introduce a silent regression.

### Alternative 2: Place the shapers in keiko-tools alongside summarizeCommand

Add an `observations.ts` to `keiko-tools` so the shaper and the serializer live in the same
package, and have `runCommandTool` in `registry.ts` populate `shapedObservation` directly.

- **Pros**: no cross-package call for the command shaper; `CommandResult` is a local type.
- **Cons**: `keiko-tools` would need to import `keiko-security` (for `detectPromptInjectionSignals`)
  and `keiko-contracts/context-observations` (for the shaped types). `keiko-tools` currently
  imports only `keiko-security` (`redact`, already present — `exec.ts:15`) and `keiko-workspace`.
  The `detectPromptInjectionSignals` import would be new for `keiko-tools`. More importantly,
  test shapers need `VerificationResult` from `keiko-contracts/verification.ts` — a type that
  belongs to the verification domain, not the tools domain. Placing both command and test shapers
  in `keiko-tools` would make `keiko-tools` responsible for verification concerns (a violation of
  single-responsibility). Splitting shapers across `keiko-tools` and `keiko-workflows` creates
  two discovery points for the same abstraction, violating the "fewer paths" quality standard.
- **Why rejected**: `keiko-workflows` already depends on both `keiko-tools` (via the compaction
  builder's `ContextCommandOutcome` type, derived from command results) and `keiko-verification`.
  It is the natural home for cross-domain policy that spans tool types. The ADR-0052 precedent
  places the allocator in `keiko-workflows` for the same reason.

### Alternative 3: Place the shapers in keiko-server near the orchestrator

Add observation shaping to `keiko-server`, where the two context paths converge and where
`buildGatewayMessages` / `conversationForGateway` produce the final prompt assembly.

- **Pros**: co-located with the consumer (PR4 prompt wiring happens in keiko-server); a single
  jump from raw result to prompt-ready lane item.
- **Cons**: `keiko-server` is the orchestration/IO tier (ADR-0019 dependency direction: high-level
  policy depends on lower tiers). Placing pure, no-IO shaping logic in `keiko-server` makes it
  untestable in isolation and mixes policy with orchestration. The allocator precedent (ADR-0052 D6)
  explicitly rejected putting pure allocation policy in `keiko-server` for these reasons. The
  same argument applies to pure observation shaping.
- **Why rejected**: the allocator is in `keiko-workflows` for testability and dependency-direction
  reasons. Observation shaping is the same class of pure policy. `keiko-workflows` is the correct
  tier.

### Alternative 4: Skip the ShapedBrowserObservation type, add it in PR6 when the producer exists

Omit `ShapedBrowserObservation` from the union entirely in PR3. Add it in PR6 when the
in-app browser verification tool is introduced.

- **Pros**: pure YAGNI; zero dead code; the union has only live members.
- **Cons**: adding a new union member in PR6 is a breaking change to any exhaustive switch on
  `ContextToolObservation.kind`. PR4's lane assembler will write an exhaustive switch. Without the
  `"browser"` arm pre-defined, PR6 must either (a) patch every switch site or (b) ask the team
  to accept a non-exhaustive switch at PR4 time — both are avoidable churn. The
  `CompactionRecord`/`RehydrationHandle` precedent (ADR-0052 D8) demonstrates that defining a type
  without implementing its producer costs very little and avoids a later surface churn.
- **Why rejected**: the cost of one unused interface is lower than the cost of a non-additive
  union extension in PR6. The milestone constraint "define the full vocabulary up front so later
  PRs are purely implementational" applies here.

## Acceptance gates (measurable)

1. **Backward compatibility.** A legacy `ToolCallResult` fixture with no `shapedObservation?`
   and a legacy `CommandResult` fixture with no `omittedByteCount?` validate and round-trip
   unchanged. Pinned by `tools.test.ts` absent-field guards.
2. **Additive field types.** TypeScript compile under the package `tsconfig` with no `as T`,
   no `!`, no ESLint suppressions; all new files ≤ 400 LOC; cyclomatic complexity ≤ 10 per
   function. `boundary.test.ts` stays green (no new sibling `@oscharko-dev/keiko-*` import
   in `keiko-contracts`).
3. **omittedByteCount correctness.** A unit test with a fake `SpawnFn` that emits exactly
   `maxOutputBytes + N` bytes asserts that `CommandResult.omittedByteCount === N` (within the
   "undercount on kill" tolerance — the test uses a single contiguous chunk so all bytes arrive
   before kill). A non-truncated run asserts `omittedByteCount === undefined`.
4. **summarizeCommand byte-identical.** A test asserts that `JSON.parse(summarizeCommand(result))`
   contains exactly the keys `{exitCode, signal, timedOut, truncated, stdout, stderr}` and no
   `omittedByteCount` key. This gate pins the live-flow invariant mechanically.
5. **Shaper signal preservation.** `shapeCommandObservation(commandResult)` returns a
   `ShapedCommandObservation` with `exitCode`, `durationMs`, `truncated`, and `omittedByteCount`
   matching the source `CommandResult` exactly.
6. **Shaper redaction.** A command result whose `stdout` contains a redactable secret shape
   produces a `ShapedCommandObservation` whose `excerpts[*].text` does not contain the secret
   (redact applied by the shaper before slicing excerpts).
7. **Injection signal content-free.** A command result whose `stdout` contains an
   instruction-override cue produces `injectionSignalCount >= 1` and
   `hasCriticalInjectionSignal === true`. Neither the cue text nor any fragment of the matched
   content appears in the `ShapedCommandObservation`.
8. **Excerpt size bound.** For any `CommandResult`, the sum of `excerpts[*].bytes` in the
   produced `ShapedCommandObservation` is ≤ `MAX_OBSERVATION_EXCERPT_BYTES`. Tested with a
   result whose stdout is 1 MiB.
9. **Test shaper counts.** `shapeTestObservation` with a `VerificationResult` carrying two
   failing tests produces `counts.failed === 2` and `failingTestNames.length === 2`.
10. **toolObservationShapingFidelity gate ≥ 0.9.** `npm run check:context-quality` exits 0 with
    `toolObservationShapingFidelity` reported as measured (not scaffolded) and ≥ 0.9 on the corpus
    that includes command/test/search fixtures covering gates 3–9 above.

## Wave breakdown

**W1 — contracts types + additive fields + validators (keiko-contracts)**

New file `packages/keiko-contracts/src/context-observations.ts` with the full vocabulary from D1:
`ShapedCommandObservation`, `ShapedStreamExcerpt`, `ShapedTestObservation`, `ShapedTestCounts`,
`ShapedSearchObservation`, `ShapedSearchRange`, `ShapedBrowserObservation`,
`ContextToolObservation`, `ContextToolRehydrationHandle`, size constants. Validators following the
`{ ok: true } | { ok: false; reasons }` envelope (house pattern). Additive optional field
`CommandResult.omittedByteCount?` on the existing interface in `tools.ts`. Additive optional
field `ToolCallResult.shapedObservation?` on the existing interface in `tools.ts`. Subpath export
`./context-observations` added to `package.json` (same pattern as `./context-engineering`). Tests:
absent-field backward-compat guards + validator round-trip + type-level anti-regression.

**W2 — omittedByteCount capture (keiko-tools)**

`packages/keiko-tools/src/exec.ts`: add `attempted: number` to the internal `Buffers` interface
(initialized 0); increment it by `chunk.length` in `appendCapped` unconditionally; set
`omittedByteCount: buffers.attempted - policy.maxOutputBytes` in `buildResult` when
`buffers.truncated`. Tests: fake-SpawnFn unit test asserting correct omittedByteCount on
truncation and `undefined` on non-truncation; `summarizeCommand` byte-identical assertion.

**W3 — shapers + tests (keiko-workflows)**

New directory `packages/keiko-workflows/src/observations/` with four source files per D4. Each
shaper:
- Accepts the raw result type + options.
- Calls `redact` on untrusted stream text before slicing to `maxExcerptBytes`.
- Calls `detectPromptInjectionSignals` on the combined (pre-redaction, post-cap) text and records
  `injectionSignalCount` / `hasCriticalInjectionSignal`.
- Computes `observationId = sha256Hex(toolCallId ?? '')`.
- Builds a `ContextToolRehydrationHandle` with `artifactId = sha256Hex(toolCallId)` when
  the output is shapeable, or sets `notPersistedReason` when truncated-and-empty.
- Returns the shaped type; never throws (total function, unknown input → empty excerpts).

Tests: one test file per shaper exercising signal preservation, redaction, injection flag,
excerpt bound, and backward-compat. Tests use fake `CommandResult` / `VerificationResult` /
`SearchResult` objects — no real processes, no IO.

**W4 — harness gate tighten (scripts)**

`scripts/check-context-quality.mjs`: move `toolObservationShapingFidelity` from `scaffolded` to
`measured`; add `evaluateToolObservationShapingFidelity` function that exercises the shapers
directly against corpus fixtures. `scripts/check-context-quality.budget.json`: add
`"minToolObservationShapingFidelity": 0.9`. Corpus: add fixtures covering a truncated command,
a failing-test result, a search result, and a command with injection cues. Tests for the gate
evaluator itself.

## Self-critique pass

**Pass 1 — Devil's Advocate:**

- Every new field is additive? Yes — `CommandResult.omittedByteCount?`, `ToolCallResult.shapedObservation?`,
  and all observation fields are `| undefined`, emitted by conditional-spread. No existing field
  changes type or cardinality. The `summarizeCommand` output is pinned as byte-identical by gate 4.
- No new package edge from the shaper? `keiko-workflows` already depends on `keiko-contracts`,
  `keiko-security`, `keiko-workspace`, `keiko-tools` (type imports via `keiko-contracts/tools`),
  and `keiko-verification` (type imports via `keiko-contracts/verification`). The shaper imports
  `redact` and `detectPromptInjectionSignals` from `keiko-security` (already in the dep graph
  per `decision-log.md:51`). `sha256Hex` from `keiko-workspace/stableId.ts` is already used by
  the PR2 compaction builder in the same package. Confirmed: zero new package edges.
- Live tool flow unchanged (no AC regression) in PR3? Yes — `summarizeCommand` is unchanged,
  `ToolCallResult.output` is unchanged, and `shapedObservation?` is absent on the existing
  `WorkspaceToolHost.execute` call path (the field is not yet set by the host; it is set by
  the PR4 shaping wrapper). Wait — this is actually a risk: if PR4 wraps the host and sets
  `shapedObservation?` additively, the PR3 gate (`shapedObservation` on `ToolCallResult`) must
  be tested via the shaper functions directly, not via the live `execute` path. The W4 gate
  evaluator calls the shapers directly — this is correct and sufficient.
- Injection signal content-free? The observation carries only `injectionSignalCount: number`
  and `hasCriticalInjectionSignal: boolean`. The `PromptInjectionSignal.matchCount` from each
  individual signal is dropped. The matched text is never in any shaped field. Gate 7 asserts
  this mechanically.
- omittedByteCount captured without changing the redaction/truncation contract? The new
  `buffers.attempted` counter is purely additive to the internal `Buffers` struct. `appendCapped`
  already exits early after setting `truncated`; the new `attempted += chunk.length` line runs
  before the existing `remaining` check on the first (truncating) chunk. Subsequent data events
  do not fire (child is killed). The redaction in `buildResult` (`redact(Buffer.concat(buffers.out))`)
  is unchanged — it runs only on the non-truncated path (the truncated path uses the static
  marker string). No change to redaction semantics.
- Could `ShapedBrowserObservation` create confusion in PR4's exhaustive switch? Yes — the PR4
  implementor must handle the `"browser"` arm. They can return a no-op (empty lane contribution)
  for the dead branch; this is explicit and safe, unlike ignoring an untyped observation.

**Pass 2 — Clarity:**

- Is the decision concrete enough? A new engineer can find `keiko-workflows/src/observations/`,
  read the shaper API (`shapeCommandObservation(result, options) → ShapedCommandObservation`),
  and implement it against the types in `context-observations.ts` without ambiguity.
- Are the consequences honest? Yes — the cost of `shapedObservation?` on the wide `ToolCallResult`
  type is acknowledged; the undercount risk of `omittedByteCount` is documented.
- Did we cite real alternatives? Yes — all three rejected alternatives (mutate summarizeCommand,
  shapers in keiko-tools, shapers in keiko-server) are genuine options that a reasonable engineer
  would consider.
- Is the ADR free of undefined jargon? File:line references given for every claim about existing
  code. ADR-0044 is cited for `detectPromptInjectionSignals` provenance.

## Related

- ADR-0052: defines the `tool-observations` lane and the `ContextRehydrationHandle` stub (PR1).
  The eight-lane taxonomy, the allocator, and the additive-projection principle are established
  there.
- ADR-0053: defines `ContextRehydrationHandle.kind: "tool-result"` as an unresolved variant
  (PR2). PR3 defines `ContextToolRehydrationHandle` as the concrete shaped-observation handle
  that PR5 will bridge to `rehydrateHandle`.
- ADR-0019: modular package architecture and `boundary.test.ts`. D4 above justifies no new
  package edge for the shaper placement in `keiko-workflows`.
- ADR-0044: prompt-enhancer architecture. Establishes `detectPromptInjectionSignals` in
  `keiko-security` as the authoritative, content-free injection detector (not QI's
  `scanForPromptInjections`).
- ADR-0048: evidence artifact confidentiality. The `ContextToolRehydrationHandle.artifactId`
  will be the EvidenceStore key in PR5; that write goes through `redact`/`writeSideFile`/
  `applyRetention` per ADR-0048 posture.
- `packages/keiko-tools/src/registry.ts:95–104` — `summarizeCommand` (live model-facing output;
  unchanged in PR3).
- `packages/keiko-tools/src/exec.ts:123–128,275–290,324–362` — `Buffers` interface,
  `appendCapped`, `buildResult` (W2 change site).
- `packages/keiko-contracts/src/tools.ts:201–215,363–373` — `CommandResult`, `ToolCallResult`
  (additive attach points).
- `packages/keiko-contracts/src/verification.ts:79–96` — `VerificationResult` (test shaper input).
- `packages/keiko-workspace/src/repoSearch.ts:81–88` — `SearchResult` (search shaper input).
- `packages/keiko-security/src/promptInjection.ts:249–267` — `detectPromptInjectionSignals`
  (content-free injection scan).
- `packages/keiko-workspace/src/stableId.ts:37` — `sha256Hex` (reused for `observationId` and
  `artifactId`).
- `packages/keiko-harness/src/tasks/policy.ts:16` — `TaskPlan.allowsTools` (primary injection
  structural fence; unchanged in PR3).
- `scripts/check-context-quality.mjs:522–527` — scaffolded `toolObservationShapingFidelity`
  (promoted to measured in W4).
- `scripts/check-context-quality.budget.json` — gate thresholds (W4 adds
  `minToolObservationShapingFidelity: 0.9`).

## Date

2026-06-23
