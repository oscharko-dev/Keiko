import { act, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { DebugPanel } from "../panels/DebugPanel";
import { EditorDebugSessionHost } from "./EditorDebugSessionHost";
import { debugSessionSnapshot, resetDebugSessionStoreForTests } from "./debugSessionStore";
import { resetSharedEventSourcesForTests } from "./sharedEventSource";
import {
  pendingDebugStreamResyncRequestsForTests,
  resetDebugBootstrapRequestsForTests,
  useDebugSession,
} from "./useDebugSession";

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

function session(status: "paused" | "running" = "paused", pauseGeneration = 2): object {
  return {
    schemaVersion: "1",
    sessionId: "session-1",
    workspaceId: "canonical-workspace-id",
    status,
    targetKind: "file",
    activationRevision: 4,
    pauseGeneration,
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

function pausedSession(pauseGeneration = 2): ReturnType<typeof session> {
  return session("paused", pauseGeneration);
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

function emitDebugEvent(type: string, sequence: number, event: object, sourceIndex = 0): void {
  const listeners = FakeEventSource.instances[sourceIndex]?.listeners.get(type);
  if (listeners === undefined) throw new Error(`Expected ${type} listener.`);
  const message = new MessageEvent(type, {
    data: JSON.stringify({ sequence, event }),
    lastEventId: String(sequence),
  });
  for (const listener of listeners) listener(message);
}

function emitReplaySnapshot(type: string, sequence: number, sourceIndex = 0): void {
  const listeners = FakeEventSource.instances[sourceIndex]?.listeners.get(type);
  if (listeners === undefined) throw new Error(`Expected ${type} listener.`);
  const message = new MessageEvent(type, {
    data: JSON.stringify({
      sequence,
      retainedCount: 0,
      retainedBytes: 0,
      evictedCount: sequence,
      evictedBytes: sequence * 100,
    }),
    lastEventId: String(sequence),
  });
  for (const listener of listeners) listener(message);
}

function emitReplaySnapshotRequired(sequence = 20): void {
  emitReplaySnapshot("editor-debug:snapshot-required", sequence);
}

function emitStreamReady(sourceIndex = 0): void {
  const listeners = FakeEventSource.instances[sourceIndex]?.listeners.get("ready");
  if (listeners === undefined) throw new Error("Expected ready listener.");
  const message = new MessageEvent("ready", { data: "" });
  for (const listener of listeners) listener(message);
}

interface ProjectionRequestCounts {
  session: number;
  stack: number;
  scopes: number;
  variables: number;
}

function parsedRequestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") throw new Error("Expected a JSON request body.");
  return JSON.parse(init.body) as Record<string, unknown>;
}

function expectProtectedProjectionRequests(url: string): void {
  const calls = vi.mocked(fetch).mock.calls.filter(([input]) => {
    const requestedUrl = input instanceof Request ? input.url : input.toString();
    return requestedUrl === url;
  });
  expect(calls.length).toBeGreaterThan(0);
  for (const [, init] of calls) {
    expect(init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: expect.objectContaining({ "x-keiko-csrf": "1" }),
    });
  }
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
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
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

  it("single-flights concurrent direct session and variable requests", async () => {
    const sessionProjection = deferredResponse();
    const variableProjection = deferredResponse();
    let sessionRequests = 0;
    let variableRequests = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        return response(instrumentation());
      }
      if (url === "/api/editor/debug/sessions/session-1") {
        sessionRequests += 1;
        return sessionProjection.promise;
      }
      if (url === "/api/editor/debug/variables") {
        variableRequests += 1;
        return variableProjection.promise;
      }
      return response({});
    });
    const first = renderHook(() => useDebugSession("canonical-workspace-id", true));
    const second = renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    const pendingSessions = [
      first.result.current.actions.refreshSession("session-1"),
      second.result.current.actions.refreshSession("session-1"),
    ];
    await waitFor(() => expect(sessionRequests).toBe(1));
    sessionProjection.resolve(pausedSession());
    await act(async () => Promise.all(pendingSessions));
    const current = first.result.current.snapshot.session;
    if (current === null) throw new Error("Expected shared paused session.");

    const pendingVariables = [
      first.result.current.actions.loadVariables(current, "scope-1"),
      second.result.current.actions.loadVariables(current, "scope-1"),
    ];
    await waitFor(() => expect(variableRequests).toBe(1));
    variableProjection.resolve({ nodes: [], truncated: false, omittedCount: 0 });
    await act(async () => Promise.all(pendingVariables));

    expect(sessionRequests).toBe(1);
    expect(variableRequests).toBe(1);
    expect(first.result.current.snapshot.variablesByParent.has("scope-1")).toBe(true);
    expect(second.result.current.snapshot.variablesByParent.has("scope-1")).toBe(true);
  });

  it("isolates identical session and projection identities across workspaces", async () => {
    const secondaryWorkspaceId = "secondary-workspace-id";
    const sessionResponses = [deferredResponse(), deferredResponse()];
    const variableResponses = [deferredResponse(), deferredResponse()];
    let sessionRequests = 0;
    let variableRequests = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        return response(instrumentation());
      }
      if (url.endsWith(`/instrumentation?workspaceId=${secondaryWorkspaceId}`)) {
        return response({ ...instrumentation(), workspaceId: secondaryWorkspaceId });
      }
      if (url === "/api/editor/debug/sessions/session-1") {
        const pending = sessionResponses[sessionRequests];
        sessionRequests += 1;
        return pending?.promise ?? response({});
      }
      if (url === "/api/editor/debug/variables") {
        const pending = variableResponses[variableRequests];
        variableRequests += 1;
        return pending?.promise ?? response({});
      }
      return response({});
    });
    const first = renderHook(() => useDebugSession("canonical-workspace-id", true));
    const second = renderHook(() => useDebugSession(secondaryWorkspaceId, true));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));

    const pendingSessions = [
      first.result.current.actions.refreshSession("session-1"),
      second.result.current.actions.refreshSession("session-1"),
    ];
    await waitFor(() => expect(sessionRequests).toBe(2));
    sessionResponses[0]?.resolve(pausedSession());
    sessionResponses[1]?.resolve({ ...pausedSession(), workspaceId: secondaryWorkspaceId });
    await act(async () => Promise.all(pendingSessions));
    const firstSession = first.result.current.snapshot.session;
    const secondSession = second.result.current.snapshot.session;
    if (firstSession === null || secondSession === null) {
      throw new Error("Expected isolated paused sessions.");
    }

    const pendingVariables = [
      first.result.current.actions.loadVariables(firstSession, "scope-1"),
      second.result.current.actions.loadVariables(secondSession, "scope-1"),
    ];
    await waitFor(() => expect(variableRequests).toBe(2));
    variableResponses[0]?.resolve({ nodes: [], truncated: false, omittedCount: 0 });
    variableResponses[1]?.resolve({ nodes: [], truncated: false, omittedCount: 0 });
    await act(async () => Promise.all(pendingVariables));

    expect(first.result.current.snapshot.variablesByParent.has("scope-1")).toBe(true);
    expect(second.result.current.snapshot.variablesByParent.has("scope-1")).toBe(true);
  });

  it("single-flights the production host and panel stop-to-projection pipeline", async () => {
    const counts: ProjectionRequestCounts = { session: 0, stack: 0, scopes: 0, variables: 0 };
    const sessionProjection = deferredResponse();
    const firstStackPage = deferredResponse();
    const secondStackPage = deferredResponse();
    const scopeProjection = deferredResponse();
    const variableProjection = deferredResponse();
    const requestBodies = {
      stack: [] as object[],
      scopes: [] as object[],
      variables: [] as object[],
    };
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        return response(instrumentation());
      }
      if (url === "/api/editor/debug/sessions/session-1") {
        counts.session += 1;
        return sessionProjection.promise;
      }
      if (url === "/api/editor/debug/stack") {
        counts.stack += 1;
        requestBodies.stack.push(parsedRequestBody(init));
        return counts.stack === 1 ? firstStackPage.promise : secondStackPage.promise;
      }
      if (url === "/api/editor/debug/scopes") {
        counts.scopes += 1;
        requestBodies.scopes.push(parsedRequestBody(init));
        return scopeProjection.promise;
      }
      if (url === "/api/editor/debug/variables") {
        counts.variables += 1;
        requestBodies.variables.push(parsedRequestBody(init));
        return variableProjection.promise;
      }
      return response({});
    });
    render(
      <I18nProvider>
        <EditorDebugSessionHost
          root="/repo"
          workspaceId="canonical-workspace-id"
          activationRevision={4}
          enabled
          fileId="src/program.ts"
          onOpenDebugPanel={vi.fn()}
          onHostChange={vi.fn()}
          onSessionStateChange={vi.fn()}
        />
        <DebugPanel root="/repo" workspaceId="canonical-workspace-id" debugEnabled />
      </I18nProvider>,
    );
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() =>
      emitDebugEvent("editor-debug:stopped", 1, {
        kind: "stopped",
        sessionId: "session-1",
        pauseGeneration: 2,
        reason: "breakpoint",
        allThreadsStopped: true,
      }),
    );
    await waitFor(() => expect(counts.session).toBe(1));
    await act(async () => sessionProjection.resolve(pausedSession()));
    await waitFor(() => expect(counts.stack).toBe(1));
    await act(async () => {
      firstStackPage.resolve({
        frames: [{ frameRef: "frame-1", name: bounded("first"), line: 1, column: 1 }],
        truncated: true,
        omittedCount: 1,
        nextCursor: "stack-page-2",
      });
    });
    await waitFor(() => expect(counts.stack).toBe(2));
    await act(async () => {
      secondStackPage.resolve({
        frames: [{ frameRef: "frame-2", name: bounded("second"), line: 2, column: 1 }],
        truncated: false,
        omittedCount: 0,
      });
    });
    await waitFor(() => expect(counts.scopes).toBe(1));
    await act(async () => {
      scopeProjection.resolve({
        scopes: [
          { scopeRef: "scope-1", name: bounded("Local"), expensive: false, variableCount: 1 },
        ],
        truncated: false,
        omittedCount: 0,
      });
    });
    await waitFor(() => expect(counts.variables).toBe(1));
    await act(async () =>
      variableProjection.resolve({ nodes: [], truncated: false, omittedCount: 0 }),
    );
    await waitFor(() =>
      expect(debugSessionSnapshot("canonical-workspace-id").variablesByParent.has("scope-1")).toBe(
        true,
      ),
    );

    expect(counts).toEqual({ session: 1, stack: 2, scopes: 1, variables: 1 });
    expect(requestBodies.stack).toEqual([
      expect.objectContaining({ sessionId: "session-1", pauseGeneration: 2, startFrame: 0 }),
      expect.objectContaining({
        sessionId: "session-1",
        pauseGeneration: 2,
        cursor: "stack-page-2",
      }),
    ]);
    expect(requestBodies.scopes).toEqual([
      expect.objectContaining({ sessionId: "session-1", pauseGeneration: 2, frameRef: "frame-1" }),
    ]);
    expect(requestBodies.variables).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        pauseGeneration: 2,
        variableRef: "scope-1",
      }),
    ]);
    expectProtectedProjectionRequests("/api/editor/debug/stack");
    expectProtectedProjectionRequests("/api/editor/debug/scopes");
    expectProtectedProjectionRequests("/api/editor/debug/variables");

    act(() =>
      emitDebugEvent("editor-debug:stopped", 1, {
        kind: "stopped",
        sessionId: "session-1",
        pauseGeneration: 2,
        reason: "breakpoint",
        allThreadsStopped: true,
      }),
    );
    await act(async () => Promise.resolve());
    expect(counts).toEqual({ session: 1, stack: 2, scopes: 1, variables: 1 });
  });

  it("keeps distinct frame and variable references in separate shared requests", async () => {
    const scopeResponses = [deferredResponse(), deferredResponse()];
    const variableResponses = [deferredResponse(), deferredResponse()];
    const scopeBodies: Record<string, unknown>[] = [];
    const variableBodies: Record<string, unknown>[] = [];
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        return response(instrumentation());
      }
      if (url === "/api/editor/debug/sessions/session-1") return response(pausedSession());
      if (url === "/api/editor/debug/scopes") {
        scopeBodies.push(parsedRequestBody(init));
        return scopeResponses[scopeBodies.length - 1]?.promise ?? response({});
      }
      if (url === "/api/editor/debug/variables") {
        variableBodies.push(parsedRequestBody(init));
        return variableResponses[variableBodies.length - 1]?.promise ?? response({});
      }
      return response({});
    });
    const { result } = renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await act(async () => result.current.actions.refreshSession("session-1"));
    const current = result.current.snapshot.session;
    if (current === null) throw new Error("Expected paused session.");

    const pending = [
      result.current.actions.loadScopes(current, "frame-1"),
      result.current.actions.loadScopes(current, "frame-2"),
      result.current.actions.loadVariables(current, "scope-1"),
      result.current.actions.loadVariables(current, "scope-2"),
    ];
    await waitFor(() => {
      expect(scopeBodies).toHaveLength(2);
      expect(variableBodies).toHaveLength(2);
    });
    expect(scopeBodies.map((body) => body.frameRef).sort()).toEqual(["frame-1", "frame-2"]);
    expect(variableBodies.map((body) => body.variableRef).sort()).toEqual(["scope-1", "scope-2"]);

    scopeResponses[0]?.resolve({ scopes: [], truncated: false, omittedCount: 0 });
    scopeResponses[1]?.resolve({ scopes: [], truncated: false, omittedCount: 0 });
    variableResponses[0]?.resolve({ nodes: [], truncated: false, omittedCount: 0 });
    variableResponses[1]?.resolve({ nodes: [], truncated: false, omittedCount: 0 });
    await act(async () => Promise.all(pending));

    expect(result.current.snapshot.scopesByFrame.has("frame-1")).toBe(true);
    expect(result.current.snapshot.scopesByFrame.has("frame-2")).toBe(true);
    expect(result.current.snapshot.variablesByParent.has("scope-1")).toBe(true);
    expect(result.current.snapshot.variablesByParent.has("scope-2")).toBe(true);
  });

  it("isolates a replacement pause request from the old generation's late completion", async () => {
    const oldStack = deferredResponse();
    const newStack = deferredResponse();
    let sessionRequests = 0;
    let stackRequests = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        return response(instrumentation());
      }
      if (url === "/api/editor/debug/sessions/session-1") {
        sessionRequests += 1;
        return response(pausedSession(sessionRequests === 1 ? 2 : 3));
      }
      if (url === "/api/editor/debug/stack") {
        stackRequests += 1;
        return stackRequests === 1 ? oldStack.promise : newStack.promise;
      }
      return response({});
    });
    const { result } = renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await act(async () => result.current.actions.refreshSession("session-1"));
    const oldSession = result.current.snapshot.session;
    if (oldSession === null) throw new Error("Expected old paused session.");
    const oldPending = result.current.actions.loadStack(oldSession);
    await waitFor(() => expect(stackRequests).toBe(1));

    act(() =>
      emitDebugEvent("editor-debug:stopped", 1, {
        kind: "stopped",
        sessionId: "session-1",
        pauseGeneration: 3,
        reason: "step",
        allThreadsStopped: true,
      }),
    );
    await waitFor(() => expect(result.current.snapshot.session?.pauseGeneration).toBe(3));
    const replacementSession = result.current.snapshot.session;
    if (replacementSession === null) throw new Error("Expected replacement paused session.");
    const replacementPending = result.current.actions.loadStack(replacementSession);
    await waitFor(() => expect(stackRequests).toBe(2));

    oldStack.resolve({
      frames: [{ frameRef: "old-frame", name: bounded("old"), line: 1, column: 1 }],
      truncated: false,
      omittedCount: 0,
    });
    await act(async () => oldPending);
    const coalescedPending = result.current.actions.loadStack(replacementSession);
    await act(async () => Promise.resolve());
    expect(stackRequests).toBe(2);

    newStack.resolve({
      frames: [{ frameRef: "new-frame", name: bounded("new"), line: 2, column: 1 }],
      truncated: false,
      omittedCount: 0,
    });
    await act(async () => Promise.all([replacementPending, coalescedPending]));

    expect(result.current.snapshot.stack?.frames.map((frame) => frame.frameRef)).toEqual([
      "new-frame",
    ]);
    expect(stackRequests).toBe(2);
  });

  it("rejects a late paused response after another hook accepts continue", async () => {
    const staleSession = deferredResponse();
    const pendingWatches = deferredResponse();
    let sessionRequests = 0;
    let watchSignal: AbortSignal | undefined;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        return response(instrumentation());
      }
      if (url === "/api/editor/debug/sessions/session-1") {
        sessionRequests += 1;
        return sessionRequests === 1 ? staleSession.promise : response(session("running"));
      }
      if (url === "/api/editor/debug/watches") {
        watchSignal = init?.signal ?? undefined;
        return pendingWatches.promise;
      }
      return response({});
    });
    const first = renderHook(() => useDebugSession("canonical-workspace-id", true));
    const second = renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() =>
      emitDebugEvent("editor-debug:stopped", 1, {
        kind: "stopped",
        sessionId: "session-1",
        pauseGeneration: 2,
        reason: "breakpoint",
        allThreadsStopped: true,
      }),
    );
    await waitFor(() => expect(sessionRequests).toBe(1));
    act(() =>
      emitDebugEvent("editor-debug:continued", 2, {
        kind: "continued",
        sessionId: "session-1",
        pauseGeneration: 2,
      }),
    );
    await waitFor(() => expect(first.result.current.snapshot.session?.status).toBe("running"));
    expect(sessionRequests).toBe(2);
    const saveWatches = first.result.current.actions.saveWatches([
      { watchId: "watch-1", expression: "total", enabled: true },
    ]);
    await waitFor(() => expect(watchSignal).toBeDefined());
    expect(watchSignal?.aborted).toBe(false);

    await act(async () => {
      staleSession.resolve(pausedSession());
      await staleSession.promise;
      await Promise.resolve();
    });

    expect(watchSignal?.aborted).toBe(false);
    pendingWatches.resolve(
      mutationSnapshot({
        watches: [{ watchId: "watch-1", expression: "total", enabled: true }],
      }),
    );
    await act(async () => saveWatches);
    expect(first.result.current.snapshot.session?.status).toBe("running");
    expect(second.result.current.snapshot.session?.status).toBe("running");
  });

  it("aborts pre-lifecycle tracked requests owned by every hook consumer", async () => {
    const watchResponses = [deferredResponse(), deferredResponse()];
    const watchSignals: AbortSignal[] = [];
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        return response(instrumentation());
      }
      if (url === "/api/editor/debug/watches") {
        if (init?.signal != null) watchSignals.push(init.signal);
        return watchResponses[watchSignals.length - 1]?.promise ?? response({});
      }
      return response({});
    });
    const first = renderHook(() => useDebugSession("canonical-workspace-id", true));
    const second = renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    const pending = [
      first.result.current.actions.saveWatches([
        { watchId: "watch-1", expression: "first", enabled: true },
      ]),
      second.result.current.actions.saveWatches([
        { watchId: "watch-2", expression: "second", enabled: true },
      ]),
    ];
    await waitFor(() => expect(watchSignals).toHaveLength(2));
    act(() =>
      emitDebugEvent("editor-debug:continued", 1, {
        kind: "continued",
        sessionId: "session-1",
        pauseGeneration: 2,
      }),
    );

    await waitFor(() => expect(watchSignals.every((signal) => signal.aborted)).toBe(true));
    watchResponses[0]?.resolve(mutationSnapshot());
    watchResponses[1]?.resolve(mutationSnapshot());
    await act(async () => Promise.all(pending));
  });

  it("does not abort tracked requests owned by another workspace", async () => {
    const secondaryWorkspaceId = "secondary-workspace-id";
    const watchResponses = new Map([
      ["canonical-workspace-id", deferredResponse()],
      [secondaryWorkspaceId, deferredResponse()],
    ]);
    const watchSignals = new Map<string, AbortSignal>();
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.includes("/instrumentation?workspaceId=")) {
        const workspaceId = url.endsWith(secondaryWorkspaceId)
          ? secondaryWorkspaceId
          : "canonical-workspace-id";
        return response({ ...instrumentation(), workspaceId });
      }
      if (url === "/api/editor/debug/watches") {
        const workspaceId = String(parsedRequestBody(init).workspaceId);
        if (init?.signal != null) watchSignals.set(workspaceId, init.signal);
        return watchResponses.get(workspaceId)?.promise ?? response({});
      }
      return response({});
    });
    const first = renderHook(() => useDebugSession("canonical-workspace-id", true));
    const second = renderHook(() => useDebugSession(secondaryWorkspaceId, true));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    const pending = [
      first.result.current.actions.saveWatches([]),
      second.result.current.actions.saveWatches([]),
    ];
    await waitFor(() => expect(watchSignals.size).toBe(2));

    const continued = FakeEventSource.instances[0]?.listeners.get("editor-debug:continued");
    if (continued === undefined) throw new Error("Expected primary workspace listener.");
    act(() => {
      for (const listener of continued) {
        listener(
          new MessageEvent("editor-debug:continued", {
            data: JSON.stringify({
              sequence: 1,
              event: { kind: "continued", sessionId: "session-1", pauseGeneration: 2 },
            }),
            lastEventId: "1",
          }),
        );
      }
    });
    await waitFor(() => expect(watchSignals.get("canonical-workspace-id")?.aborted).toBe(true));
    expect(watchSignals.get(secondaryWorkspaceId)?.aborted).toBe(false);

    for (const [workspaceId, pendingResponse] of watchResponses) {
      pendingResponse.resolve(mutationSnapshot({ workspaceId }));
    }
    await act(async () => Promise.all(pending));
  });

  it("does not resurrect a terminal session from another hook's late refresh", async () => {
    const staleSession = deferredResponse();
    let sessionRequests = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        return response(instrumentation());
      }
      if (url === "/api/editor/debug/sessions/session-1") {
        sessionRequests += 1;
        return staleSession.promise;
      }
      return response({});
    });
    const first = renderHook(() => useDebugSession("canonical-workspace-id", true));
    const second = renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() =>
      emitDebugEvent("editor-debug:stopped", 1, {
        kind: "stopped",
        sessionId: "session-1",
        pauseGeneration: 2,
        reason: "breakpoint",
        allThreadsStopped: true,
      }),
    );
    await waitFor(() => expect(sessionRequests).toBe(1));
    act(() =>
      emitDebugEvent("editor-debug:session-stopped", 2, {
        kind: "session-stopped",
        sessionId: "session-1",
        status: "stopped",
        reason: "requested",
      }),
    );
    await waitFor(() => expect(debugSessionSnapshot("canonical-workspace-id").sequence).toBe(2));

    await act(async () => {
      staleSession.resolve(pausedSession());
      await staleSession.promise;
      await Promise.resolve();
    });

    expect(first.result.current.snapshot.session).toBeNull();
    expect(second.result.current.snapshot.session).toBeNull();
    expect(sessionRequests).toBe(1);
  });

  it("waits for initial instrumentation before persisting an immediate breakpoint", async () => {
    const initialInstrumentation = deferredResponse();
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
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
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        return response(instrumentation());
      }
      if (url === "/api/editor/debug/sessions/session-1") return response(pausedSession());
      if (url === "/api/editor/debug/stack") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { readonly cursor?: unknown };
        if (body.cursor === "stack-page-2") {
          return response({
            frames: [
              {
                frameRef: "frame-2",
                name: bounded("caller"),
                sourceFileId: "src/program.ts",
                line: 2,
                column: 1,
              },
            ],
            truncated: false,
            omittedCount: 0,
          });
        }
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
          omittedCount: 1,
          nextCursor: "stack-page-2",
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
    expect(result.current.snapshot.stack?.frames[1]).toMatchObject({ frameRef: "frame-2" });
    expect(vi.mocked(fetch).mock.calls).toContainEqual([
      "/api/editor/debug/stack",
      expect.objectContaining({ body: expect.stringContaining('"cursor":"stack-page-2"') }),
    ]);
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

  it("fails a stack projection closed when cursors exceed the two governed pages", async () => {
    let stackPage = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        return response(instrumentation());
      }
      if (url === "/api/editor/debug/sessions/session-1") return response(pausedSession());
      if (url !== "/api/editor/debug/stack") return response({});
      stackPage += 1;
      return response({
        frames: [
          {
            frameRef: `frame-${String(stackPage)}`,
            name: bounded("frame"),
            line: 1,
            column: 1,
          },
        ],
        truncated: true,
        omittedCount: 128 - stackPage,
        nextCursor: `cursor-${String(stackPage + 1)}`,
      });
    });
    const { result } = renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(result.current.snapshot.instrumentation).not.toBeNull());
    await act(async () => result.current.actions.refreshSession("session-1"));
    const current = result.current.snapshot.session;
    if (current === null) throw new Error("Expected paused session.");

    await act(async () => result.current.actions.loadStack(current));

    expect(stackPage).toBe(2);
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

  it("does not let a late shared session refresh replace a newly started session", async () => {
    const oldSession = deferredResponse();
    let oldRequestCount = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        return response(instrumentation());
      }
      if (url === "/api/editor/debug/sessions/session-1") {
        oldRequestCount += 1;
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
    await waitFor(() => expect(oldRequestCount).toBe(1));
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

  it("keeps shared inspection alive until the last hook consumer unmounts", async () => {
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
    const first = renderHook(() => useDebugSession("canonical-workspace-id", true));
    const second = renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await act(async () => first.result.current.actions.refreshSession("session-1"));
    const current = first.result.current.snapshot.session;
    if (current === null) throw new Error("Expected paused session.");
    const pending = first.result.current.actions.loadStack(current);
    await waitFor(() => expect(stackSignal).toBeDefined());

    first.unmount();
    expect(stackSignal?.aborted).toBe(false);
    second.unmount();
    expect(stackSignal?.aborted).toBe(true);
    stack.resolve({ frames: [], truncated: false, omittedCount: 0 });
    await pending;
  });

  it("keeps a same-key replacement mapped after the aborted request settles late", async () => {
    const oldVariables = deferredResponse();
    const newVariables = deferredResponse();
    const signals: AbortSignal[] = [];
    let variableRequests = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        return response(instrumentation());
      }
      if (url === "/api/editor/debug/sessions/session-1") return response(pausedSession());
      if (url === "/api/editor/debug/variables") {
        variableRequests += 1;
        if (init?.signal != null) signals.push(init.signal);
        return variableRequests === 1 ? oldVariables.promise : newVariables.promise;
      }
      return response({});
    });
    const first = renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await act(async () => first.result.current.actions.refreshSession("session-1"));
    const paused = first.result.current.snapshot.session;
    if (paused === null) throw new Error("Expected paused session.");
    const oldPending = first.result.current.actions.loadVariables(paused, "scope-1");
    await waitFor(() => expect(variableRequests).toBe(1));

    first.unmount();
    expect(signals[0]?.aborted).toBe(true);
    const second = renderHook(() => useDebugSession("canonical-workspace-id", true));
    const replacementPending = second.result.current.actions.loadVariables(paused, "scope-1");
    await waitFor(() => expect(variableRequests).toBe(2));
    expect(signals[1]?.aborted).toBe(false);

    oldVariables.resolve({ nodes: [], truncated: false, omittedCount: 0 });
    await act(async () => oldPending);
    const coalescedPending = second.result.current.actions.loadVariables(paused, "scope-1");
    await act(async () => Promise.resolve());
    expect(variableRequests).toBe(2);

    newVariables.resolve({ nodes: [], truncated: false, omittedCount: 0 });
    await act(async () => Promise.all([replacementPending, coalescedPending]));
    expect(second.result.current.snapshot.variablesByParent.has("scope-1")).toBe(true);
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

  it("does not let a two-consumer resync undo a successful step transition", async () => {
    const resyncInstrumentation = deferredResponse();
    let instrumentationCalls = 0;
    let sessionCalls = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        instrumentationCalls += 1;
        return instrumentationCalls === 1
          ? response(instrumentation())
          : resyncInstrumentation.promise;
      }
      if (url === "/api/editor/debug/sessions/session-1") {
        sessionCalls += 1;
        return response(pausedSession());
      }
      if (url === "/api/editor/debug/control") {
        return response({ sessionId: "session-1", status: "running" });
      }
      return response({});
    });
    const first = renderHook(() => useDebugSession("canonical-workspace-id", true));
    const second = renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await act(async () => first.result.current.actions.refreshSession("session-1"));
    const paused = first.result.current.snapshot.session;
    if (paused === null) throw new Error("Expected paused session.");

    act(() => emitReplaySnapshotRequired());
    await waitFor(() => expect(instrumentationCalls).toBe(2));
    await act(async () => first.result.current.actions.control(paused, "next"));
    expect(first.result.current.snapshot.session?.status).toBe("running");
    expect(second.result.current.snapshot.session?.status).toBe("running");
    resyncInstrumentation.resolve({ ...instrumentation(), revision: 4, etag: "resynced" });

    await waitFor(() => expect(first.result.current.snapshot.sequence).toBe(20));
    expect(sessionCalls).toBe(1);
    expect(first.result.current.snapshot.session?.status).toBe("running");
    expect(second.result.current.snapshot.session?.status).toBe("running");
  });

  it("does not fetch or resurrect a session stopped during two-consumer resync", async () => {
    const resyncInstrumentation = deferredResponse();
    let instrumentationCalls = 0;
    let sessionCalls = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        instrumentationCalls += 1;
        return instrumentationCalls === 1
          ? response(instrumentation())
          : resyncInstrumentation.promise;
      }
      if (url === "/api/editor/debug/sessions/session-1") {
        sessionCalls += 1;
        if (sessionCalls === 1) return response(pausedSession());
        return new Response(JSON.stringify({ code: "SESSION_NOT_FOUND" }), { status: 404 });
      }
      if (url === "/api/editor/debug/control") {
        return response({ sessionId: "session-1", status: "stopped" });
      }
      return response({});
    });
    const first = renderHook(() => useDebugSession("canonical-workspace-id", true));
    const second = renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await act(async () => first.result.current.actions.refreshSession("session-1"));
    const paused = first.result.current.snapshot.session;
    if (paused === null) throw new Error("Expected paused session.");

    act(() => emitReplaySnapshotRequired());
    await waitFor(() => expect(instrumentationCalls).toBe(2));
    await act(async () => first.result.current.actions.control(paused, "stop"));
    expect(first.result.current.snapshot.session).toBeNull();
    expect(second.result.current.snapshot.session).toBeNull();
    resyncInstrumentation.resolve({ ...instrumentation(), revision: 4, etag: "resynced" });

    await waitFor(() => expect(first.result.current.snapshot.sequence).toBe(20));
    expect(sessionCalls).toBe(1);
    act(() =>
      emitDebugEvent("editor-debug:output", 21, {
        kind: "output",
        sessionId: "session-1",
        category: "stdout",
        text: "after-stop-resync",
        truncated: false,
        originalBytes: 17,
        omittedBytes: 0,
      }),
    );
    await waitFor(() => expect(first.result.current.snapshot.sequence).toBe(21));
    expect(first.result.current.snapshot.console.entries[0]?.text).toBe("after-stop-resync");
  });

  it("recovers a lower ordinary-snapshot epoch after every consumer remounts", async () => {
    let instrumentationCalls = 0;
    let sessionCalls = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        instrumentationCalls += 1;
        return response({
          ...instrumentation(),
          revision: instrumentationCalls,
          etag: `instrumentation-${String(instrumentationCalls)}`,
        });
      }
      if (url === "/api/editor/debug/sessions/session-1") {
        sessionCalls += 1;
        return sessionCalls === 1
          ? response(pausedSession())
          : new Response(JSON.stringify({ code: "SESSION_NOT_FOUND" }), { status: 404 });
      }
      return response({});
    });
    const first = renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await act(async () => first.result.current.actions.refreshSession("session-1"));
    expect(first.result.current.snapshot.session?.status).toBe("paused");
    act(() =>
      emitDebugEvent("editor-debug:output", 7, {
        kind: "output",
        sessionId: "session-1",
        category: "stdout",
        text: "old-epoch",
        truncated: false,
        originalBytes: 9,
        omittedBytes: 0,
      }),
    );
    await waitFor(() => expect(first.result.current.snapshot.sequence).toBe(7));
    first.unmount();

    const second = renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(FakeEventSource.instances[1]?.url).toBe(
      "/api/editor/debug/events?workspaceId=canonical-workspace-id",
    );
    act(() => emitReplaySnapshot("editor-debug:snapshot", 2, 1));
    await waitFor(() => expect(second.result.current.snapshot.sequence).toBe(2));
    expect(second.result.current.snapshot.session).toBeNull();
    expect(sessionCalls).toBe(2);
    expect(second.result.current.snapshot.console.entries).toHaveLength(0);
    expect(pendingDebugStreamResyncRequestsForTests()).toBe(0);

    act(() =>
      emitDebugEvent(
        "editor-debug:output",
        3,
        {
          kind: "output",
          sessionId: "session-1",
          category: "stdout",
          text: "new-epoch",
          truncated: false,
          originalBytes: 9,
          omittedBytes: 0,
        },
        1,
      ),
    );
    await waitFor(() => expect(second.result.current.snapshot.sequence).toBe(3));
    expect(second.result.current.snapshot.console.entries[0]?.text).toBe("new-epoch");
    second.unmount();
    expect(pendingDebugStreamResyncRequestsForTests()).toBe(0);
  });

  it("automatically retries one failed resync before admitting ready or live events", async () => {
    let instrumentationCalls = 0;
    let rejectResync: ((reason: Error) => void) | undefined;
    const retryResync = deferredResponse();
    const rejectedResync = new Promise<Response>((_resolve, reject) => {
      rejectResync = reject;
    });
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        instrumentationCalls += 1;
        if (instrumentationCalls === 1) return response(instrumentation());
        return instrumentationCalls === 2 ? rejectedResync : retryResync.promise;
      }
      return response({});
    });
    const first = renderHook(() => useDebugSession("canonical-workspace-id", true));
    renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => emitReplaySnapshotRequired());
    await waitFor(() => expect(instrumentationCalls).toBe(2));
    if (rejectResync === undefined) throw new Error("Expected resync rejection handle.");
    const rejectPendingResync = rejectResync;
    act(() => rejectPendingResync(new Error("instrumentation unavailable")));
    await waitFor(() => expect(instrumentationCalls).toBe(3));
    act(() => {
      emitStreamReady();
      emitDebugEvent("editor-debug:output", 21, {
        kind: "output",
        sessionId: "session-1",
        category: "stdout",
        text: "after-rejected-resync",
        truncated: false,
        originalBytes: 21,
        omittedBytes: 0,
      });
    });
    expect(first.result.current.snapshot.streamReady).toBe(false);
    expect(first.result.current.snapshot.console.entries).toHaveLength(0);
    retryResync.resolve({ ...instrumentation(), revision: 4, etag: "retry-resynced" });

    await waitFor(() => expect(first.result.current.snapshot.sequence).toBe(21));
    expect(first.result.current.snapshot.streamReady).toBe(true);
    expect(first.result.current.snapshot.console.entries[0]?.text).toBe("after-rejected-resync");
  });

  it("keeps the generation fail-closed after both bounded resync attempts fail", async () => {
    let instrumentationCalls = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        instrumentationCalls += 1;
        if (instrumentationCalls === 1) return response(instrumentation());
        throw new Error("instrumentation unavailable");
      }
      return response({});
    });
    const first = renderHook(() => useDebugSession("canonical-workspace-id", true));
    renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => {
      emitReplaySnapshotRequired();
      emitStreamReady();
      emitDebugEvent("editor-debug:output", 21, {
        kind: "output",
        sessionId: "session-1",
        category: "stdout",
        text: "must-not-appear",
        truncated: false,
        originalBytes: 15,
        omittedBytes: 0,
      });
    });
    await waitFor(() => expect(instrumentationCalls).toBe(3));
    await waitFor(() => expect(pendingDebugStreamResyncRequestsForTests()).toBe(0));
    await act(async () => {
      for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    });

    expect(first.result.current.snapshot.sequence).toBe(0);
    expect(first.result.current.snapshot.streamReady).toBe(false);
    expect(first.result.current.snapshot.console.entries).toHaveLength(0);
  });

  it("shares one exhausted retry budget with a hook whose queue reaches the snapshot later", async () => {
    const staleSession = deferredResponse();
    let instrumentationCalls = 0;
    let sessionCalls = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        instrumentationCalls += 1;
        if (instrumentationCalls === 1) return response(instrumentation());
        throw new Error("instrumentation unavailable");
      }
      if (url === "/api/editor/debug/sessions/session-1") {
        sessionCalls += 1;
        return staleSession.promise;
      }
      return response({});
    });
    const first = renderHook(() => useDebugSession("canonical-workspace-id", true));
    renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() =>
      emitDebugEvent("editor-debug:stopped", 1, {
        kind: "stopped",
        sessionId: "session-1",
        pauseGeneration: 2,
        reason: "breakpoint",
        allThreadsStopped: true,
      }),
    );
    await waitFor(() => expect(sessionCalls).toBe(1));
    act(() => {
      emitReplaySnapshotRequired();
      emitStreamReady();
      emitDebugEvent("editor-debug:output", 21, {
        kind: "output",
        sessionId: "session-1",
        category: "stdout",
        text: "must-not-appear",
        truncated: false,
        originalBytes: 15,
        omittedBytes: 0,
      });
    });
    await waitFor(() => expect(instrumentationCalls).toBe(3));
    await waitFor(() => expect(pendingDebugStreamResyncRequestsForTests()).toBe(0));

    await act(async () => {
      staleSession.resolve(pausedSession());
      for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
    });

    expect(instrumentationCalls).toBe(3);
    expect(first.result.current.snapshot.sequence).toBe(1);
    expect(first.result.current.snapshot.streamReady).toBe(false);
    expect(first.result.current.snapshot.console.entries).toHaveLength(0);
    expect(pendingDebugStreamResyncRequestsForTests()).toBe(0);
  });

  it("keeps live events queued while the shared resync awaits its session", async () => {
    const resyncInstrumentation = deferredResponse();
    const resyncSession = deferredResponse();
    let instrumentationCalls = 0;
    let sessionCalls = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        instrumentationCalls += 1;
        return instrumentationCalls === 1
          ? response(instrumentation())
          : resyncInstrumentation.promise;
      }
      if (url === "/api/editor/debug/sessions/session-1") {
        sessionCalls += 1;
        return sessionCalls === 1 ? response(pausedSession()) : resyncSession.promise;
      }
      return response({});
    });
    const first = renderHook(() => useDebugSession("canonical-workspace-id", true));
    renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await act(async () => first.result.current.actions.refreshSession("session-1"));

    act(() => emitReplaySnapshotRequired());
    await waitFor(() => expect(instrumentationCalls).toBe(2));
    resyncInstrumentation.resolve({ ...instrumentation(), revision: 4, etag: "resynced" });
    await waitFor(() => expect(sessionCalls).toBe(2));

    act(() =>
      emitDebugEvent("editor-debug:output", 21, {
        kind: "output",
        sessionId: "session-1",
        category: "stdout",
        text: "once",
        truncated: false,
        originalBytes: 4,
        omittedBytes: 0,
      }),
    );
    expect(first.result.current.snapshot.console.entries).toHaveLength(0);
    await act(async () => {
      resyncSession.resolve(pausedSession());
      for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
    });

    await waitFor(() => expect(first.result.current.snapshot.sequence).toBe(21));
    expect(first.result.current.snapshot.console.entries).toHaveLength(1);
    expect(first.result.current.snapshot.console.entries[0]?.text).toBe("once");
  });

  it("does not let a delayed second hook repeat a completed destructive resync", async () => {
    const staleSession = deferredResponse();
    let instrumentationCalls = 0;
    let sessionCalls = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/instrumentation?workspaceId=canonical-workspace-id")) {
        instrumentationCalls += 1;
        return response({
          ...instrumentation(),
          revision: instrumentationCalls === 1 ? 0 : 4,
          etag: instrumentationCalls === 1 ? "debug-etag" : "resynced",
        });
      }
      if (url === "/api/editor/debug/sessions/session-1") {
        sessionCalls += 1;
        return staleSession.promise;
      }
      return response({});
    });
    const first = renderHook(() => useDebugSession("canonical-workspace-id", true));
    const second = renderHook(() => useDebugSession("canonical-workspace-id", true));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() =>
      emitDebugEvent("editor-debug:stopped", 1, {
        kind: "stopped",
        sessionId: "session-1",
        pauseGeneration: 2,
        reason: "breakpoint",
        allThreadsStopped: true,
      }),
    );
    await waitFor(() => expect(sessionCalls).toBe(1));
    act(() => emitReplaySnapshotRequired());
    await waitFor(() => expect(second.result.current.snapshot.sequence).toBe(20));
    act(() =>
      emitDebugEvent("editor-debug:output", 21, {
        kind: "output",
        sessionId: "session-1",
        category: "stdout",
        text: "retained-once",
        truncated: false,
        originalBytes: 13,
        omittedBytes: 0,
      }),
    );
    await waitFor(() => expect(second.result.current.snapshot.console.entries).toHaveLength(1));

    await act(async () => {
      staleSession.resolve(pausedSession());
      for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
    });

    expect(first.result.current.snapshot.sequence).toBe(21);
    expect(first.result.current.snapshot.console.entries).toHaveLength(1);
    expect(first.result.current.snapshot.console.entries[0]?.text).toBe("retained-once");
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
