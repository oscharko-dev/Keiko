import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EDITOR_VERIFICATION_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts";
import {
  resetEditorVerificationRunStateForTests,
  useEditorVerificationRun,
} from "./useEditorVerificationRun";

const V = EDITOR_VERIFICATION_SCHEMA_VERSION;

class FakeEventSource {
  public static instances: FakeEventSource[] = [];
  public static autoOpen = true;
  public readonly listeners = new Map<string, EventListener>();
  public closed = false;
  public constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
    queueMicrotask(() => {
      if (FakeEventSource.autoOpen) this.emitOpen();
    });
  }
  public addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener);
  }
  public close(): void {
    this.closed = true;
  }
  public emitOpen(): void {
    this.listeners.get("open")?.(new Event("open"));
  }
  public emit(kind: string, payload: Record<string, unknown>): void {
    this.listeners.get(`verification:${kind}`)?.({
      data: JSON.stringify({ schemaVersion: V, kind, ...payload }),
    } as unknown as Event);
  }
}

function completed(overall: string): Record<string, unknown> {
  return {
    report: {
      workspaceRoot: "/ws",
      results: [],
      overallStatus: overall,
      startedAtMs: 1,
      durationMs: 2,
      counts: {
        passed: 0,
        failed: 0,
        skipped: 0,
        denied: 0,
        "timed-out": 0,
        cancelled: 0,
        "resource-exceeded": 0,
      },
    },
  };
}

function response(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) } as Response;
}

