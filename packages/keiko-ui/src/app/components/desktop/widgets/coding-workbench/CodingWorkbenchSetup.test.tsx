// Unit tests for the Coding Workbench Code setup bootstrap (Issue #2385). Renders the workbench
// window inside a stubbed ActiveWorkspace context and proves the setup section appears only while
// the runtime is available and no binding is active, drives provision → set-active → refresh with
// the entered repository path and target branch, and surfaces failures as a content-free alert.

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";

const runtimeHookMock = vi.hoisted(() => vi.fn());
const provisionMock = vi.hoisted(() => vi.fn());
const reconcileMock = vi.hoisted(() => vi.fn());
const setActiveMock = vi.hoisted(() => vi.fn());
const listMock = vi.hoisted(() => vi.fn());
const repairMock = vi.hoisted(() => vi.fn());
const baseBranchMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/useCodingWorkbenchRuntime", () => ({
  useCodingWorkbenchRuntime: runtimeHookMock,
}));

vi.mock("@/lib/task-workspace-api", () => ({
  provisionTaskWorkspace: provisionMock,
  reconcileTaskWorkspaces: reconcileMock,
  setActiveTaskWorkspace: setActiveMock,
  listTaskWorkspaces: listMock,
  repairTaskWorkspace: repairMock,
  fetchRepositoryBaseBranch: baseBranchMock,
}));

// The persisted row provisioning refused for the (repository, task) pair the setup card derives
// from the target branch, carrying the classified finding and the server's recovery hint.
function refusedWorkspace(
  hint: { readonly strategy: string; readonly operatorActionRequired: boolean },
  marker = "identity-schema-retired",
): unknown {
  return {
    workspaceId: "ws-refused",
    taskId: codingWorkbenchSetupTaskId("main"),
    driftMarkers: [marker],
    recoveryHints: [{ marker, ...hint }],
  };
}

function pointerDrift(): Error {
  return Object.assign(new Error("sensitive worktree detail"), {
    code: "POINTER_DRIFT",
    failureClass: "repairable",
  });
}

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
    inventoryUnavailable: false,
    refresh: vi.fn(() => Promise.resolve(true)),
    switchTo: vi.fn(() => Promise.resolve(true)),
    clearActive: vi.fn(() => Promise.resolve(true)),
    pause: vi.fn(() => Promise.resolve(true)),
    resume: vi.fn(() => Promise.resolve(true)),
    prepareHandoff: vi.fn(() => Promise.resolve(true)),
    repair: vi.fn(() => Promise.resolve(true)),
    provision: vi.fn(() => Promise.resolve(true)),
    ...overrides,
  };
}

function liveState(
  runtimeAvailable = true,
  runtimeEvidenceClass:
    "platform-qualified" | "functional-not-platform-qualified" = "platform-qualified",
): CodingWorkbenchRuntimeState {
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
        ...(runtimeAvailable ? { runtimeEvidenceClass } : {}),
      },
      error: null,
    },
  };
}

