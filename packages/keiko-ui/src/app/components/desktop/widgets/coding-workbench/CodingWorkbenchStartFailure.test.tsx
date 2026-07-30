// Regression pin for release-audit finding F-09a (#2835 follow-up): a rejected
// POST /api/coding-workbench/runtime/runs (e.g. 403 CODING_RUNTIME_AUTHORITY_RESOLUTION_FAILED
// after server-side workspace-lifecycle state loss) must surface a visible, actionable error in
// the Workbench — never a dead "Start coding run" button. This suite runs the REAL runtime hook
// stack (useCodingWorkbenchRuntime → mutation queue → reducer → visibleAlert) against a stubbed
// fetch, exactly the layer the silent failure lived in.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UseCodingWorkbenchQuestionsResult } from "@/lib/useCodingWorkbenchQuestions";
import type { UseCodingWorkbenchSafeActivityResult } from "@/lib/useCodingWorkbenchSafeActivity";
import { CodingWorkbenchWindow } from "./CodingWorkbenchWindow";

const questionsHookMock = vi.hoisted(() => vi.fn());
const activityHookMock = vi.hoisted(() => vi.fn());
const researchHookMock = vi.hoisted(() => vi.fn());
const autonomyHookMock = vi.hoisted(() => vi.fn());
const editorBridgeHookMock = vi.hoisted(() => vi.fn());
const activeWorkspaceHookMock = vi.hoisted(() => vi.fn());

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
      taskBranch: "issue/2835",
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
    refresh: vi.fn(() => Promise.resolve()),
    switchTo: vi.fn(() => Promise.resolve()),
    clearActive: vi.fn(() => Promise.resolve()),
    pause: vi.fn(() => Promise.resolve()),
    resume: vi.fn(() => Promise.resolve()),
    prepareHandoff: vi.fn(() => Promise.resolve()),
    provision: vi.fn(() => Promise.resolve()),
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
  };
}

function routeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
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
  return Promise.resolve(jsonResponse(404, { error: { code: "NOT_FOUND", message: url } }));
}

describe("CodingWorkbenchWindow start failure surfacing (F-09a)", () => {
  beforeEach(() => {
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("surfaces a rejected start as a visible alert carrying the error code and correlation id", async () => {
    const user = userEvent.setup();
    render(<CodingWorkbenchWindow />);

    // Readiness resolves from the stubbed server truth; the composer unlocks.
    await screen.findByText("task-1 · issue/2835 · healthy");
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
  });
});
