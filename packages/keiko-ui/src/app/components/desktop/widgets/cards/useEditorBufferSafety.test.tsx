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
  it("registers only minimal safety state and keeps unsaved protection on unmount", async () => {
    const hook = renderHook(() => useEditorBufferSafety(snapshot()));
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledOnce());
    expect(postEditorBufferSafetyRequest).toHaveBeenCalledWith({
      schemaVersion: "1",
      kind: "buffer-snapshot",
      snapshot: snapshot(),
    });
    hook.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(postEditorBufferSafetyRequest).toHaveBeenCalledOnce();
    expect(
      window.sessionStorage.getItem("keiko.editor.buffer-safety.v1:buffer:test:main:root"),
    ).toBe(JSON.stringify({ capability, dirtyFiles: ["src/a.ts"] }));
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
        snapshot: snapshot(),
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
      bufferSnapshotCapability: capability,
    });
    expect(
      window.sessionStorage.getItem("keiko.editor.buffer-safety.v1:buffer:test:main:root"),
    ).toBeNull();
  });
  it("orders a newer dirty update behind a pending clean publication", async () => {
    const pending = deferred<EditorAgentSnapshotResponse>();
    vi.mocked(postEditorBufferSafetyRequest).mockReturnValueOnce(pending.promise);
    const hook = renderHook(({ value }) => useEditorBufferSafety(value), {
      initialProps: { value: snapshot(false) },
    });
    hook.rerender({ value: snapshot() });
    hook.unmount();
    pending.resolve({ snapshot: snapshot(false), bufferSnapshotCapability: capability });
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledTimes(2));
    expect(postEditorBufferSafetyRequest).toHaveBeenLastCalledWith({
      schemaVersion: "1",
      kind: "buffer-snapshot",
      snapshot: snapshot(),
      bufferSnapshotCapability: capability,
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
  it("re-registers a remount arriving during a clean release without reusing revoked ownership", async () => {
    const release = deferred<EditorAgentSnapshotResponse>();
    const first = renderHook(() => useEditorBufferSafety(snapshot(false)));
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledOnce());
    vi.mocked(postEditorBufferSafetyRequest).mockReturnValueOnce(release.promise);
    first.unmount();
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledTimes(2));
    const second = renderHook(() => useEditorBufferSafety(snapshot()));
    release.resolve({ snapshot: null });
    await waitFor(() => expect(postEditorBufferSafetyRequest).toHaveBeenCalledTimes(3));
    expect(postEditorBufferSafetyRequest).toHaveBeenLastCalledWith({
      schemaVersion: "1",
      kind: "buffer-snapshot",
      snapshot: snapshot(),
    });
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
    pending.resolve({ snapshot: snapshot(), bufferSnapshotCapability: capability });
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
    pending.resolve({ snapshot: bothDirty, bufferSnapshotCapability: capability });
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
    pending.resolve({ snapshot: snapshot(), bufferSnapshotCapability: capability });
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
