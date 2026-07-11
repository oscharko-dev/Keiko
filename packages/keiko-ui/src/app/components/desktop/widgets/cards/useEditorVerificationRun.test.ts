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
  public readonly listeners = new Map<string, EventListener>();
  public closed = false;
  public constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  public addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener);
  }
  public close(): void {
    this.closed = true;
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

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetEditorVerificationRunStateForTests();
  FakeEventSource.instances = [];
  fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    const body = init?.method === "DELETE" ? { ok: true } : { runId: "run-1" };
    return Promise.resolve({ json: () => Promise.resolve(body) } as Response);
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
    await act(async () => {
      result.current.runWorkspaceVerification("typecheck");
    });
    await tick();
    expect(result.current.verificationRunning).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/verification/runs",
      expect.objectContaining({ method: "POST" }),
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

  it("sends the resolved target path for a file-targeted run", async () => {
    const { result } = render("src/foo.ts");
    await act(async () => {
      result.current.runFileTests();
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      projectId: "/ws",
      kinds: ["targeted-test"],
      targetPath: "src/foo.test.ts",
    });
  });

  it("cancels the active run via DELETE using the adopted run id", async () => {
    const { result } = render();
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
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("coalesces a burst of SSE events into a bounded number of renders", async () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useEditorVerificationRun({ root: "/ws", activeFile: "src/a.ts" });
    });
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
});
