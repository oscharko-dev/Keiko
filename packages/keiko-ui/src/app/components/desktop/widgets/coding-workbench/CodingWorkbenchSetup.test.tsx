// Unit tests for the Coding Workbench Code setup bootstrap (Issue #2385). Renders the workbench
// window inside a stubbed ActiveWorkspace context and proves the setup section appears only while
// the runtime is available and no binding is active, drives provision → set-active → refresh with
// the entered repository path and target branch, and surfaces failures as a content-free alert.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceBinding } from "@oscharko-dev/keiko-contracts";
import type { CodingWorkbenchRuntimeActions } from "@/lib/useCodingWorkbenchRuntime";
import {
  createInitialCodingWorkbenchRuntimeState,
  type CodingWorkbenchRuntimeState,
} from "@/lib/coding-workbench-live-state";
import {
  ActiveWorkspaceProvider,
  type ActiveWorkspaceApi,
} from "../../context/ActiveWorkspaceContext";
import { codingWorkbenchSetupTaskId, stripLeadingAndTrailingDashes } from "./CodingWorkbenchSetup";
import { CodingWorkbenchWindow } from "./CodingWorkbenchWindow";

const runtimeHookMock = vi.hoisted(() => vi.fn());
const provisionMock = vi.hoisted(() => vi.fn());
const reconcileMock = vi.hoisted(() => vi.fn());
const setActiveMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/useCodingWorkbenchRuntime", () => ({
  useCodingWorkbenchRuntime: runtimeHookMock,
}));

vi.mock("@/lib/task-workspace-api", () => ({
  provisionTaskWorkspace: provisionMock,
  reconcileTaskWorkspaces: reconcileMock,
  setActiveTaskWorkspace: setActiveMock,
}));

// A content-free reconciliation report whose single entry classifies the just-provisioned workspace.
// `verifyBoundWorkspace` reads only `entries[].workspaceId` and `.status`, so the minimal shape suffices.
function reconciliationReport(
  workspaceId: string,
  status: "healthy" | "drifted",
): { readonly entries: readonly { readonly workspaceId: string; readonly status: string }[] } {
  return { entries: [{ workspaceId, status }] };
}

function binding(): WorkspaceBinding {
  return {
    schemaVersion: "1",
    workspaceId: "ws-1",
    taskId: "task-1",
    activeRoot: "/managed/repo/ws-1",
    boundSurfaces: [],
    gitDeliveryRoot: "/managed/repo/ws-1",
    editorProjectRoot: "/managed/repo/ws-1",
  };
}

function workspaceApi(overrides: Partial<ActiveWorkspaceApi> = {}): ActiveWorkspaceApi {
  return {
    instances: [],
    activeBinding: null,
    activeInstance: null,
    activeRoot: null,
    loading: false,
    switching: false,
    error: null,
    refresh: vi.fn(() => Promise.resolve()),
    switchTo: vi.fn(() => Promise.resolve()),
    clearActive: vi.fn(() => Promise.resolve()),
    pause: vi.fn(() => Promise.resolve()),
    resume: vi.fn(() => Promise.resolve()),
    prepareHandoff: vi.fn(() => Promise.resolve()),
    provision: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function liveState(runtimeAvailable = true): CodingWorkbenchRuntimeState {
  return {
    ...createInitialCodingWorkbenchRuntimeState(),
    runtime: {
      status: "ready",
      value: {
        schemaVersion: "1",
        requestedMode: "governed-assist",
        deploymentCeiling: "supervised-coding",
        effectiveMode: "governed-assist",
        runtimeAvailable,
      },
      error: null,
    },
  };
}

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
  };
}

function renderWorkbench(
  api: ActiveWorkspaceApi,
  state: CodingWorkbenchRuntimeState = liveState(),
): ReturnType<typeof render> {
  runtimeHookMock.mockReturnValue({ state, actions: actions() });
  return render(
    <ActiveWorkspaceProvider value={api}>
      <CodingWorkbenchWindow />
    </ActiveWorkspaceProvider>,
  );
}

