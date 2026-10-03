import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { setClientDiagnosticWriter, resetClientDiagnosticWriter } from "@/lib/client-diagnostics";
import { useFilesNavigation } from "./useFilesNavigation";

describe("folder navigation", () => {
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

it("records product navigation lifecycle pairs for visit, Back and Forward", () => {
  const writer = vi.fn();
  setClientDiagnosticWriter(writer);
  try {
    const { result } = renderHook(() => useFilesNavigation("/documents"));
    act(() => result.current.visit("notes"));
    act(() => result.current.back());
    act(() => result.current.forward());
    expect(writer).toHaveBeenCalledTimes(6);
    for (let index = 0; index < 6; index += 2) {
      const started = writer.mock.calls[index]?.[1];
      const settled = writer.mock.calls[index + 1]?.[1];
      expect(started?.stageReport).toMatchObject({
        stage: "files directory navigation",
        phase: "started",
      });
      expect(settled).toMatchObject({
        correlationId: started?.correlationId,
        stageReport: {
          stage: "files directory navigation",
          phase: "settled",
          ordinal: started?.stageReport.ordinal,
        },
      });
    }
  } finally {
    resetClientDiagnosticWriter();
  }
});
