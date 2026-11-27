// Regression pin for release-audit finding F-09a (#2835 follow-up): a rejected
// POST /api/coding-workbench/runtime/runs (e.g. 403 CODING_RUNTIME_AUTHORITY_RESOLUTION_FAILED
// after server-side workspace-lifecycle state loss) must surface a visible, actionable error in
// the Workbench — never a dead "Start coding run" button. This suite runs the REAL runtime hook
// stack (useCodingWorkbenchRuntime → mutation queue → reducer → visibleAlert) against a stubbed
// fetch, exactly the layer the silent failure lived in.

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { resetSupportReportOutcomesForTests } from "../../SupportReportButton";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import { isCodingWorkbenchModel } from "@oscharko-dev/keiko-contracts/runtime/gateway";
import type { ChatSessionCatalog } from "../../context/ChatSessionContext";
import type { UseCodingWorkbenchQuestionsResult } from "@/lib/useCodingWorkbenchQuestions";
import type { UseCodingWorkbenchSafeActivityResult } from "@/lib/useCodingWorkbenchSafeActivity";
import { CodingWorkbenchWindow } from "./CodingWorkbenchWindow";

const reportApi = vi.hoisted(() => {
  let release = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release, imports: 0, create: vi.fn() };
});
const createSupportReport = reportApi.create;
vi.mock("@/lib/support-report-api", async (importOriginal) => {
  reportApi.imports += 1;
  await reportApi.ready;
  return {
    ...(await importOriginal<typeof import("@/lib/support-report-api")>()),
    createSupportReport: reportApi.create,
    createSupportReportDownload: vi.fn(() => ({ href: "blob:keiko-report", dispose: vi.fn() })),
  };
});

const questionsHookMock = vi.hoisted(() => vi.fn());
const activityHookMock = vi.hoisted(() => vi.fn());
const researchHookMock = vi.hoisted(() => vi.fn());
const autonomyHookMock = vi.hoisted(() => vi.fn());
const editorBridgeHookMock = vi.hoisted(() => vi.fn());
const activeWorkspaceHookMock = vi.hoisted(() => vi.fn());
const catalogHookMock = vi.hoisted(() => vi.fn());

vi.mock("../../context/ChatSessionContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../context/ChatSessionContext")>();
  return { ...actual, useOptionalChatSessionCatalog: catalogHookMock };
});

