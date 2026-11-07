// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodingWorkbenchRuntimeReadiness,
  CodingWorkbenchRuntimeSnapshot,
} from "@oscharko-dev/keiko-contracts";
import { reportCodingWorkbenchInteraction } from "@/lib/coding-workbench-interaction";
import {
  codingWorkbenchRuntimeReducer,
  createInitialCodingWorkbenchRuntimeState,
  type CodingWorkbenchRuntimeState,
} from "@/lib/coding-workbench-live-state";
import { useCodingWorkbenchIdentityEvidence } from "./useCodingWorkbenchIdentityEvidence";

vi.mock("@/lib/coding-workbench-interaction", () => ({
  reportCodingWorkbenchInteraction: vi.fn(),
}));

const report = vi.mocked(reportCodingWorkbenchInteraction);

function run(overrides: Partial<CodingWorkbenchRuntimeSnapshot>): CodingWorkbenchRuntimeSnapshot {
  return {
    schemaVersion: "1",
    state: "running",
    revision: 3,
    updatedAt: "2026-11-03T12:00:00.000Z",
    runId: "run-1",
    ...overrides,
  };
}

function withReadiness(
  state: CodingWorkbenchRuntimeState,
  toolProfile?: CodingWorkbenchRuntimeReadiness["toolProfile"],
): CodingWorkbenchRuntimeState {
  return codingWorkbenchRuntimeReducer(state, {
    kind: "runtime-set",
    readiness: {
      schemaVersion: "1",
      requestedMode: "supervised-coding",
      deploymentCeiling: "autonomous-delivery",
      effectiveMode: "supervised-coding",
      runtimeAvailable: true,
      selectableAgents: ["build"],
      ...(toolProfile === undefined ? {} : { toolProfile }),
    },
  });
}

function withRun(
  state: CodingWorkbenchRuntimeState,
  snapshot: CodingWorkbenchRuntimeSnapshot,
): CodingWorkbenchRuntimeState {
  return codingWorkbenchRuntimeReducer(state, { kind: "run-set", snapshot });
}

describe("useCodingWorkbenchIdentityEvidence (#4068 W12)", () => {
  beforeEach(() => {
    report.mockClear();
  });

  it("records a live run's reported identity once, in reported flags only", () => {
    const initial = withRun(
      withReadiness(createInitialCodingWorkbenchRuntimeState(), "mapped"),
      run({ modelId: "private-model-name", agent: "build" }),
    );
    const { rerender } = renderHook(
      ({ state }: { state: CodingWorkbenchRuntimeState }) => {
        useCodingWorkbenchIdentityEvidence(state);
      },
      { initialProps: { state: initial } },
    );
    rerender({ state: withRun(initial, run({ modelId: "private-model-name", revision: 4 })) });

    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith({
      interaction: "run-identity-observed",
      modelReported: true,
      agentReported: true,
      toolProfile: "mapped",
    });
    expect(JSON.stringify(report.mock.calls)).not.toContain("private-model-name");
  });

  it("states an identity the server did not report as unreported", () => {
    const state = withRun(withReadiness(createInitialCodingWorkbenchRuntimeState()), run({}));
    renderHook(() => {
      useCodingWorkbenchIdentityEvidence(state);
    });
    expect(report).toHaveBeenCalledWith({
      interaction: "run-identity-observed",
      modelReported: false,
      agentReported: false,
      toolProfile: "unreported",
    });
  });

  it("records nothing without a live run or before readiness is known", () => {
    const idle = withReadiness(createInitialCodingWorkbenchRuntimeState(), "mapped");
    const settled = withRun(idle, run({ state: "failed", modelId: "m" }));
    const unread = withRun(createInitialCodingWorkbenchRuntimeState(), run({ modelId: "m" }));
    for (const state of [idle, settled, unread]) {
      renderHook(() => {
        useCodingWorkbenchIdentityEvidence(state);
      });
    }
    expect(report).not.toHaveBeenCalled();
  });
});
