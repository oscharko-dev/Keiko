// Unit tests for the active-workspace binding state machine (Issue #446). Drives the reducer through
// refresh/switchTo/pause/error against a routed fetch stub and asserts the atomic settle behavior:
// the bound active root only changes once the post-mutation reload lands, and errors are surfaced
// without dropping the previous binding.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceBinding, WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import { useActiveWorkspaceState } from "./useActiveWorkspaceState";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";

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
  // The inventory read answers 503 while the binding read still succeeds.
  inventoryUnavailable?: boolean;
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

function requestMethod(init: RequestInit | undefined): string {
  return (init?.method ?? "GET").toUpperCase();
}

function workspaceReadResponse(
  state: RouterState,
  url: string,
  method: string,
  reconcileStatus: (workspaceId: string) => string = () => "healthy",
): Promise<Response> | undefined {
  if (url.startsWith("/api/task-workspaces/active") && method === "GET") {
    return Promise.resolve(json({ active: state.active }));
  }
  if (url === "/api/task-workspaces/reconciliation" && method === "POST") {
    return Promise.resolve(json(reconciliationReport(state, reconcileStatus)));
  }
  if (
    (url === "/api/task-workspaces" || url.startsWith("/api/task-workspaces?")) &&
    method === "GET"
  ) {
    if (state.inventoryUnavailable === true) {
      return Promise.resolve(json({ error: { code: "INTERNAL", message: "redacted" } }, 503));
    }
    return Promise.resolve(json({ instances: state.instances }));
  }
  return undefined;
}

function requestedWorkspaceId(init: RequestInit | undefined): string {
  return (JSON.parse(init?.body as string) as { workspaceId: string }).workspaceId;
}

function activateWorkspace(state: RouterState, workspaceId: string): WorkspaceInstance | undefined {
  const target = state.instances.find((item) => item.workspaceId === workspaceId);
  if (target === undefined) return undefined;
  state.active = {
    instance: target,
    binding: binding(workspaceId, target.managedWorktreePath),
    pointer: {},
  };
  return target;
}

// A stateful fetch router so a switch is observable through a subsequent getActive reload.
function installRouter(
  state: RouterState,
  reconcileStatus: (workspaceId: string) => string = () => "healthy",
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = requestMethod(init);
    const read = workspaceReadResponse(state, url, method, reconcileStatus);
    if (read !== undefined) return read;
    if (url === "/api/task-workspaces/active" && method === "POST") {
      const target = activateWorkspace(state, requestedWorkspaceId(init));
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
  resetClientDiagnosticWriter();
});

