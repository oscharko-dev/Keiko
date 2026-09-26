// Unit tests for the task-workspace-api fetch wrapper (Issue #446). Same shape as terminal-api.test:
// asserts CSRF/Content-Type header injection per method, the request shapes, and error mapping.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import {
  clearActiveTaskWorkspace,
  fetchRepositoryBaseBranch,
  getActiveTaskWorkspace,
  listTaskWorkspaces,
  pauseTaskWorkspace,
  prepareHandoffTaskWorkspace,
  provisionTaskWorkspace,
  reconcileTaskWorkspaces,
  repairTaskWorkspace,
  resumeTaskWorkspace,
  setActiveTaskWorkspace,
} from "./task-workspace-api";

const gitStatusMock = vi.hoisted(() => vi.fn());

// The git status route keeps its own contract validator in ./api; only that one call is replaced so
// the branch-default helper is exercised against the response shapes the validator admits.
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, fetchGitStatus: gitStatusMock };
});

function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function lastInit(fetchMock: ReturnType<typeof vi.fn>): RequestInit {
  const calls = fetchMock.mock.calls;
  return (calls[calls.length - 1] as [string, RequestInit])[1];
}

function lastUrl(fetchMock: ReturnType<typeof vi.fn>): string {
  const calls = fetchMock.mock.calls;
  return (calls[calls.length - 1] as [string, RequestInit])[0];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("header injection", () => {
  it("GET list without a root asks for every managed workspace", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonOk({ instances: [] })));
    vi.stubGlobal("fetch", fetchMock);
    await listTaskWorkspaces();
    expect(lastUrl(fetchMock)).toBe("/api/task-workspaces");
  });

  it("GET list sends no CSRF/Content-Type and encodes the root", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonOk({ instances: [] })));
    vi.stubGlobal("fetch", fetchMock);
    await listTaskWorkspaces("/repo/a");
    const headers = lastInit(fetchMock).headers as Record<string, string>;
    expect(headers["X-Keiko-CSRF"]).toBeUndefined();
    expect(headers["Content-Type"]).toBeUndefined();
    expect(headers.Accept).toBe("application/json");
    expect(lastUrl(fetchMock)).toContain("root=%2Frepo%2Fa");
  });

  it("POST setActive includes CSRF + JSON Content-Type and the body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonOk({ instance: {}, binding: {} }));
    vi.stubGlobal("fetch", fetchMock);
    await setActiveTaskWorkspace({ workspaceId: "ws-1", requestedBy: "op" });
    const init = lastInit(fetchMock);
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Keiko-CSRF"]).toBe("1");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ workspaceId: "ws-1", requestedBy: "op" });
    expect(lastUrl(fetchMock)).toBe("/api/task-workspaces/active");
  });

  it("DELETE clear targets the active route with CSRF", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await clearActiveTaskWorkspace();
    expect(lastInit(fetchMock).method).toBe("DELETE");
    expect((lastInit(fetchMock).headers as Record<string, string>)["X-Keiko-CSRF"]).toBe("1");
  });

  it("pause/resume/handoff encode the workspace id in the path", async () => {
    // A fresh Response per call — a Response body can only be read once.
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonOk({ instance: {}, binding: {} })));
    vi.stubGlobal("fetch", fetchMock);
    await pauseTaskWorkspace({ workspaceId: "ws/1", requestedBy: "op" });
    expect(lastUrl(fetchMock)).toBe("/api/task-workspaces/ws%2F1/pause");
    await resumeTaskWorkspace({ workspaceId: "ws-2", requestedBy: "op" });
    expect(lastUrl(fetchMock)).toBe("/api/task-workspaces/ws-2/resume");
    await prepareHandoffTaskWorkspace({ workspaceId: "ws-3", requestedBy: "op" });
    expect(lastUrl(fetchMock)).toBe("/api/task-workspaces/ws-3/handoff");
  });

  it("provision posts to the collection route with the full body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonOk({ instance: {}, binding: {}, created: true }));
    vi.stubGlobal("fetch", fetchMock);
    await provisionTaskWorkspace({
      root: "/repo",
      taskId: "t1",
      baseBranch: "dev",
      requestedBy: "op",
    });
    expect(lastUrl(fetchMock)).toBe("/api/task-workspaces");
    expect(JSON.parse(lastInit(fetchMock).body as string)).toEqual({
      root: "/repo",
      taskId: "t1",
      baseBranch: "dev",
      requestedBy: "op",
    });
  });

  it("reconcile posts the root to the reconciliation route and unwraps the report", async () => {
    const report = {
      schemaVersion: "1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      entries: [{ workspaceId: "ws-1", status: "healthy" }],
      activeRestoration: { kind: "none" },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonOk({ report }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await reconcileTaskWorkspaces({ root: "/repo/x" });
    const init = lastInit(fetchMock);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Keiko-CSRF"]).toBe("1");
    expect(lastUrl(fetchMock)).toBe("/api/task-workspaces/reconciliation");
    expect(JSON.parse(init.body as string)).toEqual({ root: "/repo/x" });
    expect(result).toEqual(report);
  });
});