// The Workbench reads the Git repository catalog for its repository selector. This suite is about
// the rejected start, so the catalog lists the bound repository as available, and the selector adds
// no alert of its own.
vi.mock("./codingWorkbenchRepositories", () => ({
  repositorySelectable: (): Promise<boolean> => Promise.resolve(true),
  selectableRepositories: (): Promise<readonly unknown[]> =>
    Promise.resolve([
      {
        id: "repo-1",
        name: "repo",
        path: "/repo/.keiko-task-workspaces/ws-1",
        available: true,
        workspaceAvailable: true,
      },
    ]),
}));
// The selector reads the bound repository's branches; this suite answers them as a Git repository so
// the selector raises no alert of its own beside the rejected start.
vi.mock("../../hooks/useRepositoryBranchState", () => ({
  useRepositoryBranchState: (root: string | null): unknown => ({
    root,
    response: null,
    loading: false,
    error: null,
    branches: [],
    currentBranch: root === null ? null : "issue/2835",
    refresh: (): Promise<void> => Promise.resolve(),
  }),
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

vi.mock("@/lib/useCodingWorkbenchEditorBridge", () => ({
  useCodingWorkbenchEditorBridge: editorBridgeHookMock,
}));

vi.mock("../../hooks/useAutonomyModePolicy", () => ({
  useAutonomyModePolicy: autonomyHookMock,
}));

vi.mock("../../context/ActiveWorkspaceContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../context/ActiveWorkspaceContext")>();
  return { ...actual, useOptionalActiveWorkspace: activeWorkspaceHookMock };
});

const AT = "2026-07-13T12:00:00.000Z";
const CORRELATION_ID = "ui-f09a-correlation";

function codingModel(): ModelCapability {
  return {
    id: "gpt-5.4",
    kind: "chat",
    conversationReady: true,
    contextWindow: 100_000,
    maxOutputTokens: 16_000,
    toolCalling: true,
    toolCallingVerification: {
      status: "verified",
      checkedAt: new Date().toISOString(),
      probe: "gateway-tool-calling-v1",
      configurationFingerprint: "f09a-test-configuration",
    },
    structuredOutput: true,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: true,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "test fixture",
    preferredUseCases: ["Coding"],
    knownLimitations: [],
  };
}

function readyCatalog(): ChatSessionCatalog {
  return {
    projects: [],
    chats: [],
    models: [codingModel()],
    configuredModelIds: ["gpt-5.4"],
    activeProject: undefined,
    activeChat: undefined,
    selectedModel: "gpt-5.4",
    noEligibleModels: false,
    loading: false,
    error: undefined,
  };
}

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

// The client context after a browser reload restores a bound workspace view.
function boundActiveWorkspace(): unknown {
  return {
    instances: [],
    activeBinding: {
      workspaceId: "ws-1",
      taskId: "task-1",
      repositoryId: "repo-1",
      activeRoot: "/repo/.keiko-task-workspaces/ws-1",
      boundAt: AT,
    },
    activeInstance: {
      workspaceId: "ws-1",
      taskId: "task-1",
      repositoryId: "repo-1",
      repositoryRoot: "/repo/.keiko-task-workspaces/ws-1",
      baseBranch: "issue/2835",
      taskBranch: "issue/2835",
      executionLocation: "worktree",
      state: "active",
      health: "healthy",
      managedRoot: "/repo/.keiko-task-workspaces/ws-1",
      createdAt: AT,
      updatedAt: AT,
    },
    activeRoot: "/repo/.keiko-task-workspaces/ws-1",
    loading: false,
    switching: false,
    error: null,
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Keiko-Correlation-Id": CORRELATION_ID,
    },
  });
}

function idleSnapshot(): unknown {
  return { schemaVersion: "1", state: "idle", revision: 0, updatedAt: AT };
}

function readiness(): unknown {
  return {
    schemaVersion: "1",
    requestedMode: "supervised-coding",
    deploymentCeiling: "autonomous-delivery",
    effectiveMode: "supervised-coding",
    runtimeAvailable: true,
    runtimeEvidenceClass: "platform-qualified",
    selectableAgents: ["build"],
  };
}

function sidecarProfile(): unknown {
  return {
    status: "available",
    profileId: "profile-1",
    modelAlias: "gpt-5.4",
    localEndpointPath: "/api/coding-sidecar/gateway",
    supportsStreaming: true,
    supportsToolCalling: true,
    runMetadata: {
      maxPromptTokens: 100_000,
      maxOutputTokens: 16_000,
      maxInputMessages: 100,
      maxRequestBytes: 1_000_000,
    },
    // F-01: this suite drives Start, which requires a source whose last probe did not fail. The BFF
    // always reports a verification state, so the stub does too.
    verification: "verified",
  };
}

// U-14: another paired window of the same installation already runs a task. The start is refused
// as an active-run conflict and the next status read shows the other window's run. The two windows
// share one private draft: either it refuses this window's save (a stale revision), or it saves and
// then hands back the text the other window left, an empty one.
const otherWindowRun = {
  active: false,
  started: false,
  draft: "conflict" as "conflict" | "replaced",
};

function otherWindowDraftResponse(method: string, body: string): Response {
  if (otherWindowRun.draft === "conflict") {
    return method === "PUT"
      ? jsonResponse(409, { error: { code: "DRAFT_CONFLICT", message: "Draft revision stale." } })
      : jsonResponse(200, { text: "", revision: 3 });
  }
  if (method === "PUT") {
    const saved = JSON.parse(body) as { text: string };
    return jsonResponse(200, { text: saved.text, revision: 4 });
  }
  return jsonResponse(200, { text: "", revision: otherWindowRun.started ? 5 : 3 });
}

