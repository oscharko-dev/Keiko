import { act, renderHook } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EDITOR_VERIFICATION_SCHEMA_VERSION,
  WORKSPACE_TRUST_SCHEMA_VERSION,
} from "@oscharko-dev/keiko-contracts";
import { WORKSPACE_TRUST_CHANGED_EVENT } from "../../../../../lib/workspace-trust-api";
import {
  resetEditorVerificationRunStateForTests,
  useEditorVerificationRun,
  type EditorVerificationRunControls,
} from "./useEditorVerificationRun";
import {
  getEditorProblems,
  getEditorProblemsSourceHealth,
  resetEditorProblemsStoreForTests,
  setVerificationReport,
  subscribeEditorProblems,
} from "./editorProblemsStore";

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
  public emitError(): void {
    this.listeners.get("error")?.(new Event("error"));
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
    workspaceTrust: trustStatus(projectId, "trusted"),
    kinds: ["test", "targeted-test", "typecheck", "lint", "build"].map((kind) => ({
      kind,
      available: true,
      trustState: "trusted",
    })),
  };
}

function trustStatus(projectId: string, trust: "trusted" | "restricted"): Record<string, unknown> {
  return {
    kind: "workspace-trust-status",
    schemaVersion: WORKSPACE_TRUST_SCHEMA_VERSION,
    projectId,
    trust,
    decidedBy: "server",
    reason: trust === "trusted" ? "human-grant" : "human-revocation",
    revision: 1,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetEditorVerificationRunStateForTests();
  resetEditorProblemsStoreForTests();
  FakeEventSource.instances = [];
  FakeEventSource.autoOpen = true;
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.startsWith("/api/editor/verification/catalog")) {
      const projectId = decodeURIComponent(url.split("projectId=")[1] ?? "");
      return Promise.resolve(response(catalog(projectId)));
    }
    if (url === "/api/editor/verification/trust") {
      return Promise.resolve(
        response(trustStatus("/ws", init?.method === "POST" ? "trusted" : "restricted")),
      );
    }
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
  resetEditorProblemsStoreForTests();
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

interface DeferredResponse {
  readonly promise: Promise<Response>;
  readonly resolve: (value: Response) => void;
}

// A catalog request that stays in flight until the test releases it, so an "is it settled YET?"
// assertion has a deterministic window instead of racing an already-resolved promise.
function deferredResponse(): DeferredResponse {
  let settle: (value: Response) => void = () => undefined;
  const promise = new Promise<Response>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: (value: Response): void => settle(value) };
}

function isCatalogRequest(url: string, projectId?: string): boolean {
  const prefix = "/api/editor/verification/catalog";
  return projectId === undefined
    ? url.startsWith(prefix)
    : url.startsWith(`${prefix}?projectId=${encodeURIComponent(projectId)}`);
}

