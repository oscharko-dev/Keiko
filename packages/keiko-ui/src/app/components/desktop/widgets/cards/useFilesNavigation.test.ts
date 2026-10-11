import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  setClientDiagnosticWriter,
  resetClientDiagnosticWriter,
  type ClientDiagnosticMeta,
  type ClientDiagnosticWriter,
} from "@/lib/client-diagnostics";
import { observeFilesDirectoryRead } from "@/lib/files-navigation-evidence";
import { useFilesNavigation } from "./useFilesNavigation";

describe("folder navigation", () => {
  it("preserves the selected folder and history only for its acknowledged canonical root", () => {
    const changeRoot = vi.fn();
    const view = renderHook(
      ({ root, resolved }) => useFilesNavigation(root, changeRoot, "Alpha", resolved),
      {
        initialProps: { root: "/alias", resolved: "/canonical" },
      },
    );
    act(() => view.result.current.visit("Alpha/nested"));
    view.rerender({ root: "/canonical", resolved: "/canonical" });
    expect(view.result.current.path).toBe("Alpha/nested");
    act(() => view.result.current.back());
    expect(view.result.current.path).toBe("Alpha");
    expect(changeRoot).not.toHaveBeenCalled();
    view.rerender({ root: "/unrelated", resolved: "/canonical" });
    expect(view.result.current.path).toBeNull();
    act(() => view.result.current.back());
    expect(changeRoot).toHaveBeenCalledWith("/canonical");
  });
  it("restores an initial canonical folder while root changes reset its relative binding", () => {
    const view = renderHook(({ root }) => useFilesNavigation(root, undefined, "docs"), {
      initialProps: { root: "/repo" },
    });
    expect(view.result.current.path).toBe("docs");
    view.rerender({ root: "/other" });
    expect(view.result.current.path).toBeNull();
  });
  it.each([
    "../outside",
    "/absolute",
    "docs/../outside",
    "docs\\other",
    "docs\u202e",
    "docs\nother",
    "docs\u2028other",
    "docs/",
    "",
    "https://outside.test",
  ])("rejects an unsafe persisted initial folder: %s", (path) => {
    const view = renderHook(() => useFilesNavigation("/repo", undefined, path));
    expect(view.result.current.path).toBeNull();
  });

  it("keeps folder history across explicit roots and restores the relative folder", () => {
    const changeRoot = vi.fn();
    const { result, rerender } = renderHook(({ root }) => useFilesNavigation(root, changeRoot), {
      initialProps: { root: "/documents" },
    });
    act(() => result.current.visit("notes"));
    rerender({ root: "/projects" });
    expect(result.current.path).toBeNull();
    act(() => result.current.back());
    expect(changeRoot).toHaveBeenCalledWith("/documents");
    rerender({ root: "/documents" });
    expect(result.current.path).toBe("notes");
    act(() => result.current.forward());
    expect(changeRoot).toHaveBeenLastCalledWith("/projects");
    rerender({ root: "/projects" });
    expect(result.current.path).toBeNull();
  });

  it("drops forward history after a new selection, skips duplicates and bounds history", () => {
    const { result } = renderHook(() => useFilesNavigation("/documents"));
    act(() => {
      result.current.back();
      result.current.forward();
    });
    expect(result.current.canGoBack).toBe(false);
    act(() => result.current.visit("a"));
    act(() => result.current.visit("b"));
    act(() => result.current.back());
    act(() => result.current.visit("c"));
    expect(result.current.canGoForward).toBe(false);
    act(() => result.current.visit("c"));
    act(() => result.current.back());
    expect(result.current.path).toBe("a");
    act(() => {
      for (let index = 0; index < 150; index += 1) result.current.visit(String(index));
    });
    for (let index = 0; index < 105; index += 1) act(() => result.current.back());
    expect(result.current.path).toBe("50");
    expect(result.current.canGoBack).toBe(false);
  });

  it("resets history on task-bound root switches and initial fallback resolution", () => {
    const { result, rerender } = renderHook(({ root }) => useFilesNavigation(root), {
      initialProps: { root: "/task-a" },
    });
    act(() => result.current.visit("notes"));
    rerender({ root: "/task-b" });
    expect(result.current.path).toBeNull();
    expect(result.current.canGoBack).toBe(false);
    const fallback = renderHook(({ root }) => useFilesNavigation(root, vi.fn()), {
      initialProps: { root: "" },
    });
    fallback.rerender({ root: "/documents" });
    expect(fallback.result.current.canGoBack).toBe(false);
  });
});

function expectLifecyclePair(
  started: ClientDiagnosticMeta | undefined,
  settled: ClientDiagnosticMeta | undefined,
  readStarted: ClientDiagnosticMeta | undefined,
  readSettled: ClientDiagnosticMeta | undefined,
): void {
  expect(started?.stageReport).toMatchObject({ phase: "started" });
  expect(settled).toMatchObject({
    correlationId: started?.correlationId,
    stageReport: {
      phase: "settled",
      ordinal: started?.stageReport?.ordinal,
      navigationOutcome: "applied",
    },
  });
  expect(readStarted).toMatchObject({
    correlationId: started?.correlationId,
    stageReport: { phase: "started" },
  });
  expect(readSettled).toMatchObject({
    correlationId: started?.correlationId,
    stageReport: { phase: "settled", navigationOutcome: "applied" },
  });
}

it("records product navigation lifecycle pairs for visit, Back and Forward after each read", async () => {
  const writer = vi.fn<ClientDiagnosticWriter>();
  setClientDiagnosticWriter(writer);
  try {
    const { result } = renderHook(() => useFilesNavigation("/documents"));
    const actions = [
      (): void => result.current.visit("notes"),
      (): void => result.current.back(),
      (): void => result.current.forward(),
    ];
    for (const navigate of actions) {
      act(navigate);
      const context = result.current.takeRead(result.current.path ?? "");
      expect(context).toBeDefined();
      await observeFilesDirectoryRead(async () => undefined, context);
    }
    expect(writer).toHaveBeenCalledTimes(12);
    const navigation = writer.mock.calls.filter(
      (call) => call[1]?.stageReport?.stage === "files directory navigation",
    );
    const reads = writer.mock.calls.filter(
      (call) => call[1]?.stageReport?.stage === "files directory load",
    );
    expect(navigation).toHaveLength(6);
    expect(reads).toHaveLength(6);
    for (let index = 0; index < 6; index += 2) {
      expectLifecyclePair(
        navigation[index]?.[1],
        navigation[index + 1]?.[1],
        reads[index]?.[1],
        reads[index + 1]?.[1],
      );
    }
  } finally {
    resetClientDiagnosticWriter();
  }
});
