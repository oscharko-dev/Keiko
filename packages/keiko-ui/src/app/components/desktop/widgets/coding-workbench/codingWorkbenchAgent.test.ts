import { describe, expect, it } from "vitest";
import type {
  CodingWorkbenchRuntimeSnapshot,
  CodingWorkbenchRuntimeStateName,
} from "@oscharko-dev/keiko-contracts";
import {
  createInitialCodingWorkbenchRuntimeState,
  type CodingWorkbenchMutationState,
  type CodingWorkbenchRuntimeState,
} from "@/lib/coding-workbench-live-state";
import { activeAgentIsPlan, agentSelectionLocked } from "./codingWorkbenchAgent";

const UPDATED_AT = "2026-10-23T12:00:00.000Z";

function stateIn(
  runState: CodingWorkbenchRuntimeStateName | undefined,
  overrides: Partial<CodingWorkbenchRuntimeState> = {},
): CodingWorkbenchRuntimeState {
  const run =
    runState === undefined
      ? null
      : ({
          schemaVersion: "1",
          state: runState,
          revision: 1,
          updatedAt: UPDATED_AT,
          runId: "run-1",
        } as CodingWorkbenchRuntimeSnapshot);
  return {
    ...createInitialCodingWorkbenchRuntimeState(),
    run: { status: "ready", value: run, error: null },
    ...overrides,
  };
}

const PENDING: CodingWorkbenchMutationState = {
  status: "pending",
  kind: "follow-up",
  requestId: "request-1",
  error: null,
};

describe("agent selection lock", () => {
  it.each(["starting", "ready", "running", "awaiting-approval", "stopping"] as const)(
    "is locked while the run is %s",
    (runState) => {
      expect(agentSelectionLocked(stateIn(runState), false)).toBe(true);
    },
  );

  it.each(["paused", "idle", "succeeded", "failed", "cancelled", "taken-over"] as const)(
    "is open between turns, when the run is %s",
    (runState) => {
      expect(agentSelectionLocked(stateIn(runState), false)).toBe(false);
    },
  );

  it("is open before any run exists", () => {
    expect(agentSelectionLocked(stateIn(undefined), false)).toBe(false);
  });

  it("is locked while a mutation or an issue lookup is pending", () => {
    expect(agentSelectionLocked(stateIn("paused", { mutation: PENDING }), false)).toBe(true);
    expect(agentSelectionLocked(stateIn("idle"), true)).toBe(true);
  });
});

describe("active agent", () => {
  it("is the plan agent only when the plan agent is offered and selected", () => {
    expect(activeAgentIsPlan(stateIn("idle"))).toBe(false);
    expect(
      activeAgentIsPlan(stateIn("idle", { selectableAgents: ["build", "plan"], agent: "plan" })),
    ).toBe(true);
    expect(
      activeAgentIsPlan(stateIn("idle", { selectableAgents: ["build", "plan"], agent: "build" })),
    ).toBe(false);
    // A selection the offer no longer carries is not an active plan agent.
    expect(
      activeAgentIsPlan(
        stateIn("idle", {
          selectableAgents: ["build", "plan"],
          agent: "plan",
          runtimePreference: "codex-subscription",
        }),
      ),
    ).toBe(false);
  });
});