// Records COMMITTED renders only (`${root}:${catalogSettled}`). The render-phase reset in the hook
// discards its first pass, and the DOM an observer polls only ever reflects committed renders — so
// a pin on "what did the commit that bound this root report" must be taken from an effect, never
// from the render body.
function useObservedRun(root: string, observed: string[]): EditorVerificationRunControls {
  const controls = useEditorVerificationRun({ root, activeFile: null });
  useEffect(() => {
    observed.push(`${root}:${String(controls.catalogSettled)}`);
  });
  return controls;
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

  it("keeps an active run tracked while another project joins the recovered shared stream", async () => {
    vi.useFakeTimers();
    try {
      const hookA = renderHook(() =>
        useEditorVerificationRun({ root: "/project-a", activeFile: null }),
      );
      const hookB = renderHook(() =>
        useEditorVerificationRun({ root: "/project-b", activeFile: null }),
      );
      await tick();

      act(() => hookA.result.current.runWorkspaceVerification("typecheck"));
      await tick();
      const source = FakeEventSource.instances[0];
      await act(async () => {
        source?.emit("run-started", {
          runId: "run-a",
          projectId: "/project-a",
          kinds: ["typecheck"],
          startedAtMs: 1,
        });
        source?.emitError();
        await Promise.resolve();
      });

      act(() => hookB.result.current.runWorkspaceVerification("lint"));
      await act(async () => {
        vi.advanceTimersByTime(1_000);
        await Promise.resolve();
        await Promise.resolve();
      });

      const recoveredSource = FakeEventSource.instances[1];
      expect(source?.closed).toBe(true);
      expect(recoveredSource?.closed).toBe(false);
      expect(hookA.result.current.verificationRunning).toBe(true);
      expect(hookB.result.current.verificationRunning).toBe(true);

      await act(async () => {
        recoveredSource?.emit("run-completed", { runId: "run-a", ...completed("passed") });
        recoveredSource?.emit("run-completed", { runId: "run-1", ...completed("passed") });
        await Promise.resolve();
      });
      expect(hookA.result.current.statusBarRun?.label).toContain("passed");
      expect(hookB.result.current.statusBarRun?.label).toContain("passed");
      expect(recoveredSource?.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reopens the one shared stream and restores root health after a fresh terminal event", async () => {
    vi.useFakeTimers();
    const unsubscribe = subscribeEditorProblems("/ws", vi.fn());
    try {
      const { result } = render();
      await tick();
      act(() => result.current.runWorkspaceVerification("typecheck"));
      await tick();
      const first = FakeEventSource.instances[0];
      FakeEventSource.autoOpen = false;

      act(() => first?.emitError());
      expect(first?.closed).toBe(true);
      expect(getEditorProblemsSourceHealth("/ws")).toBe("reconnecting");
      expect(FakeEventSource.instances).toHaveLength(1);

      act(() => vi.advanceTimersByTime(1_000));
      expect(FakeEventSource.instances).toHaveLength(2);
      expect(FakeEventSource.instances.filter((source) => !source.closed)).toHaveLength(1);
      expect(getEditorProblemsSourceHealth("/ws")).toBe("reconnecting");

      act(() => FakeEventSource.instances[1]?.emitOpen());
      expect(getEditorProblemsSourceHealth("/ws")).toBe("failed");

      act(() =>
        FakeEventSource.instances[1]?.emit("run-completed", {
          runId: "run-1",
          ...completed("passed"),
        }),
      );
      expect(getEditorProblemsSourceHealth("/ws")).toBe("healthy");
    } finally {
      unsubscribe();
      vi.useRealTimers();
    }
  });

  it("fails closed when the terminal event is lost during a successful reconnect", async () => {
    vi.useFakeTimers();
    const unsubscribe = subscribeEditorProblems("/ws", vi.fn());
    try {
      const { result } = render();
      await tick();
      act(() => result.current.runWorkspaceVerification("typecheck"));
      await tick();
      const first = FakeEventSource.instances[0];
      FakeEventSource.autoOpen = false;

      act(() => first?.emitError());
      act(() => vi.advanceTimersByTime(1_000));
      const replacement = FakeEventSource.instances[1];
      act(() => replacement?.emitOpen());

      expect(result.current.verificationRunning).toBe(true);
      expect(getEditorProblemsSourceHealth("/ws")).toBe("failed");

      await act(async () => {
        vi.advanceTimersByTime(10_000);
        await Promise.resolve();
      });

      expect(result.current.verificationRunning).toBe(false);
      expect(result.current.statusBarRun?.label).toBe("Verification: status unknown");
      expect(getEditorProblemsSourceHealth("/ws")).toBe("failed");
      expect(replacement?.closed).toBe(true);

      FakeEventSource.autoOpen = true;
      act(() => result.current.runWorkspaceVerification("lint"));
      await tick();
      expect(
        fetchMock.mock.calls.filter(
          ([url, init]) =>
            url === "/api/editor/verification/runs" &&
            (init as RequestInit | undefined)?.method === "POST",
        ),
      ).toHaveLength(2);
      await act(async () => {
        vi.advanceTimersByTime(10_000);
        await Promise.resolve();
      });
      expect(result.current.verificationRunning).toBe(true);
    } finally {
      unsubscribe();
      vi.useRealTimers();
    }
  });

  it("re-arms terminal reconciliation while a recovered stream delivers fresh activity", async () => {
    vi.useFakeTimers();
    const unsubscribe = subscribeEditorProblems("/ws", vi.fn());
    try {
      const { result } = render();
      await tick();
      act(() => result.current.runWorkspaceVerification("typecheck"));
      await tick();
      FakeEventSource.autoOpen = false;

      act(() => FakeEventSource.instances[0]?.emitError());
      act(() => vi.advanceTimersByTime(1_000));
      const replacement = FakeEventSource.instances[1];
      act(() => replacement?.emitOpen());

      await act(async () => {
        vi.advanceTimersByTime(9_000);
        replacement?.emit("step-started", { runId: "run-1", stepKind: "typecheck" });
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(9_000);
        await Promise.resolve();
      });

      expect(result.current.verificationRunning).toBe(true);
      expect(result.current.statusBarRun?.label).toBe("Verification: typecheck…");
      expect(getEditorProblemsSourceHealth("/ws")).toBe("failed");

      await act(async () => {
        replacement?.emit("step-completed", {
          runId: "run-1",
          stepKind: "typecheck",
          status: "passed",
          durationMs: 18_000,
        });
        vi.advanceTimersByTime(9_000);
        replacement?.emit("run-completed", { runId: "run-1", ...completed("passed") });
        await Promise.resolve();
      });

      expect(result.current.verificationRunning).toBe(false);
      expect(result.current.statusBarRun?.label).toBe("Verification: passed");
      expect(getEditorProblemsSourceHealth("/ws")).toBe("healthy");
    } finally {
      unsubscribe();
      vi.useRealTimers();
    }
  });

  it("settles a replacement that never opens as failed instead of reconnecting forever", async () => {
    vi.useFakeTimers();
    let unsubscribe = subscribeEditorProblems("/ws", vi.fn());
    try {
      const { result } = render();
      await tick();
      act(() => result.current.runWorkspaceVerification("typecheck"));
      await tick();
      FakeEventSource.autoOpen = false;

      act(() => FakeEventSource.instances[0]?.emitError());
      act(() => vi.advanceTimersByTime(1_000));
      const replacement = FakeEventSource.instances[1];
      expect(getEditorProblemsSourceHealth("/ws")).toBe("reconnecting");

      act(() => vi.advanceTimersByTime(10_000));
      await tick();
      expect(replacement?.closed).toBe(true);
      expect(getEditorProblemsSourceHealth("/ws")).toBe("failed");
      expect(result.current.verificationRunning).toBe(false);
      expect(result.current.statusBarRun?.label).toBe("Verification: status unknown");

      unsubscribe();
      expect(getEditorProblemsSourceHealth("/ws")).toBe("failed");
      unsubscribe = subscribeEditorProblems("/ws", vi.fn());
      FakeEventSource.autoOpen = true;
      act(() => result.current.runWorkspaceVerification("lint"));
      await tick();
      expect(result.current.verificationRunning).toBe(true);
      expect(getEditorProblemsSourceHealth("/ws")).toBe("failed");
      expect(
        fetchMock.mock.calls.filter(
          ([url, init]) =>
            url === "/api/editor/verification/runs" &&
            (init as RequestInit | undefined)?.method === "POST",
        ),
      ).toHaveLength(2);
      act(() =>
        FakeEventSource.instances.at(-1)?.emit("run-completed", {
          runId: "run-1",
          ...completed("passed"),
        }),
      );
      expect(getEditorProblemsSourceHealth("/ws")).toBe("healthy");
    } finally {
      unsubscribe();
      vi.useRealTimers();
    }
  });

  it("marks only affected roots failed after bounded reopen attempts and retains stale rows", async () => {
    vi.useFakeTimers();
    try {
      const hookA = renderHook(() =>
        useEditorVerificationRun({ root: "/project-a", activeFile: null }),
      );
      renderHook(() => useEditorVerificationRun({ root: "/project-b", activeFile: null }));
      await tick();
      setVerificationReport("/project-a", {
        workspaceRoot: "/project-a",
        results: [
          {
            kind: "typecheck",
            scriptName: "typecheck",
            command: "npm",
            args: [],
            status: "failed",
            exitCode: 2,
            signal: null,
            durationMs: 1,
            truncated: false,
            redacted: true,
            outputSummary: "stale",
            appliedLimits: [],
            locations: [{ file: "src/stale.ts", line: 7, message: "stale" }],
          },
        ],
        overallStatus: "failed",
        startedAtMs: 1,
        durationMs: 2,
        counts: {
          passed: 0,
          failed: 1,
          skipped: 0,
          denied: 0,
          "timed-out": 0,
          cancelled: 0,
          "resource-exceeded": 0,
        },
      });
      act(() => hookA.result.current.runWorkspaceVerification("typecheck"));
      await tick();
      FakeEventSource.autoOpen = false;

      for (const delay of [1_000, 2_000, 4_000]) {
        act(() => FakeEventSource.instances.at(-1)?.emitError());
        expect(getEditorProblemsSourceHealth("/project-a")).toBe("reconnecting");
        act(() => vi.advanceTimersByTime(delay));
      }
      act(() => FakeEventSource.instances.at(-1)?.emitError());
      await tick();

      expect(FakeEventSource.instances).toHaveLength(4);
      expect(getEditorProblemsSourceHealth("/project-a")).toBe("failed");
      expect(hookA.result.current.verificationRunning).toBe(false);
      expect(hookA.result.current.statusBarRun?.label).toBe("Verification: status unknown");
      expect(getEditorProblems("/project-a").map((problem) => problem.file)).toEqual([
        "src/stale.ts",
      ]);
      expect(getEditorProblemsSourceHealth("/project-b")).toBe("healthy");

      FakeEventSource.autoOpen = true;
      act(() => hookA.result.current.runWorkspaceVerification("lint"));
      await tick();
      expect(hookA.result.current.verificationRunning).toBe(true);
      expect(getEditorProblemsSourceHealth("/project-a")).toBe("failed");
      expect(getEditorProblems("/project-a").map((problem) => problem.file)).toEqual([
        "src/stale.ts",
      ]);
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
    await tick();
    expect(result.current.verificationRunning).toBe(false);
    expect(result.current.statusBarRun?.label).toBe("Verification: cancelled");
  });

  it("keeps an acknowledged cancellation visible when the terminal SSE was dismissed before DELETE returns", async () => {
    vi.useFakeTimers();
    let resolveDelete: ((value: Response) => void) | undefined;
    const pendingDelete = new Promise<Response>((resolve) => {
      resolveDelete = resolve;
    });
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith("/api/editor/verification/catalog")) {
        return Promise.resolve(response(catalog()));
      }
      if (init?.method === "DELETE") return pendingDelete;
      return Promise.resolve(
        response({
          runId: "run-1",
          projectId: "/ws",
          kinds: ["build"],
          state: "running",
          startedAtMs: 1,
        }),
      );
    });
    try {
      const { result } = render();
      await tick();
      act(() => result.current.runWorkspaceVerification("build"));
      await tick();
      const source = FakeEventSource.instances[0];
      await act(async () => {
        source?.emit("run-started", {
          runId: "run-1",
          projectId: "/ws",
          kinds: ["build"],
          startedAtMs: 1,
        });
        source?.emit("step-started", { runId: "run-1", stepKind: "build" });
        await Promise.resolve();
      });
      expect(result.current.statusBarRun?.label).toBe("Verification: build…");

      act(() => result.current.cancelVerification());
      await tick();
      expect(result.current.statusBarRun?.label).toBe("Verification: cancelling…");
      await act(async () => {
        source?.emit("run-cancelled", { runId: "run-1" });
        await Promise.resolve();
      });
      expect(result.current.statusBarRun?.label).toBe("Verification: cancelled");

      await act(async () => {
        vi.advanceTimersByTime(10_000);
        await Promise.resolve();
      });
      expect(result.current.statusBarRun).toBeNull();

      await act(async () => {
        resolveDelete?.(response({ ok: true }));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(result.current.verificationRunning).toBe(false);
      expect(result.current.statusBarRun?.label).toBe("Verification: cancelled");
    } finally {
      vi.useRealTimers();
    }
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

  it("does not strand a terminal status when cancel is requested after the run already settled", async () => {
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

      act(() => {
        result.current.cancelVerification();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).startsWith("/api/editor/verification/runs/") &&
            (init as RequestInit | undefined)?.method === "DELETE",
        ),
      ).toBe(false);
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
    await act(async () => {
      await result.current.trustWorkspaceScripts();
    });
    await act(async () => {
      await result.current.revokeWorkspaceScriptTrust();
    });
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

  // Issue #2696 — `catalogSettled` is the deterministic readiness signal the editor's
  // `data-trust-settled` attribute is derived from. It must latch on BOTH catalog outcomes, stay
  // latched across a trust refetch, and never report a previous root's state for a new root.
  it("reports catalogSettled only once the current root's catalog request has completed", async () => {
    const pending = deferredResponse();
    fetchMock.mockImplementation((url: string) =>
      isCatalogRequest(url) ? pending.promise : Promise.resolve(response({ ok: true })),
    );

    const { result } = render();
    await tick();
    expect(result.current.catalog).toBeNull();
    expect(result.current.catalogSettled).toBe(false);

    await act(async () => {
      pending.resolve(response(catalog()));
    });
    await tick();
    expect(result.current.catalog?.projectId).toBe("/ws");
    expect(result.current.catalogSettled).toBe(true);
  });

  it("settles catalogSettled when the catalog request is rejected (no registered project)", async () => {
    fetchMock.mockImplementation((url: string) =>
      isCatalogRequest(url)
        ? Promise.resolve(response({ error: "unregistered project" }, false))
        : Promise.resolve(response({ ok: true })),
    );

    const { result } = render();
    await tick();

    // A rejected catalog raises no trust prompt, so an observer must not keep waiting on it.
    expect(result.current.catalog).toBeNull();
    expect(result.current.catalogSettled).toBe(true);
  });

  it("settles catalogSettled when the catalog payload is malformed", async () => {
    fetchMock.mockImplementation((url: string) =>
      isCatalogRequest(url)
        ? Promise.resolve(response({ schemaVersion: V, projectId: "/ws" }))
        : Promise.resolve(response({ ok: true })),
    );

    const { result } = render();
    await tick();

    expect(result.current.catalog).toBeNull();
    expect(result.current.catalogSettled).toBe(true);
  });

  it("reports the newly bound root as unsettled in the very render that binds it", async () => {
    const pendingB = deferredResponse();
    fetchMock.mockImplementation((url: string) => {
      if (isCatalogRequest(url, "/project-b")) return pendingB.promise;
      if (isCatalogRequest(url)) return Promise.resolve(response(catalog("/project-a")));
      return Promise.resolve(response({ ok: true }));
    });

    const observed: string[] = [];
    const { rerender } = renderHook(
      ({ root }: { readonly root: string }) => useObservedRun(root, observed),
      { initialProps: { root: "/project-a" } },
    );
    await tick();
    expect(observed).toContain("/project-a:true");

    observed.length = 0;
    rerender({ root: "/project-b" });
    // The switch must report "not settled" in the FIRST commit that already binds /project-b — a
    // reset that lands one commit later would leak /project-a's settled state through exactly the
    // window in which an observer would read a stale-true readiness signal.
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((entry) => entry === "/project-b:false")).toBe(true);

    await act(async () => {
      pendingB.resolve(response(catalog("/project-b")));
    });
    await tick();
    expect(observed).toContain("/project-b:true");
  });

  it("clears catalogSettled when the SAME root is re-bound after an unbound render", async () => {
    const rebound = deferredResponse();
    let catalogRequests = 0;
    fetchMock.mockImplementation((url: string) => {
      if (!isCatalogRequest(url)) return Promise.resolve(response({ ok: true }));
      catalogRequests += 1;
      return catalogRequests === 1
        ? Promise.resolve(response(catalog("/project-a")))
        : rebound.promise;
    });

    const observed: string[] = [];
    const { rerender } = renderHook(
      ({ root }: { readonly root: string }) => useObservedRun(root, observed),
      { initialProps: { root: "/project-a" } },
    );
    await tick();
    expect(observed).toContain("/project-a:true");

    rerender({ root: "" });
    await tick();

    observed.length = 0;
    rerender({ root: "/project-a" });
    // Re-binding a root that ALREADY settled once is a NEW binding: its catalog request is back in
    // flight, so the commit that re-binds it must not report the previous binding's settled state.
    // Keying the marker on the root value alone cannot see this — the root string is unchanged.
    expect(catalogRequests).toBe(2);
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((entry) => entry === "/project-a:false")).toBe(true);

    await act(async () => {
      rebound.resolve(response(catalog("/project-a")));
    });
    await tick();
    expect(observed).toContain("/project-a:true");
  });

  it("resets catalogSettled on a root switch and re-latches it for the new root", async () => {
    const pendingB = deferredResponse();
    fetchMock.mockImplementation((url: string) => {
      if (isCatalogRequest(url, "/project-b")) return pendingB.promise;
      if (isCatalogRequest(url)) return Promise.resolve(response(catalog("/project-a")));
      return Promise.resolve(response({ ok: true }));
    });

    const { result, rerender } = renderHook(
      ({ root }: { readonly root: string }) => useEditorVerificationRun({ root, activeFile: null }),
      { initialProps: { root: "/project-a" } },
    );
    await tick();
    expect(result.current.catalogSettled).toBe(true);

    rerender({ root: "/project-b" });
    expect(result.current.catalogSettled).toBe(false);

    await act(async () => {
      pendingB.resolve(response(catalog("/project-b")));
    });
    await tick();
    expect(result.current.catalog?.projectId).toBe("/project-b");
    expect(result.current.catalogSettled).toBe(true);
  });

  it("keeps catalogSettled latched while a workspace-trust change refetches the catalog", async () => {
    const refetch = deferredResponse();
    let catalogRequests = 0;
    fetchMock.mockImplementation((url: string) => {
      if (!isCatalogRequest(url)) return Promise.resolve(response({ ok: true }));
      catalogRequests += 1;
      return catalogRequests === 1 ? Promise.resolve(response(catalog())) : refetch.promise;
    });

    const { result } = render(null);
    await tick();
    expect(result.current.catalogSettled).toBe(true);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(WORKSPACE_TRUST_CHANGED_EVENT, { detail: { projectId: "/ws" } }),
      );
    });
    // The refetch is still in flight for the SAME root: the readiness signal must never fall back
    // from true to false while the bound root is unchanged.
    expect(catalogRequests).toBe(2);
    expect(result.current.catalogSettled).toBe(true);

    await act(async () => {
      refetch.resolve(response(catalog()));
    });
    await tick();
    expect(result.current.catalogSettled).toBe(true);
  });
});