function otherWindowStatusResponse(): Response {
  return jsonResponse(200, {
    schemaVersion: "1",
    state: "running",
    runId: "run-other-window",
    revision: 5,
    updatedAt: AT,
    requestedMode: "supervised-coding",
    effectiveMode: "supervised-coding",
  });
}

function otherWindowRunResponse(url: string, init: RequestInit | undefined): Response | undefined {
  if (!otherWindowRun.active) return undefined;
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "POST" && url.endsWith("/api/coding-workbench/runtime/runs")) {
    otherWindowRun.started = true;
    return jsonResponse(409, {
      error: { code: "CODING_RUNTIME_ACTIVE_RUN_CONFLICT", message: "Run already active." },
    });
  }
  if (url.includes("/api/coding-workbench/drafts/")) {
    return otherWindowDraftResponse(method, typeof init?.body === "string" ? init.body : "");
  }
  const reading = url.includes("/api/coding-workbench/runtime/status");
  return reading && otherWindowRun.started ? otherWindowStatusResponse() : undefined;
}

function routeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const other = otherWindowRunResponse(url, init);
  return other === undefined ? routeBaseFetch(url, init) : Promise.resolve(other);
}

function routeBaseFetch(url: string, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "POST" && url.endsWith("/api/coding-workbench/runtime/runs")) {
    return Promise.resolve(
      jsonResponse(403, {
        error: {
          code: "CODING_RUNTIME_AUTHORITY_RESOLUTION_FAILED",
          message: "Runtime request was rejected.",
        },
      }),
    );
  }
  if (url.includes("/api/coding-workbench/runtime/status")) {
    return Promise.resolve(jsonResponse(200, idleSnapshot()));
  }
  if (url.includes("/api/coding-workbench/runtime/readiness")) {
    return Promise.resolve(jsonResponse(200, readiness()));
  }
  if (url.includes("/api/coding-sidecar/gateway/profile")) {
    return Promise.resolve(jsonResponse(200, sidecarProfile()));
  }
  // F-08/RG-12 pairing dimension: this scenario is a PAIRED window whose start is rejected by the
  // server anyway (workspace-lifecycle state loss) — the honest workspaces read answers paired
  // (no `session: "unpaired"` marker), so readiness arms and the rejected POST stays reachable.
  if (url.endsWith("/api/workspaces")) {
    return Promise.resolve(jsonResponse(200, { session: "paired", manifests: [] }));
  }
  return Promise.resolve(jsonResponse(404, { error: { code: "NOT_FOUND", message: url } }));
}

