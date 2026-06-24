// Optional, injected shaped-observation port (ADR-0055 D4, PR4-W3). The harness produces a
// ContextToolObservation for a completed tool call WITHOUT importing keiko-workflows: the
// concrete shaper (shapeCommandObservation et al.) lives in keiko-workflows and is injected as
// this port by the production wiring tier (keiko-cli / keiko-sdk / keiko-server), which already
// depends on keiko-workflows. The harness depends only on keiko-contracts for the observation
// type. When no port is injected (every existing caller), the executor never shapes — the run is
// byte-identical to today (D6 unchanged-guarantee).
//
// The port is content-agnostic: it receives the completed ToolCallResult plus the originating
// call's name/id/arguments and returns a ContextToolObservation or undefined (no shape for this
// tool type). It MUST be pure and total — it never throws and performs no IO. The shaped
// observation is attached ONLY to the keiko-internal ToolCallResult / accumulator; it is NEVER
// serialized into the model-facing role:tool ChatMessage content (which stays result.output).

import type { ContextToolObservation, ToolCallResult } from "@oscharko-dev/keiko-contracts";

export interface HarnessShaperInput {
  // The completed result whose `output` is the byte-identical model-facing string.
  readonly result: ToolCallResult;
  // The tool that produced the result (e.g. "run_command").
  readonly toolName: string;
  // Correlates the observation back to the originating tool call.
  readonly toolCallId: string;
  // The model-supplied arguments for the call (used by the search shaper to recover the query).
  readonly arguments: Record<string, unknown>;
}

export type HarnessShaperPort = (input: HarnessShaperInput) => ContextToolObservation | undefined;
