// Unit tests for the active-workspace binding state machine (Issue #446). Drives the reducer through
// refresh/switchTo/pause/error against a routed fetch stub and asserts the atomic settle behavior:
// the bound active root only changes once the post-mutation reload lands, and errors are surfaced
// without dropping the previous binding.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceBinding, WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import { useActiveWorkspaceState } from "./useActiveWorkspaceState";

function instance(workspaceId: string, root: string): WorkspaceInstance {
  return {
    schemaVersion: "1",
    workspaceId,
    taskId: workspaceId,
    repositoryId: "repo",
    repositoryRoot: "/repo",
    baseBranch: "main",
    taskBranch: `keiko/${workspaceId}`,
    managedWorktreePath: root,
    gitdirIdentity: "g",
    lifecycleState: "active",
    health: "healthy",
    lock: null,
    createdAt: "t",
    updatedAt: "t",
    driftMarkers: [],
    recoveryHints: [],
    auditCorrelationId: workspaceId,
  };
}

function binding(workspaceId: string, root: string): WorkspaceBinding {
  return {
    schemaVersion: "1",
    workspaceId,
    taskId: workspaceId,
    activeRoot: root,
    boundSurfaces: ["editor", "files", "terminal", "git-delivery"],
    gitDeliveryRoot: root,
    editorProjectRoot: root,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface RouterState {
  active: { instance: WorkspaceInstance; binding: WorkspaceBinding; pointer: unknown } | null;
  instances: readonly WorkspaceInstance[];
}

// A stateful fetch router so a switch is observable through a subsequent getActive reload.
function installRouter(state: RouterState): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.startsWith("/api/task-workspaces/active") && method === "GET") {
      return Promise.resolve(json({ active: state.active }));
    }
    if (url.startsWith("/api/task-workspaces?") && method === "GET") {
      return Promise.resolve(json({ instances: state.instances }));
    }
    if (url === "/api/task-workspaces/active" && method === "POST") {
      const { workspaceId } = JSON.parse(init?.body as string) as { workspaceId: string };
      const target = state.instances.find((i) => i.workspaceId === workspaceId);
      if (target !== undefined) {
        state.active = {
          instance: target,
          binding: binding(workspaceId, target.managedWorktreePath),
          pointer: {},
        };
      }
      return Promise.resolve(json({ instance: target, binding: state.active?.binding }));
    }
    if (url === "/api/task-workspaces/active" && method === "DELETE") {
      state.active = null;
      return Promise.resolve(json({ active: null }));
    }
    return Promise.resolve(json({}, 404));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useActiveWorkspaceState", () => {
  it("refresh loads the inventory and active binding", async () => {
    installRouter({ active: null, instances: [instance("ws-1", "/wt/1")] });
    const { result } = renderHook(() => useActiveWorkspaceState());
    await act(async () => {
      await result.current.refresh("/repo");
    });
    expect(result.current.instances).toHaveLength(1);
    expect(result.current.activeRoot).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("switchTo binds the active root atomically after the reload settles", async () => {
    installRouter({
      active: null,
      instances: [instance("ws-1", "/wt/1"), instance("ws-2", "/wt/2")],
    });
    const { result } = renderHook(() => useActiveWorkspaceState());
    await act(async () => {
      await result.current.refresh("/repo");
    });
    await act(async () => {
      await result.current.switchTo("ws-2");
    });
    expect(result.current.activeRoot).toBe("/wt/2");
    expect(result.current.activeInstance?.workspaceId).toBe("ws-2");
    expect(result.current.switching).toBe(false);
  });

  it("ignores a stale refresh response after a newer root has settled", async () => {
    const repoA = deferred<Response>();
    const repoB = deferred<Response>();
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.startsWith("/api/task-workspaces/active") && method === "GET") {
        return Promise.resolve(json({ active: null }));
      }
      if (url.startsWith("/api/task-workspaces?") && method === "GET") {
        const root = new URL(url, "http://keiko.local").searchParams.get("root");
        if (root === "/repo-a") return repoA.promise;
        if (root === "/repo-b") return repoB.promise;
      }
      return Promise.resolve(json({}, 404));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useActiveWorkspaceState());

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.refresh("/repo-a");
    });
    act(() => {
      second = result.current.refresh("/repo-b");
    });

    await act(async () => {
      repoB.resolve(json({ instances: [instance("ws-b", "/wt/b")] }));
      await second;
    });
    expect(result.current.instances.map((item) => item.workspaceId)).toEqual(["ws-b"]);

    await act(async () => {
      repoA.resolve(json({ instances: [instance("ws-a", "/wt/a")] }));
      await first;
    });
    expect(result.current.instances.map((item) => item.workspaceId)).toEqual(["ws-b"]);
  });

  it("ignores a stale mutation reload after a newer switch has settled", async () => {
    const postWs1 = deferred<Response>();
    const postWs2 = deferred<Response>();
    const state: RouterState = {
      active: null,
      instances: [instance("ws-1", "/wt/1"), instance("ws-2", "/wt/2")],
    };
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.startsWith("/api/task-workspaces/active") && method === "GET") {
        return Promise.resolve(json({ active: state.active }));
      }
      if (url.startsWith("/api/task-workspaces?") && method === "GET") {
        return Promise.resolve(json({ instances: state.instances }));
      }
      if (url === "/api/task-workspaces/active" && method === "POST") {
        const { workspaceId } = JSON.parse(init?.body as string) as { workspaceId: string };
        const target = state.instances.find((item) => item.workspaceId === workspaceId);
        const response = workspaceId === "ws-1" ? postWs1 : postWs2;
        return response.promise.then(() => {
          if (target !== undefined) {
            state.active = {
              instance: target,
              binding: binding(workspaceId, target.managedWorktreePath),
              pointer: {},
            };
          }
          return json({ instance: target, binding: state.active?.binding });
        });
      }
      return Promise.resolve(json({}, 404));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useActiveWorkspaceState());
    await act(async () => {
      await result.current.refresh("/repo");
    });

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.switchTo("ws-1");
    });
    act(() => {
      second = result.current.switchTo("ws-2");
    });

    await act(async () => {
      postWs2.resolve(json({}));
      await second;
    });
    expect(result.current.activeRoot).toBe("/wt/2");

    await act(async () => {
      postWs1.resolve(json({}));
      await first;
    });
    expect(result.current.activeRoot).toBe("/wt/2");
  });

  it("clearActive returns to unbound mode", async () => {
    installRouter({ active: null, instances: [instance("ws-1", "/wt/1")] });
    const { result } = renderHook(() => useActiveWorkspaceState());
    await act(async () => {
      await result.current.refresh("/repo");
      await result.current.switchTo("ws-1");
    });
    expect(result.current.activeRoot).toBe("/wt/1");
    await act(async () => {
      await result.current.clearActive();
    });
    expect(result.current.activeRoot).toBeNull();
  });

  it("surfaces an error and preserves the previous binding on failure", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.startsWith("/api/task-workspaces/active") && method === "GET") {
        return Promise.resolve(json({ active: null }));
      }
      if (url.startsWith("/api/task-workspaces?")) {
        return Promise.resolve(json({ instances: [] }));
      }
      return Promise.resolve(json({ error: { code: "LOCK_CONTENTION", message: "locked" } }, 409));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useActiveWorkspaceState());
    await act(async () => {
      await result.current.refresh("/repo");
    });
    await act(async () => {
      await result.current.pause("ws-1");
    });
    await waitFor(() => {
      expect(result.current.error).toBe("locked");
    });
    expect(result.current.switching).toBe(false);
  });
});