describe("CodingWorkbenchWindow start failure surfacing (F-09a)", (): void => {
  beforeEach((): void => {
    vi.stubGlobal("fetch", vi.fn(routeFetch));
    questionsHookMock.mockReturnValue(EMPTY_QUESTIONS);
    activityHookMock.mockReturnValue(IDLE_ACTIVITY);
    researchHookMock.mockReturnValue({ status: "idle", ask: null, grant: null });
    editorBridgeHookMock.mockReturnValue({
      pendingReview: null,
      approve: vi.fn(),
      deny: vi.fn(),
      retry: vi.fn(),
    });
    autonomyHookMock.mockReturnValue({
      requestedMode: "supervised-coding",
      effectiveMode: "supervised-coding",
      deploymentCeiling: "autonomous-delivery",
      pending: false,
      error: null,
      change: vi.fn(),
    });
    activeWorkspaceHookMock.mockReturnValue(boundActiveWorkspace());
    const catalog = readyCatalog();
    expect(catalog.models.every(isCodingWorkbenchModel)).toBe(true);
    catalogHookMock.mockReturnValue(catalog);
  });

  afterEach((): void => {
    otherWindowRun.active = false;
    otherWindowRun.started = false;
    otherWindowRun.draft = "conflict";
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetSupportReportOutcomesForTests();
  });

  it("surfaces a rejected start as a visible alert carrying the error code and correlation id", async (): Promise<void> => {
    const user = userEvent.setup();
    render(<CodingWorkbenchWindow />);

    // Readiness resolves from the stubbed server truth; the composer unlocks.
    await user.type(screen.getByLabelText("Task instructions"), "Fix the flaky retry loop");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start coding run" })).toHaveAttribute(
        "data-on",
        "true",
      );
    });

    await user.click(screen.getByRole("button", { name: "Start coding run" }));

    // The rejected start must be visible and actionable: the alert names the runtime error code
    // and the correlation id that ties the UI failure to the redacted server diagnostic.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("CODING_RUNTIME_AUTHORITY_RESOLUTION_FAILED");
    expect(alert).toHaveTextContent(CORRELATION_ID);
    const report = { fileName: "report.json", reportJson: "{}" };
    vi.mocked(createSupportReport).mockResolvedValueOnce(report);
    expect(reportApi.imports).toBe(0);
    await user.click(screen.getByRole("button", { name: "Create error report" }));
    await waitFor(() => expect(reportApi.imports).toBe(1));
    expect(createSupportReport).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Creating report…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await act(async () => reportApi.release());
    await waitFor(() =>
      expect(createSupportReport).toHaveBeenCalledExactlyOnceWith(
        CORRELATION_ID,
        expect.any(AbortSignal),
        { context: [], errorKind: "unknown" },
      ),
    );
    expect(await screen.findByRole("link", { name: "Download report" })).toHaveAttribute(
      "download",
      report.fileName,
    );
    expect(screen.getByRole("link", { name: "Download report" })).toHaveAttribute(
      "href",
      "blob:keiko-report",
    );
  });

  function draftCalls(method: "GET" | "PUT"): number {
    return vi
      .mocked(fetch)
      .mock.calls.filter(
        ([url, init]) =>
          String(url).includes("/api/coding-workbench/drafts/") &&
          (init?.method ?? "GET") === method,
      ).length;
  }

  async function startRefusedByOtherWindow(task: string): Promise<void> {
    otherWindowRun.active = true;
    const user = userEvent.setup();
    render(<CodingWorkbenchWindow draftKey="coding" />);
    await user.type(screen.getByLabelText("Task instructions"), task);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start coding run" })).toHaveAttribute(
        "data-on",
        "true",
      );
    });
    await user.click(screen.getByRole("button", { name: "Start coding run" }));
    await waitFor(() => expect(otherWindowRun.started).toBe(true));
    // The next status read adopts the other window's run: its Stop control replaces Start.
    await screen.findByRole("button", { name: "Stop run" });
  }

  it("keeps the typed task and says why when another window's run refuses the start (U-14)", async (): Promise<void> => {
    const task = "Fix the flaky retry loop";
    await startRefusedByOtherWindow(task);

    expect(
      screen.getByText(/Another coding run is already active in this installation/u),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Task instructions")).toHaveValue(task);
  });

  it("puts the task back when the shared draft hands back the other window's empty text (U-14)", async (): Promise<void> => {
    otherWindowRun.draft = "replaced";
    const task = "Fix the flaky retry loop";
    await startRefusedByOtherWindow(task);

    // The shared draft saves the task, then the next read hands back the other window's empty text.
    await waitFor(() => expect(draftCalls("PUT")).toBe(1));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    // The kept task is put back and saved again.
    await waitFor(() => expect(draftCalls("PUT")).toBe(2), { timeout: 4_000 });
    expect(screen.getByLabelText("Task instructions")).toHaveValue(task);
  });

  it("shows a run another window started as soon as the person returns to this window (U-14)", async (): Promise<void> => {
    otherWindowRun.active = true;
    render(<CodingWorkbenchWindow />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start coding run" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Stop run" })).not.toBeInTheDocument();

    // The other window starts its run; this one is told nothing until the person comes back.
    otherWindowRun.started = true;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(await screen.findByRole("button", { name: "Stop run" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start coding run" })).not.toBeInTheDocument();
  });

  it("lets the person clear the kept task on purpose (U-14)", async (): Promise<void> => {
    otherWindowRun.draft = "replaced";
    await startRefusedByOtherWindow("Fix the flaky retry loop");

    await userEvent.setup().clear(screen.getByLabelText("Task instructions"));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Task instructions")).toHaveValue("");
    });
  });
});