describe("responses", () => {
  it("getActive unwraps the active envelope (null when unbound)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonOk({ active: null }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getActiveTaskWorkspace()).toBeNull();
  });

  it("list unwraps the instances array", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonOk({ instances: [{ workspaceId: "ws-1" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const instances = await listTaskWorkspaces("/repo");
    expect(instances).toHaveLength(1);
  });

  it("maps a non-ok response to an ApiError carrying the server code", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonOk({ error: { code: "ILLEGAL_TRANSITION", message: "no" } }, 409));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      pauseTaskWorkspace({ workspaceId: "ws-1", requestedBy: "op" }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("repairTaskWorkspace", () => {
  it("POSTs the strategy and the explicit approval flag to the workspace's repair route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonOk({
        instance: {},
        binding: {},
        strategy: "reconcile-pointer",
        applied: true,
        outcome: "repaired",
        status: "healthy",
        driftMarkers: [],
        operatorActionRequired: false,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await repairTaskWorkspace({
      workspaceId: "ws/1",
      requestedBy: "op",
      strategy: "reconcile-pointer",
      operatorApproved: true,
    });

    expect(lastUrl(fetchMock)).toBe("/api/task-workspaces/ws%2F1/repair");
    const init = lastInit(fetchMock);
    const headers = init.headers as Record<string, string>;
    expect(init.method).toBe("POST");
    expect(headers["X-Keiko-CSRF"]).toBe("1");
    expect(JSON.parse(init.body as string)).toEqual({
      requestedBy: "op",
      strategy: "reconcile-pointer",
      operatorApproved: true,
    });
    expect(result.applied).toBe(true);
  });

  it("never sets the approval flag on its own", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonOk({ instance: {}, binding: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await repairTaskWorkspace({
      workspaceId: "ws-1",
      requestedBy: "op",
      strategy: "release-stale-lock",
      operatorApproved: false,
    });

    expect(JSON.parse(lastInit(fetchMock).body as string)).toMatchObject({
      operatorApproved: false,
    });
  });

  it("carries the failure class of a refused repair", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonOk(
          {
            error: {
              code: "OPERATOR_APPROVAL_REQUIRED",
              message: "repair requires operator approval",
              failureClass: "policy-denied",
            },
          },
          403,
        ),
      ),
    );

    await expect(
      repairTaskWorkspace({
        workspaceId: "ws-1",
        requestedBy: "op",
        strategy: "reconcile-pointer",
        operatorApproved: false,
      }),
    ).rejects.toMatchObject({
      code: "OPERATOR_APPROVAL_REQUIRED",
      failureClass: "policy-denied",
    });
  });
});

describe("fetchRepositoryBaseBranch", () => {
  afterEach(() => {
    gitStatusMock.mockReset();
  });

  it("returns the checked-out branch of an available repository", async () => {
    gitStatusMock.mockResolvedValue({ available: true, detached: false, branch: " dev " });

    await expect(fetchRepositoryBaseBranch("/repo")).resolves.toBe("dev");
    expect(gitStatusMock).toHaveBeenCalledWith("/repo");
  });

  it.each([
    { label: "an unavailable path", status: { available: false, detached: false } },
    { label: "a detached HEAD", status: { available: true, detached: true, branch: "dev" } },
    { label: "a missing branch", status: { available: true, detached: false } },
    { label: "a blank branch", status: { available: true, detached: false, branch: "  " } },
  ])("resolves null for $label instead of guessing", async ({ status }) => {
    gitStatusMock.mockResolvedValue(status);

    await expect(fetchRepositoryBaseBranch("/repo")).resolves.toBeNull();
  });

  it("propagates a transport failure so the caller can report it", async () => {
    gitStatusMock.mockRejectedValue(new ApiError("INTERNAL", "HTTP 500", 500));

    await expect(fetchRepositoryBaseBranch("/repo")).rejects.toMatchObject({ code: "INTERNAL" });
  });
});

describe("provisionTaskWorkspace — error envelopes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The failure class is read from the envelope only when the envelope has one; a body without an
  // `error` object must still surface as the classified ApiError, never as a TypeError thrown
  // while decorating it (workbench audit, 2026-09-03).
  it("rejects with a plain ApiError when the error body carries no envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(jsonOk({}, 500))),
    );

    const failure: unknown = await provisionTaskWorkspace({
      root: "/repo",
      taskId: "t-1",
      baseBranch: "main",
      requestedBy: "u",
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ code: "INTERNAL", status: 500 });
    expect(Reflect.get(failure as object, "failureClass")).toBeUndefined();
  });
});
