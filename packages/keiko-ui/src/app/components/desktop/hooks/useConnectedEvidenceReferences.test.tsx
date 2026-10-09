import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { connectedInspectionAnswer } from "../connectedEvidenceInspection.test-fixtures";
import { useConnectedEvidenceReferences } from "./useConnectedEvidenceReferences";

const roots = [{ root: "/repo", label: "repo" }];

describe("answer-bound read paths", () => {
  it("clears reads across answer versions and ignores a stale or unrelated manifest", () => {
    const view = renderHook(({ answer }) => useConnectedEvidenceReferences(answer, roots), {
      initialProps: { answer: connectedInspectionAnswer() },
    });
    const staleRead = view.result.current.onReadPaths;
    act(() => staleRead("run-1", ["src/feature/read.ts"]));
    expect(view.result.current.evidence?.readPaths).toEqual(["src/feature/read.ts"]);
    view.rerender({ answer: connectedInspectionAnswer("run-2") });
    expect(view.result.current.evidence?.readPaths).toEqual([]);
    act(() => view.result.current.onReadPaths("run-2", ["src/feature/current.ts"]));
    act(() => staleRead("run-1", ["src/feature/stale.ts"]));
    expect(view.result.current.evidence?.readPaths).toEqual(["src/feature/current.ts"]);
    act(() => view.result.current.onReadPaths("outside-run", ["src/feature/foreign.ts"]));
    expect(view.result.current.evidence?.readPaths).toEqual(["src/feature/current.ts"]);
  });
  it("clears attribution when the connected root changes", () => {
    const answer = connectedInspectionAnswer();
    const view = renderHook(
      ({ currentRoots }) => useConnectedEvidenceReferences(answer, currentRoots),
      { initialProps: { currentRoots: roots } },
    );
    act(() => view.result.current.onReadPaths("run-1", ["src/feature/read.ts"]));
    view.rerender({ currentRoots: [{ root: "/other", label: "other" }] });
    expect(view.result.current.evidence?.readPaths).toEqual([]);
  });
});
