import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import type {
  CodingWorkbenchRuntimeSnapshot,
  CodingWorkbenchRuntimeSseEvent,
} from "@oscharko-dev/keiko-contracts";
import type { CodingWorkbenchRuntimeActions } from "@/lib/useCodingWorkbenchRuntime";
import {
  createInitialCodingWorkbenchRuntimeState,
  type CodingWorkbenchRuntimeState,
} from "@/lib/coding-workbench-live-state";
import { CodingWorkbenchWindow } from "./CodingWorkbenchWindow";

const runtimeHookMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/useCodingWorkbenchRuntime", () => ({
  useCodingWorkbenchRuntime: runtimeHookMock,
}));

const AT = "2026-07-13T12:00:00.000Z";

function actions(): CodingWorkbenchRuntimeActions {
  return {
    setRequestedMode: vi.fn(),
    setRuntimePreference: vi.fn(),
    refreshProfile: vi.fn(() => Promise.resolve()),
    refreshSource: vi.fn(() => Promise.resolve()),
    refreshRuntime: vi.fn(() => Promise.resolve()),
    refreshRun: vi.fn(() => Promise.resolve()),
    start: vi.fn(() => Promise.resolve()),
    decideApproval: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    takeover: vi.fn(() => Promise.resolve()),
    retry: vi.fn(() => Promise.resolve()),
    acknowledgeRecovery: vi.fn(() => Promise.resolve()),
    pause: vi.fn(() => Promise.resolve()),
    resume: vi.fn(() => Promise.resolve()),
    submitFollowUp: vi.fn(() => Promise.resolve()),
    revokeResearchGrant: vi.fn(() => Promise.resolve()),
  };
}

function snapshot(
  overrides: Partial<CodingWorkbenchRuntimeSnapshot> = {},
): CodingWorkbenchRuntimeSnapshot {
  return {
    schemaVersion: "1",
    state: "idle",
    revision: 1,
    updatedAt: AT,
    ...overrides,
  } as CodingWorkbenchRuntimeSnapshot;
}

function event(sequence: number): CodingWorkbenchRuntimeSseEvent {
  return {
    schemaVersion: "1",
    cursor: `cursor-${String(sequence)}`,
    sequence,
    occurredAt: AT,
    kind: "runtime-event",
    runId: "run-1",
    state: "running",
    revision: sequence,
    eventKind: "observation-streamed",
  };
}

function liveState(
  overrides: Partial<CodingWorkbenchRuntimeState> = {},
): CodingWorkbenchRuntimeState {
  return {
    ...createInitialCodingWorkbenchRuntimeState(),
    source: {
      status: "ready",
      value: {
        runtimePreference: "managed-gateway",
        modelSource: "keiko-model-gateway",
        runtimeSource: "keiko-sidecar",
        available: true,
      },
      error: null,
    },
    workspace: {
      status: "ready",
      value: {
        workspaceId: "workspace-1",
        taskId: "task-1",
        taskBranch: "issue/2257",
        health: "healthy",
        switching: false,
      },
      error: null,
    },
    runtime: {
      status: "ready",
      value: {
        schemaVersion: "1",
        requestedMode: "governed-assist",
        deploymentCeiling: "supervised-coding",
        effectiveMode: "governed-assist",
        runtimeAvailable: true,
      },
      error: null,
    },
    run: { status: "ready", value: snapshot(), error: null },
    canStart: true,
    ...overrides,
  };
}

function renderWorkbench(
  state: CodingWorkbenchRuntimeState = liveState(),
  liveActions: CodingWorkbenchRuntimeActions = actions(),
): CodingWorkbenchRuntimeActions {
  runtimeHookMock.mockReturnValue({ state, actions: liveActions });
  render(<CodingWorkbenchWindow />);
  return liveActions;
}

