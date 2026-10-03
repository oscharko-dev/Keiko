import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postEditorBufferSafetyRequest } from "@/lib/api";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";
import type { EditorAgentSessionSnapshot, EditorAgentSnapshotResponse } from "@/lib/types";
import {
  discardEditorBufferSafetyFiles,
  resetEditorBufferSafetyForTests,
  useEditorBufferSafety,
} from "./useEditorBufferSafety";

vi.mock("@/lib/api", () => ({ postEditorBufferSafetyRequest: vi.fn() }));
const capability = "a".repeat(43);
function snapshot(dirty = true): EditorAgentSessionSnapshot {
  return {
    schemaVersion: "1",
    sessionId: "buffer:test:main:root",
    windowId: "test",
    workspaceRoot: "/repo",
    activePaneId: "main",
    panes: [{ paneId: "main", activeFile: "src/a.ts", openFiles: ["src/a.ts"] }],
    dirtyFiles: dirty ? ["src/a.ts"] : [],
    activeFile: "src/a.ts",
    cursor: null,
    selection: null,
    diagnosticsSummary: null,
    textMode: "none",
    updatedAt: 1,
  };
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  resetEditorBufferSafetyForTests();
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.mocked(postEditorBufferSafetyRequest).mockImplementation((request) =>
    Promise.resolve(
      request.kind === "buffer-snapshot"
        ? {
            snapshot: request.snapshot,
            ...(request.bufferSnapshotCapability === undefined
              ? { bufferSnapshotCapability: capability }
              : {}),
          }
        : { snapshot: null },
    ),
  );
});
afterEach(() => {
  resetClientDiagnosticWriter();
  vi.clearAllMocks();
});

