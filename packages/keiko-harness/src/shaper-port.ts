// Optional, injected shaped-observation port (ADR-0055 D4, PR4-W3). The harness produces a
// ContextToolObservation for a completed tool call WITHOUT importing keiko-workflows: the
// concrete shaper (shapeCommandObservation et al.) lives in keiko-workflows and is injected as
// this port by the production wiring tier (keiko-cli / keiko-sdk / keiko-server), which already
// depends on keiko-workflows. The harness depends only on keiko-contracts for the observation
// type. When no port is injected, the executor never shapes and keeps the existing fail-closed
// context-size behavior.
//
// The port is content-agnostic: it receives the completed ToolCallResult plus the originating
// call's name/id/arguments and returns a ContextToolObservation or undefined (no shape for this
// tool type). It MUST be total and fail closed: production wiring may inject evidence-layer IO, but
// failures must be represented on the observation (for example notPersistedReason), never thrown
// through the harness. The shaped observation is attached to the keiko-internal ToolCallResult /
// accumulator; the executor renders a compact role:tool message from it only when raw output would
// exceed the live context budget.

import type { ContextToolObservation, ToolCallResult } from "@oscharko-dev/keiko-contracts";

export interface HarnessShaperInput {
  // The completed result whose `output` remains the preferred model-facing string when it fits.
  readonly result: ToolCallResult;
  // The tool that produced the result (e.g. "run_command").
  readonly toolName: string;
  // Correlates the observation back to the originating tool call.
  readonly toolCallId: string;
  // The model-supplied arguments for the call (used by the search shaper to recover the query).
  readonly arguments: Record<string, unknown>;
}

export type HarnessShaperPort = (input: HarnessShaperInput) => ContextToolObservation | undefined;
