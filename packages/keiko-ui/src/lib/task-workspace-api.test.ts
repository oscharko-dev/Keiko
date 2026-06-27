// Unit tests for the task-workspace-api fetch wrapper (Issue #446). Same shape as terminal-api.test:
// asserts CSRF/Content-Type header injection per method, the request shapes, and error mapping.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import {
  clearActiveTaskWorkspace,
  getActiveTaskWorkspace,
  listTaskWorkspaces,
  pauseTaskWorkspace,
  prepareHandoffTaskWorkspace,
  provisionTaskWorkspace,
  resumeTaskWorkspace,
  setActiveTaskWorkspace,
} from "./task-workspace-api";

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