describe("CodingWorkbenchWindow", () => {
  it("renders only live server-confirmed readiness and starts with transient task intent", async () => {
    const user = userEvent.setup();
    const liveActions = renderWorkbench();

    expect(screen.getByRole("heading", { name: "Coding Workbench" })).toBeInTheDocument();
    expect(screen.getByText(/Server effective mode:/u)).toHaveTextContent(
      "Server effective mode: Ask for approval.",
    );
    expect(screen.getByText(/Deployment ceiling:/u)).toHaveTextContent(
      "Deployment ceiling: Supervised workspace.",
    );
    expect(screen.getByText("task-1 · issue/2257 · healthy")).toBeInTheDocument();
    expect(screen.queryByText(/Issue #1990|marketing|preview/u)).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Task instructions"), "Investigate the failing test");
    await user.click(screen.getByRole("button", { name: "Start coding run" }));
    expect(liveActions.start).toHaveBeenCalledWith("Investigate the failing test");
  });

  it("binds one-time approval controls to live pending permission truth", async () => {
    const user = userEvent.setup();
    const liveActions = renderWorkbench(
      liveState({
        run: {
          status: "ready",
          error: null,
          value: snapshot({
            state: "awaiting-approval",
            runId: "run-1",
            pendingPermission: {
              requestId: "permission-1",
              kind: "delivery-substrate",
              actionClass: "delivery-substrate",
              reasonCode: "approval-required",
              actionKind: "push",
              scopeLabel: "workspace-scope",
              risk: "high",
              policyReason: "approval-required",
              expiresAt: "2026-07-13T12:05:00.000Z",
            },
          }),
        },
      }),
    );

    expect(screen.getByRole("heading", { name: "Review the bounded action" })).toBeInTheDocument();
    expect(screen.queryByText(/diff --git|Bearer|\/Users\//u)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Approve once" }));
    await user.click(screen.getByRole("button", { name: "Deny" }));
    expect(liveActions.decideApproval).toHaveBeenNthCalledWith(1, "approved");
    expect(liveActions.decideApproval).toHaveBeenNthCalledWith(2, "denied");
  });

  it("renders recovery acknowledgement before allowing a fresh retry", async () => {
    const user = userEvent.setup();
    const liveActions = renderWorkbench(
      liveState({
        canStart: false,
        canRetry: false,
        run: {
          status: "ready",
          error: null,
          value: snapshot({
            state: "recovery-required",
            runId: "run-1",
            failureCode: "recovery-required",
          }),
        },
      }),
    );

    await user.click(screen.getByRole("button", { name: "Acknowledge recovery" }));
    expect(liveActions.acknowledgeRecovery).toHaveBeenCalledOnce();
  });

  it("announces an unavailable authentication setup plan in the single live status", () => {
    renderWorkbench(
      liveState({
        codexSetup: {
          status: "unavailable",
          value: null,
          error: {
            code: "CODEX_SETUP_UNAVAILABLE",
            message: "Setup is unavailable.",
            retryable: true,
          },
        },
      }),
    );

    expect(screen.getByRole("status")).toHaveTextContent("Authentication setup plan unavailable.");
  });

  it("virtualizes a 1,000-event timeline to at most 96 rendered event rows", () => {
    const events = Array.from({ length: 1_000 }, (_, index) => event(index + 1));
    runtimeHookMock.mockReturnValue({ state: liveState({ events }), actions: actions() });
    const { container } = render(<CodingWorkbenchWindow />);

    expect(
      container.querySelectorAll(
        'ol[aria-label="Coding run event timeline"] > li:not([aria-hidden])',
      ),
    ).toHaveLength(96);
  });

  it("has no serious or critical axe violations in the live ready state", async () => {
    runtimeHookMock.mockReturnValue({ state: liveState(), actions: actions() });
    const { container } = render(<CodingWorkbenchWindow />);

    const report = await axe(container);
    expect(
      report.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("surfaces the internet research grant and revokes it during a live run", async () => {
    const user = userEvent.setup();
    const liveActions = renderWorkbench(
      liveState({
        run: {
          status: "ready",
          error: null,
          value: snapshot({
            state: "running",
            runId: "run-1",
            researchGrant: {
              grantId: "grant-1",
              domains: ["developer.mozilla.org", "nodejs.org"],
              expiresAt: "2026-07-13T12:30:00.000Z",
            },
          }),
        },
      }),
    );

    const group = screen.getByRole("group", { name: "Internet · Research only" });
    expect(group).toHaveTextContent("developer.mozilla.org, nodejs.org");
    expect(group).toHaveTextContent("2026-07-13T12:30:00.000Z");
    const revoke = screen.getByRole("button", {
      name: "Revoke the internet research grant for this run and its child agents",
    });
    expect(revoke).toBeEnabled();
    await user.click(revoke);
    expect(liveActions.revokeResearchGrant).toHaveBeenCalledOnce();
  });
});
