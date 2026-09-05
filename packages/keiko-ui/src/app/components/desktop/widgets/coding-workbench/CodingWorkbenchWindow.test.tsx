import { draftDeliveryReview, draftDeliverySnapshot } from "./_draftDeliveryTestSupport";
import { journeyFixture } from "./_journeyOutcomeTestSupport";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNVERIFIED_GATEWAY } from "@oscharko-dev/keiko-contracts/runtime/gateway-verification";
import { WORKSPACE_TRUST_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/workspace-trust";
import type {
  AvailableCodingSafeActivityFeed,
  CodingWorkbenchMode,
  CodingWorkbenchRuntimePendingApprovalReview,
  CodingWorkbenchRuntimeSnapshot,
  CodingWorkbenchRuntimeSseEvent,
  WorkspaceBinding,
  WorkspaceInstance,
  WorkspaceTrustStatus,
} from "@oscharko-dev/keiko-contracts";
import type { CodingWorkbenchRuntimeActions } from "@/lib/useCodingWorkbenchRuntime";
import type { UseCodingWorkbenchQuestionsResult } from "@/lib/useCodingWorkbenchQuestions";
import type { UseCodingWorkbenchSafeActivityResult } from "@/lib/useCodingWorkbenchSafeActivity";
import {
  createInitialCodingWorkbenchRuntimeState,
  type CodingWorkbenchRuntimeState,
} from "@/lib/coding-workbench-live-state";
import type { ProjectWithAvailability } from "@/lib/types";
import { CodingWorkbenchWindow, type CodingWorkbenchGitTarget } from "./CodingWorkbenchWindow";
import styles from "./CodingWorkbenchWindow.module.css";
import { GATEWAY_MODEL_CATALOG_REFRESH_REQUESTED_EVENT } from "../shared/gatewaySetupBus";
import {
  ActiveWorkspaceProvider,
  type ActiveWorkspaceApi,
} from "../../context/ActiveWorkspaceContext";

const runtimeHookMock = vi.hoisted(() => vi.fn());
const questionsHookMock = vi.hoisted(() => vi.fn());
const activityHookMock = vi.hoisted(() => vi.fn());
const researchHookMock = vi.hoisted(() => vi.fn());
const approvalReviewHookMock = vi.hoisted(() => vi.fn());
const autonomyHookMock = vi.hoisted(() => vi.fn());
const editorBridgeHookMock = vi.hoisted(() => vi.fn());
const chatCatalogMock = vi.hoisted(() => ({
  activeProject: undefined as ProjectWithAvailability | undefined,
  projects: [] as ProjectWithAvailability[],
}));
// #3389 AC3 mark-ready wiring: the mint/execute pair the propose-ready control performs, and the
// journey-refresh read the window uses to obtain a real, matching `JourneyOutcome`. `proposePrMarkReady`
// is replaced with a version that calls THESE mocks directly (not the real module's own approve/execute,
// which `importOriginal` would still close over) so a click's mint-then-execute sequence is observable
// as two separate call counts, exactly as the mark-ready client itself performs it (api.ts).
const journeyRefreshMock = vi.hoisted(() => vi.fn());
const markReadyApproveMock = vi.hoisted(() => vi.fn());
const markReadyExecuteMock = vi.hoisted(() => vi.fn());
const mergeExecuteMock = vi.hoisted(() => vi.fn());
const prUpdateExecuteMock = vi.hoisted(() => vi.fn());
// #3390 wave: the header's trust affordance (`CodingWorkbenchTrustAffordance`) reads live workspace
// trust through the SAME client the Editor uses (`useWorkspaceTrust` → workspace-trust-api). Every
// suite in this file that binds an active workspace would otherwise reach this real fetch; the
// `beforeEach` below resolves it "trusted" by default so the affordance stays invisible and every
// pre-existing assertion in this file is unaffected. The dedicated suite further down overrides it.
const trustStatusMock = vi.hoisted(() => vi.fn());
const trustMutateMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchCodingWorkbenchJourneyRefresh: journeyRefreshMock,
    fetchGitDeliveryMergeExecute: mergeExecuteMock,
    fetchGitDeliveryPrExecute: prUpdateExecuteMock,
    proposePrMarkReady: async (
      input: Parameters<typeof actual.proposePrMarkReady>[0],
    ): ReturnType<typeof actual.proposePrMarkReady> => {
      const minted: Awaited<ReturnType<typeof actual.fetchGitDeliveryPrMarkReadyApprove>> =
        await markReadyApproveMock(input);
      return markReadyExecuteMock({ ...input, approval: minted.approval });
    },
  };
});

vi.mock("@/lib/useCodingWorkbenchRuntime", () => ({
  useCodingWorkbenchRuntime: runtimeHookMock,
}));

vi.mock("@/lib/useCodingWorkbenchQuestions", () => ({
  useCodingWorkbenchQuestions: questionsHookMock,
}));

vi.mock("@/lib/useCodingWorkbenchSafeActivity", () => ({
  useCodingWorkbenchSafeActivity: activityHookMock,
}));

vi.mock("@/lib/useCodingWorkbenchResearch", () => ({
  useCodingWorkbenchResearch: researchHookMock,
}));

vi.mock("@/lib/useCodingWorkbenchApprovalReview", () => ({
  useCodingWorkbenchApprovalReview: approvalReviewHookMock,
}));

vi.mock("../../hooks/useAutonomyModePolicy", () => ({
  useAutonomyModePolicy: autonomyHookMock,
}));

vi.mock("@/lib/workspace-trust-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace-trust-api")>()),
  fetchWorkspaceTrustStatus: trustStatusMock,
  mutateWorkspaceTrust: trustMutateMock,
}));

vi.mock("@/lib/useCodingWorkbenchEditorBridge", () => ({
  useCodingWorkbenchEditorBridge: editorBridgeHookMock,
}));

vi.mock("../../context/ChatSessionContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../context/ChatSessionContext")>();
  return {
    ...actual,
    useOptionalChatSessionCatalog: () => ({
      activeProject: chatCatalogMock.activeProject,
      projects: chatCatalogMock.projects,
      models: [],
      noEligibleModels: true,
    }),
  };
});

const AT = "2026-07-13T12:00:00.000Z";

const EMPTY_QUESTIONS: UseCodingWorkbenchQuestionsResult = {
  status: "empty",
  questions: [],
  errorCode: null,
  mutationFailure: null,
  answer: vi.fn(() => Promise.resolve(true)),
  reject: vi.fn(() => Promise.resolve(true)),
  retry: vi.fn(),
};

const IDLE_ACTIVITY: UseCodingWorkbenchSafeActivityResult = {
  status: "idle",
  feed: null,
  errorCode: null,
  retry: vi.fn(),
};

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
        verification: "verified",
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
        runtimeEvidenceClass: "platform-qualified",
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
  onOpenGit?: (target: CodingWorkbenchGitTarget) => void,
  activeWorkspace?: ActiveWorkspaceApi,
): CodingWorkbenchRuntimeActions {
  runtimeHookMock.mockReturnValue({ state, actions: liveActions });
  const workbench = (
    <CodingWorkbenchWindow
      selectedRoot={
        chatCatalogMock.activeProject?.available === true
          ? chatCatalogMock.activeProject.path
          : undefined
      }
      onOpenGit={onOpenGit}
    />
  );
  render(
    activeWorkspace === undefined ? (
      workbench
    ) : (
      <ActiveWorkspaceProvider value={activeWorkspace}>{workbench}</ActiveWorkspaceProvider>
    ),
  );
  return liveActions;
}

function activeWorkspaceWithBinding(
  repositoryRoot: string,
  activeRoot: string,
  identity: { readonly workspaceId?: string; readonly taskBranch?: string } = {},
): ActiveWorkspaceApi {
  const instance: WorkspaceInstance = {
    schemaVersion: "1",
    workspaceId: identity.workspaceId ?? "workspace-1",
    taskId: "task-1",
    repositoryId: "repository-1",
    repositoryRoot,
    baseBranch: "dev",
    taskBranch: identity.taskBranch ?? "task-1",
    managedWorktreePath: "/worktrees/task-1",
    gitdirIdentity: "gitdir-1",
    lifecycleState: "active",
    health: "healthy",
    lock: null,
    createdAt: AT,
    updatedAt: AT,
    driftMarkers: [],
    recoveryHints: [],
    auditCorrelationId: "correlation-1",
  };
  const binding: WorkspaceBinding = {
    schemaVersion: "1",
    workspaceId: instance.workspaceId,
    taskId: instance.taskId,
    activeRoot,
    boundSurfaces: ["git-delivery"],
    gitDeliveryRoot: activeRoot,
    editorProjectRoot: activeRoot,
  };
  return {
    instances: [instance],
    activeBinding: binding,
    activeInstance: instance,
    activeRoot,
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
  };
}

function trustStatus(
  projectId: string,
  trust: "trusted" | "restricted" = "trusted",
): WorkspaceTrustStatus {
  return {
    kind: "workspace-trust-status",
    schemaVersion: WORKSPACE_TRUST_SCHEMA_VERSION,
    projectId,
    trust,
    decidedBy: "server",
    reason: trust === "trusted" ? "human-grant" : "human-revocation",
    revision: 1,
  };
}

// FILE scope, not one describe's: three top-level suites in this file render
// `CodingWorkbenchWindow`, which reads `research.grant` and `editorBridge.pendingReview` on every
// render. While these defaults lived inside the first describe, the other two saw them only because
// vitest happens to run the suites in source order and mock return values survive across them — a
// reorder, an `only`, or a `clearMocks` config would have handed those renders `undefined` hook
// results (#3381 review). A suite that needs a different default overrides it in its own
// `beforeEach`, which runs after this one.
beforeEach(() => {
  chatCatalogMock.activeProject = undefined;
  chatCatalogMock.projects = [];
  // Every other suite in this file leaves the journey read unmocked-in-spirit: it never sets up an
  // observed outcome, so it must keep resolving to a valid "nothing observed" envelope rather than
  // silently reusing whatever a mark-ready test configured last (AGENTS.md §7: hermetic tests, no
  // shared mutable global state between them).
  journeyRefreshMock.mockReset().mockResolvedValue({ status: "unavailable", reason: "not-tested" });
  markReadyApproveMock.mockReset();
  markReadyExecuteMock.mockReset();
  mergeExecuteMock.mockReset();
  prUpdateExecuteMock.mockReset();
  trustStatusMock.mockReset().mockResolvedValue(trustStatus("unused", "trusted"));
  trustMutateMock.mockReset();
  questionsHookMock.mockReturnValue(EMPTY_QUESTIONS);
  activityHookMock.mockReturnValue(IDLE_ACTIVITY);
  approvalReviewHookMock.mockReturnValue({ status: "idle", review: null, retry: vi.fn() });
  researchHookMock.mockReturnValue({ status: "idle", ask: null, grant: null, retry: vi.fn() });
  editorBridgeHookMock.mockReset();
  editorBridgeHookMock.mockReturnValue({
    pendingReview: null,
    approve: vi.fn(),
    deny: vi.fn(),
    retry: vi.fn(),
    bridgeUnavailable: false,
  });
  autonomyHookMock.mockReturnValue({
    requestedMode: "supervised-coding",
    effectiveMode: "supervised-coding",
    deploymentCeiling: "autonomous-delivery",
    pending: false,
    error: null,
    change: vi.fn(),
  });
});

