// Shared internal types and small pure helpers used across the bug-investigation pipeline stages
// (the model loop, the verify stage, the report stages). Kept private to the module — none of these
// are re-exported from index.ts. Splitting them out keeps each pipeline file under the LOC limit
// while leaving a single source of truth for the resolved BugRunState and the loop result shape.

import type { PatchLimits, PatchValidation } from "../../tools/index.js";
import { createBugEventEmitter, type BugEventEmitter } from "./emit.js";
import {
  DEFAULT_BUG_WORKFLOW_LIMITS,
  type BugInvestigationDeps,
  type BugInvestigationInput,
  type BugWorkflowLimits,
  type Hypothesis,
} from "./types.js";
import type { BugWorkflowEventSink } from "./events.js";

// A no-op sink used when the caller injects none. emit is synchronous (ADR-0004 EventSink contract).
export const NO_OP_SINK: BugWorkflowEventSink = { emit: (): void => undefined };

export interface BugWorkflowProgress {
  modelCallCount: number;
  patchRetryCount: number;
}

// The resolved, defaulted view of input + deps the pipeline stages share.
export interface BugRunState {
  readonly input: BugInvestigationInput;
  readonly deps: BugInvestigationDeps;
  readonly limits: BugWorkflowLimits;
  readonly signal: AbortSignal;
  readonly now: () => number;
  readonly emitter: BugEventEmitter;
  readonly startedAt: number;
  readonly progress: BugWorkflowProgress;
}

// A successful model+validate+guard outcome ready for dry-run or apply.
export interface AcceptedBugPatch {
  readonly diff: string;
  readonly validation: PatchValidation;
  readonly hypothesis: Hypothesis;
}

export interface BugModelLoopResult {
  // A validated, in-scope patch (fix-proposed / fix-applied path).
  readonly accepted: AcceptedBugPatch | undefined;
  // A root-cause hypothesis with NO patch (investigation-only path).
  readonly investigationOnly: Hypothesis | undefined;
  readonly modelCallCount: number;
  readonly patchRetryCount: number;
  readonly lastRejectionCode: string | undefined;
}

// The zero-progress loop used to assemble a cancelled/failed report before the model loop ran.
export const EMPTY_BUG_LOOP: BugModelLoopResult = {
  accepted: undefined,
  investigationOnly: undefined,
  modelCallCount: 0,
  patchRetryCount: 0,
  lastRejectionCode: undefined,
};

export function resolveBugLimits(input: BugInvestigationInput): BugWorkflowLimits {
  return { ...DEFAULT_BUG_WORKFLOW_LIMITS, ...input.limits };
}

// The #6 PatchLimits view derived from the resolved workflow limits (D6 bound 1). Passed into
// validatePatch/applyPatch via their `limits` override seam — #6's defaults stay untouched.
export function patchLimitsFrom(limits: BugWorkflowLimits): PatchLimits {
  return {
    maxFilesChanged: limits.maxFilesChanged,
    maxChangedLines: limits.maxChangedLines,
    maxPatchBytes: limits.maxPatchBytes,
  };
}

export function buildBugRunState(
  input: BugInvestigationInput,
  deps: BugInvestigationDeps,
  fingerprint: string,
): BugRunState {
  const now = deps.now ?? Date.now;
  const idSource = deps.idSource ?? ((): string => crypto.randomUUID());
  return {
    input,
    deps,
    limits: resolveBugLimits(input),
    signal: deps.signal ?? new AbortController().signal,
    now,
    emitter: createBugEventEmitter(deps.sink ?? NO_OP_SINK, idSource(), fingerprint, now),
    startedAt: now(),
    progress: { modelCallCount: 0, patchRetryCount: 0 },
  };
}

// UI-renderable next actions for the report. Pure. `elevated` lists changed manifest/config paths
// that warrant elevated review (D6).
export function nextActionsFor(
  applied: boolean,
  files: readonly string[],
  elevated: readonly string[],
): readonly string[] {
  const first = files[0] ?? "the proposed fix";
  const base = applied
    ? [`Review the applied fix in ${first}`, "Run `keiko verify` to confirm the suite is green"]
    : [`Review the proposed fix for ${first}`, "Re-run with --apply to write the fix and verify"];
  if (elevated.length > 0) {
    return [
      ...base,
      `This fix modifies build/manifest configuration (${elevated.join(", ")}) — review with elevated scrutiny before applying`,
    ];
  }
  return base;
}

// The next-actions list for the investigation-only outcome (no patch produced).
export function investigationNextActions(): readonly string[] {
  return [
    "No safe fix was proposed; review the root-cause hypothesis and uncertainty",
    "Provide more evidence (full failing output, stack trace, or suspected files) and re-run",
  ];
}