function actions(): CodingWorkbenchRuntimeActions {
  return {
    setRequestedMode: vi.fn(),
    setRuntimePreference: vi.fn(),
    setSelectedModel: vi.fn(),
    setReasoningEffort: vi.fn(),
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

function renderWorkbench(
  api: ActiveWorkspaceApi,
  state: CodingWorkbenchRuntimeState = liveState(),
  selectedRoot?: string,
): ReturnType<typeof render> {
  runtimeHookMock.mockReturnValue({ state, actions: actions() });
  return render(
    <ActiveWorkspaceProvider value={api}>
      <CodingWorkbenchWindow selectedRoot={selectedRoot} />
    </ActiveWorkspaceProvider>,
  );
}

function setupSection(): HTMLElement | null {
  return screen.queryByRole("region", { name: "Code setup" });
}

type UserApi = ReturnType<typeof userEvent.setup>;

function bindButton(): HTMLElement {
  return screen.getByRole("button", { name: "Bind workspace" });
}

// Waits for the card to be bindable. A path the operator entered has no branch default yet — the
// lookup is armed when they LEAVE the field, and binding stays refused until it settles, so the
// task id can never be derived from the previous repository's untouched default (CodeRabbit review
// of #3381).
async function bindable(): Promise<HTMLElement> {
  const button = bindButton();
  await waitFor(() => {
    expect(button).toBeEnabled();
  });
  return button;
}

// The operator's own sequence for a typed checkout: enter the path, leave the field, bind.
async function bindEnteredPath(user: UserApi, path: string): Promise<void> {
  await user.type(screen.getByLabelText("Repository path"), path);
  await user.tab();
  await user.click(await bindable());
}

// Runs the bind sequence's remaining continuations to completion. Used where the assertion is that
// NOTHING is published, which has no positive signal of its own to wait for.
async function flushBindSequence(): Promise<void> {
  await act(async () => {
    for (let step = 0; step < 8; step += 1) await Promise.resolve();
  });
}

describe("CodingWorkbenchSetup", () => {
  beforeEach(() => {
    provisionMock.mockReset();
    reconcileMock.mockReset();
    setActiveMock.mockReset();
    listMock.mockReset();
    repairMock.mockReset();
    baseBranchMock.mockReset();
    baseBranchMock.mockResolvedValue(null);
  });

  afterEach(() => {
    resetClientDiagnosticWriter();
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

  // ADR-0163 D9: the bootstrap setup section is the FIRST screen a fresh evaluation install shows.
  // A clean form here would imply a verified runtime.
  it("states the unverified evaluation runtime on the bootstrap setup screen", async () => {
    const { container } = renderWorkbench(
      workspaceApi(),
      liveState(true, "functional-not-platform-qualified"),
    );

    expect(setupSection()).toBeInTheDocument();
    const note = screen.getByTestId("coding-workbench-setup-runtime-evaluation-note");
    expect(note).toHaveTextContent(/unverified evaluation runtime/iu);
    // The unavailable note states a different condition and must not appear alongside it.
    expect(screen.queryByTestId("coding-workbench-setup-runtime-note")).not.toBeInTheDocument();

    const report = await axe(container);
    expect(
      report.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("renders neither runtime note on a platform-qualified install", () => {
    renderWorkbench(workspaceApi(), liveState(true, "platform-qualified"));

    expect(setupSection()).toBeInTheDocument();
    expect(screen.queryByTestId("coding-workbench-setup-runtime-note")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("coding-workbench-setup-runtime-evaluation-note"),
    ).not.toBeInTheDocument();
  });

  it("prefills the selected Workbench repository without granting managed execution authority", async () => {
    renderWorkbench(workspaceApi(), liveState(), "/repos/selected");

    expect(setupSection()).toBeInTheDocument();
    expect(screen.getByLabelText("Repository path")).toHaveValue("/repos/selected");
    // The selection arms the branch lookup for that repository, and binding waits for it: until it
    // settles the field still shows the fallback, which belongs to no repository at all.
    expect(bindButton()).toBeDisabled();
    await bindable();
    expect(setActiveMock).not.toHaveBeenCalled();
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
      expect(api.refresh).toHaveBeenCalledTimes(1);
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

    await bindEnteredPath(user, "/repos/dirty-checkout");

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

    await bindEnteredPath(user, "/repos/x");

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

    await bindEnteredPath(user, "/repos/x");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "The workspace could not be bound. Review the repository path and target branch.",
    );
    expect(alert).not.toHaveTextContent("ACTIVATION_FAILED");
    // Activation ran (reconcile verified) but failed before the refresh; no bound surface flips.
    expect(setActiveMock).toHaveBeenCalledTimes(1);
    expect(api.refresh).not.toHaveBeenCalled();
  });

  // Provision, reconcile and activate all COMPLETED here — only the shared context refresh did
  // not settle (a newer operation superseded it). Reporting that as the generic bind failure told
  // the operator to review a path and branch that were both accepted, and hid the fact that the
  // workspace IS bound (#3381 review).
  it("names a bound workspace whose view could not refresh instead of blaming the bind", async () => {
    const user = userEvent.setup();
    const diagnostics: string[] = [];
    setClientDiagnosticWriter((message) => diagnostics.push(message));
    const api = workspaceApi({ refresh: vi.fn(() => Promise.resolve(false)) });
    provisionMock.mockResolvedValue({ instance: { workspaceId: "ws-9" }, created: true });
    reconcileMock.mockResolvedValue(reconciliationReport("ws-9", "healthy"));
    setActiveMock.mockResolvedValue({});
    renderWorkbench(api);

    await bindEnteredPath(user, "/repos/x");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "The workspace was bound, but this view could not refresh. Open Task workspaces and use Refresh.",
    );
    expect(alert).not.toHaveTextContent("Review the repository path and target branch.");
    expect(api.refresh).toHaveBeenCalledTimes(1);
    expect(diagnostics).toContain("[keiko] coding workbench workspace refresh did not settle");
  });

  it("names a bound workspace whose refresh threw instead of blaming the bind", async () => {
    const user = userEvent.setup();
    const diagnostics: string[] = [];
    setClientDiagnosticWriter((message) => diagnostics.push(message));
    const api = workspaceApi({
      refresh: vi.fn(() => Promise.reject(new Error("REFRESH_TRANSPORT_FAILED"))),
    });
    provisionMock.mockResolvedValue({ instance: { workspaceId: "ws-9" }, created: true });
    reconcileMock.mockResolvedValue(reconciliationReport("ws-9", "healthy"));
    setActiveMock.mockResolvedValue({});
    renderWorkbench(api);

    await bindEnteredPath(user, "/repos/x");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The workspace was bound, but this view could not refresh.");
    expect(alert).not.toHaveTextContent("Review the repository path and target branch.");
    expect(alert).not.toHaveTextContent("REFRESH_TRANSPORT_FAILED");
    expect(
      diagnostics.some((line) =>
        line.includes("[keiko] coding workbench workspace refresh failed"),
      ),
    ).toBe(true);
  });

  it("surfaces a content-free alert when the bind fails and never activates", async () => {
    const user = userEvent.setup();
    provisionMock.mockRejectedValue(new Error("WORKSPACE_ROOT_INVALID"));
    renderWorkbench(workspaceApi());

    await bindEnteredPath(user, "/repos/broken");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "The workspace could not be bound. Review the repository path and target branch.",
    );
    expect(alert).not.toHaveTextContent("WORKSPACE_ROOT_INVALID");
    expect(setActiveMock).not.toHaveBeenCalled();
  });

  it("explains a blocked task-branch conflict without exposing server detail", async () => {
    const user = userEvent.setup();
    const api = workspaceApi();
    provisionMock.mockRejectedValue(
      Object.assign(new Error("sensitive repository detail"), {
        code: "BRANCH_CONFLICT",
        failureClass: "blocked",
      }),
    );
    renderWorkbench(api, liveState(), "/repos/selected");

    await user.click(screen.getByRole("button", { name: "Bind workspace" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "The task branch for this coding run already exists. Remove the previous branch or its managed workspace. Alternatively, choose a different target branch.",
    );
    expect(alert).not.toHaveTextContent("sensitive repository detail");
    expect(reconcileMock).not.toHaveBeenCalled();
    expect(setActiveMock).not.toHaveBeenCalled();
    expect(api.refresh).not.toHaveBeenCalled();
    expect(setupSection()).toBeInTheDocument();
  });

  it("does not render once a binding is active", () => {
    renderWorkbench(workspaceApi({ activeBinding: binding() }));

    expect(setupSection()).not.toBeInTheDocument();
  });

  // A checkout whose integration branch is `dev` was offered `main`, which does not resolve there
  // and refused the bind with INVALID_BASE_BRANCH behind the generic sentence (2026-09-03 dev log).
  it("defaults the target branch to the selected repository's checked-out branch", async () => {
    baseBranchMock.mockResolvedValue("dev");
    renderWorkbench(workspaceApi(), liveState(), "/repos/selected");

    await waitFor(() => {
      expect(screen.getByLabelText("Target branch")).toHaveValue("dev");
    });
    expect(baseBranchMock).toHaveBeenCalledWith("/repos/selected");
  });

  // A branch typed for one repository is not a choice for the next: a new workbench-wide selection
  // re-arms the default the way the path field follows it (review of ec04288dc).
  it("re-arms the branch default when the selected repository changes", async () => {
    const user = userEvent.setup();
    baseBranchMock.mockResolvedValue("dev");
    const api = workspaceApi();
    const view = renderWorkbench(api, liveState(), "/repos/selected");
    await waitFor(() => {
      expect(screen.getByLabelText("Target branch")).toHaveValue("dev");
    });
    await user.clear(screen.getByLabelText("Target branch"));
    await user.type(screen.getByLabelText("Target branch"), "release/1.0");
    baseBranchMock.mockResolvedValue("trunk");

    view.rerender(
      <ActiveWorkspaceProvider value={api}>
        <CodingWorkbenchWindow selectedRoot="/repos/other" />
      </ActiveWorkspaceProvider>,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Target branch")).toHaveValue("trunk");
    });
    expect(baseBranchMock).toHaveBeenCalledWith("/repos/other");
  });

  // …but "the next repository" is the one in the PATH FIELD, not the workbench-wide selection. A
  // typed path does not follow the switcher, so re-arming on the selection alone re-read the
  // branch of a repository that was not being bound and overwrote the branch typed for the one
  // that was: Bind then provisioned /repos/A with /repos/B's checked-out branch (#3381 review).
  it("keeps a typed path and its typed branch when the workbench selection changes", async () => {
    const user = userEvent.setup();
    baseBranchMock.mockResolvedValue("dev");
    const api = workspaceApi();
    const view = renderWorkbench(api, liveState(), "/repos/selected");
    await waitFor(() => {
      expect(screen.getByLabelText("Target branch")).toHaveValue("dev");
    });

    await user.clear(screen.getByLabelText("Repository path"));
    await user.type(screen.getByLabelText("Repository path"), "/repos/A");
    await user.clear(screen.getByLabelText("Target branch"));
    await user.type(screen.getByLabelText("Target branch"), "release/1");
    baseBranchMock.mockResolvedValue("trunk");

    view.rerender(
      <ActiveWorkspaceProvider value={api}>
        <CodingWorkbenchWindow selectedRoot="/repos/B" />
      </ActiveWorkspaceProvider>,
    );

    // Flush whatever the selection change could have started before reading the fields back: the
    // overwrite this pins is the lookup's RESOLUTION, not the render that follows the rerender.
    await waitFor(() => {
      expect(screen.getByLabelText("Repository path")).toHaveValue("/repos/A");
    });
    expect(screen.getByLabelText("Target branch")).toHaveValue("release/1");
    expect(baseBranchMock).not.toHaveBeenCalledWith("/repos/B");
  });

  it("keeps a branch the operator typed even when the lookup resolves later", async () => {
    const user = userEvent.setup();
    let resolveLookup: (branch: string | null) => void = () => undefined;
    baseBranchMock.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          resolveLookup = resolve;
        }),
    );
    renderWorkbench(workspaceApi(), liveState(), "/repos/selected");

    await user.clear(screen.getByLabelText("Target branch"));
    await user.type(screen.getByLabelText("Target branch"), "release/1.0");
    resolveLookup("dev");

    await waitFor(() => {
      expect(baseBranchMock).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByLabelText("Target branch")).toHaveValue("release/1.0");
  });

  it("re-reads the branch default when the operator leaves a typed repository path", async () => {
    const user = userEvent.setup();
    baseBranchMock.mockResolvedValue("trunk");
    renderWorkbench(workspaceApi());

    await user.type(screen.getByLabelText("Repository path"), "/repos/typed");
    await user.tab();

    await waitFor(() => {
      expect(screen.getByLabelText("Target branch")).toHaveValue("trunk");
    });
    expect(baseBranchMock).toHaveBeenCalledWith("/repos/typed");
  });

  it("keeps the previous default when the branch lookup fails and leaves a diagnostic", async () => {
    const diagnostics: string[] = [];
    setClientDiagnosticWriter((message) => diagnostics.push(message));
    baseBranchMock.mockRejectedValue(new Error("HTTP 500 /repos/selected"));
    renderWorkbench(workspaceApi(), liveState(), "/repos/selected");

    await waitFor(() => {
      expect(diagnostics.some((line) => line.includes("base branch lookup failed"))).toBe(true);
    });
    expect(screen.getByLabelText("Target branch")).toHaveValue("main");
    expect(diagnostics.join("\n")).not.toContain("/repos/selected");
  });

  // A lookup that never answers must not lock the card out of binding for good — a settled failure
  // makes the fallback THIS path's fallback, which is exactly what the operator can then edit.
  it("binds with the visible fallback once a failed branch lookup has settled", async () => {
    const user = userEvent.setup();
    baseBranchMock.mockRejectedValue(new Error("HTTP 500"));
    provisionMock.mockResolvedValue({ instance: { workspaceId: "ws-9" }, created: true });
    reconcileMock.mockResolvedValue(reconciliationReport("ws-9", "healthy"));
    setActiveMock.mockResolvedValue({});
    renderWorkbench(workspaceApi(), liveState(), "/repos/selected");

    await user.click(await bindable());

    await waitFor(() => {
      expect(provisionMock).toHaveBeenCalledWith({
        root: "/repos/selected",
        taskId: codingWorkbenchSetupTaskId("main"),
        baseBranch: "main",
        requestedBy: "studio-operator",
      });
    });
  });

  // CodeRabbit review of #3381 (CodingWorkbenchSetup.tsx ~571): `lookupFor` runs on BLUR, and
  // pressing Enter in the path field submits without ever blurring it. The bind then derived the
  // task id from the untouched default of the PREVIOUS repository. The refused submit is what arms
  // the missing lookup, so the operator is never stuck — the next Enter binds the settled branch.
  it("refuses an Enter bind until the typed path's own branch default has settled", async () => {
    const user = userEvent.setup();
    baseBranchMock.mockResolvedValue("dev");
    provisionMock.mockResolvedValue({ instance: { workspaceId: "ws-9" }, created: true });
    reconcileMock.mockResolvedValue(reconciliationReport("ws-9", "healthy"));
    setActiveMock.mockResolvedValue({});
    renderWorkbench(workspaceApi());

    await user.type(screen.getByLabelText("Repository path"), "/repos/typed{Enter}");

    expect(provisionMock).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByLabelText("Target branch")).toHaveValue("dev");
    });

    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(provisionMock).toHaveBeenCalledTimes(1);
    });
    expect(provisionMock).toHaveBeenCalledWith({
      root: "/repos/typed",
      taskId: codingWorkbenchSetupTaskId("dev"),
      baseBranch: "dev",
      requestedBy: "studio-operator",
    });
  });

  // The click half of the same finding: clicking Bind blurs the path field and only THEN submits,
  // so the bind raced the lookup it had just armed and could still use the previous repository's
  // branch — `main` here, for a checkout whose integration branch is `dev`.
  it("refuses a click bind with the previous repository's branch after the path changes", async () => {
    const user = userEvent.setup();
    baseBranchMock.mockImplementation((root: string) =>
      Promise.resolve(root === "/repos/second" ? "dev" : "main"),
    );
    provisionMock.mockResolvedValue({ instance: { workspaceId: "ws-9" }, created: true });
    reconcileMock.mockResolvedValue(reconciliationReport("ws-9", "healthy"));
    setActiveMock.mockResolvedValue({});
    renderWorkbench(workspaceApi(), liveState(), "/repos/first");
    await bindable();
    expect(screen.getByLabelText("Target branch")).toHaveValue("main");

    await user.clear(screen.getByLabelText("Repository path"));
    await user.type(screen.getByLabelText("Repository path"), "/repos/second");
    await user.click(bindButton());

    expect(provisionMock).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByLabelText("Target branch")).toHaveValue("dev");
    });

    await user.click(await bindable());

    await waitFor(() => {
      expect(provisionMock).toHaveBeenCalledTimes(1);
    });
    expect(provisionMock).toHaveBeenCalledWith({
      root: "/repos/second",
      taskId: codingWorkbenchSetupTaskId("dev"),
      baseBranch: "dev",
      requestedBy: "studio-operator",
    });
  });

  // A branch the operator typed is their choice for whatever path they bind, so it never waits for
  // a lookup — the gate above must not turn into "the operator cannot bind what they chose".
  it("binds an operator-typed branch immediately after the path changes", async () => {
    const user = userEvent.setup();
    baseBranchMock.mockResolvedValue("main");
    provisionMock.mockResolvedValue({ instance: { workspaceId: "ws-9" }, created: true });
    reconcileMock.mockResolvedValue(reconciliationReport("ws-9", "healthy"));
    setActiveMock.mockResolvedValue({});
    renderWorkbench(workspaceApi(), liveState(), "/repos/first");
    await bindable();

    await user.clear(screen.getByLabelText("Target branch"));
    await user.type(screen.getByLabelText("Target branch"), "release/1.0");
    await user.clear(screen.getByLabelText("Repository path"));
    await user.type(screen.getByLabelText("Repository path"), "/repos/second{Enter}");

    await waitFor(() => {
      expect(provisionMock).toHaveBeenCalledTimes(1);
    });
    expect(provisionMock).toHaveBeenCalledWith({
      root: "/repos/second",
      taskId: codingWorkbenchSetupTaskId("release/1.0"),
      baseBranch: "release/1.0",
      requestedBy: "studio-operator",
    });
  });

  it.each([
    {
      code: "INVALID_BASE_BRANCH",
      failureClass: "blocked",
      text: "The target branch does not exist in this repository.",
    },
    {
      code: "MISSING_REPOSITORY",
      failureClass: "blocked",
      text: "The repository path is not inside a local Git repository.",
    },
    {
      code: "UNSAFE_PATH",
      failureClass: "blocked",
      text: "The repository path is outside the folders this installation may bind.",
    },
    {
      code: "LOCK_CONTENTION",
      failureClass: "retryable",
      text: "Another action currently holds this task workspace.",
    },
    {
      code: "WORKSPACE_PROVISIONING_UNAVAILABLE",
      failureClass: undefined,
      text: "Managed task workspaces are not configured on this installation",
    },
  ])(
    "names a $code refusal instead of the generic sentence",
    async ({ code, failureClass, text }) => {
      const user = userEvent.setup();
      provisionMock.mockRejectedValue(
        Object.assign(new Error("sensitive detail"), { code, failureClass }),
      );
      renderWorkbench(workspaceApi(), liveState(), "/repos/selected");

      await user.click(screen.getByRole("button", { name: "Bind workspace" }));

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(text);
      expect(alert).not.toHaveTextContent("Review the repository path and target branch.");
      expect(alert).not.toHaveTextContent("sensitive detail");
      expect(reconcileMock).not.toHaveBeenCalled();
      expect(setActiveMock).not.toHaveBeenCalled();
    },
  );

  // A refusal and its repair offer belong to the path they were answered for. Switching the
  // workbench-wide selection moves the path field on; the stale offer must go with it, or "Repair
  // and bind" would apply the old workspace's repair under the new path (review of ec04288dc).
  it("withdraws a repair offer when the selected repository changes", async () => {
    const user = userEvent.setup();
    const api = workspaceApi();
    provisionMock.mockRejectedValue(pointerDrift());
    listMock.mockResolvedValue([
      refusedWorkspace({ strategy: "reconcile-pointer", operatorActionRequired: false }),
    ]);
    const view = renderWorkbench(api, liveState(), "/repos/selected");

    await user.click(screen.getByRole("button", { name: "Bind workspace" }));
    expect(await screen.findByRole("button", { name: "Repair and bind" })).toBeInTheDocument();

    view.rerender(
      <ActiveWorkspaceProvider value={api}>
        <CodingWorkbenchWindow selectedRoot="/repos/other" />
      </ActiveWorkspaceProvider>,
    );

    expect(screen.getByLabelText("Repository path")).toHaveValue("/repos/other");
    expect(screen.queryByRole("button", { name: "Repair and bind" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(repairMock).not.toHaveBeenCalled();
  });

  // The offer is resolved for the taskId `executeBind` derives from the TARGET BRANCH, so an
  // edited branch field withdraws it exactly as an edited path does. Keeping it let "Repair and
  // bind" repair, verify and activate the PREVIOUS branch's workspace while the card displayed the
  // new one (#3381 review).
  it("withdraws a repair offer when the target branch changes", async () => {
    const user = userEvent.setup();
    provisionMock.mockRejectedValue(pointerDrift());
    listMock.mockResolvedValue([
      refusedWorkspace({ strategy: "reconcile-pointer", operatorActionRequired: false }),
    ]);
    renderWorkbench(workspaceApi(), liveState(), "/repos/selected");

    await user.click(screen.getByRole("button", { name: "Bind workspace" }));
    expect(await screen.findByRole("button", { name: "Repair and bind" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Target branch"), "-next");

    expect(screen.getByLabelText("Target branch")).toHaveValue("main-next");
    expect(screen.queryByRole("button", { name: "Repair and bind" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(repairMock).not.toHaveBeenCalled();
  });

  // #3381 review: the withdrawal above only ever cleared an EXISTING error, so a bind that was
  // still PENDING when its inputs moved kept its right to publish. The workbench-wide selection
  // moves the path field while the fields themselves are disabled, so the deferred sequence could
  // land a repair offer answered for `/repos/selected` beside a card showing `/repos/other` —
  // "Repair and bind" one click away from repairing and activating the wrong workspace.
  it("publishes nothing from a pending bind whose inputs changed while it ran", async () => {
    const user = userEvent.setup();
    const api = workspaceApi();
    let refuseProvision: (error: unknown) => void = () => undefined;
    provisionMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          refuseProvision = reject;
        }),
    );
    listMock.mockResolvedValue([
      refusedWorkspace({ strategy: "reconcile-pointer", operatorActionRequired: false }),
    ]);
    const view = renderWorkbench(api, liveState(), "/repos/selected");

    await user.click(await bindable());
    expect(screen.getByRole("button", { name: "Binding…" })).toBeDisabled();

    view.rerender(
      <ActiveWorkspaceProvider value={api}>
        <CodingWorkbenchWindow selectedRoot="/repos/other" />
      </ActiveWorkspaceProvider>,
    );
    expect(screen.getByLabelText("Repository path")).toHaveValue("/repos/other");

    refuseProvision(pointerDrift());
    await waitFor(() => {
      expect(listMock).toHaveBeenCalled();
    });
    await flushBindSequence();

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Repair and bind" })).not.toBeInTheDocument();
    expect(repairMock).not.toHaveBeenCalled();
  });

  // The 2026-09-03 defect: an existing managed workspace the server could not re-verify was
  // refused with 409 POINTER_DRIFT, the card blamed the path and branch, and the row had no exit.
  it("offers the operator-approved repair for a refused existing workspace, then verifies and activates", async () => {
    const user = userEvent.setup();
    const api = workspaceApi();
    provisionMock.mockRejectedValue(pointerDrift());
    listMock.mockResolvedValue([
      refusedWorkspace({ strategy: "reconcile-pointer", operatorActionRequired: false }),
    ]);
    repairMock.mockResolvedValue({ applied: true, driftMarkers: [] });
    reconcileMock.mockResolvedValue(reconciliationReport("ws-refused", "healthy"));
    setActiveMock.mockResolvedValue({});
    renderWorkbench(api, liveState(), "/repos/selected");

    await user.click(screen.getByRole("button", { name: "Bind workspace" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Keiko could not re-verify it");
    expect(alert).toHaveTextContent("nothing is deleted");
    // The approver, not Keiko, supplies the provenance proof here: the retired identity cannot
    // separate the original worktree from a same-path replacement (#3381 review).
    expect(alert).toHaveTextContent("re-registers whatever is on disk there");
    expect(alert).toHaveTextContent("inspect the tree in Task workspaces first");
    expect(alert).not.toHaveTextContent("Review the repository path and target branch.");
    expect(alert).not.toHaveTextContent("sensitive worktree detail");
    expect(listMock).toHaveBeenCalledWith("/repos/selected");
    expect(setActiveMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Repair and bind" }));

    await waitFor(() => {
      expect(api.refresh).toHaveBeenCalledTimes(1);
    });
    // The click is the approval, and it names the strategy the server recommended.
    expect(repairMock).toHaveBeenCalledWith({
      workspaceId: "ws-refused",
      requestedBy: "studio-operator",
      strategy: "reconcile-pointer",
      operatorApproved: true,
    });
    expect(reconcileMock).toHaveBeenCalledWith({ root: "/repos/selected" });
    expect(setActiveMock).toHaveBeenCalledWith({
      workspaceId: "ws-refused",
      requestedBy: "studio-operator",
    });
  });

  // `automaticStrategyOf` returns `recreate-worktree` first for a missing worktree, and the #447
  // repair then prunes the stale registration and rebuilds it. The single sentence keyed to every
  // automatic strategy promised "nothing is deleted" on that path too (#3381 review).
  it("describes the repair by the recommended strategy, not one sentence for all of them", async () => {
    const user = userEvent.setup();
    provisionMock.mockRejectedValue(pointerDrift());
    listMock.mockResolvedValue([
      refusedWorkspace({ strategy: "recreate-worktree", operatorActionRequired: false }),
    ]);
    renderWorkbench(workspaceApi(), liveState(), "/repos/selected");

    await user.click(screen.getByRole("button", { name: "Bind workspace" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Keiko could not re-verify it");
    expect(alert).toHaveTextContent("rebuilds the worktree from its task branch");
    expect(alert).not.toHaveTextContent("nothing is deleted");
    expect(await screen.findByRole("button", { name: "Repair and bind" })).toBeInTheDocument();
  });

  it("describes a stale-lock repair as touching no worktree", async () => {
    const user = userEvent.setup();
    provisionMock.mockRejectedValue(pointerDrift());
    listMock.mockResolvedValue([
      refusedWorkspace(
        { strategy: "release-stale-lock", operatorActionRequired: false },
        "lock-stale",
      ),
    ]);
    renderWorkbench(workspaceApi(), liveState(), "/repos/selected");

    await user.click(screen.getByRole("button", { name: "Bind workspace" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("releases the stale lock an interrupted action left behind");
    expect(alert).not.toHaveTextContent("nothing is deleted");
  });

  it("names an operator-required finding without offering a repair", async () => {
    const user = userEvent.setup();
    provisionMock.mockRejectedValue(pointerDrift());
    listMock.mockResolvedValue([
      refusedWorkspace({ strategy: "operator-repair", operatorActionRequired: true }, "head-moved"),
    ]);
    renderWorkbench(workspaceApi(), liveState(), "/repos/selected");

    await user.click(screen.getByRole("button", { name: "Bind workspace" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Keiko cannot repair it automatically");
    expect(screen.queryByRole("button", { name: "Repair and bind" })).not.toBeInTheDocument();
    expect(repairMock).not.toHaveBeenCalled();
    expect(setActiveMock).not.toHaveBeenCalled();
  });

  it("reports a repair the server did not apply and never activates", async () => {
    const user = userEvent.setup();
    provisionMock.mockRejectedValue(pointerDrift());
    listMock.mockResolvedValue([
      refusedWorkspace({ strategy: "recreate-worktree", operatorActionRequired: false }),
    ]);
    repairMock.mockResolvedValue({ applied: false, driftMarkers: ["branch-deleted"] });
    renderWorkbench(workspaceApi(), liveState(), "/repos/selected");

    await user.click(screen.getByRole("button", { name: "Bind workspace" }));
    await user.click(await screen.findByRole("button", { name: "Repair and bind" }));

    const alert = await screen.findByRole("alert");
    await waitFor(() => {
      expect(alert).toHaveTextContent("Keiko cannot repair it automatically");
    });
    expect(screen.queryByRole("button", { name: "Repair and bind" })).not.toBeInTheDocument();
    expect(reconcileMock).not.toHaveBeenCalled();
    expect(setActiveMock).not.toHaveBeenCalled();
    expect(setupSection()).toBeInTheDocument();
  });

  it("falls back to the finding-free operator sentence when the refused row cannot be listed", async () => {
    const user = userEvent.setup();
    provisionMock.mockRejectedValue(pointerDrift());
    listMock.mockRejectedValue(new Error("HTTP 503"));
    renderWorkbench(workspaceApi(), liveState(), "/repos/selected");

    await user.click(screen.getByRole("button", { name: "Bind workspace" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("its state could not be re-verified");
    expect(screen.queryByRole("button", { name: "Repair and bind" })).not.toBeInTheDocument();
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