function setupSection(): HTMLElement | null {
  return screen.queryByRole("region", { name: "Code setup" });
}

describe("CodingWorkbenchSetup", () => {
  beforeEach(() => {
    provisionMock.mockReset();
    reconcileMock.mockReset();
    setActiveMock.mockReset();
  });

  it("renders the setup section while the runtime is available and no binding is active", async () => {
    const { container } = renderWorkbench(workspaceApi());

    expect(setupSection()).toBeInTheDocument();
    expect(screen.getByLabelText("Repository path")).toBeInTheDocument();
    expect(screen.getByLabelText("Target branch")).toHaveValue("main");
    expect(screen.getByRole("button", { name: "Bind workspace" })).toBeInTheDocument();
    expect(screen.queryByTestId("coding-workbench-setup-runtime-note")).not.toBeInTheDocument();

    const report = await axe(container);
    expect(
      report.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("binds the entered checkout through provision, reconciliation, activation, and a refresh", async () => {
    const user = userEvent.setup();
    const api = workspaceApi();
    provisionMock.mockResolvedValue({ instance: { workspaceId: "ws-9" }, created: true });
    reconcileMock.mockResolvedValue(reconciliationReport("ws-9", "healthy"));
    setActiveMock.mockResolvedValue({});
    renderWorkbench(api);

    await user.type(screen.getByLabelText("Repository path"), "/repos/keiko-checkout");
    await user.clear(screen.getByLabelText("Target branch"));
    await user.type(screen.getByLabelText("Target branch"), "dev");
    await user.click(screen.getByRole("button", { name: "Bind workspace" }));

    await waitFor(() => {
      expect(api.refresh).toHaveBeenCalledWith("/repos/keiko-checkout");
    });
    expect(provisionMock).toHaveBeenCalledWith({
      root: "/repos/keiko-checkout",
      taskId: codingWorkbenchSetupTaskId("dev"),
      baseBranch: "dev",
      requestedBy: "studio-operator",
    });
    // Reconciliation stamps the verified head before activation, so a hand-bound repo is startable
    // without an out-of-band API call (#2476).
    expect(reconcileMock).toHaveBeenCalledWith({ root: "/repos/keiko-checkout" });
    expect(setActiveMock).toHaveBeenCalledWith({
      workspaceId: "ws-9",
      requestedBy: "studio-operator",
    });
  });

  it("keeps the run unstartable with a content-free retry when reconciliation does not verify", async () => {
    const user = userEvent.setup();
    const api = workspaceApi();
    provisionMock.mockResolvedValue({ instance: { workspaceId: "ws-9" }, created: true });
    reconcileMock.mockResolvedValue(reconciliationReport("ws-9", "drifted"));
    renderWorkbench(api);

    await user.type(screen.getByLabelText("Repository path"), "/repos/dirty-checkout");
    await user.click(screen.getByRole("button", { name: "Bind workspace" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "The workspace could not be verified. Reconciliation did not confirm a clean, matching checkout, so the run stays unavailable. Review the repository and try again.",
    );
    expect(alert).not.toHaveTextContent("drifted");
    // A workspace reconciliation cannot verify is never activated; the setup surface stays for a retry.
    expect(setActiveMock).not.toHaveBeenCalled();
    expect(api.refresh).not.toHaveBeenCalled();
    expect(setupSection()).toBeInTheDocument();
  });

  it("treats a reconciliation error as a content-free verify failure and never activates", async () => {
    const user = userEvent.setup();
    const api = workspaceApi();
    provisionMock.mockResolvedValue({ instance: { workspaceId: "ws-9" }, created: true });
    reconcileMock.mockRejectedValue(new Error("RECONCILIATION_UNAVAILABLE"));
    renderWorkbench(api);

    await user.type(screen.getByLabelText("Repository path"), "/repos/x");
    await user.click(screen.getByRole("button", { name: "Bind workspace" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The workspace could not be verified.");
    expect(alert).not.toHaveTextContent("RECONCILIATION_UNAVAILABLE");
    expect(setActiveMock).not.toHaveBeenCalled();
    expect(setupSection()).toBeInTheDocument();
  });

  it("surfaces a content-free bind failure when activation fails after a healthy reconcile", async () => {
    const user = userEvent.setup();
    const api = workspaceApi();
    provisionMock.mockResolvedValue({ instance: { workspaceId: "ws-9" }, created: true });
    reconcileMock.mockResolvedValue(reconciliationReport("ws-9", "healthy"));
    setActiveMock.mockRejectedValue(new Error("ACTIVATION_FAILED"));
    renderWorkbench(api);

    await user.type(screen.getByLabelText("Repository path"), "/repos/x");
    await user.click(screen.getByRole("button", { name: "Bind workspace" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "The workspace could not be bound. Review the repository path and target branch.",
    );
    expect(alert).not.toHaveTextContent("ACTIVATION_FAILED");
    // Activation ran (reconcile verified) but failed before the refresh; no bound surface flips.
    expect(setActiveMock).toHaveBeenCalledTimes(1);
    expect(api.refresh).not.toHaveBeenCalled();
  });

  it("surfaces a content-free alert when the bind fails and never activates", async () => {
    const user = userEvent.setup();
    provisionMock.mockRejectedValue(new Error("WORKSPACE_ROOT_INVALID"));
    renderWorkbench(workspaceApi());

    await user.type(screen.getByLabelText("Repository path"), "/repos/broken");
    await user.click(screen.getByRole("button", { name: "Bind workspace" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "The workspace could not be bound. Review the repository path and target branch.",
    );
    expect(alert).not.toHaveTextContent("WORKSPACE_ROOT_INVALID");
    expect(setActiveMock).not.toHaveBeenCalled();
  });

  it("does not render once a binding is active", () => {
    renderWorkbench(workspaceApi({ activeBinding: binding() }));

    expect(setupSection()).not.toBeInTheDocument();
  });

  it("stays reachable with an honest note when the runtime is not confirmed available", () => {
    renderWorkbench(workspaceApi(), liveState(false));

    // #2476 AC4 — the setup no longer disappears behind runtime availability; it renders and honestly
    // explains why starting a run is unavailable so a workspace can still be bound.
    expect(setupSection()).toBeInTheDocument();
    expect(screen.getByTestId("coding-workbench-setup-runtime-note")).toHaveTextContent(
      "Starting a coding run is unavailable on this installation until the coding runtime is active.",
    );
  });

  it("derives a content-free idempotent task id from the target branch", () => {
    expect(codingWorkbenchSetupTaskId("dev")).toBe("coding-workbench-dev");
    expect(codingWorkbenchSetupTaskId("feat/Native Program")).toBe(
      "coding-workbench-feat-native-program",
    );
    expect(codingWorkbenchSetupTaskId("///")).toBe("coding-workbench");
  });

  it("strips only leading and trailing dashes, keeping interior runs intact", () => {
    expect(stripLeadingAndTrailingDashes("")).toBe("");
    expect(stripLeadingAndTrailingDashes("-")).toBe("");
    expect(stripLeadingAndTrailingDashes("----")).toBe("");
    expect(stripLeadingAndTrailingDashes("-a-")).toBe("a");
    expect(stripLeadingAndTrailingDashes("--a--b--")).toBe("a--b");
    expect(stripLeadingAndTrailingDashes("a-b")).toBe("a-b");
  });

  // SonarCloud S8786 regression: the previous /^-+|-+$/gu alternation of two unbounded
  // quantifiers is provably O(n) here (each side is anchored and can match at most once), but
  // codingWorkbenchSetupTaskId's own pipeline never hands the strip step more than a single
  // leading/trailing "-" — so this guards the extracted helper directly against a raw,
  // adversarially large dash-only input the original regex was designed to handle.
  it("stays fast trimming an adversarially large dash-only string", () => {
    const start = Date.now();
    const result = stripLeadingAndTrailingDashes("-".repeat(20_000));
    expect(Date.now() - start).toBeLessThan(1000);
    expect(result).toBe("");
  });
});