describe("CodingWorkbenchWindow", () => {
  it("refreshes the model catalog when the Workbench opens", (): void => {
    const listener = vi.fn();
    window.addEventListener(GATEWAY_MODEL_CATALOG_REFRESH_REQUESTED_EVENT, listener);

    try {
      renderWorkbench();
      expect(listener).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener(GATEWAY_MODEL_CATALOG_REFRESH_REQUESTED_EVENT, listener);
    }
  });

  it("inherits the globally selected folder without requiring a chat model", (): void => {
    const selectedRoot = "/Users/oscharko-dev/Projects/Keiko";
    const selectedProject: ProjectWithAvailability = {
      path: selectedRoot,
      name: "Keiko",
      favorite: false,
      createdAt: 1,
      lastOpenedAt: 1,
      available: true,
      workspaceAvailable: true,
    };
    chatCatalogMock.activeProject = selectedProject;
    chatCatalogMock.projects = [selectedProject];

    renderWorkbench(createInitialCodingWorkbenchRuntimeState());

    expect(screen.getByLabelText("Repository path")).toHaveValue(selectedRoot);
  });

  function egressApprovalState(
    kind: "network-egress" | "delivery-substrate" = "network-egress",
  ): CodingWorkbenchRuntimeState {
    return liveState({
      run: {
        status: "ready",
        error: null,
        value: snapshot({
          state: "awaiting-approval",
          runId: "run-1",
          pendingPermission: {
            requestId: "research-approval-1",
            kind,
            actionClass: "network-egress",
            reasonCode: "research-approval-required",
            actionKind: "research",
            risk: "medium",
            expiresAt: "2026-07-13T12:02:00.000Z",
          },
        }),
      },
    });
  }

  function editApprovalState(
    actionKind: "file-edit" | "git-stage" = "file-edit",
  ): CodingWorkbenchRuntimeState {
    return liveState({
      run: {
        status: "ready",
        error: null,
        value: snapshot({
          state: "awaiting-approval",
          runId: "run-1",
          pendingPermission: {
            requestId: "permission-7",
            kind: "workspace-write",
            actionClass: "workspace-write",
            reasonCode: "approval-required",
            actionKind,
            scopeLabel: "workspace-scope",
            risk: "medium",
            policyReason: "approval-required",
            expiresAt: "2026-07-13T12:05:00.000Z",
          },
        }),
      },
    });
  }

  it("renders only live server-confirmed readiness and starts with transient task intent", async () => {
    const user = userEvent.setup();
    const liveActions = renderWorkbench();

    expect(screen.getByRole("heading", { name: "Coding Workbench" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Keiko" })).toBeInTheDocument();
    expect(screen.queryByText("task-1")).not.toBeInTheDocument();
    expect(screen.getByText("task-1 · issue/2257 · healthy")).toBeInTheDocument();
    expect(screen.getAllByText("Keiko Gateway")).toHaveLength(2);
    expect(screen.getByRole("combobox", { name: "Run authority" })).toHaveTextContent(
      "Supervised workspace",
    );
    expect(screen.queryByRole("radio", { name: /Full access/u })).not.toBeInTheDocument();
    expect(screen.queryByText(/Issue #1990|marketing|preview/u)).not.toBeInTheDocument();
    expect(screen.queryByText("Explore and understand code")).not.toBeInTheDocument();

    const taskInput = screen.getByLabelText("Task instructions");
    await user.type(taskInput, "Investigate the failing test");
    await user.click(screen.getByRole("button", { name: "Start coding run" }));
    expect(liveActions.start).toHaveBeenCalledWith("Investigate the failing test");
  });

  // Workbench audit, 2026-09-03: the draft used to persist after Start succeeded — indistinguishable
  // from an unsent draft, and re-submittable as a brand-new follow-up by mistake if the operator
  // later paused and clicked Send instead of Resume. `actions.start`'s own returned promise always
  // resolves (the mutation queue swallows a failure into `state.mutation` and never rejects), so
  // this drives the mutation through the real pending -> settled transitions the reducer produces,
  // rather than trusting the promise to tell success from failure.
  // The crash-recovery Retry consumes the draft exactly like Start; a successful retry that left
  // the recovery text in the re-enabled composer made it resubmittable as a brand-new follow-up
  // (review of ec04288dc).
  // The composer acts on the bound task workspace: before a run its chip names the repository the
  // workspace was bound from, not the folder selected elsewhere in the Workbench (end-to-end run,
  // 2026-09-03: the chip read "pr-3355-code-review-fdaabd · main" over a workspace bound from
  // "e2e-project").
  it("names the bound repository in the composer before a run starts", () => {
    renderWorkbench(
      liveState(),
      actions(),
      undefined,
      activeWorkspaceWithBinding("/repos/e2e-project", "/wt/e2e-project-task"),
    );

    expect(screen.getByText("e2e-project")).toBeInTheDocument();
    expect(screen.queryByText("e2e-project-task")).not.toBeInTheDocument();
  });

  it("clears the composer draft once a crash-recovery retry succeeds", async () => {
    const user = userEvent.setup();
    const liveActions = actions();
    runtimeHookMock.mockReturnValue({ state: liveState(), actions: liveActions });
    const view = render(<CodingWorkbenchWindow selectedRoot={undefined} />);
    const taskInput = screen.getByLabelText("Task instructions");
    await user.type(taskInput, "Resume where the run crashed");

    runtimeHookMock.mockReturnValue({
      state: liveState({
        mutation: { status: "pending", kind: "retry", requestId: "req-r", error: null },
      }),
      actions: liveActions,
    });
    view.rerender(<CodingWorkbenchWindow selectedRoot={undefined} />);
    expect(taskInput).toHaveValue("Resume where the run crashed");

    runtimeHookMock.mockReturnValue({
      state: liveState({ mutation: { status: "idle", kind: null, requestId: null, error: null } }),
      actions: liveActions,
    });
    view.rerender(<CodingWorkbenchWindow selectedRoot={undefined} />);
    expect(taskInput).toHaveValue("");
  });

  it("clears the composer draft once Start succeeds, but keeps it after a failed Start", async () => {
    const user = userEvent.setup();
    const liveActions = actions();
    runtimeHookMock.mockReturnValue({ state: liveState(), actions: liveActions });
    const view = render(<CodingWorkbenchWindow selectedRoot={undefined} />);

    const taskInput = screen.getByLabelText("Task instructions");
    await user.type(taskInput, "Investigate the failing test");
    await user.click(screen.getByRole("button", { name: "Start coding run" }));
    expect(liveActions.start).toHaveBeenCalledWith("Investigate the failing test");

    // The mutation queue starts the "start" mutation…
    runtimeHookMock.mockReturnValue({
      state: liveState({
        mutation: { status: "pending", kind: "start", requestId: "req-1", error: null },
      }),
      actions: liveActions,
    });
    view.rerender(<CodingWorkbenchWindow selectedRoot={undefined} />);
    expect(taskInput).toHaveValue("Investigate the failing test");

    // …and fails. The draft must survive so the operator can fix and resend it.
    runtimeHookMock.mockReturnValue({
      state: liveState({
        mutation: {
          status: "error",
          kind: "start",
          requestId: "req-1",
          error: { code: "START_FAILED", message: "redacted", retryable: true },
        },
      }),
      actions: liveActions,
    });
    view.rerender(<CodingWorkbenchWindow selectedRoot={undefined} />);
    expect(taskInput).toHaveValue("Investigate the failing test");

    // A second attempt: pending again, then this time succeeds — the draft is cleared.
    runtimeHookMock.mockReturnValue({
      state: liveState({
        mutation: { status: "pending", kind: "start", requestId: "req-2", error: null },
      }),
      actions: liveActions,
    });
    view.rerender(<CodingWorkbenchWindow selectedRoot={undefined} />);
    runtimeHookMock.mockReturnValue({ state: liveState(), actions: liveActions });
    view.rerender(<CodingWorkbenchWindow selectedRoot={undefined} />);

    expect(taskInput).toHaveValue("");
  });

  it("opens Git for the selected repository from the composer context", async (): Promise<void> => {
    const user = userEvent.setup();
    const selectedProject: ProjectWithAvailability = {
      path: "/repos/keiko",
      name: "Keiko",
      favorite: false,
      createdAt: 1,
      lastOpenedAt: 1,
      available: true,
      workspaceAvailable: false,
    };
    const onOpenGit = vi.fn();
    chatCatalogMock.activeProject = selectedProject;
    chatCatalogMock.projects = [selectedProject];

    renderWorkbench(liveState(), actions(), onOpenGit);

    await user.click(screen.getByRole("button", { name: "Manage repository keiko" }));
    expect(onOpenGit).toHaveBeenCalledWith({
      root: selectedProject.path,
      binding: "repository",
    });
  });

  it("uses the selected repository outside an active run despite a prior task worktree", async () => {
    const user = userEvent.setup();
    const selectedProject: ProjectWithAvailability = {
      path: "/repos/keiko",
      name: "Keiko",
      favorite: false,
      createdAt: 1,
      lastOpenedAt: 1,
      available: true,
      workspaceAvailable: false,
    };
    const onOpenGit = vi.fn();
    chatCatalogMock.activeProject = selectedProject;

    renderWorkbench(
      liveState(),
      actions(),
      onOpenGit,
      activeWorkspaceWithBinding("/repos/keiko", "/worktrees/prior-task"),
    );

    await user.click(screen.getByRole("button", { name: "Manage repository keiko" }));
    expect(onOpenGit).toHaveBeenCalledWith({
      root: selectedProject.path,
      binding: "repository",
    });
  });

  it("opens Git on the active task worktree while a coding run is in progress", async (): Promise<void> => {
    const user = userEvent.setup();
    const onOpenGit = vi.fn();
    chatCatalogMock.activeProject = {
      path: "/repos/keiko",
      name: "Keiko",
      favorite: false,
      createdAt: 1,
      lastOpenedAt: 1,
      available: true,
      workspaceAvailable: false,
    };

    renderWorkbench(
      liveState({
        run: {
          status: "ready",
          value: snapshot({ state: "running", runId: "run-1" }),
          error: null,
        },
      }),
      actions(),
      onOpenGit,
      activeWorkspaceWithBinding("/repos/keiko", "/worktrees/active-task"),
    );

    expect(screen.getByRole("button", { name: "Manage branch task-1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Manage branch dev" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Manage repository active-task" }));
    expect(onOpenGit).toHaveBeenCalledWith({
      root: "/worktrees/active-task",
      binding: "task-workspace",
    });
  });

  it("persists an explicitly selected run authority instead of reverting it", async () => {
    const user = userEvent.setup();
    const change = vi.fn();
    autonomyHookMock.mockReturnValue({
      requestedMode: "governed-assist",
      effectiveMode: "governed-assist",
      deploymentCeiling: "autonomous-delivery",
      pending: false,
      error: null,
      change,
    });
    const liveActions = renderWorkbench(liveState({ requestedMode: "governed-assist" }));

    await user.click(screen.getByRole("combobox", { name: "Run authority" }));
    await user.click(screen.getByRole("option", { name: "Full access" }));

    expect(liveActions.setRequestedMode).toHaveBeenCalledWith("autonomous-delivery");
    expect(change).toHaveBeenCalledWith("autonomous-delivery");
  });

  it("shows the selected authority while the server enforces a lower deployment ceiling", () => {
    renderWorkbench(
      liveState({
        requestedMode: "autonomous-delivery",
        runtime: {
          status: "ready",
          error: null,
          value: {
            schemaVersion: "1",
            requestedMode: "autonomous-delivery",
            deploymentCeiling: "governed-assist",
            effectiveMode: "governed-assist",
            runtimeAvailable: true,
          },
        },
      }),
    );

    expect(screen.getByRole("combobox", { name: "Run authority" })).toHaveTextContent(
      "Full access",
    );
    expect(document.querySelectorAll("[data-mode]")).toHaveLength(1);
    expect(document.querySelector('[data-mode="governed-assist"]')).toBeInTheDocument();
  });

  it("locks the authority control without reverting the selection while persistence is pending", () => {
    autonomyHookMock.mockReturnValue({
      requestedMode: "governed-assist",
      effectiveMode: "governed-assist",
      deploymentCeiling: "autonomous-delivery",
      pending: true,
      error: null,
      change: vi.fn(),
    });
    const liveActions = renderWorkbench(liveState({ requestedMode: "autonomous-delivery" }));

    expect(screen.getByRole("combobox", { name: "Run authority" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Run authority" })).toHaveTextContent(
      "Full access",
    );
    expect(liveActions.setRequestedMode).not.toHaveBeenCalled();
  });

  it("surfaces a failed authority update instead of silently reverting", () => {
    autonomyHookMock.mockReturnValue({
      requestedMode: "governed-assist",
      effectiveMode: "governed-assist",
      deploymentCeiling: "autonomous-delivery",
      pending: false,
      error: "persist",
      change: vi.fn(),
    });
    renderWorkbench(liveState({ requestedMode: "governed-assist" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Run authority could not be saved. The previous authority remains active.",
    );
  });

  it("never presents the requested mode as server-effective before readiness resolves", (): void => {
    autonomyHookMock.mockReturnValue({
      requestedMode: "autonomous-delivery",
      effectiveMode: "autonomous-delivery",
      deploymentCeiling: "autonomous-delivery",
      pending: false,
      error: null,
      change: vi.fn(),
    });
    renderWorkbench(
      liveState({
        requestedMode: "autonomous-delivery",
        runtime: { status: "loading", value: null, error: null },
      }),
    );

    expect(screen.getByText("Awaiting server confirmation")).toBeInTheDocument();
    expect(document.querySelector("[data-mode]")).toBeNull();
  });

  it("names the blocking reason when a bound workspace meets an unqualified runtime", (): void => {
    renderWorkbench(
      liveState({
        canStart: false,
        runtime: {
          status: "ready",
          error: null,
          value: {
            schemaVersion: "1",
            requestedMode: "governed-assist",
            deploymentCeiling: "supervised-coding",
            effectiveMode: "governed-assist",
            runtimeAvailable: false,
            runtimeUnavailableReason: "runtime-unqualified",
          },
        },
      }),
    );

    // The bootstrap setup section is absent once a workspace is bound, so this is the only place
    // left that can explain why the start control is disabled — and it must not repeat the setup
    // copy, which invites binding a workspace that is already bound.
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Starting a coding run stays unavailable until this installation's coding runtime is confirmed active.",
    );
    expect(screen.queryByText(/You can bind a workspace now/u)).not.toBeInTheDocument();
  });

  it("states the unqualified runtime once while the bootstrap setup section owns that message", (): void => {
    const initial = createInitialCodingWorkbenchRuntimeState();
    renderWorkbench({
      ...initial,
      canStart: false,
      runtime: {
        status: "ready",
        error: null,
        value: {
          schemaVersion: "1",
          requestedMode: "governed-assist",
          deploymentCeiling: "supervised-coding",
          effectiveMode: "governed-assist",
          runtimeAvailable: false,
          runtimeUnavailableReason: "runtime-unqualified",
        },
      },
    });

    // Setup renders the sentence itself; a second live-region copy would announce it twice.
    expect(screen.getAllByText(/until the coding runtime is active/u)).toHaveLength(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps a recoverable refresh failure ahead of the standing runtime condition", (): void => {
    const base = liveState();
    renderWorkbench(
      liveState({
        canStart: false,
        runtime: {
          status: "ready",
          error: null,
          value: {
            schemaVersion: "1",
            requestedMode: "governed-assist",
            deploymentCeiling: "supervised-coding",
            effectiveMode: "governed-assist",
            runtimeAvailable: false,
          },
        },
        workspace: {
          ...base.workspace,
          status: "error",
          error: { code: "TASK_WORKSPACE_UNAVAILABLE", message: "unavailable", retryable: true },
        },
      }),
    );

    // One alert is shown at a time: the retryable failure must not be swallowed by the condition.
    expect(screen.getByRole("alert")).toHaveTextContent("Workspace could not be refreshed.");
  });

  it("keeps the unpaired browser state out of the standing workbench banner", (): void => {
    renderWorkbench(liveState({ canStart: false, pairing: "unpaired" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Browser window not paired|keiko start --open/u),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Not ready to start");
    expect(screen.getByRole("button", { name: "Start coding run" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("keeps actionable standing alerts in the body row before the scrollable session", (): void => {
    renderWorkbench(
      liveState({
        canStart: false,
        run: {
          status: "error",
          value: null,
          error: { code: "RUN_REFRESH_FAILED", message: "unavailable", retryable: true },
        },
      }),
    );

    const alert = screen.getByRole("alert");
    const bodyClass = styles.body;
    const sessionClass = styles.session;
    if (bodyClass === undefined || sessionClass === undefined) {
      throw new Error("Coding Workbench layout classes are unavailable");
    }
    expect(alert.parentElement).toHaveClass(bodyClass);
    expect(alert.nextElementSibling).toHaveClass(sessionClass);
  });

  // Release-audit F-01: the idle header pill is a READINESS claim, not a run state. It must
  // consume the same server-confirmed readiness the start action gates on — including the
  // sidecar gateway profile — so it can never say "Ready to start" over an unavailable source.
  it("never claims Ready to start while the sidecar gateway profile is unavailable", (): void => {
    renderWorkbench(
      liveState({
        canStart: false,
        source: {
          status: "ready",
          value: {
            runtimePreference: "managed-gateway",
            modelSource: "keiko-model-gateway",
            runtimeSource: "keiko-sidecar",
            available: false,
            unavailableReason: "no-tool-calling",
            verification: UNVERIFIED_GATEWAY,
          },
          error: null,
        },
      }),
    );

    expect(screen.getByRole("status")).toHaveTextContent("Not ready to start");
    expect(screen.getByText(/Keiko Gateway — Unavailable/u)).toBeInTheDocument();
  });

  /**
   * ADR-0163 D9 / audit F-01. An unverified evaluation runtime must never render as plain green:
   * not in the idle pill's label, not in the run-state pill's colour, and not by silence in the
   * session context bar.
   */
  describe("unverified evaluation runtime", () => {
    function evaluationState(
      overrides: Partial<CodingWorkbenchRuntimeState> = {},
    ): CodingWorkbenchRuntimeState {
      const base = liveState(overrides);
      return {
        ...base,
        runtime: {
          ...base.runtime,
          value: {
            ...base.runtime.value,
            runtimeEvidenceClass: "functional-not-platform-qualified",
          },
        } as CodingWorkbenchRuntimeState["runtime"],
      };
    }

    it("never renders the plain Ready to start label over an evaluation runtime", (): void => {
      renderWorkbench(evaluationState({ run: { status: "ready", value: null, error: null } }));

      expect(screen.getByRole("status")).toHaveTextContent(
        "Runtime available as an unverified evaluation runtime",
      );
    });

    it("keeps evaluation assurance out of decorative status chrome", (): void => {
      renderWorkbench(evaluationState());

      expect(document.querySelector('[data-assurance="evaluation"]')).toBeNull();
      expect(screen.getByRole("status")).toHaveTextContent(
        "Runtime available as an unverified evaluation runtime",
      );
    });

    it("keeps runtime assurance in the lifecycle announcement", (): void => {
      renderWorkbench(evaluationState());

      expect(screen.getByText("Coding runtime")).toBeInTheDocument();
      expect(
        screen.getByText("Unverified evaluation runtime — no platform signature"),
      ).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent(
        "Runtime available as an unverified evaluation runtime",
      );
    });

    it("raises no alert and does not preempt a concurrent refresh failure", (): void => {
      renderWorkbench(
        evaluationState({
          workspace: {
            status: "error",
            value: null,
            error: { code: "WORKSPACE_REFRESH_FAILED", message: "redacted", retryable: true },
          },
        }),
      );

      expect(screen.getByRole("alert")).toHaveTextContent(/workspace/iu);
    });

    it("keeps a platform-qualified runtime rendering exactly as before", (): void => {
      renderWorkbench(liveState({ run: { status: "ready", value: null, error: null } }));

      expect(screen.getByRole("status")).toHaveTextContent("Runtime ready");
      expect(document.querySelector('[data-assurance="evaluation"]')).toBeNull();
      expect(
        screen.getByText("Platform-verified — signed and notarized runtime"),
      ).toBeInTheDocument();
    });

    // Workbench audit, 2026-09-03: before this fix, a completely unavailable runtime (no evaluation
    // runtime exists at all) rendered the SAME "Unverified evaluation runtime" text as a genuinely
    // running evaluation build — the chip only ever distinguished platform-qualified from
    // everything else, so "unavailable" and "evaluation" were indistinguishable to the operator.
    it("names the runtime unavailable instead of implying an evaluation runtime exists", (): void => {
      renderWorkbench(
        liveState({
          canStart: false,
          runtime: {
            status: "ready",
            error: null,
            value: {
              schemaVersion: "1",
              requestedMode: "governed-assist",
              deploymentCeiling: "supervised-coding",
              effectiveMode: "governed-assist",
              runtimeAvailable: false,
              runtimeUnavailableReason: "runtime-disabled",
            },
          },
        }),
      );

      expect(screen.getByText("Coding runtime unavailable")).toBeInTheDocument();
      expect(
        screen.queryByText("Unverified evaluation runtime — no platform signature"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("Platform-verified — signed and notarized runtime"),
      ).not.toBeInTheDocument();
    });

    // Finding 3: while readiness has not yet resolved, the chip must not flash the "evaluation"
    // text — nothing has been confirmed yet. Mirrors the bootstrap setup card's own posture.
    // Every mode switch re-reads readiness; a known-unavailable runtime must not flash "verified"
    // for the duration of that read (review of ec04288dc).
    it("keeps naming the runtime unavailable while readiness is re-read", (): void => {
      const liveActions = actions();
      runtimeHookMock.mockReturnValue({
        state: liveState({
          canStart: false,
          runtime: {
            status: "ready",
            error: null,
            value: {
              schemaVersion: "1",
              requestedMode: "governed-assist",
              deploymentCeiling: "supervised-coding",
              effectiveMode: "governed-assist",
              runtimeAvailable: false,
              runtimeUnavailableReason: "runtime-disabled",
            },
          },
        }),
        actions: liveActions,
      });
      const view = render(<CodingWorkbenchWindow selectedRoot={undefined} />);
      expect(screen.getByText("Coding runtime unavailable")).toBeInTheDocument();

      runtimeHookMock.mockReturnValue({
        state: liveState({
          canStart: false,
          runtime: { status: "loading", value: null, error: null },
        }),
        actions: liveActions,
      });
      view.rerender(<CodingWorkbenchWindow selectedRoot={undefined} />);

      expect(screen.getByText("Coding runtime unavailable")).toBeInTheDocument();
      expect(
        screen.queryByText("Platform-verified — signed and notarized runtime"),
      ).not.toBeInTheDocument();
    });

    it("names the runtime unavailable when the readiness read failed", (): void => {
      renderWorkbench(
        liveState({
          canStart: false,
          runtime: {
            status: "error",
            value: null,
            error: { code: "RUNTIME_READ_FAILED", message: "redacted", retryable: true },
          },
        }),
      );

      expect(screen.getByText("Coding runtime unavailable")).toBeInTheDocument();
    });

    // The placeholder before the FIRST resolve must claim nothing: not the evaluation text (nothing
    // has been confirmed yet) and not the platform-verified text either, which is the strongest
    // trust claim in the window and used to stand on first open, on every remount, and indefinitely
    // on a hanging readiness read (#3381 review).
    it("claims neither verification nor evaluation while the first readiness read is in flight", (): void => {
      renderWorkbench(liveState({ runtime: { status: "loading", value: null, error: null } }));

      expect(
        screen.queryByText("Unverified evaluation runtime — no platform signature"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("Platform-verified — signed and notarized runtime"),
      ).not.toBeInTheDocument();
      expect(screen.getByText("Checking coding runtime…")).toBeInTheDocument();
    });

    it("keeps the pending placeholder neutral rather than marking it a warning", (): void => {
      renderWorkbench(liveState({ runtime: { status: "idle", value: null, error: null } }));

      const chip = screen.getByText("Checking coding runtime…").closest("[title]");
      expect(chip).not.toBeNull();
      expect(chip).not.toHaveAttribute("data-tone", "warning");
    });

    // The last RESOLVED posture still stands across a re-read — the pending placeholder is only
    // for the state before anything has resolved.
    it("keeps the resolved verified posture while a later readiness read is in flight", (): void => {
      const liveActions = actions();
      runtimeHookMock.mockReturnValue({ state: liveState(), actions: liveActions });
      const view = render(<CodingWorkbenchWindow selectedRoot={undefined} />);
      expect(
        screen.getByText("Platform-verified — signed and notarized runtime"),
      ).toBeInTheDocument();

      runtimeHookMock.mockReturnValue({
        state: liveState({ runtime: { status: "loading", value: null, error: null } }),
        actions: liveActions,
      });
      view.rerender(<CodingWorkbenchWindow selectedRoot={undefined} />);

      expect(
        screen.getByText("Platform-verified — signed and notarized runtime"),
      ).toBeInTheDocument();
      expect(screen.queryByText("Checking coding runtime…")).not.toBeInTheDocument();
    });
  });

  // The remedy for an unavailable model source used to render only inside the source panel, which
  // nothing mounts: a sighted operator saw "Keiko Gateway — Unavailable" and a disabled Start with
  // no reason and no next step, while only the sr-only live region spoke it (#3381 review).
  it("shows an unavailable source's reason and next step on the mounted surface", (): void => {
    renderWorkbench(
      liveState({
        canStart: false,
        source: {
          status: "ready",
          value: {
            runtimePreference: "managed-gateway",
            modelSource: "keiko-model-gateway",
            runtimeSource: "keiko-sidecar",
            available: false,
            unavailableReason: "no-tool-calling",
            verification: UNVERIFIED_GATEWAY,
          },
          error: null,
        },
      }),
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/No chat model has verified tool calling/u);
    expect(alert).toHaveTextContent(/Run the readiness check in Settings/u);
  });

  // Workbench audit, 2026-09-03: every truncatable header chip carries a `title` equal to its OWN
  // rendered value — before this fix, three of the four chips had no `title` at all, and the
  // fourth (Task workspace) pointed at an unrelated raw filesystem path instead of its own text.
  it("titles every header chip with its own rendered text", (): void => {
    renderWorkbench(liveState());
    const itemClass = styles.contextItem;
    const valueClass = styles.contextValue;
    if (itemClass === undefined || valueClass === undefined) {
      throw new Error("Coding Workbench context-bar classes are unavailable");
    }
    const items = Array.from(document.querySelectorAll(`.${itemClass}`));
    expect(items).toHaveLength(4);
    for (const item of items) {
      const value = item.querySelector(`.${valueClass}`);
      expect(value).not.toBeNull();
      expect(item).toHaveAttribute("title", value?.textContent ?? "");
    }
  });

  // Finding 5: the workspace chip's `title` used to be wired to `activeBinding.activeRoot` — a
  // raw filesystem path never shown anywhere else on the chip — instead of the composite text
  // (`taskId · taskBranch · health`) actually rendered and truncated.
  it("titles the workspace chip with its rendered text, not the raw root path", (): void => {
    renderWorkbench(
      liveState(),
      actions(),
      undefined,
      activeWorkspaceWithBinding("/repos/keiko", "/worktrees/active-task"),
    );

    const value = screen.getByText("task-1 · issue/2257 · healthy");
    const itemClass = styles.contextItem;
    if (itemClass === undefined) throw new Error("Coding Workbench context-item class unavailable");
    const workspaceItem = value.closest(`.${itemClass}`);
    expect(workspaceItem).toHaveAttribute("title", "task-1 · issue/2257 · healthy");
    expect(workspaceItem).not.toHaveAttribute("title", "/worktrees/active-task");
  });

  // Finding 5: the reported screenshot's exact unbound case — no `title` at all used to exist
  // over the very text ("No active task workspace") the CSS ellipsis was clipping.
  it("titles the workspace chip even when no workspace is bound", (): void => {
    renderWorkbench(createInitialCodingWorkbenchRuntimeState());

    const value = screen.getByText("No active task workspace");
    const itemClass = styles.contextItem;
    if (itemClass === undefined) throw new Error("Coding Workbench context-item class unavailable");
    expect(value.closest(`.${itemClass}`)).toHaveAttribute("title", "No active task workspace");
  });

  it("keeps a drifted worktree visible in the session context", (): void => {
    renderWorkbench(
      liveState({
        workspace: {
          status: "ready",
          value: {
            workspaceId: "workspace-1",
            taskId: "task-1",
            taskBranch: "issue/2257",
            health: "drifted",
            switching: false,
          },
          error: null,
        },
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Workspace unavailable");
    expect(screen.getByText("task-1 · issue/2257 · drifted")).toBeInTheDocument();
  });

  it("binds one-time approval controls to live pending permission truth", async () => {
    const user = userEvent.setup();
    approvalReviewHookMock.mockReturnValue({
      status: "ready",
      review: draftDeliveryReview("push"),
      retry: vi.fn(),
    });
    const liveActions = renderWorkbench(deliveryApprovalState("push"));

    expect(screen.getByRole("heading", { name: "Review the bounded action" })).toBeInTheDocument();
    expect(screen.queryByText(/diff --git|Bearer|\/Users\//u)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Approve once" }));
    await user.click(screen.getByRole("button", { name: "Deny" }));
    expect(liveActions.decideApproval).toHaveBeenNthCalledWith(1, "approved");
    expect(liveActions.decideApproval).toHaveBeenNthCalledWith(2, "denied");
  });

  // Workbench audit, 2026-09-03: on the governance-critical permission-approval screen, `request.kind`,
  // `request.actionClass`, and `request.risk` used to render as raw, untranslated kebab-case slugs
  // — the only three facts on this fully-localized screen left unlocalized.
  it("localizes the approval kind, action class, and risk instead of raw slugs", (): void => {
    renderWorkbench(
      liveState({
        run: {
          status: "ready",
          error: null,
          value: snapshot({
            state: "awaiting-approval",
            runId: "run-1",
            pendingPermission: {
              requestId: "permission-2",
              kind: "network-egress",
              actionClass: "connector-access",
              actionKind: "push",
              policyReason: "out-of-scope-file-edit",
              connectorScopes: ["source-control.write", "issue-tracker.read"],
              reasonCode: "approval-required",
              risk: "critical",
              expiresAt: "2026-07-13T12:05:00.000Z",
            },
          }),
        },
      }),
    );

    expect(screen.getByText("Network egress")).toBeInTheDocument();
    expect(screen.getByText("Connector access")).toBeInTheDocument();
    expect(screen.getByText("Critical")).toBeInTheDocument();
    // The three remaining closed-union facts on the same screen (review of ec04288dc).
    expect(screen.getByText("Push")).toBeInTheDocument();
    expect(screen.getByText("File edit outside the task scope")).toBeInTheDocument();
    expect(screen.getByText("Source control (write), Issue tracker (read)")).toBeInTheDocument();
    expect(screen.queryByText("out-of-scope-file-edit")).not.toBeInTheDocument();
    expect(screen.queryByText("source-control.write")).not.toBeInTheDocument();
    expect(screen.queryByText("network-egress")).not.toBeInTheDocument();
    expect(screen.queryByText("connector-access")).not.toBeInTheDocument();
    expect(screen.queryByText("critical")).not.toBeInTheDocument();
  });

  it("#2387: shows the research destination the operator is about to approve", async () => {
    researchHookMock.mockReturnValue({
      status: "ready",
      grant: null,
      ask: {
        requestId: "research-approval-1",
        host: "nodejs.org",
        requestLine: "/docs/latest/api/stream.html backpressure",
        expiresAt: "2026-07-13T12:02:00.000Z",
      },
      retry: vi.fn(),
    });
    renderWorkbench(egressApprovalState());

    const destination = screen.getByRole("group", { name: "Research destination" });
    expect(destination).toHaveTextContent("nodejs.org");
    expect(destination).toHaveTextContent("/docs/latest/api/stream.html backpressure");
    // The destination is reviewable text, never a live link that reviewing could follow.
    expect(destination.querySelector("a")).toBeNull();
    expect(await axe(document.body)).toHaveNoViolations();
  });

  // Workbench audit, 2026-09-03: a transient failure while the operator is deciding a network-egress
  // request left them with no way to see the destination other than cancelling out entirely.
  it("#2387/finding 7: offers a retry for an unavailable destination and calls it on click", async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    researchHookMock.mockReturnValue({ status: "unavailable", ask: null, grant: null, retry });
    renderWorkbench(egressApprovalState());

    expect(screen.getByText(/Destination unavailable\. Re-pair this window/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve once" })).toBeInTheDocument();
    expect(await axe(document.body)).toHaveNoViolations();
    await user.click(screen.getByRole("button", { name: "Retry loading the destination" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("#2387: offers no retry control while the destination read is only loading", () => {
    researchHookMock.mockReturnValue({ status: "loading", ask: null, grant: null, retry: vi.fn() });
    renderWorkbench(egressApprovalState());

    expect(
      screen.queryByRole("button", { name: "Retry loading the destination" }),
    ).not.toBeInTheDocument();
  });

  it("#2387: shows no destination block for an approval that is not network egress", () => {
    researchHookMock.mockReturnValue({ status: "idle", ask: null, grant: null, retry: vi.fn() });
    renderWorkbench(egressApprovalState("delivery-substrate"));

    expect(screen.queryByText("Research destination")).not.toBeInTheDocument();
  });

  it("#2802: shows the files and magnitude of the edit the operator is approving", async () => {
    approvalReviewHookMock.mockReturnValue({
      status: "ready",
      review: {
        requestId: "permission-7",
        paths: ["src/alpha.ts", "src/beta.ts"],
        pathsTruncated: false,
        fileCount: 2,
        addedLines: 12,
        deletedLines: 4,
      },
      retry: vi.fn(),
    });
    renderWorkbench(editApprovalState());

    const changes = screen.getByRole("group", { name: "Files this change would write" });
    expect(changes).toHaveTextContent("src/alpha.ts");
    expect(changes).toHaveTextContent("src/beta.ts");
    expect(changes).toHaveTextContent("+12 / -4");
    // Reviewable text only: never a live link, and never a byte of the patch.
    expect(changes.querySelector("a")).toBeNull();
    expect(screen.queryByText(/diff --git/u)).not.toBeInTheDocument();
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it("#2802: marks a truncated file list instead of understating the blast radius", () => {
    approvalReviewHookMock.mockReturnValue({
      status: "ready",
      review: {
        requestId: "permission-7",
        paths: ["src/alpha.ts"],
        pathsTruncated: true,
        fileCount: 9,
        addedLines: 30,
        deletedLines: 0,
      },
      retry: vi.fn(),
    });
    renderWorkbench(editApprovalState());

    const changes = screen.getByRole("group", { name: "Files this change would write" });
    expect(changes).toHaveTextContent("Only the first 1 of 9 files are listed.");
    expect(changes).toHaveTextContent("9");
  });

  // Workbench audit, 2026-09-03: a transient failure while the operator is deciding a file-edit
  // approval left them with no way to see which files would be written other than denying blind.
  it("#2802/finding 7: offers a retry for unavailable changed files and calls it on click", async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    approvalReviewHookMock.mockReturnValue({ status: "unavailable", review: null, retry });
    renderWorkbench(editApprovalState());

    expect(
      screen.getByText(/Changed files unavailable\. Re-pair this window/u),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve once" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry loading the changed files" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("#2802: offers no retry control while the changed-files read is only loading", () => {
    approvalReviewHookMock.mockReturnValue({ status: "loading", review: null, retry: vi.fn() });
    renderWorkbench(editApprovalState());

    expect(
      screen.queryByRole("button", { name: "Retry loading the changed files" }),
    ).not.toBeInTheDocument();
  });

  it.each(["loading", "unavailable"] as const)(
    "#3386: git staging cannot be approved with %s review evidence",
    (status) => {
      approvalReviewHookMock.mockReturnValue({ status, review: null, retry: vi.fn() });
      renderWorkbench(editApprovalState("git-stage"));
      expect(approvalReviewHookMock).toHaveBeenCalledWith({
        runId: "run-1",
        permissionRequestId: "permission-7",
      });
      expect(screen.getByRole("button", { name: "Approve once" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();
    },
  );

  it("#3386: shows exact paths before one-use Git stage approval", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const user = userEvent.setup();
    approvalReviewHookMock.mockReturnValue({
      status: "ready",
      review: {
        requestId: "permission-7",
        paths: ["src/stage-only.ts"],
        pathsTruncated: false,
        fileCount: 1,
        addedLines: 4,
        deletedLines: 2,
      },
      retry: vi.fn(),
    });
    const actions = renderWorkbench(editApprovalState("git-stage"));
    expect(screen.getByText("Stage changes")).toBeInTheDocument();
    expect(screen.getByText("src/stage-only.ts")).toBeInTheDocument();
    expect(warning).toHaveBeenCalledWith("[keiko] git stage review ready: files 1");
    expect(JSON.stringify(warning.mock.calls)).not.toContain("src/stage-only.ts");
    expect(
      screen.queryByRole("region", { name: "Reviewed commit message" }),
    ).not.toBeInTheDocument();
    expect(actions.decideApproval).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Approve once" }));
    expect(actions.decideApproval).toHaveBeenCalledExactlyOnceWith("approved");
    warning.mockRestore();
  });

  function commitApprovalState(
    mode: CodingWorkbenchMode = "governed-assist",
  ): CodingWorkbenchRuntimeState {
    return liveState({
      run: {
        status: "ready",
        error: null,
        value: snapshot({
          state: "awaiting-approval",
          runId: "run-1",
          requestedMode: mode,
          effectiveMode: mode,
          pendingPermission: {
            requestId: "proposal-3386",
            kind: "delivery-substrate",
            actionClass: "delivery-substrate",
            actionKind: "commit",
            reasonCode: "approval-required",
            policyReason: "approval-required",
            risk: "high",
            expiresAt: "2026-07-13T12:05:00.000Z",
          },
        }),
      },
    });
  }

  function commitReview(): CodingWorkbenchRuntimePendingApprovalReview {
    return {
      requestId: "proposal-3386",
      paths: ["src/actual.ts"],
      pathsTruncated: false,
      fileCount: 1,
      addedLines: 7,
      deletedLines: 2,
      verifiedCommit: {
        message: "fix: preserve exact verified commit\n\nUntrusted <script> content",
        result: {
          schemaVersion: "1",
          status: "approval-required",
          reason: "approval-required",
          recordedAt: AT,
          proposalId: "proposal-3386",
          runId: "run-1",
          envelopeDigest: "a".repeat(64),
          runtimeAuthorityDigest: "b".repeat(64),
          workspaceDigest: "c".repeat(64),
          repositoryDigest: "d".repeat(64),
          baseSha: "1".repeat(40),
          parentSha: "2".repeat(40),
          stagedTreeDigest: "3".repeat(64),
          messageDigest: "4".repeat(64),
          verificationEvidenceId: "verification-3386",
        },
      },
    };
  }

  it.each(["governed-assist", "supervised-coding", "autonomous-delivery"] as const)(
    "#3386: commit approval in %s requires its exact reviewed proposal",
    async (mode) => {
      const user = userEvent.setup();
      approvalReviewHookMock.mockReturnValue({ status: "loading", review: null, retry: vi.fn() });
      const liveActions = renderWorkbench(commitApprovalState(mode));
      expect(approvalReviewHookMock).toHaveBeenCalledWith({
        runId: "run-1",
        permissionRequestId: "proposal-3386",
      });
      expect(screen.getByRole("button", { name: "Approve once" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();
      await user.click(screen.getByRole("button", { name: "Approve once" }));
      expect(liveActions.decideApproval).not.toHaveBeenCalled();
    },
  );

  it.each(["governed-assist", "supervised-coding", "autonomous-delivery"] as const)(
    "#3386: displays the exact staged change and untrusted commit message before approval in %s",
    async (mode) => {
      const user = userEvent.setup();
      approvalReviewHookMock.mockReturnValue({
        status: "ready",
        review: commitReview(),
        retry: vi.fn(),
      });
      const liveActions = renderWorkbench(commitApprovalState(mode));
      expect(liveActions.decideApproval).not.toHaveBeenCalled();
      const message = screen.getByRole("region", { name: "Reviewed commit message" });
      expect(message).toHaveTextContent("Untrusted <script> content");
      expect(message.querySelector("script")).toBeNull();
      const files = screen.getByRole("group", { name: "Staged files for this commit" });
      expect(files).toHaveTextContent("src/actual.ts");
      expect(files).toHaveTextContent("+7 / -2");
      expect(screen.getByText("verification-3386")).toBeInTheDocument();
      expect(screen.getByText("1".repeat(40))).toBeInTheDocument();
      expect(screen.getByText("2".repeat(40))).toBeInTheDocument();
      expect(screen.getByText("3".repeat(64))).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Approve once" }));
      expect(liveActions.decideApproval).toHaveBeenCalledExactlyOnceWith("approved");
      expect(await axe(document.body)).toHaveNoViolations();
    },
  );

  it.each([
    "missing-commit",
    "wrong-run",
    "wrong-proposal",
    "invalid-message",
    "blocked-pending",
    "token-field",
    "unsafe-path",
  ])("#3386: refuses %s commit review without exposing its message", (shape) => {
    const review = commitReview();
    const commit = review.verifiedCommit;
    if (commit === undefined) throw new Error("Fixture requires a commit");
    const broken = { ...review, verifiedCommit: { ...commit, result: { ...commit.result } } };
    if (shape === "missing-commit") Reflect.deleteProperty(broken, "verifiedCommit");
    if (shape === "invalid-message") broken.verifiedCommit.message = "";
    if (shape === "wrong-run") broken.verifiedCommit.result.runId = "other-run";
    if (shape === "wrong-proposal") broken.verifiedCommit.result.proposalId = "other-proposal";
    if (shape === "blocked-pending") Reflect.set(broken.verifiedCommit.result, "status", "blocked");
    if (shape === "token-field")
      Reflect.set(broken.verifiedCommit, "approvalToken", "fixture-token");
    if (shape === "unsafe-path") broken.paths = ["../private.txt"];
    approvalReviewHookMock.mockReturnValue({ status: "ready", review: broken, retry: vi.fn() });
    renderWorkbench(commitApprovalState());
    expect(screen.getByRole("button", { name: "Approve once" })).toBeDisabled();
    expect(screen.queryByText(/Untrusted <script>/u)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();
  });

  it("#3386: does not display a commit review beside a file-edit permission", () => {
    const review = commitReview();
    const commit = review.verifiedCommit;
    if (commit === undefined) throw new Error("Fixture requires a commit");
    approvalReviewHookMock.mockReturnValue({
      status: "ready",
      retry: vi.fn(),
      review: {
        ...review,
        requestId: "permission-7",
        verifiedCommit: {
          ...commit,
          result: { ...commit.result, proposalId: "permission-7" },
        },
      },
    });
    renderWorkbench(editApprovalState());
    expect(
      screen.queryByRole("region", { name: "Reviewed commit message" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve once" })).toBeDisabled();
  });

  function deliveryApprovalState(
    action: "push" | "pull-request",
    mode: CodingWorkbenchMode = "governed-assist",
  ): CodingWorkbenchRuntimeState {
    const review = draftDeliveryReview(action);
    return liveState({
      run: {
        status: "ready",
        error: null,
        value: {
          ...draftDeliverySnapshot(),
          state: "awaiting-approval",
          requestedMode: mode,
          effectiveMode: mode,
          pendingPermission: {
            requestId: review.requestId,
            kind: "delivery-substrate",
            actionClass: "delivery-substrate",
            actionKind: action,
            reasonCode: "approval-required",
            policyReason: "approval-required",
            risk: "high",
            expiresAt: "2026-09-05T00:05:00.000Z",
          },
        },
      },
    });
  }

  const DELIVERY_CASES = (
    ["governed-assist", "supervised-coding", "autonomous-delivery"] as const
  ).flatMap((mode) => (["push", "pull-request"] as const).map((action) => ({ mode, action })));

  it.each(DELIVERY_CASES)(
    "#3387: $mode $action waits for authenticated review",
    ({ mode, action }) => {
      approvalReviewHookMock.mockReturnValue({ status: "loading", review: null, retry: vi.fn() });
      renderWorkbench(deliveryApprovalState(action, mode));
      expect(approvalReviewHookMock).toHaveBeenCalledWith({
        runId: "run-1",
        permissionRequestId: "delivery-1",
      });
      expect(screen.getByRole("button", { name: "Approve once" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();
    },
  );

  it.each(DELIVERY_CASES)(
    "#3387: $mode reviews exact $action target before explicit approval",
    async ({ mode, action }) => {
      approvalReviewHookMock.mockReturnValue({
        status: "ready",
        review: draftDeliveryReview(action),
        retry: vi.fn(),
      });
      const actions = renderWorkbench(deliveryApprovalState(action, mode));
      const target = screen.getByRole("region", { name: "Reviewed delivery target" });
      for (const value of [
        "owner/repository",
        "#42",
        "feature/issue-42",
        "main",
        "3".repeat(40),
        "1".repeat(40),
      ])
        expect(target).toHaveTextContent(value);
      expect(screen.queryByRole("group", { name: "Changed files" })).not.toBeInTheDocument();
      if (action === "pull-request") {
        expect(
          screen.getByRole("region", { name: "Reviewed pull request title" }),
        ).toHaveTextContent("fix: exact reviewed delivery <script>");
        const body = screen.getByRole("region", { name: "Reviewed pull request description" });
        expect(body).toHaveTextContent("Original template <img src=x>");
        expect(body).toHaveTextContent("Closes #42");
        expect(body.querySelector("img")).toBeNull();
      } else
        expect(
          screen.queryByRole("region", { name: "Reviewed pull request description" }),
        ).not.toBeInTheDocument();
      expect(actions.decideApproval).not.toHaveBeenCalled();
      await userEvent.setup().click(screen.getByRole("button", { name: "Approve once" }));
      expect(actions.decideApproval).toHaveBeenCalledExactlyOnceWith("approved");
      expect(await axe(document.body)).toHaveNoViolations();
    },
  );

  it.each([
    "missing",
    "wrong-run",
    "wrong-issue",
    "wrong-remote",
    "wrong-number",
    "wrong-base",
    "wrong-request",
    "wrong-phase",
    "token",
    "missing-body",
    "mixed-commit",
  ])("#3387: refuses %s PR review and hides its transient text", (shape) => {
    const review = structuredClone(draftDeliveryReview("pull-request"));
    const delivery = review.draftDelivery;
    if (delivery === undefined) throw new Error("Fixture requires delivery");
    if (shape === "missing") Reflect.deleteProperty(review, "draftDelivery");
    const changedBinding: Readonly<Record<string, readonly [string, string | number]>> = {
      "wrong-run": ["runId", "other-run"],
      "wrong-issue": ["issueBindingDigest", "b".repeat(64)],
      "wrong-remote": ["remoteDigest", "b".repeat(64)],
      "wrong-number": ["issueNumber", 43],
      "wrong-base": ["baseRef", "dev"],
    };
    const mutation = changedBinding[shape];
    if (mutation !== undefined) Reflect.set(delivery.record.binding, ...mutation);
    if (shape === "wrong-request") Reflect.set(review, "requestId", "other-request");
    if (shape === "wrong-phase") Reflect.set(delivery.record, "phase", "push-proposed");
    if (shape === "token") Reflect.set(delivery, "approvalToken", "fixture-secret");
    if (shape === "missing-body") Reflect.deleteProperty(delivery, "body");
    if (shape === "mixed-commit")
      Reflect.set(review, "verifiedCommit", commitReview().verifiedCommit);
    approvalReviewHookMock.mockReturnValue({ status: "ready", review, retry: vi.fn() });
    renderWorkbench(deliveryApprovalState("pull-request"));
    expect(screen.getByRole("button", { name: "Approve once" })).toBeDisabled();
    expect(screen.queryByText(/exact reviewed delivery/u)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();
  });

  it.each(["push", "pull-request"] as const)(
    "#3387: refuses a valid review for the other delivery action beside %s",
    (action) => {
      const other = action === "push" ? "pull-request" : "push";
      approvalReviewHookMock.mockReturnValue({
        status: "ready",
        review: draftDeliveryReview(other),
        retry: vi.fn(),
      });
      renderWorkbench(deliveryApprovalState(action));
      expect(screen.getByRole("button", { name: "Approve once" })).toBeDisabled();
      expect(
        screen.queryByRole("region", { name: "Reviewed pull request description" }),
      ).not.toBeInTheDocument();
    },
  );
  it("#3387: records the unavailable delivery display without its rejected text", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    approvalReviewHookMock.mockReturnValue({
      status: "ready",
      review: draftDeliveryReview("push"),
      retry: vi.fn(),
    });
    renderWorkbench(deliveryApprovalState("pull-request"));
    expect(warn).toHaveBeenCalledWith("[keiko] draft delivery review displayed: unavailable");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Original template");
  });

  it("#3387: denies an unavailable delivery without granting and retries its existing review channel", async () => {
    const retry = vi.fn();
    approvalReviewHookMock.mockReturnValue({ status: "unavailable", review: null, retry });
    const actions = renderWorkbench(deliveryApprovalState("push"));
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry delivery review" }));
    expect(retry).toHaveBeenCalledOnce();
    await userEvent.setup().click(screen.getByRole("button", { name: "Deny" }));
    expect(actions.decideApproval).toHaveBeenCalledExactlyOnceWith("denied");
  });

  it("#3387: restores durable delivery after reload with no commit receipt or session events", () => {
    renderWorkbench(
      liveState({ run: { status: "ready", error: null, value: draftDeliverySnapshot() } }),
    );
    expect(screen.getByRole("region", { name: "Repository delivery" })).toHaveTextContent(
      "Draft pull request created",
    );
    expect(screen.getByRole("link", { name: "Pull request #7" })).toHaveAttribute(
      "href",
      "https://github.com/owner/repository/pull/7",
    );
    expect(screen.queryByRole("button", { name: "Approve once" })).not.toBeInTheDocument();
  });

  it("#3386: restores the durable commit finding after reload even without session events", () => {
    const commit = commitReview().verifiedCommit;
    if (commit === undefined) throw new Error("Fixture requires a commit");
    renderWorkbench(
      liveState({
        run: {
          status: "ready",
          error: null,
          value: snapshot({
            state: "succeeded",
            runId: "run-1",
            verifiedCommitResult: {
              ...commit.result,
              status: "blocked",
              reason: "policy-block",
              blockReason: "protected-branch",
            },
          }),
        },
      }),
    );
    expect(screen.getByRole("region", { name: "Commit result" })).toHaveTextContent(
      "Target is a protected branch",
    );
    expect(screen.queryByRole("button", { name: "Approve once" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Reviewed commit message" }),
    ).not.toBeInTheDocument();
  });

  // #3381 review: the loading/unavailable branches of the evidence panels used to leave Approve
  // enabled, so a file-edit could be approved without its paths and an egress ask without its
  // destination — the review channel bypassed, and the human-control invariant with it. Approve
  // now fails closed until the evidence is READY and bound to the request on screen; Deny and the
  // channel's own retry remain the recovery path.
  const APPROVAL_REVIEW = {
    requestId: "permission-7",
    paths: ["src/alpha.ts"],
    pathsTruncated: false,
    fileCount: 1,
    addedLines: 3,
    deletedLines: 1,
  };

  const RESEARCH_ASK = {
    requestId: "research-approval-1",
    host: "nodejs.org",
    requestLine: "/docs/latest/api/stream.html backpressure",
    expiresAt: "2026-07-13T12:02:00.000Z",
  };

  function approveButton(): HTMLElement {
    return screen.getByRole("button", { name: "Approve once" });
  }

  it.each([
    ["loading", { status: "loading", review: null }],
    ["unavailable", { status: "unavailable", review: null }],
  ])(
    "#3381: cannot approve a file edit whose changed files are %s",
    async (_label, reviewState) => {
      const user = userEvent.setup();
      approvalReviewHookMock.mockReturnValue({ ...reviewState, retry: vi.fn() });
      const liveActions = renderWorkbench(editApprovalState());

      expect(approveButton()).toBeDisabled();
      expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();
      await user.click(approveButton());
      expect(liveActions.decideApproval).not.toHaveBeenCalled();
    },
  );

  it("#3381: cannot approve a file edit whose evidence belongs to another request", async () => {
    const user = userEvent.setup();
    approvalReviewHookMock.mockReturnValue({
      status: "ready",
      review: { ...APPROVAL_REVIEW, requestId: "permission-8" },
      retry: vi.fn(),
    });
    const liveActions = renderWorkbench(editApprovalState());

    expect(approveButton()).toBeDisabled();
    await user.click(approveButton());
    expect(liveActions.decideApproval).not.toHaveBeenCalled();
  });

  it("#3381: approves a file edit once its changed files are ready and bound", async () => {
    const user = userEvent.setup();
    approvalReviewHookMock.mockReturnValue({
      status: "ready",
      review: APPROVAL_REVIEW,
      retry: vi.fn(),
    });
    const liveActions = renderWorkbench(editApprovalState());

    expect(approveButton()).toBeEnabled();
    await user.click(approveButton());
    expect(liveActions.decideApproval).toHaveBeenCalledWith("approved");
  });

  it.each([
    ["loading", { status: "loading", ask: null }],
    ["unavailable", { status: "unavailable", ask: null }],
  ])("#3381: cannot approve network egress whose destination is %s", async (_label, askState) => {
    const user = userEvent.setup();
    researchHookMock.mockReturnValue({ ...askState, grant: null, retry: vi.fn() });
    const liveActions = renderWorkbench(egressApprovalState());

    expect(approveButton()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();
    await user.click(approveButton());
    expect(liveActions.decideApproval).not.toHaveBeenCalled();
  });

  it("#3381: approves network egress once its destination is ready and bound", async () => {
    const user = userEvent.setup();
    researchHookMock.mockReturnValue({
      status: "ready",
      ask: RESEARCH_ASK,
      grant: null,
      retry: vi.fn(),
    });
    const liveActions = renderWorkbench(egressApprovalState());

    expect(approveButton()).toBeEnabled();
    await user.click(approveButton());
    expect(liveActions.decideApproval).toHaveBeenCalledWith("approved");
  });

  it("#3381: names the blocked approval instead of leaving a dead control", async () => {
    approvalReviewHookMock.mockReturnValue({ status: "unavailable", review: null, retry: vi.fn() });
    renderWorkbench(editApprovalState());

    const note = screen.getByText(
      /Approval stays unavailable until what this request would touch/u,
    );
    expect(approveButton()).toHaveAttribute("aria-describedby", note.id);
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it("#2802: shows no changed-file block for an approval that writes no file", () => {
    approvalReviewHookMock.mockReturnValue({ status: "idle", review: null, retry: vi.fn() });
    renderWorkbench(egressApprovalState());

    expect(screen.queryByText("Files this change would write")).not.toBeInTheDocument();
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

  // #3390: after a server restart the operator's actual control was the composer's single "Start
  // coding run" action, not the recovery panel's separate Retry button. Once the live-state guard
  // reports the acknowledged predecessor as startable (`canStart: true`), that primary action must
  // reach `actions.start` exactly like any other startable state — a hidden runState-specific
  // guard here would leave the button visually enabled but silently inert.
  it("lets the primary Start action fire once an acknowledged recovery-required predecessor is startable", async () => {
    const user = userEvent.setup();
    const liveActions = renderWorkbench(
      liveState({
        canStart: true,
        canRetry: true,
        run: {
          status: "ready",
          error: null,
          value: snapshot({
            state: "recovery-required",
            runId: "run-1",
            failureCode: "recovery-required",
            recoveryAcknowledged: true,
          }),
        },
      }),
    );

    const taskInput = screen.getByLabelText("Task instructions");
    await user.type(taskInput, "Continue after the restart");
    await user.click(screen.getByRole("button", { name: "Start coding run" }));

    expect(liveActions.start).toHaveBeenCalledWith("Continue after the restart");
  });

  it("keeps terminal result evidence out of the user-facing workbench", async () => {
    renderWorkbench(
      liveState({
        canStart: false,
        run: {
          status: "ready",
          error: null,
          value: snapshot({
            state: "failed",
            runId: "run-1",
            result: {
              status: "failed",
              exitCode: 9,
              output: {
                byteCount: 22,
                lineCount: 1,
                sha256: "a".repeat(64),
                truncated: false,
              },
              error: {
                byteCount: 17,
                lineCount: 2,
                sha256: "b".repeat(64),
                truncated: true,
              },
            },
          }),
        },
      }),
    );

    expect(screen.queryByRole("heading", { name: "Body-free process summary" })).toBeNull();
    expect(screen.queryByText("Standard output SHA-256")).toBeNull();
    expect(screen.queryByText("a".repeat(64))).toBeNull();
    expect(screen.queryByText("b".repeat(64))).toBeNull();
    expect(screen.queryByText(/hostile-process-body/u)).not.toBeInTheDocument();
    expect(await axe(document.body)).toHaveNoViolations();
  });

  // 0.3.0 release audit: `RuntimeControls` rendered nothing for a paused run, and these two
  // buttons are the ONLY call sites of `actions.stop` and `actions.takeover` in the whole UI — so
  // a paused run offered no way to end it at all, while the server admits stop and takeover from
  // `paused`. Pausing must not remove the operator's exits.
  it("keeps stop and takeover reachable while a run is paused", async () => {
    const user = userEvent.setup();
    const liveActions = renderWorkbench(
      liveState({
        canStart: false,
        run: {
          status: "ready",
          error: null,
          value: snapshot({ state: "paused", runId: "run-1" }),
        },
      }),
    );

    await user.click(screen.getByRole("button", { name: "Stop run" }));
    expect(liveActions.stop).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Take over manually" }));
    expect(liveActions.takeover).toHaveBeenCalledOnce();
  });

  it("resumes a full-access run with the explicitly selected supervised mode", async () => {
    const user = userEvent.setup();
    const liveActions = actions();
    const pausedState = liveState({
      canStart: false,
      run: {
        status: "ready",
        error: null,
        value: snapshot({
          state: "paused",
          runId: "run-1",
          requestedMode: "autonomous-delivery",
          effectiveMode: "autonomous-delivery",
        }),
      },
    });
    runtimeHookMock.mockReturnValue({ state: pausedState, actions: liveActions });
    const view = render(<CodingWorkbenchWindow selectedRoot={undefined} />);

    const selector = screen.getByRole("combobox", { name: "Resume autonomy" });
    expect(screen.getByRole("option", { name: "Full access" })).toBeInTheDocument();
    await user.selectOptions(selector, "supervised-coding");
    await user.click(screen.getByRole("button", { name: "Resume run" }));

    expect(liveActions.resume).toHaveBeenCalledWith("supervised-coding");
    expect(document.querySelector('[data-mode="autonomous-delivery"]')).toHaveTextContent(
      "Full access",
    );

    runtimeHookMock.mockReturnValue({
      state: liveState({
        canStart: false,
        run: {
          status: "ready",
          error: null,
          value: snapshot({
            state: "running",
            runId: "run-1",
            requestedMode: "autonomous-delivery",
            effectiveMode: "supervised-coding",
          }),
        },
      }),
      actions: liveActions,
    });
    view.rerender(<CodingWorkbenchWindow selectedRoot={undefined} />);

    expect(document.querySelector('[data-mode="autonomous-delivery"]')).not.toBeInTheDocument();
    expect(document.querySelector('[data-mode="supervised-coding"]')).toHaveTextContent(
      "Supervised workspace",
    );
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it("offers no widening mode when a supervised run is paused", () => {
    renderWorkbench(
      liveState({
        canStart: false,
        run: {
          status: "ready",
          error: null,
          value: snapshot({
            state: "paused",
            runId: "run-1",
            requestedMode: "autonomous-delivery",
            effectiveMode: "supervised-coding",
          }),
        },
      }),
    );

    expect(screen.getByRole("combobox", { name: "Resume autonomy" })).toHaveValue(
      "supervised-coding",
    );
    expect(screen.queryByRole("option", { name: "Full access" })).not.toBeInTheDocument();
    expect(document.querySelector('[data-mode="supervised-coding"]')).toHaveTextContent(
      "Supervised workspace",
    );
  });

  // Same root cause, higher consequence. `activeRunState` also drives the headless editor-bridge
  // lease and the autonomy auto-sync: while paused the bridge must stay leased — a changeset
  // review already pending when the operator pauses can only be delivered over a live lease, so
  // tearing it down loses the operator's Approve/Deny — and the requested mode must not be
  // re-synced under a run whose minted envelope can no longer change.
  it("keeps the editor bridge leased and the minted mode untouched while a run is paused", () => {
    const liveActions = renderWorkbench(
      liveState({
        requestedMode: "governed-assist",
        canStart: false,
        run: {
          status: "ready",
          error: null,
          value: snapshot({ state: "paused", runId: "run-1" }),
        },
      }),
    );

    expect(editorBridgeHookMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", active: true }),
    );
    expect(liveActions.setRequestedMode).not.toHaveBeenCalled();
  });

  // Workbench audit, 2026-09-03: the editor bridge's `root` and `bindingPending` must come from the
  // SAME live workspace signal `CodingWorkbenchChanges` uses — the actual root-locking behavior is
  // pinned at the hook level (useCodingWorkbenchEditorBridge.test.ts); this proves the wiring at
  // the boundary this file owns, so the two consumers can never observe a different workspace.
  it("wires the editor bridge to the same live workspace root and binding-pending signal as CodingWorkbenchChanges", (): void => {
    const binding = activeWorkspaceWithBinding("/repos/keiko", "/worktrees/active-task");
    renderWorkbench(
      liveState({
        run: {
          status: "ready",
          error: null,
          value: snapshot({ state: "running", runId: "run-1" }),
        },
      }),
      actions(),
      undefined,
      binding,
    );

    expect(editorBridgeHookMock).toHaveBeenCalledWith(
      expect.objectContaining({
        root: "/worktrees/active-task",
        runId: "run-1",
        active: true,
        bindingPending: false,
      }),
    );
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

    expect(
      screen.getByText("Authentication setup plan unavailable.", { exact: false }),
    ).toBeInTheDocument();
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

  it("renders authenticated conversation, terminal tools, plan, truncation, and an inline question", async () => {
    const user = userEvent.setup();
    const answer = vi.fn(() => Promise.resolve(true));
    activityHookMock.mockReturnValue({
      status: "live",
      feed: activityFeed(),
      errorCode: null,
      retry: vi.fn(),
    } satisfies UseCodingWorkbenchSafeActivityResult);
    questionsHookMock.mockReturnValue({
      status: "ready",
      questions: [
        {
          id: "question-1",
          questions: [
            {
              header: "Continue",
              question: "Use <img src=x onerror=alert(1)>?",
              options: [{ label: "Proceed", description: "Continue the bounded run" }],
            },
          ],
        },
      ],
      errorCode: null,
      mutationFailure: null,
      answer,
      reject: vi.fn(() => Promise.resolve(true)),
      retry: vi.fn(),
    } satisfies UseCodingWorkbenchQuestionsResult);
    renderWorkbench(
      liveState({
        run: {
          status: "ready",
          error: null,
          value: snapshot({ state: "running", runId: "run-1" }),
        },
      }),
    );

    const timeline = screen.getByRole("list", { name: "Coding run event timeline" });
    expect(timeline).toHaveTextContent("Review the repository");
    expect(timeline).toHaveTextContent("Tool activity: workspace.read");
    expect(timeline).toHaveTextContent("Succeeded");
    expect(timeline).toHaveTextContent("Current plan");
    expect(timeline).toHaveTextContent("Output truncated");
    expect(document.querySelector("img")).toBeNull();
    const questions = screen.getByRole("region", { name: "Runtime questions" });
    expect(questions.closest('ol[aria-label="Coding run event timeline"]')).toBe(timeline);

    await user.click(screen.getByRole("radio", { name: /Proceed/u }));
    await user.click(screen.getByRole("button", { name: "Send answer" }));
    expect(answer).toHaveBeenCalledWith("question-1", [["Proceed"]]);
    expect(screen.getByRole("heading", { name: "Activity" })).toHaveFocus();
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
    const grant = {
      grantId: "grant-1",
      domains: ["developer.mozilla.org", "nodejs.org"],
      expiresAt: "2026-07-13T12:30:00.000Z",
    } as const;
    researchHookMock.mockReturnValue({ status: "ready", ask: null, grant, retry: vi.fn() });
    const liveActions = renderWorkbench(
      liveState({
        run: {
          status: "ready",
          error: null,
          value: snapshot({
            state: "running",
            runId: "run-1",
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
    expect(liveActions.revokeResearchGrant).toHaveBeenCalledWith(grant);
  });
});

describe("CodingWorkbenchWindow live stream follows the newest activity", () => {
  // Only what differs from the file-scope defaults above.
  beforeEach(() => {
    autonomyHookMock.mockReturnValue({
      requestedMode: "governed-assist",
      effectiveMode: "governed-assist",
      deploymentCeiling: "governed-assist",
      pending: false,
      error: null,
      change: vi.fn(),
    });
  });

  // Observed live on 2026-08-23: a run completed with a plan, thirteen tool calls and the final
  // answer in the feed, yet the operator saw only the first three rows because the scroll region
  // never moved to the newest activity. The feed was right; the view was stale.
  it("scrolls the log region to the newest activity as the feed grows", () => {
    const runningState = liveState({
      canStart: false,
      run: {
        status: "ready",
        error: null,
        value: snapshot({ state: "running", runId: "run-1", revision: 2 }),
      },
      events: [event(1)],
    });
    activityHookMock.mockReturnValue({ ...IDLE_ACTIVITY, status: "live", feed: activityFeed() });
    runtimeHookMock.mockReturnValue({ state: runningState, actions: actions() });
    const view = render(<CodingWorkbenchWindow selectedRoot={undefined} />);
    const log = screen.getByRole("log");
    const scrollTop = { value: 0 };
    Object.defineProperty(log, "scrollHeight", { configurable: true, get: () => 1720 });
    Object.defineProperty(log, "clientHeight", { configurable: true, get: () => 292 });
    Object.defineProperty(log, "scrollTop", {
      configurable: true,
      get: () => scrollTop.value,
      set: (next: number) => {
        scrollTop.value = next;
      },
    });

    const grown = activityFeed();
    activityHookMock.mockReturnValue({
      ...IDLE_ACTIVITY,
      status: "live",
      feed: {
        ...grown,
        updatedAt: "2026-08-23T09:52:09.000Z",
        turns: [
          {
            ...grown.turns[0]!,
            messages: [
              ...grown.turns[0]!.messages,
              {
                messageId: "message-2",
                role: "assistant",
                occurredAt: "2026-08-23T09:52:09.000Z",
                segments: [
                  {
                    kind: "text",
                    text: "The file is scripts/check-adr-index.mjs.",
                    truncated: false,
                  },
                ],
                truncated: false,
              },
            ],
          },
        ],
      },
    });
    view.rerender(<CodingWorkbenchWindow selectedRoot={undefined} />);

    expect(scrollTop.value).toBe(1720);
  });

  it("does not yank a reader who scrolled up into the history", () => {
    const runningState = liveState({
      canStart: false,
      run: {
        status: "ready",
        error: null,
        value: snapshot({ state: "running", runId: "run-1", revision: 2 }),
      },
      events: [event(1)],
    });
    activityHookMock.mockReturnValue({ ...IDLE_ACTIVITY, status: "live", feed: activityFeed() });
    runtimeHookMock.mockReturnValue({ state: runningState, actions: actions() });
    const view = render(<CodingWorkbenchWindow selectedRoot={undefined} />);
    const log = screen.getByRole("log");
    const scrollTop = { value: 0 };
    Object.defineProperty(log, "scrollHeight", { configurable: true, get: () => 1720 });
    Object.defineProperty(log, "clientHeight", { configurable: true, get: () => 292 });
    Object.defineProperty(log, "scrollTop", {
      configurable: true,
      get: () => scrollTop.value,
      set: (next: number) => {
        scrollTop.value = next;
      },
    });
    // The reader scrolls up into the history (far from the bottom) and the view learns about it.
    scrollTop.value = 100;
    fireEvent.scroll(log);

    activityHookMock.mockReturnValue({
      ...IDLE_ACTIVITY,
      status: "live",
      feed: { ...activityFeed(), updatedAt: "2026-08-23T09:52:09.000Z" },
    });
    view.rerender(<CodingWorkbenchWindow selectedRoot={undefined} />);

    expect(scrollTop.value).toBe(100);
  });
});

function activityFeed(): AvailableCodingSafeActivityFeed {
  return {
    schemaVersion: "1",
    availability: "available",
    runId: "run-1",
    updatedAt: AT,
    turns: [
      {
        turnId: "turn-1",
        messages: [
          {
            messageId: "message-1",
            role: "assistant",
            occurredAt: AT,
            segments: [{ kind: "text", text: "Review the repository", truncated: true }],
            truncated: true,
          },
        ],
        tools: [
          {
            callId: "call-1",
            tool: "workspace.read",
            state: "succeeded",
            occurredAt: AT,
          },
        ],
        truncated: true,
      },
    ],
    plan: {
      revision: 1,
      anchorMessageId: "message-1",
      updatedAt: AT,
      steps: [{ text: "Inspect the target", state: "active", truncated: false }],
      truncated: false,
    },
    truncated: false,
    droppedEventCount: 0,
  };
}

describe("Codex subscription sign-in surface", () => {
  it("mounts the sign-in card above the composer while the subscription is selected and not connected", async () => {
    renderWorkbench(
      liveState({
        runtimePreference: "codex-subscription",
        profile: {
          status: "ready",
          value: {
            schemaVersion: "1",
            profileId: "profile-1",
            modelSource: "chatgpt-codex-subscription-profile",
            runtimeSource: "codex-cli-adapter",
            status: "missing",
            credentialStore: "file",
            stateScope: "keiko-owned-state",
            stateRoot: "keiko-codex-runtime-state",
            usesGlobalCodexHome: false,
            runtimeBinarySources: ["managed-sidecar-runtime"],
            supportsBrowserLogin: true,
            supportsDeviceCode: false,
            supportsAccessToken: false,
            deploymentPolicyDisabled: false,
            headless: false,
          },
          error: null,
        },
      }),
    );

    expect(screen.getByTestId("coding-workbench-codex-auth")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh authentication" })).toBeInTheDocument();
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it("stays absent for the managed gateway source", () => {
    renderWorkbench(liveState());

    expect(screen.queryByTestId("coding-workbench-codex-auth")).not.toBeInTheDocument();
  });
});

// #3381 review: the active task workspace is a global singleton pointer the operator can move at
// any time; a run's authority is not. The server bound the run to the workspace that was active
// when Start arrived and keeps it for the run's life, so the composer chips, the session context
// bar and the Git target must keep naming THAT workspace. Following the pointer instead labelled a
// run in A with B's root and branch and opened B's Git — an invitation to act on the wrong tree.
// #3390 wave: the header's "Allow package scripts for verification" affordance. It reads the SAME
// server-owned trust status the Editor's own trust surface reads, keyed on the live active root —
// the operator no longer has to already know the Editor's own command to unblock a run refused
// WORKSPACE_TRUST_REQUIRED (2026-09-05 real run).
describe("CodingWorkbenchWindow #3390 verification trust affordance", () => {
  it("shows the allow action once the bound workspace resolves as restricted", async () => {
    trustStatusMock.mockResolvedValue(trustStatus("/repos/keiko", "restricted"));
    renderWorkbench(
      liveState(),
      actions(),
      undefined,
      activeWorkspaceWithBinding("/repos/keiko", "/repos/keiko"),
    );

    const action = await screen.findByRole("button", {
      name: "Allow package scripts for verification",
    });
    expect(action).toBeEnabled();
    expect(trustStatusMock).toHaveBeenCalledWith("/repos/keiko");
  });

  it("grants trust for the bound root through the existing grant route and hides once trusted", async () => {
    trustStatusMock.mockResolvedValue(trustStatus("/repos/keiko", "restricted"));
    trustMutateMock.mockResolvedValue(trustStatus("/repos/keiko", "trusted"));
    const user = userEvent.setup();
    renderWorkbench(
      liveState(),
      actions(),
      undefined,
      activeWorkspaceWithBinding("/repos/keiko", "/repos/keiko"),
    );

    const action = await screen.findByRole("button", {
      name: "Allow package scripts for verification",
    });
    await user.click(action);

    expect(trustMutateMock).toHaveBeenCalledExactlyOnceWith("/repos/keiko", "grant");
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /Allow package scripts/u }),
      ).not.toBeInTheDocument(),
    );
  });

  it("renders no affordance once the bound workspace resolves as trusted", async () => {
    trustStatusMock.mockResolvedValue(trustStatus("/repos/keiko", "trusted"));
    renderWorkbench(
      liveState(),
      actions(),
      undefined,
      activeWorkspaceWithBinding("/repos/keiko", "/repos/keiko"),
    );

    await waitFor(() => expect(trustStatusMock).toHaveBeenCalledWith("/repos/keiko"));
    expect(
      screen.queryByRole("button", { name: /Allow package scripts/u }),
    ).not.toBeInTheDocument();
  });

  it("renders no affordance while no workspace is bound", () => {
    renderWorkbench(liveState());

    expect(trustStatusMock).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: /Allow package scripts/u }),
    ).not.toBeInTheDocument();
  });
});

describe("CodingWorkbenchWindow run workspace attribution", () => {
  const WORKSPACE_A = { root: "/worktrees/task-a", branch: "issue/aaa", id: "workspace-a" };
  const WORKSPACE_B = { root: "/worktrees/task-b", branch: "issue/bbb", id: "workspace-b" };

  function workspaceApi(workspace: {
    root: string;
    branch: string;
    id: string;
  }): ActiveWorkspaceApi {
    return activeWorkspaceWithBinding("/repos/keiko", workspace.root, {
      workspaceId: workspace.id,
      taskBranch: workspace.branch,
    });
  }

  /** The runtime state while the shell's pointer names `workspace`: the runtime's own workspace
   * projection follows that pointer, exactly as `useCodingWorkbenchWorkspaceEffect` makes it. */
  function stateIn(
    workspace: { root: string; branch: string; id: string },
    run: Partial<CodingWorkbenchRuntimeSnapshot> | null = null,
  ): CodingWorkbenchRuntimeState {
    return liveState({
      ...(run === null
        ? {}
        : { run: { status: "ready" as const, value: snapshot(run), error: null } }),
      workspace: {
        status: "ready",
        error: null,
        value: {
          workspaceId: workspace.id,
          taskId: workspace.id,
          taskBranch: workspace.branch,
          health: "healthy",
          switching: false,
        },
      },
    });
  }

  /** Start a run in workspace A, then move the singleton pointer to B while it is still live. */
  async function startInAThenSwitchToB(
    liveActions: CodingWorkbenchRuntimeActions,
    onOpenGit: (target: CodingWorkbenchGitTarget) => void,
  ): Promise<void> {
    const user = userEvent.setup();
    runtimeHookMock.mockReturnValue({ state: stateIn(WORKSPACE_A), actions: liveActions });
    const window = <CodingWorkbenchWindow selectedRoot={undefined} onOpenGit={onOpenGit} />;
    const view = render(
      <ActiveWorkspaceProvider value={workspaceApi(WORKSPACE_A)}>{window}</ActiveWorkspaceProvider>,
    );
    await user.type(screen.getByLabelText("Task instructions"), "Repair the failing gate");
    await user.click(screen.getByRole("button", { name: "Start coding run" }));

    // The Start response lands only now — after the operator switched the pointer to B.
    runtimeHookMock.mockReturnValue({
      state: stateIn(WORKSPACE_B, { state: "running", runId: "run-1" }),
      actions: liveActions,
    });
    view.rerender(
      <ActiveWorkspaceProvider value={workspaceApi(WORKSPACE_B)}>{window}</ActiveWorkspaceProvider>,
    );
  }

  it("keeps the composer, context bar and Git target on the run's own workspace", async () => {
    const onOpenGit = vi.fn();
    await startInAThenSwitchToB(actions(), onOpenGit);

    expect(screen.getByRole("button", { name: "Manage repository task-a" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Manage repository task-b" })).toBeNull();
    expect(
      screen.getByRole("button", { name: `Manage branch ${WORKSPACE_A.branch}` }),
    ).toBeInTheDocument();
    expect(screen.getByText(`workspace-a · ${WORKSPACE_A.branch} · healthy`)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(WORKSPACE_B.branch, "u"))).toBeNull();

    await userEvent.setup().click(screen.getByRole("button", { name: "Manage repository task-a" }));
    expect(onOpenGit).toHaveBeenCalledWith({
      root: WORKSPACE_A.root,
      binding: "task-workspace",
    });
  });

  it("surfaces the workspace mismatch instead of leaving the inert panels unexplained", async () => {
    await startInAThenSwitchToB(actions(), vi.fn());

    expect(
      screen.getByText(/This run keeps the authority of the workspace it started in/u),
    ).toBeInTheDocument();
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it("states no mismatch while the pointer still names the run's workspace", async () => {
    const liveActions = actions();
    const user = userEvent.setup();
    runtimeHookMock.mockReturnValue({ state: stateIn(WORKSPACE_A), actions: liveActions });
    const window = <CodingWorkbenchWindow selectedRoot={undefined} />;
    const view = render(
      <ActiveWorkspaceProvider value={workspaceApi(WORKSPACE_A)}>{window}</ActiveWorkspaceProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Start coding run" }));
    runtimeHookMock.mockReturnValue({
      state: stateIn(WORKSPACE_A, { state: "running", runId: "run-1" }),
      actions: liveActions,
    });
    view.rerender(
      <ActiveWorkspaceProvider value={workspaceApi(WORKSPACE_A)}>{window}</ActiveWorkspaceProvider>,
    );

    expect(
      screen.queryByText(/This run keeps the authority of the workspace it started in/u),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Manage repository task-a" })).toBeInTheDocument();
  });

  it("binds the editor bridge to the root the run was submitted against", async () => {
    await startInAThenSwitchToB(actions(), vi.fn());

    const lastCall = editorBridgeHookMock.mock.calls.at(-1) as [{ submittedRoot: string | null }];
    expect(lastCall[0].submittedRoot).toBe(WORKSPACE_A.root);
  });
});

// Epic #3384 cascade, end-to-end run 2026-09-05: the activity feed used to show "Reconnect
// activity" and stay disconnected even once a different run started, until the operator clicked
// Reconnect (or reloaded the page). `useCodingWorkbenchSafeActivity` is fully mocked in this file
// (its own reconnect/resync behaviour is pinned at the hook level), so these tests prove the ONE
// thing this window itself owns: calling `activity.retry()` exactly when a new run id appears.
describe("CodingWorkbenchWindow reconnects activity on a newly observed run (#3384 cascade)", () => {
  function runningState(runId: string): CodingWorkbenchRuntimeState {
    return liveState({
      run: { status: "ready", value: snapshot({ state: "running", runId }), error: null },
    });
  }

  it("reconnects the activity stream once a new run id appears, without a manual click", async () => {
    const retry = vi.fn();
    activityHookMock.mockReturnValue({
      status: "disconnected",
      feed: null,
      errorCode: null,
      retry,
    });
    runtimeHookMock.mockReturnValue({ state: liveState(), actions: actions() });
    const view = render(<CodingWorkbenchWindow selectedRoot={undefined} />);
    expect(retry).not.toHaveBeenCalled();

    runtimeHookMock.mockReturnValue({ state: runningState("run-1"), actions: actions() });
    view.rerender(<CodingWorkbenchWindow selectedRoot={undefined} />);

    await waitFor(() => {
      expect(retry).toHaveBeenCalledTimes(1);
    });
  });

  it("does not reconnect again while the same run id stays current", () => {
    const retry = vi.fn();
    activityHookMock.mockReturnValue({ status: "live", feed: null, errorCode: null, retry });
    runtimeHookMock.mockReturnValue({ state: runningState("run-1"), actions: actions() });
    const view = render(<CodingWorkbenchWindow selectedRoot={undefined} />);
    expect(retry).not.toHaveBeenCalled();

    // An unrelated re-render (e.g. a runtime event) that keeps the SAME run id must not retry.
    runtimeHookMock.mockReturnValue({ state: runningState("run-1"), actions: actions() });
    view.rerender(<CodingWorkbenchWindow selectedRoot={undefined} />);

    expect(retry).not.toHaveBeenCalled();
  });

  it("reconnects again for a second new run id after a run stops", async () => {
    const retry = vi.fn();
    activityHookMock.mockReturnValue({ status: "ended", feed: null, errorCode: null, retry });
    runtimeHookMock.mockReturnValue({ state: runningState("run-1"), actions: actions() });
    const view = render(<CodingWorkbenchWindow selectedRoot={undefined} />);

    runtimeHookMock.mockReturnValue({ state: runningState("run-2"), actions: actions() });
    view.rerender(<CodingWorkbenchWindow selectedRoot={undefined} />);

    await waitFor(() => {
      expect(retry).toHaveBeenCalledTimes(1);
    });
  });
});

// Epic #3384 cascade, end-to-end run 2026-09-05: a refused edit used to leave the operator with
// nothing but the model asking "how would you like to proceed?" while every edit kept failing
// NO_ACTIVE_SESSION. `useCodingWorkbenchEditorBridge` is fully mocked here (its own retry behaviour
// is pinned at the hook level); this proves the window actually surfaces `bridgeUnavailable`.
describe("CodingWorkbenchWindow editor bridge unavailable notice (#3384 cascade)", () => {
  it("shows the reconnecting notice while the editor bridge cannot register", () => {
    editorBridgeHookMock.mockReturnValue({
      pendingReview: null,
      approve: vi.fn(),
      deny: vi.fn(),
      retry: vi.fn(),
      bridgeUnavailable: true,
    });
    renderWorkbench(
      liveState({
        run: {
          status: "ready",
          value: snapshot({ state: "running", runId: "run-1" }),
          error: null,
        },
      }),
    );

    expect(
      screen.getByText("Edits are paused: reconnecting the editor bridge."),
    ).toBeInTheDocument();
  });

  it("stays silent while the editor bridge is registered", () => {
    renderWorkbench(
      liveState({
        run: {
          status: "ready",
          value: snapshot({ state: "running", runId: "run-1" }),
          error: null,
        },
      }),
    );

    expect(screen.queryByText("Edits are paused: reconnecting the editor bridge.")).toBeNull();
  });
});

// #3389 AC3: the Workbench window builds `onProposeReady`/`markReadyAvailable` from
// `createPrMarkReadyProposeHandler` (CodingWorkbenchJourneyOutcome.tsx), computed from the same
// observed `JourneyOutcome` the journey card renders — never a re-derived request shape.
describe("CodingWorkbenchWindow #3389 mark-ready propose control", () => {
  // The fixture's readiness/description observations carry fixed timestamps (`_ciReadinessTestSupport`,
  // 2026-09-05T00:00:00Z + a 60s freshness window); pinning `Date.now()` inside that window is what
  // keeps the journey card's "ready" state (not "stale") reproducible independent of wall-clock time.
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-09-05T00:00:05.000Z").getTime());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderWithJourney(snapshotValue: CodingWorkbenchRuntimeSnapshot): void {
    renderWorkbench(
      liveState({ run: { status: "ready", error: null, value: snapshotValue } }),
      actions(),
      undefined,
      activeWorkspaceWithBinding("/repos/keiko-checkout", "/repos/keiko-checkout"),
    );
  }

  it("keeps the control closed and calls no mutation endpoint while the mark-ready path is unavailable", async () => {
    journeyRefreshMock.mockResolvedValue({ status: "unavailable", reason: "no-observation" });
    renderWithJourney(journeyFixture().snapshot);

    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Issue handoff" })).not.toBeInTheDocument(),
    );
    expect(markReadyApproveMock).not.toHaveBeenCalled();
    expect(markReadyExecuteMock).not.toHaveBeenCalled();
  });

  it("clicking the available control mints then executes exactly once each, never a merge/close endpoint", async () => {
    const { outcome, snapshot: snapshotValue } = journeyFixture();
    journeyRefreshMock.mockResolvedValue({ status: "observed", outcome });
    markReadyApproveMock.mockResolvedValueOnce({
      schemaVersion: "1",
      approval: { schemaVersion: "1", approvalId: "approval-1", approvalToken: "token-1" },
      expiresAt: "2026-09-05T00:05:00.000Z",
    });
    markReadyExecuteMock.mockResolvedValueOnce({
      schemaVersion: "1",
      actionKind: "pr-mark-ready",
      status: "succeeded",
    });
    renderWithJourney(snapshotValue);

    const button = await screen.findByRole("button", { name: "Review ready-for-review request" });
    expect(button).toBeEnabled();

    await userEvent.setup().click(button);

    await waitFor(() => expect(markReadyExecuteMock).toHaveBeenCalledTimes(1));
    expect(markReadyApproveMock).toHaveBeenCalledTimes(1);
    expect(markReadyExecuteMock).toHaveBeenCalledTimes(1);
    expect(mergeExecuteMock).not.toHaveBeenCalled();
    expect(prUpdateExecuteMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /merge|close issue/iu })).not.toBeInTheDocument();
  });
});
