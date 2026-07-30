import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UNVERIFIED_GATEWAY } from "@oscharko-dev/keiko-contracts";
import type {
  AvailableCodingSafeActivityFeed,
  CodingWorkbenchRuntimeSnapshot,
  CodingWorkbenchRuntimeSseEvent,
} from "@oscharko-dev/keiko-contracts";
import type { CodingWorkbenchRuntimeActions } from "@/lib/useCodingWorkbenchRuntime";
import type { UseCodingWorkbenchQuestionsResult } from "@/lib/useCodingWorkbenchQuestions";
import type { UseCodingWorkbenchSafeActivityResult } from "@/lib/useCodingWorkbenchSafeActivity";
import {
  createInitialCodingWorkbenchRuntimeState,
  type CodingWorkbenchRuntimeState,
} from "@/lib/coding-workbench-live-state";
import type { ProjectWithAvailability } from "@/lib/types";
import { CodingWorkbenchWindow } from "./CodingWorkbenchWindow";

const runtimeHookMock = vi.hoisted(() => vi.fn());
const questionsHookMock = vi.hoisted(() => vi.fn());
const activityHookMock = vi.hoisted(() => vi.fn());
const researchHookMock = vi.hoisted(() => vi.fn());
const autonomyHookMock = vi.hoisted(() => vi.fn());
const chatCatalogMock = vi.hoisted(() => ({
  activeProject: undefined as ProjectWithAvailability | undefined,
  projects: [] as ProjectWithAvailability[],
}));

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

vi.mock("../../hooks/useAutonomyModePolicy", () => ({
  useAutonomyModePolicy: autonomyHookMock,
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
  render(
    <CodingWorkbenchWindow
      selectedRoot={
        chatCatalogMock.activeProject?.available === true
          ? chatCatalogMock.activeProject.path
          : undefined
      }
    />,
  );
  return liveActions;
}

describe("CodingWorkbenchWindow", () => {
  beforeEach(() => {
    chatCatalogMock.activeProject = undefined;
    chatCatalogMock.projects = [];
    questionsHookMock.mockReturnValue(EMPTY_QUESTIONS);
    activityHookMock.mockReturnValue(IDLE_ACTIVITY);
    researchHookMock.mockReturnValue({ status: "idle", ask: null, grant: null });
    autonomyHookMock.mockReturnValue({
      requestedMode: "supervised-coding",
      effectiveMode: "supervised-coding",
      deploymentCeiling: "autonomous-delivery",
      pending: false,
      error: null,
      change: vi.fn(),
    });
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

  it("renders only live server-confirmed readiness and starts with transient task intent", async () => {
    const user = userEvent.setup();
    const liveActions = renderWorkbench();

    expect(screen.getByRole("heading", { name: "Coding Workbench" })).toBeInTheDocument();
    expect(screen.getByText("task-1 · issue/2257 · healthy")).toBeInTheDocument();
    expect(screen.getByText("Keiko Gateway")).toBeInTheDocument();
    expect(screen.getByText("Ask for approval")).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /Full access/u })).not.toBeInTheDocument();
    expect(screen.queryByText(/Issue #1990|marketing|preview/u)).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Task instructions"), "Investigate the failing test");
    await user.click(screen.getByRole("button", { name: "Start coding run" }));
    expect(liveActions.start).toHaveBeenCalledWith("Investigate the failing test");
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

    expect(screen.queryByText("Ready to start")).not.toBeInTheDocument();
    expect(screen.getByText("Not ready to start")).toBeInTheDocument();
    // The model-source context line must not present the unavailable gateway as a healthy source.
    expect(screen.getByText(/Keiko Gateway — Unavailable/u)).toBeInTheDocument();
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
    expect(screen.getByText("task-1 · issue/2257 · drifted")).toBeInTheDocument();
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
    });
    renderWorkbench(egressApprovalState());

    const destination = screen.getByRole("group", { name: "Research destination" });
    expect(destination).toHaveTextContent("nodejs.org");
    expect(destination).toHaveTextContent("/docs/latest/api/stream.html backpressure");
    // The destination is reviewable text, never a live link that reviewing could follow.
    expect(destination.querySelector("a")).toBeNull();
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it("#2387: says the destination is unavailable rather than implying there is none", () => {
    researchHookMock.mockReturnValue({ status: "unavailable", ask: null, grant: null });
    renderWorkbench(egressApprovalState());

    expect(screen.getByText(/Destination unavailable\. Re-pair this window/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve once" })).toBeInTheDocument();
  });

  it("#2387: shows no destination block for an approval that is not network egress", () => {
    researchHookMock.mockReturnValue({ status: "idle", ask: null, grant: null });
    renderWorkbench(egressApprovalState("delivery-substrate"));

    expect(screen.queryByText("Research destination")).not.toBeInTheDocument();
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
    expect(screen.getByRole("heading", { name: "Live activity timeline" })).toHaveFocus();
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
    researchHookMock.mockReturnValue({ status: "ready", ask: null, grant });
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
