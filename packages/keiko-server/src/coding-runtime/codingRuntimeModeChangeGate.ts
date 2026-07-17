// Server-owned authority gate for Code-task mode changes (Issue #2386). The client `locked` flag
// is a hint, not the boundary; this pure function is the enforcing rule. A mode change is accepted
// only while the run is idle or paused, and any change that widens the effective authority posture
// additionally requires the run to be stopped (returned to idle) first. Reasons are content-free
// codes so the decision can be audited without leaking any run detail.
import {
  isCodingWorkbenchModeWidening,
  resolveEffectiveCodingWorkbenchMode,
  type CodingWorkbenchMode,
  type CodingWorkbenchRuntimeStateName,
} from "@oscharko-dev/keiko-contracts";

export type CodingRuntimeModeChangeReason =
  "mode-change-requires-idle-or-paused" | "widening-requires-stop";

export type CodingRuntimeModeChangeDecision =
  | { readonly ok: true; readonly effectiveMode: CodingWorkbenchMode }
  | { readonly ok: false; readonly reasonCode: CodingRuntimeModeChangeReason };

export interface CodingRuntimeModeChangeInput {
  readonly currentState: CodingWorkbenchRuntimeStateName;
  readonly currentRequestedMode: CodingWorkbenchMode;
  readonly requestedMode: CodingWorkbenchMode;
  readonly deploymentCeiling: CodingWorkbenchMode;
}

/** States from which a mode change may be considered at all; every other state rejects outright. */
const MODE_CHANGE_STATES: ReadonlySet<CodingWorkbenchRuntimeStateName> = new Set([
  "idle",
  "paused",
]);

/**
 * Decide whether a requested mode change is admissible. Widening is judged on the effective
 * (ceiling-clamped) postures, never the raw request, so a lowered deployment ceiling cannot be
 * bypassed. A widening change is only ever admissible from idle (a stopped run); a paused run must
 * be stopped first.
 */
export function decideCodingRuntimeModeChange(
  input: CodingRuntimeModeChangeInput,
): CodingRuntimeModeChangeDecision {
  const effectiveMode = resolveEffectiveCodingWorkbenchMode(
    input.requestedMode,
    input.deploymentCeiling,
  );
  if (!MODE_CHANGE_STATES.has(input.currentState)) {
    return { ok: false, reasonCode: "mode-change-requires-idle-or-paused" };
  }
  const currentEffective = resolveEffectiveCodingWorkbenchMode(
    input.currentRequestedMode,
    input.deploymentCeiling,
  );
  const widening = isCodingWorkbenchModeWidening(currentEffective, effectiveMode);
  if (widening && input.currentState !== "idle") {
    return { ok: false, reasonCode: "widening-requires-stop" };
  }
  return { ok: true, effectiveMode };
}
