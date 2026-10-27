import type { CodingWorkbenchAgent } from "@oscharko-dev/keiko-contracts";
import {
  codingWorkbenchAgentKind,
  reportCodingWorkbenchInteraction,
} from "@/lib/coding-workbench-interaction";
import {
  offeredCodingWorkbenchAgents,
  type CodingWorkbenchRuntimeState,
} from "@/lib/coding-workbench-live-state";
import { activeRunState } from "./codingWorkbenchLabels";

/**
 * Whether the Build | Plan switch is fixed right now (#3897). The agent is chosen between turns, so
 * the switch stays open while a run is paused, exactly where a follow-up is possible, and while no
 * run is live. It is fixed for any turn in flight and while a runtime mutation or an issue lookup
 * is pending, like the other run controls.
 */
export function agentSelectionLocked(
  state: CodingWorkbenchRuntimeState,
  extraPending: boolean,
): boolean {
  const runState = state.run.value?.state;
  return (
    (activeRunState(runState) && runState !== "paused") ||
    state.mutation.status === "pending" ||
    extraPending
  );
}

/**
 * True when the next turn runs under the plan agent. Only an offered selection counts, so a stale
 * choice never labels a run as read-only when the server would not run it that way.
 */
export function activeAgentIsPlan(state: CodingWorkbenchRuntimeState): boolean {
  return state.agent === "plan" && offeredCodingWorkbenchAgents(state).includes("plan");
}

/** The operator's agent choice as routine evidence: a built-in id or `custom`, never a custom name. */
export function reportAgentSelection(agent: CodingWorkbenchAgent): void {
  reportCodingWorkbenchInteraction({
    interaction: "agent-selected",
    agent: codingWorkbenchAgentKind(agent),
  });
}
