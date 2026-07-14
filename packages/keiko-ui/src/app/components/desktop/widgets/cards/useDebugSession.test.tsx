import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debugSessionSnapshot, resetDebugSessionStoreForTests } from "./debugSessionStore";
import { resetSharedEventSourcesForTests } from "./sharedEventSource";
import { resetDebugBootstrapRequestsForTests, useDebugSession } from "./useDebugSession";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Set<EventListener>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    // Test double.
  }
}

function instrumentation(): object {
  return {
    schemaVersion: "1",
    workspaceId: "canonical-workspace-id",
    revision: 0,
    etag: "debug-etag",
    breakpoints: [],
    exceptionFilters: [],
    watches: [],
  };
}

function response(body: object): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function session(status: "paused" | "running" = "paused"): object {
  return {
    schemaVersion: "1",
    sessionId: "session-1",
    workspaceId: "canonical-workspace-id",
    status,
    targetKind: "file",
    activationRevision: 4,
    pauseGeneration: 2,
    startedAtMs: 1,
    wallDeadlineMs: 2,
    inactivityDeadlineMs: 3,
    output: { acceptedBytes: 0, truncated: false },
  };
}

function bounded(value: string): object {
  return {
    value,
    truncated: false,
    originalBytes: value.length,
    retainedBytes: value.length,
    omittedBytes: 0,
  };
}

function mutationSnapshot(overrides: object = {}): object {
  return {
    snapshot: { ...instrumentation(), revision: 2, etag: "next-etag", ...overrides },
  };
}

function pausedSession(): ReturnType<typeof session> {
  return session("paused");
}

function deferredResponse(): {
  readonly promise: Promise<Response>;
  readonly resolve: (body: object) => void;
} {
  let resolveResponse: ((response: Response) => void) | undefined;
  const promise = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  return {
    promise,
    resolve: (body) => {
      if (resolveResponse === undefined) throw new Error("Expected response resolver.");
      resolveResponse(response(body));
    },
  };
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) =>
      response(
        input.endsWith("/instrumentation?workspaceId=canonical-workspace-id")
          ? instrumentation()
          : {},
      ),
    ),
  );
});

afterEach(() => {
  resetDebugSessionStoreForTests();
  resetSharedEventSourcesForTests();
  resetDebugBootstrapRequestsForTests();
  vi.unstubAllGlobals();
});

