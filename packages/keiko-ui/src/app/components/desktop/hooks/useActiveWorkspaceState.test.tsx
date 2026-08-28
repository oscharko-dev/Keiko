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

// Content-free reconciliation report for the routed active workspace (F-09b: every active binding
// is re-verified through this pass before any surface may claim it).
function reconciliationReport(
  state: RouterState,
  status: (workspaceId: string) => string,
): unknown {
  const active = state.active;
  return {
    report: {
      entries:
        active === null
          ? []
          : [
              {
                workspaceId: active.instance.workspaceId,
                status: status(active.instance.workspaceId),
              },
            ],
    },
  };
}

function healthyReport(state: RouterState): unknown {
  return reconciliationReport(state, () => "healthy");
}

// The reconciliation POSTs the hook issued — the observable proof that the verification pass
// actually ran for a binding, as opposed to the pointer being claimed as-is.
function reconciliationCount(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter((call: readonly unknown[]) => {
    const method = (call[1] as RequestInit | undefined)?.method ?? "GET";
    return call[0] === "/api/task-workspaces/reconciliation" && method.toUpperCase() === "POST";
  }).length;
}

// A stateful fetch router so a switch is observable through a subsequent getActive reload.
function installRouter(
  state: RouterState,
  reconcileStatus: (workspaceId: string) => string = () => "healthy",
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.startsWith("/api/task-workspaces/active") && method === "GET") {
      return Promise.resolve(json({ active: state.active }));
    }
    if (url === "/api/task-workspaces/reconciliation" && method === "POST") {
      return Promise.resolve(json(reconciliationReport(state, reconcileStatus)));
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
    await act(async (): Promise<void> => {
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
    await act(async (): Promise<void> => {
      await result.current.refresh("/repo");
    });
    await act(async (): Promise<void> => {
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

    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = result.current.refresh("/repo-a");
    });
    act(() => {
      second = result.current.refresh("/repo-b");
    });

    await act(async (): Promise<void> => {
      repoB.resolve(json({ instances: [instance("ws-b", "/wt/b")] }));
      await second;
    });
    expect(result.current.instances.map((item) => item.workspaceId)).toEqual(["ws-b"]);

    await act(async (): Promise<void> => {
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
      if (url === "/api/task-workspaces/reconciliation" && method === "POST") {
        return Promise.resolve(json(healthyReport(state)));
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
    await act(async (): Promise<void> => {
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

    await act(async (): Promise<void> => {
      postWs2.resolve(json({}));
      await second;
    });
    expect(result.current.activeRoot).toBe("/wt/2");

    await act(async (): Promise<void> => {
      postWs1.resolve(json({}));
      await first;
    });
    expect(result.current.activeRoot).toBe("/wt/2");
  });

  it("reloads server truth after a concurrent refresh settles during a mutation", async () => {
    const post = deferred<Response>();
    const target = instance("ws-1", "/wt/1");
    const state: RouterState = { active: null, instances: [target] };
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.startsWith("/api/task-workspaces/active") && method === "GET") {
        return Promise.resolve(json({ active: state.active }));
      }
      if (url === "/api/task-workspaces/reconciliation" && method === "POST") {
        return Promise.resolve(json(healthyReport(state)));
      }
      if (url.startsWith("/api/task-workspaces?") && method === "GET") {
        return Promise.resolve(json({ instances: state.instances }));
      }
      if (url === "/api/task-workspaces/active" && method === "POST") {
        return post.promise.then(() => {
          state.active = {
            instance: target,
            binding: binding(target.workspaceId, target.managedWorktreePath),
            pointer: {},
          };
          return json({ instance: target, binding: state.active.binding });
        });
      }
      return Promise.resolve(json({}, 404));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useActiveWorkspaceState());
    await act(async (): Promise<void> => {
      await result.current.refresh("/repo");
    });

    let mutation!: Promise<void>;
    act(() => {
      mutation = result.current.switchTo("ws-1");
    });
    await act(async (): Promise<void> => {
      expect(await result.current.refresh("/repo")).toBe(true);
    });
    expect(result.current.activeRoot).toBeNull();

    await act(async (): Promise<void> => {
      post.resolve(json({}));
      await mutation;
    });
    expect(result.current.activeRoot).toBe("/wt/1");
    expect(result.current.switching).toBe(false);
  });

  it("clearActive returns to unbound mode", async () => {
    installRouter({ active: null, instances: [instance("ws-1", "/wt/1")] });
    const { result } = renderHook(() => useActiveWorkspaceState());
    await act(async (): Promise<void> => {
      await result.current.refresh("/repo");
      await result.current.switchTo("ws-1");
    });
    expect(result.current.activeRoot).toBe("/wt/1");
    await act(async (): Promise<void> => {
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
    await act(async (): Promise<void> => {
      await result.current.refresh("/repo");
    });
    await act(async (): Promise<void> => {
      await result.current.pause("ws-1");
    });
    await waitFor(() => {
      expect(result.current.error).toBe("locked");
    });
    expect(result.current.switching).toBe(false);
  });

  // Release-audit F-09b: a persisted active pointer restored after a page reload is not runtime
  // start authority by itself — the server can still fail a coding-run start with
  // authority-resolution-failed. The restore path must re-verify (and thereby re-stamp) the
  // binding through the shared reconciliation pass before any surface claims it.
  describe("restore re-verification (F-09b)", (): void => {
    function boundState(): RouterState {
      const target = instance("ws-1", "/wt/1");
      return {
        active: { instance: target, binding: binding("ws-1", "/wt/1"), pointer: {} },
        instances: [target],
      };
    }

    it("re-verifies a restored active binding through the reconciliation pass before claiming it", async (): Promise<void> => {
      const fetchMock = installRouter(boundState());
      const { result } = renderHook(() => useActiveWorkspaceState());
      await act(async (): Promise<void> => {
        await result.current.refresh("/repo");
      });
      expect(reconciliationCount(fetchMock)).toBeGreaterThanOrEqual(1);
      expect(result.current.activeRoot).toBe("/wt/1");
      expect(result.current.error).toBeNull();
    });

    it("does not re-run the reconciliation pass on later reloads of the same workspace", async (): Promise<void> => {
      const fetchMock = installRouter(boundState());
      const { result } = renderHook(() => useActiveWorkspaceState());
      await act(async (): Promise<void> => {
        await result.current.refresh("/repo");
      });
      await act(async (): Promise<void> => {
        await result.current.refresh("/repo");
      });
      // Verification is scoped to the ACTIVE WORKSPACE IDENTITY, not to a reload: repeated
      // refreshes of an already-verified binding must read state without the heavy
      // git/filesystem pass (#2841).
      expect(reconciliationCount(fetchMock)).toBe(1);
      expect(result.current.error).toBeNull();
    });

    // The counterpart of the pin above, and the reason it must not be a session-wide latch:
    // `switchTo` routes through the very same `reload`, so a "verified once this session" flag
    // would let every workspace activated after the first one claim its binding WITHOUT the pass.
    // `setActiveTaskWorkspace` does not reconcile, so a newly activated pointer carries no more
    // runtime start authority than a restored one (F-09b).
    it("re-verifies every newly activated workspace, including a switch back", async (): Promise<void> => {
      const first = instance("ws-1", "/wt/1");
      const second = instance("ws-2", "/wt/2");
      const state: RouterState = {
        active: { instance: first, binding: binding("ws-1", "/wt/1"), pointer: {} },
        instances: [first, second],
      };
      const fetchMock = installRouter(state);
      const { result } = renderHook(() => useActiveWorkspaceState());
      await act(async (): Promise<void> => {
        await result.current.refresh("/repo");
      });
      await act(async (): Promise<void> => {
        await result.current.refresh("/repo");
      });
      expect(reconciliationCount(fetchMock)).toBe(1);

      await act(async (): Promise<void> => {
        await result.current.switchTo("ws-2");
      });
      expect(result.current.activeRoot).toBe("/wt/2");
      expect(reconciliationCount(fetchMock)).toBe(2);

      // Switching back re-verifies rather than reusing the earlier verdict: ws-1 may have drifted
      // while ws-2 was the bound workspace.
      await act(async (): Promise<void> => {
        await result.current.switchTo("ws-1");
      });
      expect(result.current.activeRoot).toBe("/wt/1");
      expect(reconciliationCount(fetchMock)).toBe(3);
      expect(result.current.error).toBeNull();
    });

    it("refuses to claim a switched-to binding the verification pass rejects", async (): Promise<void> => {
      const first = instance("ws-1", "/wt/1");
      const second = instance("ws-2", "/wt/2");
      const state: RouterState = {
        active: { instance: first, binding: binding("ws-1", "/wt/1"), pointer: {} },
        instances: [first, second],
      };
      const fetchMock = installRouter(state, (workspaceId) =>
        workspaceId === "ws-2" ? "stale-pointer" : "healthy",
      );
      const { result } = renderHook(() => useActiveWorkspaceState());
      await act(async (): Promise<void> => {
        await result.current.refresh("/repo");
      });
      expect(result.current.activeRoot).toBe("/wt/1");

      await act(async (): Promise<void> => {
        await result.current.switchTo("ws-2");
      });
      // The pass ran for the newly activated workspace and rejected it, so no surface ever claims
      // ws-2; the previously verified binding is preserved and the failure surfaced instead.
      expect(reconciliationCount(fetchMock)).toBe(2);
      expect(result.current.activeInstance?.workspaceId).not.toBe("ws-2");
      expect(result.current.activeRoot).toBe("/wt/1");
      expect(result.current.error).toContain("re-verification");
    });

    it("refuses to claim a restored binding the verification pass rejected", async (): Promise<void> => {
      const state = boundState();
      const fetchMock = installRouter(state);
      // The pass rejects the workspace while the persisted view still claims healthy — the
      // contradiction must fail closed instead of rendering a ready-looking workspace.
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/task-workspaces/reconciliation" && method === "POST") {
          return Promise.resolve(
            json({ report: { entries: [{ workspaceId: "ws-1", status: "stale-pointer" }] } }),
          );
        }
        if (url.startsWith("/api/task-workspaces/active") && method === "GET") {
          return Promise.resolve(json({ active: state.active }));
        }
        if (url.startsWith("/api/task-workspaces?") && method === "GET") {
          return Promise.resolve(json({ instances: state.instances }));
        }
        return Promise.resolve(json({}, 404));
      });
      const { result } = renderHook(() => useActiveWorkspaceState());
      await act(async (): Promise<void> => {
        await result.current.refresh("/repo");
      });
      expect(result.current.activeBinding).toBeNull();
      expect(result.current.error).toContain("re-verification");
    });

    it("keeps a reconciled non-healthy binding visible instead of hiding it", async (): Promise<void> => {
      const state = boundState();
      const drifted = { ...instance("ws-1", "/wt/1"), health: "drifted" as const };
      const fetchMock = installRouter(state);
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/task-workspaces/reconciliation" && method === "POST") {
          // The pass persisted its verdict; the re-read below returns the drifted truth.
          state.active = { instance: drifted, binding: binding("ws-1", "/wt/1"), pointer: {} };
          return Promise.resolve(
            json({ report: { entries: [{ workspaceId: "ws-1", status: "drifted" }] } }),
          );
        }
        if (url.startsWith("/api/task-workspaces/active") && method === "GET") {
          return Promise.resolve(json({ active: state.active }));
        }
        if (url.startsWith("/api/task-workspaces?") && method === "GET") {
          return Promise.resolve(json({ instances: state.instances }));
        }
        return Promise.resolve(json({}, 404));
      });
      const { result } = renderHook(() => useActiveWorkspaceState());
      await act(async (): Promise<void> => {
        await result.current.refresh("/repo");
      });
      // Drifted worktrees stay visible (#1990) — readiness is blocked by the non-healthy health,
      // not by hiding the binding.
      expect(result.current.activeInstance?.health).toBe("drifted");
      expect(result.current.error).toBeNull();
    });

    it("surfaces a failed verification pass as an error instead of claiming readiness", async () => {
      const state = boundState();
      const fetchMock = installRouter(state);
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/task-workspaces/reconciliation" && method === "POST") {
          return Promise.resolve(
            json({ error: { code: "INTERNAL", message: "reconciliation unavailable" } }, 500),
          );
        }
        if (url.startsWith("/api/task-workspaces/active") && method === "GET") {
          return Promise.resolve(json({ active: state.active }));
        }
        if (url.startsWith("/api/task-workspaces?") && method === "GET") {
          return Promise.resolve(json({ instances: state.instances }));
        }
        return Promise.resolve(json({}, 404));
      });
      const { result } = renderHook(() => useActiveWorkspaceState());
      await act(async (): Promise<void> => {
        await result.current.refresh("/repo");
      });
      expect(result.current.activeBinding).toBeNull();
      expect(result.current.error).toBe("reconciliation unavailable");
    });
  });
});
