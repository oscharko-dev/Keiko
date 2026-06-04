// Shared internal types and small pure helpers used across the workflow pipeline stages (the
// model loop, the verify stage, and the report stages). Kept private to the module — none of these
// are re-exported from index.ts. Splitting them out keeps each pipeline file under the LOC limit
// while leaving a single source of truth for the resolved RunState and the loop result shape.

import type { PatchValidation } from "@oscharko-dev/keiko-tools";
import { createEventEmitter, type EventEmitter } from "./emit.js";
import {
  DEFAULT_WORKFLOW_LIMITS,
  type UnitTestWorkflowDeps,
  type UnitTestWorkflowInput,
  type WorkflowLimits,
} from "./types.js";
import type { WorkflowEventSink } from "./events.js";

// A no-op sink used when the caller injects none. emit is synchronous (ADR-0004 EventSink contract).
export const NO_OP_SINK: WorkflowEventSink = { emit: (): void => undefined };

export interface WorkflowProgress {
  modelCallCount: number;
  patchRetryCount: number;
}

// The resolved, defaulted view of input + deps the pipeline stages share.
export interface RunState {
  readonly input: UnitTestWorkflowInput;
  readonly deps: UnitTestWorkflowDeps;
  readonly limits: WorkflowLimits;
  readonly signal: AbortSignal;
  readonly now: () => number;
  readonly emitter: EventEmitter;
  readonly startedAt: number;
  readonly progress: WorkflowProgress;
}

// A successful model+validate+guard outcome ready for dry-run or apply.
export interface AcceptedPatch {
  readonly diff: string;
  readonly validation: PatchValidation;
  readonly coveredBehavior: string | undefined;
  readonly knownGaps: string | undefined;
}

export interface ModelLoopResult {
  readonly accepted: AcceptedPatch | undefined;
  readonly modelCallCount: number;
  readonly patchRetryCount: number;
  readonly lastRejectionCode: string | undefined;
}

// The zero-progress loop used to assemble a cancelled/failed report before the model loop ran.
export const EMPTY_LOOP: ModelLoopResult = {
  accepted: undefined,
  modelCallCount: 0,
  patchRetryCount: 0,
  lastRejectionCode: undefined,
};

export function resolveLimits(input: UnitTestWorkflowInput): WorkflowLimits {
  return { ...DEFAULT_WORKFLOW_LIMITS, ...input.limits };
}

export function buildRunState(
  input: UnitTestWorkflowInput,
  deps: UnitTestWorkflowDeps,
  fingerprint: string,
): RunState {
  const now = deps.now ?? Date.now;
  const idSource = deps.idSource ?? ((): string => crypto.randomUUID());
  return {
    input,
    deps,
    limits: resolveLimits(input),
    signal: deps.signal ?? new AbortController().signal,
    now,
    emitter: createEventEmitter(deps.sink ?? NO_OP_SINK, idSource(), fingerprint, now),
    startedAt: now(),
    progress: { modelCallCount: 0, patchRetryCount: 0 },
  };
}

// UI-renderable next actions for the report. Pure.
export function nextActionsFor(applied: boolean, files: readonly string[]): readonly string[] {
  const first = files[0] ?? "the generated test file";
  if (applied) {
    return [`Review the generated tests in ${first}`, "Run `keiko verify` to confirm they pass"];
  }
  return [
    `Review the proposed tests for ${first}`,
    "Re-run with --apply to write the tests and verify",
  ];
}