describe("useActiveWorkspaceState", () => {
  it("refresh loads the inventory and active binding", async () => {
    installRouter({ active: null, instances: [instance("ws-1", "/wt/1")] });
    const { result } = renderHook(() => useActiveWorkspaceState());
    await act(async (): Promise<void> => {
      await result.current.refresh();
    });
    expect(result.current.instances).toHaveLength(1);
    expect(result.current.activeRoot).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  // An inventory the server could not list is a diagnostic, never a silent empty panel: the
  // binding read stands, the list is empty, and the log names the failure (AGENTS.md §8).
  it("reports a failed inventory read as a diagnostic and keeps the active binding", async () => {
    const diagnostics: string[] = [];
    setClientDiagnosticWriter((message) => diagnostics.push(message));
    const bound = instance("ws-1", "/wt/1");
    installRouter({
      active: { instance: bound, binding: binding("ws-1", "/wt/1"), pointer: {} },
      instances: [bound],
      inventoryUnavailable: true,
    });
    const { result } = renderHook(() => useActiveWorkspaceState());

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.activeRoot).toBe("/wt/1");
    expect(result.current.instances).toEqual([]);
    expect(result.current.error).toBeNull();
    // The console diagnostic is not the whole obligation: the surface has to be able to tell a
    // failed listing apart from a repository with no managed workspaces, or it renders "No managed
    // task workspaces yet." under a bound workspace (#3381 review).
    expect(result.current.inventoryUnavailable).toBe(true);
    expect(
      diagnostics.some((line) => line.includes("task workspace inventory refresh failed")),
    ).toBe(true);
  });

  it("clears the inventory-unavailable flag once a later listing succeeds", async () => {
    const bound = instance("ws-1", "/wt/1");
    const state: RouterState = {
      active: { instance: bound, binding: binding("ws-1", "/wt/1"), pointer: {} },
      instances: [bound],
      inventoryUnavailable: true,
    };
    installRouter(state);
    const { result } = renderHook(() => useActiveWorkspaceState());
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.inventoryUnavailable).toBe(true);

    state.inventoryUnavailable = false;
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.inventoryUnavailable).toBe(false);
    expect(result.current.instances.map((item) => item.workspaceId)).toEqual(["ws-1"]);
  });

  // The inventory is every managed workspace: the pointer is global, a switch may target any
  // repository, and a workspace paused in one repository must stay resumable from this panel
  // whatever folder is selected (observed live, 2026-09-03: the folder-scoped list said "no
  // managed task workspaces yet" under a bound workspace after a reload, and hid a paused one).
  it("lists every managed workspace regardless of the selected folder", async () => {
    const bound = { ...instance("ws-1", "/wt/1"), repositoryRoot: "/repo-bound" };
    const elsewhere = { ...instance("ws-2", "/wt/2"), repositoryRoot: "/repo-other" };
    const state: RouterState = {
      active: { instance: bound, binding: binding("ws-1", "/wt/1"), pointer: {} },
      instances: [bound, elsewhere],
    };
    const fetchMock = installRouter(state);
    const { result } = renderHook(() => useActiveWorkspaceState());

    await act(async () => {
      await result.current.refresh();
    });

    const listCalls = fetchMock.mock.calls
      .filter((call: readonly unknown[]) => requestMethod(call[1] as RequestInit) === "GET")
      .map((call: readonly unknown[]) => call[0] as string)
      .filter((url) => url === "/api/task-workspaces" || url.startsWith("/api/task-workspaces?"));
    expect(listCalls).toEqual(["/api/task-workspaces"]);
    expect(result.current.instances.map((item) => item.workspaceId)).toEqual(["ws-1", "ws-2"]);
  });

  it("keeps every workspace listed after the binding is released", async () => {
    const bound = { ...instance("ws-1", "/wt/1"), repositoryRoot: "/repo-bound" };
    const state: RouterState = {
      active: { instance: bound, binding: binding("ws-1", "/wt/1"), pointer: {} },
      instances: [bound],
    };
    installRouter(state);
    const { result } = renderHook(() => useActiveWorkspaceState());
    await act(async () => {
      await result.current.refresh();
    });

    await act(async () => {
      await result.current.clearActive();
    });

    expect(result.current.activeInstance).toBeNull();
    expect(result.current.instances).toHaveLength(1);
  });

  it("switchTo binds the active root atomically after the reload settles", async () => {
    installRouter({
      active: null,
      instances: [instance("ws-1", "/wt/1"), instance("ws-2", "/wt/2")],
    });
    const { result } = renderHook(() => useActiveWorkspaceState());
    await act(async (): Promise<void> => {
      await result.current.refresh();
    });
    await act(async (): Promise<void> => {
      await result.current.switchTo("ws-2");
    });
    expect(result.current.activeRoot).toBe("/wt/2");
    expect(result.current.activeInstance?.workspaceId).toBe("ws-2");
    expect(result.current.switching).toBe(false);
  });

  // Two refreshes issued back to back: the first is superseded before it lists the inventory, so
  // it performs no inventory request at all and reports `false`; only the newer one settles the
  // state. (Before the inventory went global this pin raced two root-scoped list responses; the
  // early exit now makes the stale response impossible instead of merely ignored.)
  it("drops a superseded refresh before it lists the inventory and settles the newer one", async () => {
    let listCalls = 0;
    const state: RouterState = { active: null, instances: [instance("ws-b", "/wt/b")] };
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const method = requestMethod(init);
      if (url === "/api/task-workspaces" && method === "GET") listCalls += 1;
      const read = workspaceReadResponse(state, url, method);
      if (read !== undefined) return read;
      return Promise.resolve(json({}, 404));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useActiveWorkspaceState());

    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = result.current.refresh();
    });
    act(() => {
      second = result.current.refresh();
    });

    await act(async (): Promise<void> => {
      expect(await second).toBe(true);
      expect(await first).toBe(false);
    });
    expect(listCalls).toBe(1);
    expect(result.current.instances.map((item) => item.workspaceId)).toEqual(["ws-b"]);
  });

  // The SECOND supersession guard, after the inventory GET resolves — the one the early exit above
  // cannot reach because the inventory request has already been issued. Refresh A passes the active
  // read and issues its listing; a newer refresh settles; A's listing lands late. Without the guard
  // A dispatches `settle` with its own pre-supersession view and flips every bound surface back.
  // Restored after the #3381 review found that replacing the base pin ("ignores a stale refresh
  // response after a newer root has settled") with the early-exit case left the guard deletable
  // with this file fully green (AGENTS.md §7: a pin may be relocated or strengthened, never
  // relaxed).
  it("ignores a late inventory response after a newer refresh has settled", async () => {
    const listResponses: { resolve: (value: Response) => void }[] = [];
    const state: RouterState = { active: null, instances: [] };
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const method = requestMethod(init);
      if (url === "/api/task-workspaces" && method === "GET") {
        const pending = deferred<Response>();
        listResponses.push({ resolve: pending.resolve });
        return pending.promise;
      }
      const read = workspaceReadResponse(state, url, method);
      if (read !== undefined) return read;
      return Promise.resolve(json({}, 404));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useActiveWorkspaceState());

    let first!: Promise<boolean>;
    act(() => {
      first = result.current.refresh();
    });
    // Refresh A is parked on its own inventory request, PAST the post-`readActive` early exit.
    await waitFor(() => {
      expect(listResponses).toHaveLength(1);
    });

    let second!: Promise<boolean>;
    act(() => {
      second = result.current.refresh();
    });
    await waitFor(() => {
      expect(listResponses).toHaveLength(2);
    });

    await act(async (): Promise<void> => {
      listResponses[1]?.resolve(json({ instances: [instance("ws-b", "/wt/b")] }));
      expect(await second).toBe(true);
    });
    expect(result.current.instances.map((item) => item.workspaceId)).toEqual(["ws-b"]);

    await act(async (): Promise<void> => {
      listResponses[0]?.resolve(json({ instances: [instance("ws-a", "/wt/a")] }));
      expect(await first).toBe(false);
    });
    expect(result.current.instances.map((item) => item.workspaceId)).toEqual(["ws-b"]);
  });

  // A mutation the server APPLIED and a newer mutation then superseded is not a refusal. Collapsing
  // the two into one `false` made the folder switcher report an override clear as unreleasable —
  // and abort the folder change — for a clear the server had performed (#3381 review). `false` is
  // reserved for a refused wire call ("surfaces an error and preserves the previous binding on
  // failure" below pins that side).
  it("reports a superseded but applied mutation as applied, not refused", async () => {
    const firstDelete = deferred<Response>();
    const target = instance("ws-1", "/wt/1");
    const state: RouterState = {
      active: { instance: target, binding: binding("ws-1", "/wt/1"), pointer: {} },
      instances: [target],
    };
    let deletes = 0;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const method = requestMethod(init);
      if (url === "/api/task-workspaces/active" && method === "DELETE") {
        deletes += 1;
        state.active = null;
        if (deletes === 1) return firstDelete.promise;
        return Promise.resolve(json({ active: null }));
      }
      const read = workspaceReadResponse(state, url, method);
      if (read !== undefined) return read;
      return Promise.resolve(json({}, 404));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useActiveWorkspaceState());

    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = result.current.clearActive();
    });
    act(() => {
      second = result.current.clearActive();
    });

    await act(async (): Promise<void> => {
      expect(await second).toBe(true);
    });
    await act(async (): Promise<void> => {
      firstDelete.resolve(json({ active: null }));
      expect(await first).toBe(true);
    });
    expect(result.current.activeInstance).toBeNull();
    expect(result.current.error).toBeNull();
  });

  // Two switches in flight at once. `mutationSeqRef` orders the CLIENT's commits, but it cannot
  // un-apply a request the server is already executing: here ws-2 answers first and ws-1's POST
  // lands last, so the server pointer ends on ws-1. The surface must end where the SERVER ended —
  // it advertised ws-2 while every bound surface would have resolved ws-1's root (#3381 review).
  // The convergence is asserted against the routed server's own state, not a literal, so the pin
  // cannot pass on a UI and a server that merely happen to both be wrong.
  it("converges on server truth after every applied switch of a burst has settled", async () => {
    const postWs1 = deferred<Response>();
    const postWs2 = deferred<Response>();
    const state: RouterState = {
      active: null,
      instances: [instance("ws-1", "/wt/1"), instance("ws-2", "/wt/2")],
    };
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const method = requestMethod(init);
      const read = workspaceReadResponse(state, url, method);
      if (read !== undefined) return read;
      if (url === "/api/task-workspaces/active" && method === "POST") {
        const workspaceId = requestedWorkspaceId(init);
        const target = state.instances.find((item) => item.workspaceId === workspaceId);
        const response = workspaceId === "ws-1" ? postWs1 : postWs2;
        return response.promise.then(() => {
          activateWorkspace(state, workspaceId);
          return json({ instance: target, binding: state.active?.binding });
        });
      }
      return Promise.resolve(json({}, 404));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useActiveWorkspaceState());
    await act(async (): Promise<void> => {
      await result.current.refresh();
    });

    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = result.current.switchTo("ws-1");
    });
    act(() => {
      second = result.current.switchTo("ws-2");
    });

    // The newer switch settles first and owns the surface: its reload is not clobbered by the
    // older request that is still executing.
    await act(async (): Promise<void> => {
      postWs2.resolve(json({}));
      await second;
    });
    expect(result.current.activeRoot).toBe("/wt/2");
    expect(state.active?.instance.workspaceId).toBe("ws-2");

    await act(async (): Promise<void> => {
      postWs1.resolve(json({}));
      await first;
    });
    // The server ended on ws-1, so the surface does too — an applied mutation is never dropped
    // just because a newer one committed first.
    expect(state.active?.instance.workspaceId).toBe("ws-1");
    expect(result.current.activeRoot).toBe(state.active?.binding.activeRoot);
    expect(result.current.activeInstance?.workspaceId).toBe(state.active?.instance.workspaceId);
    expect(result.current.activeRoot).toBe("/wt/1");
    expect(result.current.switching).toBe(false);
    expect(result.current.error).toBeNull();
  });

  // The authoritative re-read of an applied-but-superseded mutation must not swallow the refusal
  // of the newer one that superseded it: the operator would be left with the reconciled binding
  // and no sign that their last action was refused (AGENTS.md §7, no silent failures).
  it("keeps a refused newer mutation's error while converging on the applied older one", async () => {
    const post = deferred<Response>();
    const target = instance("ws-1", "/wt/1");
    const state: RouterState = { active: null, instances: [target] };
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const method = requestMethod(init);
      const read = workspaceReadResponse(state, url, method);
      if (read !== undefined) return read;
      if (url === "/api/task-workspaces/active" && method === "POST") {
        return post.promise.then(() => {
          activateWorkspace(state, target.workspaceId);
          return json({ instance: target, binding: state.active?.binding });
        });
      }
      if (url === "/api/task-workspaces/ws-1/pause" && method === "POST") {
        return Promise.resolve(
          json({ error: { code: "LOCK_CONTENTION", message: "locked" } }, 409),
        );
      }
      return Promise.resolve(json({}, 404));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useActiveWorkspaceState());
    await act(async (): Promise<void> => {
      await result.current.refresh();
    });

    let applied!: Promise<boolean>;
    act(() => {
      applied = result.current.switchTo("ws-1");
    });
    await act(async (): Promise<void> => {
      expect(await result.current.pause("ws-1")).toBe(false);
    });
    expect(result.current.error).toBe("locked");

    await act(async (): Promise<void> => {
      post.resolve(json({}));
      expect(await applied).toBe(true);
    });
    expect(result.current.activeRoot).toBe(state.active?.binding.activeRoot);
    expect(result.current.activeRoot).toBe("/wt/1");
    expect(result.current.error).toBe("locked");
  });

  it("reloads server truth after a concurrent refresh settles during a mutation", async () => {
    const post = deferred<Response>();
    const target = instance("ws-1", "/wt/1");
    const state: RouterState = { active: null, instances: [target] };
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const method = requestMethod(init);
      const read = workspaceReadResponse(state, url, method);
      if (read !== undefined) return read;
      if (url === "/api/task-workspaces/active" && method === "POST") {
        return post.promise.then(() => {
          activateWorkspace(state, target.workspaceId);
          return json({
            instance: target,
            binding: binding(target.workspaceId, target.managedWorktreePath),
          });
        });
      }
      return Promise.resolve(json({}, 404));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useActiveWorkspaceState());
    await act(async (): Promise<void> => {
      await result.current.refresh();
    });

    let mutation!: Promise<boolean>;
    act(() => {
      mutation = result.current.switchTo("ws-1");
    });
    await act(async (): Promise<void> => {
      expect(await result.current.refresh()).toBe(true);
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
      await result.current.refresh();
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
      await result.current.refresh();
    });
    await act(async (): Promise<void> => {
      await result.current.pause("ws-1");
    });
    await waitFor(() => {
      expect(result.current.error).toBe("locked");
    });
    expect(result.current.switching).toBe(false);
  });

  describe("repair", () => {
    // `applied` is mutated by the second half of the test below to flip the same route from a
    // completed repair to an operator-required refusal, on the same bound workspace.
    it("posts the approved strategy and reloads on success, then preserves the binding on an operator-required refusal", async () => {
      const target = instance("ws-1", "/wt/1");
      const state: RouterState = {
        active: { instance: target, binding: binding("ws-1", "/wt/1"), pointer: {} },
        instances: [target],
      };
      let applied = true;
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        const method = requestMethod(init);
        const read = workspaceReadResponse(state, url, method);
        if (read !== undefined) return read;
        if (url === "/api/task-workspaces/ws-1/repair" && method === "POST") {
          return Promise.resolve(
            json({
              instance: state.active?.instance,
              binding: state.active?.binding,
              strategy: "reconcile-pointer",
              applied,
              outcome: applied ? "repaired" : "operator-required",
              status: applied ? "healthy" : "stale-pointer",
              driftMarkers: applied ? [] : ["identity-schema-retired"],
              operatorActionRequired: !applied,
            }),
          );
        }
        return Promise.resolve(json({}, 404));
      });
      vi.stubGlobal("fetch", fetchMock);
      const activeGetCount = (): number =>
        fetchMock.mock.calls.filter(
          (call: readonly unknown[]) =>
            call[0] === "/api/task-workspaces/active" &&
            requestMethod(call[1] as RequestInit | undefined) === "GET",
        ).length;

      const { result } = renderHook(() => useActiveWorkspaceState());
      await act(async (): Promise<void> => {
        await result.current.refresh();
      });
      expect(result.current.activeRoot).toBe("/wt/1");
      const activeGetsBeforeRepair = activeGetCount();

      await act(async (): Promise<void> => {
        await result.current.repair("ws-1", "reconcile-pointer");
      });
      const repairCalls = fetchMock.mock.calls.filter(
        (call: readonly unknown[]) => call[0] === "/api/task-workspaces/ws-1/repair",
      );
      expect(repairCalls).toHaveLength(1);
      const body = JSON.parse((repairCalls[0]?.[1] as RequestInit).body as string) as {
        readonly strategy: string;
        readonly operatorApproved: boolean;
      };
      expect(body.strategy).toBe("reconcile-pointer");
      expect(body.operatorApproved).toBe(true);
      expect(result.current.error).toBeNull();
      expect(result.current.activeRoot).toBe("/wt/1");
      // "then reloads": the post-mutation reload re-reads the active binding, so the GET count
      // strictly increases beyond the repair POST itself.
      expect(activeGetCount()).toBeGreaterThan(activeGetsBeforeRepair);

      applied = false;
      await act(async (): Promise<void> => {
        await result.current.repair("ws-1", "reconcile-pointer");
      });
      expect(result.current.error).toBe(
        "This recovery needs an operator first. Inspect the managed worktree, then retry the repair.",
      );
      expect(result.current.activeRoot).toBe("/wt/1");
      expect(result.current.activeInstance?.workspaceId).toBe("ws-1");
    });
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
        await result.current.refresh();
      });
      expect(reconciliationCount(fetchMock)).toBeGreaterThanOrEqual(1);
      expect(result.current.activeRoot).toBe("/wt/1");
      expect(result.current.error).toBeNull();
    });

    it("does not re-run the reconciliation pass on later reloads of the same workspace", async (): Promise<void> => {
      const fetchMock = installRouter(boundState());
      const { result } = renderHook(() => useActiveWorkspaceState());
      await act(async (): Promise<void> => {
        await result.current.refresh();
      });
      await act(async (): Promise<void> => {
        await result.current.refresh();
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
        await result.current.refresh();
      });
      await act(async (): Promise<void> => {
        await result.current.refresh();
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
        await result.current.refresh();
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
        await result.current.refresh();
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
        await result.current.refresh();
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
        await result.current.refresh();
      });
      expect(result.current.activeBinding).toBeNull();
      expect(result.current.error).toBe("reconciliation unavailable");
    });
  });
});
