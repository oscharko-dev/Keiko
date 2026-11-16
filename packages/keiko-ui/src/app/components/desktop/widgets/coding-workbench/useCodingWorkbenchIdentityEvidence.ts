import { useEffect, useRef } from "react";
import { reportCodingWorkbenchInteraction } from "@/lib/coding-workbench-interaction";
import {
  codingWorkbenchVisibleIdentity,
  type CodingWorkbenchRuntimeState,
} from "@/lib/coding-workbench-live-state";

/**
 * Records once per live run what this window could state about it (#4068 W12), so a reload's visible
 * identity is reconstructable from the Activity Log. It waits for readiness: until then the tool
 * profile is merely unknown here, not unreported by the server. Reported flags only, never a model
 * or a custom agent's name.
 */
export function useCodingWorkbenchIdentityEvidence(state: CodingWorkbenchRuntimeState): void {
  const reportedRunId = useRef<string | null>(null);
  const identity = codingWorkbenchVisibleIdentity(state);
  const runId = identity.source === "run" ? (state.run.value?.runId ?? null) : null;
  const readinessKnown = state.runtime.status === "ready";
  const modelReported = identity.modelId !== null;
  const agentReported = identity.agent !== null;
  const toolProfile = state.toolProfile ?? "unreported";
  useEffect(() => {
    if (runId === null || !readinessKnown || reportedRunId.current === runId) return;
    reportedRunId.current = runId;
    reportCodingWorkbenchInteraction({
      interaction: "run-identity-observed",
      modelReported,
      agentReported,
      toolProfile,
    });
  }, [agentReported, modelReported, readinessKnown, runId, toolProfile]);
}
