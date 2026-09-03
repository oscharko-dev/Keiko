/**
 * Hook tests for useCodingWorkbenchEditorBridge.
 *
 * Regression context: before this hook existed, a Code task run had no way to register a live
 * editor-agent bridge session for its workspace root, so every `applyChangeset` tool call timed
 * out waiting for a session that never appeared — the run kept re-requesting file-edit approval
 * and never wrote anything. These tests prove the headless bridge registers a session for the
 * run's workspace root, auto-confirms a non-review changeset, and routes a review-required
 * changeset through `pendingReview`/`approve`/`deny` instead of silently discarding it.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetEditorAgentBridgeStateForTests } from "@/app/components/desktop/widgets/cards/editorAgentBridge";
import { ApiError } from "./api";
import { useCodingWorkbenchEditorBridge } from "./useCodingWorkbenchEditorBridge";

const postSnapshotSpy = vi.fn();
const postResultSpy = vi.fn();

// `editorAgentBridge.ts` imports this same file via a different relative specifier
// (`../../../../../lib/api`); Vitest's mock registry keys by resolved module id, so mocking it
// once here from this file's own `./api` specifier intercepts both call sites. `ApiError` is the
// REAL class: the hook narrows on it to lift a failed decision's machine error code and correlation
// id, so a stubbed stand-in would make that narrowing untestable (and `instanceof undefined` throw).
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  postEditorAgentSessionSnapshot: (snapshot: unknown, capability: string | undefined): unknown =>
    postSnapshotSpy(snapshot, capability),
  postEditorAgentActionResult: (body: unknown): unknown => postResultSpy(body),
}));

class FakeEventSource {
  public readonly listeners = new Map<string, EventListener[]>();
  public constructor(public readonly url: string) {}
  public addEventListener(type: string, listener: EventListener): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }
  public removeEventListener(): void {
    // no-op for tests
  }
  public close(): void {
    // no-op for tests
  }
  public emit(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const createSourceSpy = vi.fn((url: string) => new FakeEventSource(url));

vi.mock("./safe-event-source", () => ({
  createSameOriginApiEventSource: (url: string): unknown => createSourceSpy(url),
}));

function latestSource(): FakeEventSource {
  const source = createSourceSpy.mock.results.at(-1)?.value;
  if (source === undefined) throw new Error("expected an authenticated event source");
  return source;
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

function emitApplyChangeset(
  source: FakeEventSource,
  sessionId: string,
  overrides: { readonly requiresReview?: boolean; readonly patch?: string } = {},
): void {
  source.emit("editor-agent:action", {
    schemaVersion: "1",
    eventId: "event-1",
    type: "action",
    action: {
      schemaVersion: "1",
      actionId: "action-1",
      idempotencyKey: "key-1",
      sessionId,
      type: "applyChangeset",
      ...(overrides.requiresReview === undefined
        ? {}
        : { requiresReview: overrides.requiresReview }),
      changeset: {
        patch: overrides.patch ?? "diff --git a/x.ts b/x.ts\n",
        files: [{ file: "x.ts", expectedContentHash: "a".repeat(64) }],
      },
    },
  });
}

beforeEach(() => {
  _resetEditorAgentBridgeStateForTests();
  postSnapshotSpy
    .mockReset()
    .mockResolvedValue({ snapshot: null, bridgeDecisionCapability: "A".repeat(43) });
  postResultSpy.mockReset().mockResolvedValue({ result: { status: "succeeded" } });
  createSourceSpy.mockClear();
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
});

afterEach(() => {
  _resetEditorAgentBridgeStateForTests();
  delete (globalThis as { EventSource?: unknown }).EventSource;
});

describe("useCodingWorkbenchEditorBridge — registration", () => {
  it("registers a session bound to the workspace root while a run is active", async () => {
    renderHook(() =>
      useCodingWorkbenchEditorBridge({ root: "/repo/task-1", runId: "run-1", active: true }),
    );
    await flushMicrotasks();
    expect(postSnapshotSpy).toHaveBeenCalled();
    const [snapshot] = postSnapshotSpy.mock.calls[0] as [{ workspaceRoot: string }];
    expect(snapshot.workspaceRoot).toBe("/repo/task-1");
  });

  it("never registers a session when no workspace is bound", async () => {
    renderHook(() => useCodingWorkbenchEditorBridge({ root: null, runId: "run-1", active: true }));
    await flushMicrotasks();
    expect(postSnapshotSpy).not.toHaveBeenCalled();
  });

  it("never registers a session when the run is not active", async () => {
    renderHook(() =>
      useCodingWorkbenchEditorBridge({ root: "/repo/task-1", runId: "run-1", active: false }),
    );
    await flushMicrotasks();
    expect(postSnapshotSpy).not.toHaveBeenCalled();
  });
});

describe("useCodingWorkbenchEditorBridge — applyChangeset", () => {
  it("auto-confirms a changeset that does not require review, without exposing pendingReview", async () => {
    const { result } = renderHook(() =>
      useCodingWorkbenchEditorBridge({ root: "/repo/task-1", runId: "run-1", active: true }),
    );
    await flushMicrotasks();
    const source = latestSource();
    const sessionId = new URL(source.url, "https://example.test").searchParams.get("sessionId");
    act(() => {
      emitApplyChangeset(source, sessionId ?? "", { requiresReview: false });
    });
    await flushMicrotasks();
    expect(result.current.pendingReview).toBeNull();
    expect(postResultSpy).toHaveBeenCalledWith(
      expect.objectContaining({ result: expect.objectContaining({ status: "succeeded" }) }),
    );
  });

  it("exposes a review-required changeset as pendingReview with the parsed diff", async () => {
    const patch = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    const { result } = renderHook(() =>
      useCodingWorkbenchEditorBridge({ root: "/repo/task-1", runId: "run-1", active: true }),
    );
    await flushMicrotasks();
    const source = latestSource();
    const sessionId = new URL(source.url, "https://example.test").searchParams.get("sessionId");
    act(() => {
      emitApplyChangeset(source, sessionId ?? "", { patch });
    });
    await flushMicrotasks();
    expect(result.current.pendingReview).not.toBeNull();
    expect(result.current.pendingReview?.diff.files).toHaveLength(1);
    expect(postResultSpy).not.toHaveBeenCalled();
  });

  it("approve() posts a succeeded result and clears pendingReview", async () => {
    const { result } = renderHook(() =>
      useCodingWorkbenchEditorBridge({ root: "/repo/task-1", runId: "run-1", active: true }),
    );
    await flushMicrotasks();
    const source = latestSource();
    const sessionId = new URL(source.url, "https://example.test").searchParams.get("sessionId");
    act(() => {
      emitApplyChangeset(source, sessionId ?? "");
    });
    await flushMicrotasks();
    act(() => {
      result.current.approve();
    });
    await flushMicrotasks();
    expect(result.current.pendingReview).toBeNull();
    expect(postResultSpy).toHaveBeenCalledWith(
      expect.objectContaining({ result: expect.objectContaining({ status: "succeeded" }) }),
    );
  });

  it("deny() posts a failed result and clears pendingReview", async () => {
    const { result } = renderHook(() =>
      useCodingWorkbenchEditorBridge({ root: "/repo/task-1", runId: "run-1", active: true }),
    );
    await flushMicrotasks();
    const source = latestSource();
    const sessionId = new URL(source.url, "https://example.test").searchParams.get("sessionId");
    act(() => {
      emitApplyChangeset(source, sessionId ?? "");
    });
    await flushMicrotasks();
    act(() => {
      result.current.deny();
    });
    await flushMicrotasks();
    expect(result.current.pendingReview).toBeNull();
    expect(postResultSpy).toHaveBeenCalledWith(
      expect.objectContaining({ result: expect.objectContaining({ status: "failed" }) }),
    );
  });

  it("retries a decision that hits a transient bridge-lease race instead of losing it", async () => {
    postResultSpy
      .mockRejectedValueOnce(new Error("BRIDGE_LEASE_INACTIVE"))
      .mockResolvedValue({ result: { status: "succeeded" } });
    const { result } = renderHook(() =>
      useCodingWorkbenchEditorBridge({ root: "/repo/task-1", runId: "run-1", active: true }),
    );
    await flushMicrotasks();
    const source = latestSource();
    const sessionId = new URL(source.url, "https://example.test").searchParams.get("sessionId");
    act(() => {
      emitApplyChangeset(source, sessionId ?? "");
    });
    await flushMicrotasks();

    act(() => {
      result.current.approve();
    });
    await flushMicrotasks();
    // The first attempt rejected; the review must stay visible (marked deciding), not vanish.
    expect(result.current.pendingReview).not.toBeNull();
    expect(result.current.pendingReview?.deciding).toBe(true);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    await flushMicrotasks();

    expect(result.current.pendingReview).toBeNull();
    expect(postResultSpy).toHaveBeenCalledTimes(2);
  });

  it("forces a fresh bridge reconnect and retries once more when every attempt keeps failing", async () => {
    // Every attempt in the normal retry budget fails (a stale, silently-dead SSE stream that
    // never self-heals within that window); only the attempt made after a forced reconnect
    // succeeds. Proves the escalation path actually re-registers the session rather than giving
    // up once the bounded retry budget is spent.
    postResultSpy.mockRejectedValue(new Error("BRIDGE_LEASE_INACTIVE"));
    const { result } = renderHook(() =>
      useCodingWorkbenchEditorBridge({ root: "/repo/task-1", runId: "run-1", active: true }),
    );
    await flushMicrotasks();
    const source = latestSource();
    const sessionId = new URL(source.url, "https://example.test").searchParams.get("sessionId");
    act(() => {
      emitApplyChangeset(source, sessionId ?? "");
    });
    await flushMicrotasks();
    const registrationsBeforeDecision = postSnapshotSpy.mock.calls.length;

    act(() => {
      result.current.approve();
    });

    // Drain the bounded retry budget (150 + 400 + 900ms) while every attempt keeps rejecting.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_600));
    });
    await flushMicrotasks();
    // Still deciding: the forced-reconnect escalation has not resolved yet.
    expect(result.current.pendingReview?.deciding).toBe(true);

    // Let the reconnect cycle's success settle: the next attempt after reconnect uses the base
    // (non-rejecting) resolved value queued in beforeEach once the "always reject" mock is cleared.
    postResultSpy.mockResolvedValue({ result: { status: "succeeded" } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    await flushMicrotasks();

    expect(result.current.pendingReview).toBeNull();
    // The forced reconnect re-registered a fresh snapshot for the same session.
    expect(postSnapshotSpy.mock.calls.length).toBeGreaterThan(registrationsBeforeDecision);
  });

  it("marks the review deliveryFailed instead of silently clearing it when every attempt fails", async () => {
    postResultSpy.mockRejectedValue(new Error("BRIDGE_LEASE_INACTIVE"));
    const { result } = renderHook(() =>
      useCodingWorkbenchEditorBridge({ root: "/repo/task-1", runId: "run-1", active: true }),
    );
    await flushMicrotasks();
    const source = latestSource();
    const sessionId = new URL(source.url, "https://example.test").searchParams.get("sessionId");
    act(() => {
      emitApplyChangeset(source, sessionId ?? "");
    });
    await flushMicrotasks();

    act(() => {
      result.current.approve();
    });
    // Drain the full retry budget plus the forced-reconnect escalation, all still rejecting.
    await waitFor(
      () => {
        expect(result.current.pendingReview?.deciding).toBe(false);
      },
      { timeout: 5_000 },
    );

    expect(result.current.pendingReview).not.toBeNull();
    expect(result.current.pendingReview?.deliveryFailed).toBe(true);
    // F-09a: a rejection that is not an ApiError still gets ONE stable machine code — never an
    // absent reason. The bare `catch { return false }` this replaces discarded the error entirely.
    expect(result.current.pendingReview?.deliveryFailure).toEqual({
      code: "EDITOR_CHANGESET_DECISION_FAILED",
    });
  });

  // F-09a: the transport already carries a machine error code and, for a server-issued failure, a
  // correlation id. Both were thrown away in a bare catch, so the review could only say "could not
  // confirm this decision" — nothing to act on and nothing to report, on the one decision that
  // gates the run's file write.
  it("carries the machine error code and correlation id of an undelivered decision", async () => {
    const refused = new ApiError("BRIDGE_LEASE_INACTIVE", "Lease inactive.", 409);
    refused.correlationId = "ui-correlation-7";
    postResultSpy.mockRejectedValue(refused);
    const { result } = renderHook(() =>
      useCodingWorkbenchEditorBridge({ root: "/repo/task-1", runId: "run-1", active: true }),
    );
    await flushMicrotasks();
    const source = latestSource();
    const sessionId = new URL(source.url, "https://example.test").searchParams.get("sessionId");
    act(() => {
      emitApplyChangeset(source, sessionId ?? "");
    });
    await flushMicrotasks();

    act(() => {
      result.current.approve();
    });
    await waitFor(
      () => {
        expect(result.current.pendingReview?.deliveryFailed).toBe(true);
      },
      { timeout: 5_000 },
    );

    expect(result.current.pendingReview?.deliveryFailure).toEqual({
      code: "BRIDGE_LEASE_INACTIVE",
      correlationId: "ui-correlation-7",
    });
    // The review stays actionable: the decision is still the operator's to repeat.
    expect(result.current.pendingReview?.deciding).toBe(false);

    // A request that never reached the BFF at all (bare `fetch` rejects with a TypeError, and
    // nothing wraps it) is a different operator problem from a BFF that answered and refused, so
    // it must not borrow the refusal's code.
    postResultSpy.mockRejectedValue(new TypeError("Failed to fetch"));
    act(() => {
      result.current.retry();
    });
    await waitFor(
      () => {
        expect(result.current.pendingReview?.deliveryFailure).toEqual({
          code: "EDITOR_CHANGESET_DECISION_UNREACHABLE",
        });
      },
      { timeout: 5_000 },
    );
  });

  it("retry() resubmits the same decision after a deliveryFailed review", async () => {
    postResultSpy.mockRejectedValue(new Error("BRIDGE_LEASE_INACTIVE"));
    const { result } = renderHook(() =>
      useCodingWorkbenchEditorBridge({ root: "/repo/task-1", runId: "run-1", active: true }),
    );
    await flushMicrotasks();
    const source = latestSource();
    const sessionId = new URL(source.url, "https://example.test").searchParams.get("sessionId");
    act(() => {
      emitApplyChangeset(source, sessionId ?? "");
    });
    await flushMicrotasks();

    act(() => {
      result.current.deny();
    });
    await waitFor(
      () => {
        expect(result.current.pendingReview?.deliveryFailed).toBe(true);
      },
      { timeout: 5_000 },
    );

    postResultSpy.mockReset().mockResolvedValue({ result: { status: "failed" } });
    act(() => {
      result.current.retry();
    });
    await flushMicrotasks();
    expect(result.current.pendingReview).toBeNull();
    // The retried decision is the original one (deny → "failed"), not a fresh approve.
    expect(postResultSpy).toHaveBeenCalledWith(
      expect.objectContaining({ result: expect.objectContaining({ status: "failed" }) }),
    );
  });

  it("ignores a second approve() while the first decision is still in flight", async () => {
    let releasePost: (() => void) | undefined;
    postResultSpy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releasePost = () => resolve({ result: { status: "succeeded" } });
        }),
    );
    const { result } = renderHook(() =>
      useCodingWorkbenchEditorBridge({ root: "/repo/task-1", runId: "run-1", active: true }),
    );
    await flushMicrotasks();
    const source = latestSource();
    const sessionId = new URL(source.url, "https://example.test").searchParams.get("sessionId");
    act(() => {
      emitApplyChangeset(source, sessionId ?? "");
    });
    await flushMicrotasks();

    act(() => {
      result.current.approve();
      result.current.approve();
      result.current.deny();
    });
    await flushMicrotasks();
    expect(postResultSpy).toHaveBeenCalledTimes(1);

    releasePost?.();
    await flushMicrotasks();
    expect(result.current.pendingReview).toBeNull();
  });
});

// Workbench audit, 2026-09-03: before this lock, the headless bridge re-registered its session against
// whatever workspace the shell's active binding happened to point at, so an unrelated workspace
// switch mid-run silently re-targeted a still-live run's file edits at the wrong root.
describe("useCodingWorkbenchEditorBridge — run-bound root", () => {
  it("keeps the session bound to the run's original root when the active workspace switches mid-run", async () => {
    const { rerender } = renderHook(
      (props: { root: string; bindingPending: boolean }) =>
        useCodingWorkbenchEditorBridge({
          root: props.root,
          runId: "run-1",
          active: true,
          bindingPending: props.bindingPending,
        }),
      { initialProps: { root: "/repo/task-1", bindingPending: false } },
    );
    await flushMicrotasks();
    expect(postSnapshotSpy).toHaveBeenCalledTimes(1);
    const [firstSnapshot] = postSnapshotSpy.mock.calls[0] as [{ workspaceRoot: string }];
    expect(firstSnapshot.workspaceRoot).toBe("/repo/task-1");

    // The operator switches the desktop's active workspace to an unrelated repository while this
    // run is still live — an ordinary, reachable action nothing warns them not to take.
    rerender({ root: "/repo/other-workspace", bindingPending: false });
    await flushMicrotasks();
    // The re-registration this new (unlocked) `root` would otherwise trigger is itself debounced
    // (EDITOR_SNAPSHOT_DEBOUNCE_MS, a REAL 300ms timer) — flushing only microtasks would let this
    // assertion pass even without the fix, since that timer never gets to fire. Wait past it for
    // real so a still-unlocked root has every chance to prove itself.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });

    // No further registration ever names the new root: the session stays bound to the run's
    // original root (or goes inert) — it must never pick up "/repo/other-workspace", and no new
    // registration call for ANY root happens at all once the binding is lost.
    expect(postSnapshotSpy).toHaveBeenCalledTimes(1);
    for (const call of postSnapshotSpy.mock.calls) {
      const [snapshot] = call as [{ workspaceRoot: string }];
      expect(snapshot.workspaceRoot).toBe("/repo/task-1");
    }
  });

  it("re-registers a fresh session once a new run starts after a workspace switch", async () => {
    const { rerender } = renderHook(
      (props: { root: string; runId: string }) =>
        useCodingWorkbenchEditorBridge({
          root: props.root,
          runId: props.runId,
          active: true,
          bindingPending: false,
        }),
      { initialProps: { root: "/repo/task-1", runId: "run-1" } },
    );
    await flushMicrotasks();

    // Workspace switch mid-run: the session must not follow it (asserted above). A brand new run
    // starting in the now-active workspace is a different story — it re-arms the lock from scratch.
    rerender({ root: "/repo/other-workspace", runId: "run-2" });
    await flushMicrotasks();

    const [latestSnapshot] = postSnapshotSpy.mock.calls.at(-1) as [{ workspaceRoot: string }];
    expect(latestSnapshot.workspaceRoot).toBe("/repo/other-workspace");
  });
});