describe("passive editor buffer protection", () => {
  it("persists ownership and pending dirty paths before the first response", async () => {
    const pending = deferred<EditorAgentSnapshotResponse>();
    vi.mocked(postEditorBufferSafetyRequest).mockReturnValueOnce(pending.promise);
    const hook = renderHook(() => useEditorBufferSafety(snapshot()));
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledOnce());
    const request = vi.mocked(postEditorBufferSafetyRequest).mock.calls[0]?.[0];
    expect(request?.kind).toBe("buffer-snapshot");
    expect(request).toEqual(
      expect.objectContaining({ bufferSnapshotCapability: expect.any(String) }),
    );
    const stored = window.localStorage.getItem(
      "keiko.editor.buffer-safety.v1:" + snapshot().sessionId,
    );
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored ?? "null")).toEqual({
      sessionId: snapshot().sessionId,
      capability: request?.bufferSnapshotCapability,
      dirtyFiles: ["src/a.ts"],
      updatedAt: expect.any(Number),
    });
    pending.resolve({ snapshot: snapshot() });
    hook.unmount();
  });
  it("recovers a closed tab after its session storage has disappeared", async () => {
    const first = renderHook(() => useEditorBufferSafety(snapshot()));
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledOnce());
    const original = vi.mocked(postEditorBufferSafetyRequest).mock.calls[0]?.[0];
    first.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    resetEditorBufferSafetyForTests();
    window.sessionStorage.clear();
    const second = renderHook(() => useEditorBufferSafety(snapshot(false)));
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledTimes(2));
    expect(postEditorBufferSafetyRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        bufferSnapshotCapability: original?.bufferSnapshotCapability,
        snapshot: expect.objectContaining({ dirtyFiles: ["src/a.ts"] }),
      }),
    );
    second.unmount();
  });
  it("retains pre-minted ownership when the first response is lost", async () => {
    setClientDiagnosticWriter(vi.fn());
    vi.mocked(postEditorBufferSafetyRequest).mockRejectedValueOnce(
      new TypeError("Connection lost"),
    );
    const first = renderHook(() => useEditorBufferSafety(snapshot()));
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledOnce());
    const original = vi.mocked(postEditorBufferSafetyRequest).mock.calls[0]?.[0];
    first.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    resetEditorBufferSafetyForTests();
    window.sessionStorage.clear();
    const restored = renderHook(() => useEditorBufferSafety(snapshot(false)));
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledTimes(2));
    expect(postEditorBufferSafetyRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        bufferSnapshotCapability: original?.bufferSnapshotCapability,
        snapshot: expect.objectContaining({ dirtyFiles: ["src/a.ts"] }),
      }),
    );
    restored.unmount();
  });
  it("does not create an unrecoverable server owner when durable persistence fails", async () => {
    const writer = vi.fn();
    setClientDiagnosticWriter(writer);
    const write = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Storage denied", "QuotaExceededError");
    });
    const hook = renderHook(() => useEditorBufferSafety(snapshot()));
    await waitFor(() => expect(writer).toHaveBeenCalledOnce());
    expect(postEditorBufferSafetyRequest).not.toHaveBeenCalled();
    hook.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    write.mockRestore();
  });
  it("persists edits arriving during a pending release across immediate publisher reset", async () => {
    const release = deferred<EditorAgentSnapshotResponse>();
    const first = renderHook(() => useEditorBufferSafety(snapshot(false)));
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledOnce());
    const original = vi.mocked(postEditorBufferSafetyRequest).mock.calls[0]?.[0];
    vi.mocked(postEditorBufferSafetyRequest).mockReturnValueOnce(release.promise);
    first.unmount();
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledTimes(2));
    const resumed = renderHook(() => useEditorBufferSafety(snapshot()));
    release.resolve({ snapshot: null });
    await act(async () => {
      await Promise.resolve();
    });
    resetEditorBufferSafetyForTests();
    const record = JSON.parse(
      window.localStorage.getItem("keiko.editor.buffer-safety.v1:" + snapshot().sessionId) ??
        "null",
    );
    expect(record).toEqual({
      sessionId: snapshot().sessionId,
      capability: original?.bufferSnapshotCapability,
      dirtyFiles: ["src/a.ts"],
      updatedAt: expect.any(Number),
    });
    resumed.unmount();
  });
  it("rejects an unexpected ownership rotation without corrupting durable ownership", async () => {
    const writer = vi.fn();
    setClientDiagnosticWriter(writer);
    vi.mocked(postEditorBufferSafetyRequest).mockResolvedValueOnce({
      snapshot: snapshot(),
      bufferSnapshotCapability: capability,
    });
    const hook = renderHook(() => useEditorBufferSafety(snapshot()));
    await waitFor(() => expect(writer).toHaveBeenCalledOnce());
    const request = vi.mocked(postEditorBufferSafetyRequest).mock.calls[0]?.[0];
    const record = JSON.parse(
      window.localStorage.getItem("keiko.editor.buffer-safety.v1:" + snapshot().sessionId) ??
        "null",
    );
    expect(record.capability).toBe(request?.bufferSnapshotCapability);
    expect(record.capability).not.toBe(capability);
    expect(record.dirtyFiles).toEqual(["src/a.ts"]);
    hook.unmount();
  });
  it("persists a second pending dirty file before the first acknowledgement", async () => {
    const pending = deferred<EditorAgentSnapshotResponse>();
    vi.mocked(postEditorBufferSafetyRequest).mockReturnValueOnce(pending.promise);
    const hook = renderHook(({ value }) => useEditorBufferSafety(value), {
      initialProps: { value: snapshot() },
    });
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledOnce());
    hook.rerender({ value: { ...snapshot(), dirtyFiles: ["src/a.ts", "src/b.ts"] } });
    const record = JSON.parse(
      window.localStorage.getItem("keiko.editor.buffer-safety.v1:" + snapshot().sessionId) ??
        "null",
    );
    expect(record.dirtyFiles).toEqual(["src/a.ts", "src/b.ts"]);
    pending.resolve({ snapshot: snapshot() });
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledTimes(2));
    hook.unmount();
  });
  it("persists monotonic publication stamps across reopen and a backwards system clock", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(100);
    const first = renderHook(() => useEditorBufferSafety(snapshot()));
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledOnce());
    const original = vi.mocked(postEditorBufferSafetyRequest).mock.calls[0]?.[0];
    if (original?.kind !== "buffer-snapshot") throw new TypeError("Expected snapshot publication");
    first.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    resetEditorBufferSafetyForTests();
    clock.mockReturnValue(1);
    const second = renderHook(() => useEditorBufferSafety(snapshot(false)));
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledTimes(2));
    const restored = vi.mocked(postEditorBufferSafetyRequest).mock.calls[1]?.[0];
    if (restored?.kind !== "buffer-snapshot") throw new TypeError("Expected snapshot publication");
    expect(restored.snapshot.updatedAt).toBeGreaterThan(original.snapshot.updatedAt);
    expect(restored.snapshot.dirtyFiles).toEqual(["src/a.ts"]);
    second.unmount();
    clock.mockRestore();
  });
  it("registers only minimal safety state and keeps unsaved protection on unmount", async () => {
    const hook = renderHook(() => useEditorBufferSafety(snapshot()));
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledOnce());
    expect(postEditorBufferSafetyRequest).toHaveBeenCalledWith({
      schemaVersion: "1",
      kind: "buffer-snapshot",
      snapshot: expect.objectContaining({ ...snapshot(), updatedAt: expect.any(Number) }),
      bufferSnapshotCapability: expect.any(String),
    });
    hook.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(postEditorBufferSafetyRequest).toHaveBeenCalledOnce();
    const request = vi.mocked(postEditorBufferSafetyRequest).mock.calls[0]?.[0];
    expect(
      JSON.parse(
        window.localStorage.getItem("keiko.editor.buffer-safety.v1:buffer:test:main:root") ??
          "null",
      ),
    ).toEqual({
      sessionId: snapshot().sessionId,
      capability: request?.bufferSnapshotCapability,
      dirtyFiles: ["src/a.ts"],
      updatedAt: expect.any(Number),
    });
  });
  it("reclaims ownership after reload without publishing while drafts hydrate", async () => {
    window.sessionStorage.setItem(
      "keiko.editor.buffer-safety.v1:buffer:test:main:root",
      JSON.stringify({ capability, dirtyFiles: ["src/a.ts"] }),
    );
    const hook = renderHook(
      ({ value }: { value: EditorAgentSessionSnapshot | null }) => useEditorBufferSafety(value),
      { initialProps: { value: null as EditorAgentSessionSnapshot | null } },
    );
    expect(postEditorBufferSafetyRequest).not.toHaveBeenCalled();
    hook.rerender({ value: snapshot() });
    await waitFor(() =>
      expect(postEditorBufferSafetyRequest).toHaveBeenCalledWith({
        schemaVersion: "1",
        kind: "buffer-snapshot",
        snapshot: expect.objectContaining({ ...snapshot(), updatedAt: expect.any(Number) }),
        bufferSnapshotCapability: capability,
      }),
    );
    hook.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(postEditorBufferSafetyRequest).toHaveBeenCalledOnce();
  });
  it("acknowledges saved/discarded clean state before releasing ownership", async () => {
    const hook = renderHook(
      ({ value }) =>
        useEditorBufferSafety(value, {
          sequence: value.dirtyFiles.length === 0 ? 1 : 0,
          paths: ["src/a.ts"],
        }),
      {
        initialProps: { value: snapshot() },
      },
    );
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledOnce());
    hook.rerender({ value: snapshot(false) });
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledTimes(2));
    hook.unmount();
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledTimes(3));
    expect(postEditorBufferSafetyRequest).toHaveBeenLastCalledWith({
      schemaVersion: "1",
      kind: "buffer-release",
      sessionId: snapshot().sessionId,
      bufferSnapshotCapability: vi.mocked(postEditorBufferSafetyRequest).mock.calls[0]?.[0]
        .bufferSnapshotCapability,
    });
    expect(
      window.localStorage.getItem("keiko.editor.buffer-safety.v1:buffer:test:main:root"),
    ).toBeNull();
  });
  it("orders a newer dirty update behind a pending clean publication", async () => {
    const pending = deferred<EditorAgentSnapshotResponse>();
    vi.mocked(postEditorBufferSafetyRequest).mockReturnValueOnce(pending.promise);
    const hook = renderHook(({ value }) => useEditorBufferSafety(value), {
      initialProps: { value: snapshot(false) },
    });
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledOnce());
    hook.rerender({ value: snapshot() });
    hook.unmount();
    pending.resolve({ snapshot: snapshot(false) });
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledTimes(2));
    expect(postEditorBufferSafetyRequest).toHaveBeenLastCalledWith({
      schemaVersion: "1",
      kind: "buffer-snapshot",
      snapshot: expect.objectContaining({ ...snapshot(), updatedAt: expect.any(Number) }),
      bufferSnapshotCapability: vi.mocked(postEditorBufferSafetyRequest).mock.calls[0]?.[0]
        .bufferSnapshotCapability,
    });
  });
  it("reports refusal without raw paths, body text or capability and never releases dirty state", async () => {
    const writer = vi.fn();
    setClientDiagnosticWriter(writer);
    vi.mocked(postEditorBufferSafetyRequest).mockRejectedValueOnce(
      new Error("/customer/secret CustomerPayrollText " + capability),
    );
    const hook = renderHook(() => useEditorBufferSafety(snapshot()));
    await waitFor(() => expect(writer).toHaveBeenCalledOnce());
    hook.unmount();
    const report = JSON.stringify(writer.mock.calls);
    expect(report).not.toMatch(/customer|CustomerPayrollText/);
    expect(report).not.toContain(capability);
    expect(postEditorBufferSafetyRequest).toHaveBeenCalledOnce();
  });
  it("keeps background draft paths after reload until explicitly saved or discarded", async () => {
    const key = "keiko.editor.buffer-safety.v1:buffer:test:main:root";
    window.sessionStorage.setItem(
      key,
      JSON.stringify({ capability, dirtyFiles: ["src/background.ts"] }),
    );
    const hook = renderHook(
      ({ cleanFiles }) =>
        useEditorBufferSafety(snapshot(false), { sequence: cleanFiles.length, paths: cleanFiles }),
      {
        initialProps: { cleanFiles: [] as readonly string[] },
      },
    );
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledOnce());
    expect(postEditorBufferSafetyRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        bufferSnapshotCapability: capability,
        snapshot: expect.objectContaining({ dirtyFiles: ["src/background.ts"] }),
      }),
    );
    hook.rerender({ cleanFiles: ["src/background.ts"] });
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledTimes(2));
    expect(postEditorBufferSafetyRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ snapshot: expect.objectContaining({ dirtyFiles: [] }) }),
    );
    hook.unmount();
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledTimes(3));
  });
  it("reseeds a remount arriving during clean release with its retained passive ownership", async () => {
    const release = deferred<EditorAgentSnapshotResponse>();
    const first = renderHook(() => useEditorBufferSafety(snapshot(false)));
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledOnce());
    vi.mocked(postEditorBufferSafetyRequest).mockReturnValueOnce(release.promise);
    first.unmount();
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledTimes(2));
    const second = renderHook(() => useEditorBufferSafety(snapshot()));
    release.resolve({ snapshot: null });
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledTimes(3));
    const firstRequest = vi.mocked(postEditorBufferSafetyRequest).mock.calls[0]?.[0];
    const renewed = vi.mocked(postEditorBufferSafetyRequest).mock.calls[2]?.[0];
    expect(renewed).toEqual(
      expect.objectContaining({
        kind: "buffer-snapshot",
        snapshot: expect.objectContaining({ dirtyFiles: ["src/a.ts"] }),
        bufferSnapshotCapability: expect.any(String),
      }),
    );
    expect(renewed?.bufferSnapshotCapability).toBe(firstRequest?.bufferSnapshotCapability);
    second.unmount();
  });
  it("does not duplicate ownership or release during StrictMode effect replay", async () => {
    const value = snapshot();
    const hook = renderHook(() => useEditorBufferSafety(value), {
      wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
    });
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledOnce());
    hook.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(postEditorBufferSafetyRequest).toHaveBeenCalledOnce();
  });
  it("ignores timestamp-only updates without extra requests", async () => {
    const hook = renderHook(({ value }) => useEditorBufferSafety(value), {
      initialProps: { value: snapshot() },
    });
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledOnce());
    hook.rerender({ value: { ...snapshot(), updatedAt: 99 } });
    await act(async () => {
      await Promise.resolve();
    });
    expect(postEditorBufferSafetyRequest).toHaveBeenCalledOnce();
    hook.unmount();
  });

  it("never reapplies an old save settlement after later edits disappear from the loaded pane", async () => {
    const hook = renderHook(
      ({ value, sequence }) => useEditorBufferSafety(value, { sequence, paths: ["src/a.ts"] }),
      { initialProps: { value: snapshot(), sequence: 0 } },
    );
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledOnce());
    hook.rerender({ value: snapshot(false), sequence: 1 });
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledTimes(2));
    hook.rerender({ value: snapshot(), sequence: 1 });
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledTimes(3));
    hook.rerender({ value: { ...snapshot(false), activeFile: null, panes: [] }, sequence: 1 });
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledTimes(4));
    expect(postEditorBufferSafetyRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ snapshot: expect.objectContaining({ dirtyFiles: ["src/a.ts"] }) }),
    );
    hook.rerender({ value: snapshot(false), sequence: 2 });
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledTimes(5));
    expect(postEditorBufferSafetyRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ snapshot: expect.objectContaining({ dirtyFiles: [] }) }),
    );
    hook.unmount();
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledTimes(6));
  });
  it("settles host Discard during a pending dirty registration before unmount release", async () => {
    const pending = deferred<EditorAgentSnapshotResponse>();
    vi.mocked(postEditorBufferSafetyRequest).mockReturnValueOnce(pending.promise);
    const hook = renderHook(() => useEditorBufferSafety(snapshot()));
    discardEditorBufferSafetyFiles(["test"], "/repo", ["src/a.ts"]);
    hook.unmount();
    pending.resolve({ snapshot: snapshot() });
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledTimes(3));
    expect(postEditorBufferSafetyRequest).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ snapshot: expect.objectContaining({ dirtyFiles: [] }) }),
    );
    expect(postEditorBufferSafetyRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "buffer-release" }),
    );
  });
  it("retains both fresh save settlements coalesced behind a pending dirty publication", async () => {
    const pending = deferred<EditorAgentSnapshotResponse>();
    const bothDirty = { ...snapshot(), dirtyFiles: ["src/a.ts", "src/b.ts"] };
    vi.mocked(postEditorBufferSafetyRequest).mockReturnValueOnce(pending.promise);
    const hook = renderHook(({ value, clean }) => useEditorBufferSafety(value, clean), {
      initialProps: { value: bothDirty, clean: { sequence: 0, paths: [] as readonly string[] } },
    });
    hook.rerender({
      value: { ...bothDirty, dirtyFiles: ["src/b.ts"] },
      clean: { sequence: 1, paths: ["src/a.ts"] },
    });
    hook.rerender({
      value: { ...bothDirty, dirtyFiles: [] },
      clean: { sequence: 2, paths: ["src/b.ts"] },
    });
    pending.resolve({ snapshot: bothDirty });
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledTimes(2));
    expect(postEditorBufferSafetyRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ snapshot: expect.objectContaining({ dirtyFiles: [] }) }),
    );
    hook.unmount();
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledTimes(3));
  });
  it("invalidates queued save settlement when new unsaved edits arrive before acknowledgement", async () => {
    const pending = deferred<EditorAgentSnapshotResponse>();
    vi.mocked(postEditorBufferSafetyRequest).mockReturnValueOnce(pending.promise);
    const hook = renderHook(
      ({ value, sequence }) => useEditorBufferSafety(value, { sequence, paths: ["src/a.ts"] }),
      { initialProps: { value: snapshot(), sequence: 0 } },
    );
    hook.rerender({ value: snapshot(false), sequence: 1 });
    hook.rerender({ value: snapshot(), sequence: 1 });
    hook.rerender({ value: { ...snapshot(false), activeFile: null, panes: [] }, sequence: 1 });
    pending.resolve({ snapshot: snapshot() });
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledTimes(2));
    expect(postEditorBufferSafetyRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ snapshot: expect.objectContaining({ dirtyFiles: ["src/a.ts"] }) }),
    );
    hook.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(postEditorBufferSafetyRequest).toHaveBeenCalledTimes(2);
  });
});