function catalog(projectId = "/ws"): Record<string, unknown> {
  return {
    schemaVersion: V,
    projectId,
    kinds: ["test", "targeted-test", "typecheck", "lint", "build"].map((kind) => ({
      kind,
      available: true,
      trustState: "trusted",
    })),
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetEditorVerificationRunStateForTests();
  FakeEventSource.instances = [];
  FakeEventSource.autoOpen = true;
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.startsWith("/api/editor/verification/catalog")) {
      const projectId = decodeURIComponent(url.split("projectId=")[1] ?? "");
      return Promise.resolve(response(catalog(projectId)));
    }
    if (url === "/api/editor/verification/trust") return Promise.resolve(response({ ok: true }));
    if (init?.method === "DELETE") return Promise.resolve(response({ ok: true }));
    const request = JSON.parse(String(init?.body)) as {
      readonly projectId: string;
      readonly kinds: readonly string[];
      readonly targetPath?: string;
    };
    return Promise.resolve(
      response({
        runId: "run-1",
        projectId: request.projectId,
        kinds: request.kinds,
        ...(request.targetPath === undefined ? {} : { targetPath: request.targetPath }),
        state: "running",
        startedAtMs: 1,
      }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetEditorVerificationRunStateForTests();
});

function render(activeFile: string | null = "src/a.ts") {
  return renderHook(() => useEditorVerificationRun({ root: "/ws", activeFile }));
}

async function tick(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useEditorVerificationRun", () => {
  it("resolves the file-targeted verification target from the active file", () => {
    expect(render("src/foo.ts").result.current.verifiableTarget).toBe("src/foo.test.ts");
    expect(render(null).result.current.verifiableTarget).toBeNull();
  });

  it("opens no SSE connection while idle (lazy shared stream)", () => {
    render();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("starts a governed run, opens ONE shared stream, and reflects lifecycle then closes it", async () => {
    const { result } = render();
    await tick();
    await act(async () => {
      result.current.runWorkspaceVerification("typecheck");
    });
    await tick();
    expect(result.current.verificationRunning).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/verification/runs",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Keiko-CSRF": "1" }),
      }),
    );
    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0];
    await act(async () => {
      source?.emit("run-started", {
        runId: "run-1",
        projectId: "/ws",
        kinds: ["typecheck"],
        startedAtMs: 1,
      });
      source?.emit("run-completed", { runId: "run-1", ...completed("passed") });
    });
    await tick();
    expect(result.current.verificationRunning).toBe(false);
    expect(result.current.statusBarRun?.label).toContain("passed");
    expect(source?.closed).toBe(true);
  });

  it("waits for the SSE subscriber handshake before starting a run", async () => {
    FakeEventSource.autoOpen = false;
    const { result } = render();
    await tick();
    act(() => result.current.runWorkspaceVerification("typecheck"));

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          url === "/api/editor/verification/runs" &&
          (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toHaveLength(0);

    await act(async () => {
      FakeEventSource.instances[0]?.emitOpen();
      await Promise.resolve();
    });
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          url === "/api/editor/verification/runs" &&
          (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it("fails closed without posting when the SSE handshake never opens", async () => {
    vi.useFakeTimers();
    FakeEventSource.autoOpen = false;
    try {
      const { result } = render();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      act(() => result.current.runWorkspaceVerification("typecheck"));

      await act(async () => {
        vi.advanceTimersByTime(10_000);
        await Promise.resolve();
      });

      expect(result.current.verificationRunning).toBe(false);
      expect(result.current.statusBarRun?.label).toBe("Verification: failed to start");
      expect(FakeEventSource.instances[0]?.closed).toBe(true);
      expect(fetchMock.mock.calls.some(([url]) => url === "/api/editor/verification/runs")).toBe(
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the resolved target path for a file-targeted run", async () => {
    const { result } = render("src/foo.ts");
    await tick();
    await act(async () => {
      result.current.runFileTests();
    });
    const startCall = fetchMock.mock.calls.find(([url]) => url === "/api/editor/verification/runs");
    const init = startCall?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      projectId: "/ws",
      kinds: ["targeted-test"],
      targetPath: "src/foo.test.ts",
    });
  });

  it("cancels the active run via DELETE using the adopted run id", async () => {
    const { result } = render();
    await tick();
    await act(async () => {
      result.current.runWorkspaceVerification("lint");
    });
    await tick();
    await act(async () => {
      FakeEventSource.instances[0]?.emit("run-started", {
        runId: "run-1",
        projectId: "/ws",
        kinds: ["lint"],
        startedAtMs: 1,
      });
    });
    await act(async () => {
      result.current.cancelVerification();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/verification/runs/run-1",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({ "X-Keiko-CSRF": "1" }),
      }),
    );
  });

  it("coalesces a burst of SSE events into a bounded number of renders", async () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useEditorVerificationRun({ root: "/ws", activeFile: "src/a.ts" });
    });
    await tick();
    await act(async () => {
      result.current.runWorkspaceVerification("test");
    });
    await tick();
    const source = FakeEventSource.instances[0];
    const before = renders;
    await act(async () => {
      source?.emit("run-started", {
        runId: "run-1",
        projectId: "/ws",
        kinds: ["test"],
        startedAtMs: 1,
      });
      source?.emit("step-started", { runId: "run-1", stepKind: "test" });
      source?.emit("step-completed", {
        runId: "run-1",
        stepKind: "test",
        status: "failed",
        durationMs: 5,
      });
    });
    await tick();
    expect(renders - before).toBeLessThanOrEqual(1);
    expect(result.current.statusBarRun?.label).toContain("failed");
  });

  it("dismisses a terminal result after a delay instead of masking status forever (Issue #2212 fix-up)", async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() =>
        useEditorVerificationRun({ root: "/ws", activeFile: null }),
      );
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      act(() => {
        result.current.runWorkspaceVerification("typecheck");
      });
      await act(async () => {
        await Promise.resolve();
      });
      const source = FakeEventSource.instances[0];
      await act(async () => {
        source?.emit("run-started", {
          runId: "run-1",
          projectId: "/ws",
          kinds: ["typecheck"],
          startedAtMs: 1,
        });
        source?.emit("run-completed", { runId: "run-1", ...completed("passed") });
        await Promise.resolve();
      });
      expect(result.current.statusBarRun?.label).toContain("passed");
      await act(async () => {
        vi.advanceTimersByTime(10_000);
        await Promise.resolve();
      });
      expect(result.current.statusBarRun).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending dismiss when a new run starts before the delay elapses", async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() =>
        useEditorVerificationRun({ root: "/ws", activeFile: null }),
      );
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      act(() => {
        result.current.runWorkspaceVerification("typecheck");
      });
      await act(async () => {
        await Promise.resolve();
      });
      let source = FakeEventSource.instances[0];
      await act(async () => {
        source?.emit("run-started", {
          runId: "run-1",
          projectId: "/ws",
          kinds: ["typecheck"],
          startedAtMs: 1,
        });
        source?.emit("run-completed", { runId: "run-1", ...completed("passed") });
        await Promise.resolve();
      });
      expect(result.current.statusBarRun?.label).toContain("passed");
      act(() => {
        result.current.runWorkspaceVerification("lint");
      });
      await act(async () => {
        await Promise.resolve();
      });
      source = FakeEventSource.instances.at(-1);
      await act(async () => {
        source?.emit("run-started", {
          runId: "run-2",
          projectId: "/ws",
          kinds: ["lint"],
          startedAtMs: 2,
        });
        await Promise.resolve();
      });
      // The dismiss timer scheduled after run-1's completion must not wipe run-2's live status.
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(result.current.statusBarRun?.label).toContain("starting");
    } finally {
      vi.useRealTimers();
    }
  });

  it("scopes run state per project root — a run in one project does not appear in another's status bar (Epic #2092 fix-up)", async () => {
    const hookA = renderHook(() =>
      useEditorVerificationRun({ root: "/project-a", activeFile: null }),
    );
    const hookB = renderHook(() =>
      useEditorVerificationRun({ root: "/project-b", activeFile: null }),
    );
    expect(hookA.result.current.statusBarRun).toBeNull();
    expect(hookB.result.current.statusBarRun).toBeNull();
    await tick();

    await act(async () => {
      hookA.result.current.runWorkspaceVerification("typecheck");
      await Promise.resolve();
    });
    const source = FakeEventSource.instances.at(-1);
    // Simulates an AGENT-triggered run (Issue #2214/#2215): the browser never called startRun for it,
    // so run-started's own projectId is the ONLY signal that could route it — there is no POST
    // response client-side to fall back on.
    await act(async () => {
      source?.emit("run-started", {
        runId: "agent-run-1",
        projectId: "/project-a",
        kinds: ["lint"],
        startedAtMs: 1,
      });
      await Promise.resolve();
    });
    expect(hookA.result.current.statusBarRun?.busy).toBe(true);
    expect(hookB.result.current.statusBarRun).toBeNull();

    await act(async () => {
      source?.emit("run-completed", { runId: "agent-run-1", ...completed("passed") });
      await Promise.resolve();
    });
    expect(hookA.result.current.statusBarRun?.label).toContain("passed");
    expect(hookB.result.current.statusBarRun).toBeNull();
  });

  it.each([
    ["non-ok", () => Promise.resolve(response({ code: "DENIED" }, false))],
    ["malformed", () => Promise.resolve(response({ runId: undefined }))],
    ["network", () => Promise.reject(new Error("offline"))],
  ])("settles and dismisses a %s start failure", async (_label, failedStart) => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (url.startsWith("/api/editor/verification/catalog")) {
          return Promise.resolve(response(catalog()));
        }
        if (url === "/api/editor/verification/runs" && init?.method === "POST") {
          return failedStart();
        }
        return Promise.resolve(response({ ok: true }));
      });
      const { result } = render();
      await tick();
      act(() => result.current.runWorkspaceVerification("typecheck"));
      await tick();
      expect(result.current.verificationRunning).toBe(false);
      expect(result.current.statusBarRun?.label).toBe("Verification: failed to start");
      await act(async () => {
        vi.advanceTimersByTime(10_000);
        await Promise.resolve();
      });
      expect(result.current.statusBarRun).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces double start and queues one cancel while the POST response is pending", async () => {
    let resolveStart: ((value: Response) => void) | undefined;
    const pendingStart = new Promise<Response>((resolve) => {
      resolveStart = resolve;
    });
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith("/api/editor/verification/catalog")) {
        return Promise.resolve(response(catalog()));
      }
      if (url === "/api/editor/verification/runs" && init?.method === "POST") return pendingStart;
      return Promise.resolve(response({ ok: true }));
    });
    const { result } = render();
    await tick();
    act(() => {
      result.current.runWorkspaceVerification("lint");
      result.current.runWorkspaceVerification("lint");
      result.current.cancelVerification();
      result.current.cancelVerification();
    });
    await tick();
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          url === "/api/editor/verification/runs" &&
          (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toHaveLength(1);

    resolveStart?.(
      response({
        runId: "run-race",
        projectId: "/ws",
        kinds: ["lint"],
        state: "running",
        startedAtMs: 1,
      }),
    );
    await tick();
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          url === "/api/editor/verification/runs/run-race" &&
          (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toHaveLength(1);
  });

  it("surfaces a rejected cancel and never treats malformed DELETE data as success", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith("/api/editor/verification/catalog")) {
        return Promise.resolve(response(catalog()));
      }
      if (init?.method === "DELETE") return Promise.resolve(response({ ok: false }));
      return Promise.resolve(
        response({
          runId: "run-1",
          projectId: "/ws",
          kinds: ["lint"],
          state: "running",
          startedAtMs: 1,
        }),
      );
    });
    const { result } = render();
    await tick();
    act(() => result.current.runWorkspaceVerification("lint"));
    await tick();
    act(() => result.current.cancelVerification());
    await tick();
    expect(result.current.verificationRunning).toBe(true);
    expect(result.current.statusBarRun?.label).toBe("Verification: cancel failed");
  });

  it("uses exact trust mutation requests and refreshes the guarded catalog", async () => {
    const { result } = render();
    await tick();
    act(() => result.current.trustWorkspaceScripts());
    await tick();
    act(() => result.current.revokeWorkspaceScriptTrust());
    await tick();
    const trustCalls = fetchMock.mock.calls.filter(
      ([url]) => url === "/api/editor/verification/trust",
    );
    expect(trustCalls.map(([, init]) => (init as RequestInit).method)).toEqual(["POST", "DELETE"]);
    for (const [, init] of trustCalls) {
      expect(JSON.parse(String((init as RequestInit).body))).toEqual({ projectId: "/ws" });
      expect((init as RequestInit).headers).toEqual(
        expect.objectContaining({ "X-Keiko-CSRF": "1" }),
      );
    }
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).startsWith("/api/editor/verification/catalog?projectId="),
      ),
    ).toHaveLength(3);
  });
});