describe("useDebugSession", () => {
  it("bootstraps the HttpOnly capability before instrumentation and SSE, without a bearer token", async () => {
    renderHook(() => useDebugSession("canonical-workspace-id", true));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls[0]?.[0]).toBe("/api/editor/debug/bootstrap");
    expect(calls[1]?.[0]).toBe(
      "/api/editor/debug/instrumentation?workspaceId=canonical-workspace-id",
    );
    expect(calls[0]?.[1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: expect.objectContaining({ "x-keiko-csrf": "1" }),
    });
    expect(calls[0]?.[1]).not.toMatchObject({
      headers: expect.objectContaining({ authorization: expect.anything() }),
    });
    expect(FakeEventSource.instances.map((source) => source.url)).toEqual([
      "/api/editor/debug/events?workspaceId=canonical-workspace-id",
    ]);
  });

  it("coalesces concurrent editor and debug-panel bootstraps for one workspace", async () => {
    let releaseBootstrap: (() => void) | undefined;
    const bootstrapPending = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === "/api/editor/debug/bootstrap") await bootstrapPending;
      return response(
        url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")
          ? instrumentation()
          : {},
      );
    });

    renderHook(() => useDebugSession("canonical-workspace-id", true));
    renderHook(() => useDebugSession("canonical-workspace-id", true));

    await waitFor(() => {
      const calls = vi.mocked(fetch).mock.calls;
      expect(calls.filter(([url]) => url === "/api/editor/debug/bootstrap")).toHaveLength(1);
    });
    if (releaseBootstrap === undefined) throw new Error("Expected bootstrap release.");
    await act(async () => releaseBootstrap?.());
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  });

  it("waits for initial instrumentation before persisting an immediate breakpoint", async () => {
    const initialInstrumentation = deferredResponse();
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        return initialInstrumentation.promise;
      }
      if (url === "/api/editor/debug/breakpoints") {
        return response(mutationSnapshot());
      }
      return response({});
    });
    const { result } = renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() =>
      expect(
        vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("instrumentation")),
      ).toBe(true),
    );

    const pending = result.current.actions.saveBreakpoints("src/program.ts", [
      {
        id: "line-4",
        fileId: "src/program.ts",
        line: 4,
        enabled: true,
        kind: "line",
        verification: "pending",
      },
    ]);
    expect(
      vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/editor/debug/breakpoints"),
    ).toBe(false);
    initialInstrumentation.resolve(instrumentation());
    await act(async () => pending);

    expect(vi.mocked(fetch).mock.calls).toContainEqual([
      "/api/editor/debug/breakpoints",
      expect.objectContaining({ method: "PUT" }),
    ]);
  });

  it("adds CSRF protection to every client mutation", async () => {
    const { result } = renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(result.current.snapshot.instrumentation).not.toBeNull());

    await act(async () => {
      await result.current.actions.saveWatches([
        { watchId: "watch-1", expression: "total", enabled: true },
      ]);
    });

    const call = vi.mocked(fetch).mock.calls.at(-1);
    expect(call?.[0]).toBe("/api/editor/debug/watches");
    expect(call?.[1]).toMatchObject({
      method: "PUT",
      headers: expect.objectContaining({ "x-keiko-csrf": "1", "if-match": "debug-etag" }),
    });
  });

  it("starts only a structured file target and persists its bounded breakpoint projection", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === "/api/editor/debug/sessions") {
        return response({
          schemaVersion: "1",
          sessionId: "session-1",
          workspaceId: "canonical-workspace-id",
          status: "starting",
          targetKind: "file",
          activationRevision: 4,
          pauseGeneration: 0,
          startedAtMs: 1,
          wallDeadlineMs: 2,
          inactivityDeadlineMs: 3,
          output: { acceptedBytes: 0, truncated: false },
        });
      }
      if (url === "/api/editor/debug/breakpoints") {
        return response({
          snapshot: {
            ...instrumentation(),
            revision: 1,
            etag: "next-etag",
            breakpoints: [
              {
                id: "line-2",
                fileId: "src/program.ts",
                line: 2,
                enabled: true,
                kind: "line",
                verification: "pending",
              },
            ],
          },
        });
      }
      return response(
        url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")
          ? instrumentation()
          : {},
      );
    });
    const { result } = renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(result.current.snapshot.instrumentation).not.toBeNull());

    await act(async () => {
      await result.current.actions.start({ kind: "file", fileId: "src/program.ts" }, 4);
      await result.current.actions.saveBreakpoints("src/program.ts", [
        {
          id: "line-2",
          fileId: "src/program.ts",
          line: 2,
          enabled: true,
          kind: "line",
          verification: "pending",
        },
      ]);
    });

    expect(result.current.snapshot.session).toMatchObject({ sessionId: "session-1" });
    expect(result.current.snapshot.instrumentation?.breakpoints).toHaveLength(1);
    expect(vi.mocked(fetch).mock.calls).toContainEqual([
      "/api/editor/debug/sessions",
      expect.objectContaining({ method: "POST" }),
    ]);
  });

  it("does not substitute a browser root for the canonical workspace identity", () => {
    renderHook(() => useDebugSession(undefined, true));

    expect(fetch).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("projects each bounded paused inspection route and preserves the server concurrency token", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        return response(instrumentation());
      }
      if (url === "/api/editor/debug/sessions/session-1") return response(pausedSession());
      if (url === "/api/editor/debug/stack") {
        return response({
          frames: [
            {
              frameRef: "frame-1",
              name: bounded("main"),
              sourceFileId: "src/program.ts",
              line: 3,
              column: 1,
            },
          ],
          truncated: false,
          omittedCount: 0,
        });
      }
      if (url === "/api/editor/debug/scopes") {
        return response({
          scopes: [{ scopeRef: "scope-1", name: bounded("Local"), expensive: false }],
          truncated: false,
          omittedCount: 0,
        });
      }
      if (url === "/api/editor/debug/variables") {
        return response({
          nodes: [
            {
              kind: "variable",
              name: bounded("total"),
              value: bounded("2"),
              presentation: "data",
              children: [],
              retainedCount: 0,
              omittedCount: 0,
              truncated: false,
            },
          ],
          truncated: false,
          omittedCount: 0,
        });
      }
      if (url === "/api/editor/debug/watches/evaluate") {
        return response({
          watchId: "watch-1",
          pauseGeneration: 2,
          state: "value",
          value: bounded("2"),
        });
      }
      if (url === "/api/editor/debug/variables/set") {
        return response({
          schemaVersion: "1",
          sessionId: "session-1",
          pauseGeneration: 2,
          result: {
            kind: "variable",
            name: bounded("total"),
            value: bounded("3"),
            presentation: "data",
            children: [],
            retainedCount: 0,
            omittedCount: 0,
            truncated: false,
          },
        });
      }
      return response({});
    });
    const { result } = renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(result.current.snapshot.instrumentation).not.toBeNull());

    await act(async () => result.current.actions.refreshSession("session-1"));
    const current = result.current.snapshot.session;
    if (current === null) throw new Error("Expected session projection.");
    await act(async () => {
      await result.current.actions.loadStack(current);
      await result.current.actions.loadScopes(current, "frame-1");
      await result.current.actions.loadVariables(current, "scope-1");
      await result.current.actions.evaluateWatch(current, "watch-1", "frame-1");
      await result.current.actions.setVariable(current, "variable-1", "3");
    });

    expect(result.current.snapshot.stack?.frames[0]).toMatchObject({ frameRef: "frame-1" });
    expect(result.current.snapshot.scopesByFrame.get("frame-1")?.scopes[0]).toMatchObject({
      scopeRef: "scope-1",
    });
    expect(result.current.snapshot.variablesByParent.get("scope-1")?.nodes[0]).toMatchObject({
      kind: "variable",
    });
    expect(result.current.snapshot.watchResults).toHaveLength(0);
    expect(vi.mocked(fetch).mock.calls).toContainEqual([
      "/api/editor/debug/variables/set",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-keiko-csrf": "1" }),
      }),
    ]);
    await act(async () => result.current.actions.control(current, "next"));
    expect(result.current.snapshot.stack).toBeNull();
  });

  it("discards and aborts a stack response after the pause continues", async () => {
    const stack = deferredResponse();
    let stackSignal: AbortSignal | undefined;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        return response(instrumentation());
      }
      if (url === "/api/editor/debug/sessions/session-1") return response(pausedSession());
      if (url === "/api/editor/debug/stack") {
        stackSignal = init?.signal ?? undefined;
        return stack.promise;
      }
      return response({});
    });
    const { result } = renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await act(async () => result.current.actions.refreshSession("session-1"));
    const current = result.current.snapshot.session;
    if (current === null) throw new Error("Expected paused session.");
    const pending = result.current.actions.loadStack(current);
    await waitFor(() => expect(stackSignal).toBeDefined());
    const continued = FakeEventSource.instances[0]?.listeners.get("editor-debug:continued");
    if (continued === undefined) throw new Error("Expected continued listener.");

    act(() => {
      for (const listener of continued) {
        listener({
          data: JSON.stringify({
            sequence: 1,
            event: { kind: "continued", sessionId: "session-1", pauseGeneration: 2 },
          }),
          lastEventId: "1",
        } as MessageEvent);
      }
    });
    await waitFor(() => expect(stackSignal?.aborted).toBe(true));
    stack.resolve({ frames: [], truncated: false, omittedCount: 0 });
    await act(async () => pending);

    expect(stackSignal?.aborted).toBe(true);
    expect(result.current.snapshot.stack).toBeNull();
  });

  it("keeps a successful stop terminal when the control response follows the stream event", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        return response(instrumentation());
      }
      if (url === "/api/editor/debug/sessions/session-1") return response(pausedSession());
      if (url === "/api/editor/debug/control") {
        const source = FakeEventSource.instances[0];
        const terminated = source?.listeners.get("editor-debug:session-stopped");
        if (terminated === undefined) throw new Error("Expected terminal debug listener.");
        for (const listener of terminated) {
          listener({
            data: JSON.stringify({
              sequence: 1,
              event: {
                kind: "session-stopped",
                sessionId: "session-1",
                status: "stopped",
                reason: "requested",
              },
            }),
          } as MessageEvent);
        }
        return response({ sessionId: "session-1", status: "stopped" });
      }
      return response({});
    });
    const { result } = renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await act(async () => result.current.actions.refreshSession("session-1"));
    const current = result.current.snapshot.session;
    if (current === null) throw new Error("Expected paused session.");

    await act(async () => result.current.actions.control(current, "stop"));

    expect(result.current.snapshot.session).toBeNull();
  });

  it("aborts every old pause projection when a newer pause generation arrives", async () => {
    const stack = deferredResponse();
    const scopes = deferredResponse();
    const variables = deferredResponse();
    const signals = new Map<string, AbortSignal>();
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        return response(instrumentation());
      }
      if (url === "/api/editor/debug/sessions/session-1") return response(pausedSession());
      const pending = new Map([
        ["/api/editor/debug/stack", stack.promise],
        ["/api/editor/debug/scopes", scopes.promise],
        ["/api/editor/debug/variables", variables.promise],
      ]).get(url);
      if (pending !== undefined) {
        if (init?.signal != null) signals.set(url, init.signal);
        return pending;
      }
      return response({});
    });
    const { result } = renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await act(async () => result.current.actions.refreshSession("session-1"));
    const current = result.current.snapshot.session;
    if (current === null) throw new Error("Expected paused session.");
    const pending = [
      result.current.actions.loadStack(current),
      result.current.actions.loadScopes(current, "old-frame"),
      result.current.actions.loadVariables(current, "old-scope"),
    ];
    await waitFor(() => expect(signals.size).toBe(3));
    const stopped = FakeEventSource.instances[0]?.listeners.get("editor-debug:stopped");
    if (stopped === undefined) throw new Error("Expected stopped listener.");

    act(() => {
      for (const listener of stopped) {
        listener(
          new MessageEvent("editor-debug:stopped", {
            data: JSON.stringify({
              sequence: 1,
              event: {
                kind: "stopped",
                sessionId: "session-1",
                pauseGeneration: 3,
                reason: "step",
                allThreadsStopped: true,
              },
            }),
          }),
        );
      }
    });
    await waitFor(() => {
      expect([...signals.values()].every((signal) => signal.aborted)).toBe(true);
    });
    stack.resolve({ frames: [], truncated: false, omittedCount: 0 });
    scopes.resolve({ scopes: [], truncated: false, omittedCount: 0 });
    variables.resolve({ nodes: [], truncated: false, omittedCount: 0 });
    await act(async () => Promise.all(pending));

    expect(result.current.snapshot).toMatchObject({ stack: null });
    expect(result.current.snapshot.scopesByFrame).toHaveLength(0);
    expect(result.current.snapshot.variablesByParent).toHaveLength(0);
  });

  it("does not let a late session refresh replace a newly started session", async () => {
    const oldSession = deferredResponse();
    let oldSignal: AbortSignal | undefined;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        return response(instrumentation());
      }
      if (url === "/api/editor/debug/sessions/session-1") {
        oldSignal = init?.signal ?? undefined;
        return oldSession.promise;
      }
      if (url === "/api/editor/debug/sessions/session-2") {
        return response({ ...session("running"), sessionId: "session-2" });
      }
      return response({});
    });
    const { result } = renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const staleRefresh = result.current.actions.refreshSession("session-1");
    await waitFor(() => expect(oldSignal).toBeDefined());
    const started = FakeEventSource.instances[0]?.listeners.get("editor-debug:session-started");
    if (started === undefined) throw new Error("Expected session-started listener.");

    act(() => {
      for (const listener of started) {
        listener(
          new MessageEvent("editor-debug:session-started", {
            data: JSON.stringify({
              sequence: 1,
              event: { kind: "session-started", sessionId: "session-2", status: "running" },
            }),
          }),
        );
      }
    });
    await waitFor(() => expect(result.current.snapshot.session?.sessionId).toBe("session-2"));
    expect(oldSignal?.aborted).toBe(true);
    oldSession.resolve(pausedSession());
    await act(async () => staleRefresh);

    expect(result.current.snapshot.session?.sessionId).toBe("session-2");
  });

  it("aborts an inspection request when its hook unmounts", async () => {
    const stack = deferredResponse();
    let stackSignal: AbortSignal | undefined;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        return response(instrumentation());
      }
      if (url === "/api/editor/debug/sessions/session-1") return response(pausedSession());
      if (url === "/api/editor/debug/stack") {
        stackSignal = init?.signal ?? undefined;
        return stack.promise;
      }
      return response({});
    });
    const { result, unmount } = renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await act(async () => result.current.actions.refreshSession("session-1"));
    const current = result.current.snapshot.session;
    if (current === null) throw new Error("Expected paused session.");
    const pending = result.current.actions.loadStack(current);
    await waitFor(() => expect(stackSignal).toBeDefined());

    unmount();
    expect(stackSignal?.aborted).toBe(true);
    stack.resolve({ frames: [], truncated: false, omittedCount: 0 });
    await pending;
  });

  it("rejects late scope and variable responses after a newer pause generation", async () => {
    const scopes = deferredResponse();
    const variables = deferredResponse();
    const signals: AbortSignal[] = [];
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        return response(instrumentation());
      }
      if (url === "/api/editor/debug/sessions/session-1") return response(pausedSession());
      if (url === "/api/editor/debug/scopes") {
        if (init?.signal != null) signals.push(init.signal);
        return scopes.promise;
      }
      if (url === "/api/editor/debug/variables") {
        if (init?.signal != null) signals.push(init.signal);
        return variables.promise;
      }
      return response({});
    });
    const { result } = renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await act(async () => result.current.actions.refreshSession("session-1"));
    const current = result.current.snapshot.session;
    if (current === null) throw new Error("Expected paused session.");
    const pendingScopes = result.current.actions.loadScopes(current, "frame-1");
    const pendingVariables = result.current.actions.loadVariables(current, "scope-1");
    await waitFor(() => expect(signals).toHaveLength(2));
    const stopped = FakeEventSource.instances[0]?.listeners.get("editor-debug:stopped");
    if (stopped === undefined) throw new Error("Expected stopped listener.");

    act(() => {
      for (const listener of stopped) {
        listener(
          new MessageEvent("editor-debug:stopped", {
            data: JSON.stringify({
              sequence: 1,
              event: {
                kind: "stopped",
                sessionId: "session-1",
                pauseGeneration: 3,
                reason: "step",
                allThreadsStopped: true,
              },
            }),
            lastEventId: "1",
          }),
        );
      }
    });
    await waitFor(() => expect(signals.every((signal) => signal.aborted)).toBe(true));
    scopes.resolve({ scopes: [], truncated: false, omittedCount: 0 });
    variables.resolve({ nodes: [], truncated: false, omittedCount: 0 });
    await act(async () => Promise.all([pendingScopes, pendingVariables]));

    expect(result.current.snapshot.session?.pauseGeneration).toBe(3);
    expect(result.current.snapshot.scopesByFrame).toHaveLength(0);
    expect(result.current.snapshot.variablesByParent).toHaveLength(0);
  });

  it("aborts an in-flight pause request when the hook unmounts", async () => {
    const stack = deferredResponse();
    let stackSignal: AbortSignal | undefined;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        return response(instrumentation());
      }
      if (url === "/api/editor/debug/sessions/session-1") return response(pausedSession());
      if (url === "/api/editor/debug/stack") {
        stackSignal = init?.signal ?? undefined;
        return stack.promise;
      }
      return response({});
    });
    const { result, unmount } = renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await act(async () => result.current.actions.refreshSession("session-1"));
    const current = result.current.snapshot.session;
    if (current === null) throw new Error("Expected paused session.");
    const pending = result.current.actions.loadStack(current);
    await waitFor(() => expect(stackSignal).toBeDefined());

    unmount();
    expect(stackSignal?.aborted).toBe(true);
    stack.resolve({ frames: [], truncated: false, omittedCount: 0 });
    await pending;
  });

  it("strictly parses setVariable and atomically rebuilds fresh pause references", async () => {
    let stackCalls = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        return response(instrumentation());
      }
      if (url === "/api/editor/debug/sessions/session-1") return response(pausedSession());
      if (url === "/api/editor/debug/variables/set") {
        return response({
          schemaVersion: "1",
          sessionId: "session-1",
          pauseGeneration: 2,
          result: {
            kind: "variable",
            name: bounded("total"),
            value: bounded("3"),
            presentation: "data",
            children: [],
            retainedCount: 0,
            omittedCount: 0,
            truncated: false,
          },
        });
      }
      if (url === "/api/editor/debug/stack") {
        stackCalls += 1;
        return response({
          frames: [
            {
              frameRef: stackCalls === 1 ? "old-frame" : "fresh-frame",
              name: bounded("main"),
              line: 1,
              column: 1,
            },
          ],
          truncated: false,
          omittedCount: 0,
        });
      }
      if (url === "/api/editor/debug/scopes") {
        return response({
          scopes: [
            {
              scopeRef: stackCalls === 1 ? "old-scope" : "fresh-scope",
              name: bounded("Local"),
              expensive: false,
            },
          ],
          truncated: false,
          omittedCount: 0,
        });
      }
      if (url === "/api/editor/debug/variables") {
        return response({
          nodes: [
            {
              kind: "variable",
              variableRef: stackCalls === 1 ? "old-variable" : "fresh-variable",
              name: bounded("total"),
              value: bounded(stackCalls === 1 ? "2" : "3"),
              presentation: "data",
              children: [],
              retainedCount: 0,
              omittedCount: 0,
              truncated: false,
            },
          ],
          truncated: false,
          omittedCount: 0,
        });
      }
      return response({});
    });
    const { result } = renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(result.current.snapshot.instrumentation).not.toBeNull());
    await act(async () => result.current.actions.refreshSession("session-1"));
    const current = result.current.snapshot.session;
    if (current === null) throw new Error("Expected paused session.");
    await act(async () => {
      await result.current.actions.loadStack(current);
      await result.current.actions.loadScopes(current, "old-frame");
      await result.current.actions.loadVariables(current, "old-scope");
      await result.current.actions.setVariable(current, "old-variable", "3");
    });

    expect(result.current.snapshot.stack?.frames[0]?.frameRef).toBe("fresh-frame");
    expect(result.current.snapshot.scopesByFrame.has("old-frame")).toBe(false);
    expect(result.current.snapshot.variablesByParent.has("old-scope")).toBe(false);
    expect(result.current.snapshot.variablesByParent.get("fresh-scope")?.nodes[0]).toMatchObject({
      kind: "variable",
      variableRef: "fresh-variable",
      value: { value: "3" },
    });
  });

  it("rejects a setVariable response containing unknown fields", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        return response(instrumentation());
      }
      if (url === "/api/editor/debug/sessions/session-1") return response(pausedSession());
      if (url === "/api/editor/debug/variables/set") {
        return response({
          schemaVersion: "1",
          sessionId: "session-1",
          pauseGeneration: 2,
          result: {
            kind: "variable",
            name: bounded("total"),
            value: bounded("3"),
            presentation: "data",
            children: [],
            retainedCount: 0,
            omittedCount: 0,
            truncated: false,
          },
          unexpected: "must fail closed",
        });
      }
      return response({});
    });
    const { result } = renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(result.current.snapshot.instrumentation).not.toBeNull());
    await act(async () => result.current.actions.refreshSession("session-1"));
    const current = result.current.snapshot.session;
    if (current === null) throw new Error("Expected paused session.");

    await expect(result.current.actions.setVariable(current, "variable-1", "3")).rejects.toThrow(
      "Debug variable projection was invalid.",
    );
  });

  it("resyncs a replay gap before applying queued live events", async () => {
    const resyncInstrumentation = deferredResponse();
    let instrumentationCalls = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        instrumentationCalls += 1;
        return instrumentationCalls === 1
          ? response(instrumentation())
          : resyncInstrumentation.promise;
      }
      return response({});
    });
    const { result } = renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    const required = source?.listeners.get("editor-debug:snapshot-required");
    const output = source?.listeners.get("editor-debug:output");
    if (required === undefined || output === undefined)
      throw new Error("Expected stream listeners.");

    act(() => {
      for (const listener of required) {
        listener(
          new MessageEvent("editor-debug:snapshot-required", {
            data: JSON.stringify({
              sequence: 20,
              retainedCount: 0,
              retainedBytes: 0,
              evictedCount: 20,
              evictedBytes: 2_000,
            }),
            lastEventId: "20",
          }),
        );
      }
      for (const listener of output) {
        listener({
          data: JSON.stringify({
            sequence: 21,
            event: {
              kind: "output",
              sessionId: "session-1",
              category: "stdout",
              text: "after-resync",
              truncated: false,
              originalBytes: 12,
              omittedBytes: 0,
            },
          }),
          lastEventId: "21",
        } as MessageEvent);
      }
    });
    expect(result.current.snapshot.console.entries).toHaveLength(0);
    await waitFor(() => expect(instrumentationCalls).toBe(2));
    resyncInstrumentation.resolve({ ...instrumentation(), revision: 4, etag: "resynced" });

    await waitFor(() => expect(result.current.snapshot.instrumentation?.revision).toBe(4));
    await waitFor(() => expect(result.current.snapshot.sequence).toBe(21));
    expect(result.current.snapshot.console.entries[0]?.text).toBe("after-resync");
  });

  it("refreshes breakpoints to at least the event revision", async () => {
    let instrumentationCalls = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        instrumentationCalls += 1;
        return response({
          ...instrumentation(),
          revision: instrumentationCalls === 1 ? 0 : 3,
          etag: instrumentationCalls === 1 ? "debug-etag" : "revision-3",
        });
      }
      return response({});
    });
    const { result } = renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const changed = FakeEventSource.instances[0]?.listeners.get("editor-debug:breakpoints-changed");
    if (changed === undefined) throw new Error("Expected breakpoint listener.");

    act(() => {
      for (const listener of changed) {
        listener({
          data: JSON.stringify({
            sequence: 1,
            event: {
              kind: "breakpoints-changed",
              workspaceId: "canonical-workspace-id",
              revision: 3,
              breakpointCount: 1,
              verifiedCount: 1,
            },
          }),
          lastEventId: "1",
        } as MessageEvent);
      }
    });

    await waitFor(() => expect(result.current.snapshot.instrumentation?.revision).toBe(3));
  });

  it("updates both persisted instrumentation projections through the opaque revision and ETag", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        return response(instrumentation());
      }
      if (url === "/api/editor/debug/watches") {
        return response(
          mutationSnapshot({
            watches: [{ watchId: "watch-2", expression: "total", enabled: true }],
          }),
        );
      }
      if (url === "/api/editor/debug/exception-breakpoints") {
        return response(
          mutationSnapshot({ exceptionFilters: [{ filterId: "uncaught", enabled: true }] }),
        );
      }
      return response({});
    });
    const { result } = renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(result.current.snapshot.instrumentation).not.toBeNull());

    await act(async () => {
      await result.current.actions.saveWatches([
        { watchId: "watch-2", expression: "total", enabled: true },
      ]);
      await result.current.actions.saveExceptionFilters([{ filterId: "uncaught", enabled: true }]);
    });

    expect(result.current.snapshot.instrumentation).toMatchObject({
      revision: 2,
      etag: "next-etag",
      watches: [{ watchId: "watch-2" }],
      exceptionFilters: [{ filterId: "uncaught" }],
    });
    expect(vi.mocked(fetch).mock.calls.at(-2)?.[1]).toMatchObject({
      headers: expect.objectContaining({ "if-match": "debug-etag" }),
    });
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[1]).toMatchObject({
      headers: expect.objectContaining({ "if-match": "next-etag" }),
    });
  });

  it("accepts only well-formed SSE projections and ignores malformed event data", async () => {
    renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("Expected debug event source.");
    const ready = source.listeners.get("ready");
    const output = source.listeners.get("editor-debug:output");
    if (ready === undefined || output === undefined) throw new Error("Expected debug listeners.");

    act(() => {
      for (const listener of ready) listener(new Event("ready"));
      for (const listener of output) {
        listener({
          data: JSON.stringify({
            sequence: 1,
            event: {
              kind: "output",
              sessionId: "session-1",
              category: "stdout",
              text: "safe",
              truncated: false,
              originalBytes: 4,
              omittedBytes: 0,
            },
          }),
        } as MessageEvent);
        listener({ data: "not json" } as MessageEvent);
      }
    });

    await waitFor(() =>
      expect(debugSessionSnapshot("canonical-workspace-id")).toMatchObject({
        streamReady: true,
        console: { entries: [{ text: "safe" }] },
      }),
    );
  });

  it("retains an exception when session-started follows the immediate stopped event", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        return response(instrumentation());
      }
      if (url === "/api/editor/debug/sessions/session-1") return response(session("paused"));
      return response({});
    });
    const { result } = renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    const stopped = source?.listeners.get("editor-debug:stopped");
    const started = source?.listeners.get("editor-debug:session-started");
    if (stopped === undefined || started === undefined) {
      throw new Error("Expected debug lifecycle listeners.");
    }

    act(() => {
      for (const listener of stopped) {
        listener({
          data: JSON.stringify({
            sequence: 1,
            event: {
              kind: "stopped",
              sessionId: "session-1",
              pauseGeneration: 2,
              reason: "exception",
              allThreadsStopped: true,
              description: bounded("Fixture uncaught exception"),
            },
          }),
        } as MessageEvent);
      }
      for (const listener of started) {
        listener({
          data: JSON.stringify({
            sequence: 2,
            event: {
              kind: "session-started",
              sessionId: "session-1",
              status: "running",
            },
          }),
        } as MessageEvent);
      }
    });

    await waitFor(() => expect(result.current.snapshot.session?.status).toBe("paused"));
    expect(result.current.snapshot.stopDescription).toStrictEqual(
      bounded("Fixture uncaught exception"),
    );
    expect(vi.mocked(fetch).mock.calls).toContainEqual([
      "/api/editor/debug/sessions/session-1",
      expect.objectContaining({ headers: { "x-keiko-csrf": "1" } }),
    ]);
  });

  it("clears the active session after its terminal stream event without fetching a deleted session", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        return response(instrumentation());
      }
      if (url === "/api/editor/debug/sessions/session-1") return response(session("paused"));
      return response({});
    });
    const { result } = renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    const stopped = source?.listeners.get("editor-debug:stopped");
    const terminated = source?.listeners.get("editor-debug:session-stopped");
    if (stopped === undefined || terminated === undefined) {
      throw new Error("Expected debug lifecycle listeners.");
    }

    act(() => {
      for (const listener of stopped) {
        listener({
          data: JSON.stringify({
            sequence: 1,
            event: {
              kind: "stopped",
              sessionId: "session-1",
              pauseGeneration: 2,
              reason: "breakpoint",
              allThreadsStopped: true,
            },
          }),
        } as MessageEvent);
      }
    });
    await waitFor(() => expect(result.current.snapshot.session?.sessionId).toBe("session-1"));
    const callsBeforeTerminalEvent = vi.mocked(fetch).mock.calls.length;

    act(() => {
      for (const listener of terminated) {
        listener({
          data: JSON.stringify({
            sequence: 2,
            event: {
              kind: "session-stopped",
              sessionId: "session-1",
              status: "stopped",
              reason: "requested",
            },
          }),
        } as MessageEvent);
      }
    });

    await waitFor(() => expect(result.current.snapshot.session).toBeNull());
    expect(vi.mocked(fetch).mock.calls).toHaveLength(callsBeforeTerminalEvent);
  });
});
