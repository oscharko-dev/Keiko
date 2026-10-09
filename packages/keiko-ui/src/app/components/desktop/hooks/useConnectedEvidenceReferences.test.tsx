import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { connectedInspectionAnswer } from "../connectedEvidenceInspection.test-fixtures";
import { connectedScopeFingerprint } from "./workspaceScopeIdentity";
import { useConnectedEvidenceReferences } from "./useConnectedEvidenceReferences";

const fingerprint = connectedScopeFingerprint({
  kind: "workspace-root",
  root: "/repo",
  relativePaths: [],
  connectedAtMs: 1,
});
const roots = [{ root: "/repo", label: "repo", scopeFingerprints: [fingerprint] }];

describe("answer-bound read paths", () => {
  it("clears reads across answer versions and ignores a stale or unrelated manifest", () => {
    const view = renderHook(({ answer }) => useConnectedEvidenceReferences(answer, roots), {
      initialProps: { answer: connectedInspectionAnswer() },
    });
    const staleRead = view.result.current.onReadPaths;
    act(() => staleRead("run-1", ["src/feature/read.ts"], fingerprint));
    expect(view.result.current.evidence?.readPaths).toEqual(["src/feature/read.ts"]);
    view.rerender({ answer: connectedInspectionAnswer("run-2") });
    expect(view.result.current.evidence?.readPaths).toEqual([]);
    act(() => view.result.current.onReadPaths("run-2", ["src/feature/current.ts"], fingerprint));
    act(() => staleRead("run-1", ["src/feature/stale.ts"], fingerprint));
    expect(view.result.current.evidence?.readPaths).toEqual(["src/feature/current.ts"]);
    act(() =>
      view.result.current.onReadPaths("outside-run", ["src/feature/foreign.ts"], fingerprint),
    );
    expect(view.result.current.evidence?.readPaths).toEqual(["src/feature/current.ts"]);
  });
  it("clears attribution when the connected root changes", () => {
    const answer = connectedInspectionAnswer();
    const view = renderHook(
      ({ currentRoots }) => useConnectedEvidenceReferences(answer, currentRoots),
      {
        initialProps: {
          currentRoots: roots as readonly {
            root: string;
            label: string;
            scopeFingerprints?: readonly string[];
          }[],
        },
      },
    );
    act(() => view.result.current.onReadPaths("run-1", ["src/feature/read.ts"], fingerprint));
    view.rerender({ currentRoots: [{ root: "/other", label: "other" }] });
    expect(view.result.current.evidence?.readPaths).toEqual([]);
  });
  it.each([
    undefined,
    "malformed",
    connectedScopeFingerprint({
      kind: "workspace-root",
      root: "/other",
      relativePaths: [],
      connectedAtMs: 1,
    }),
  ])("leaves a missing or unmatched persisted identity unattributed: %s", (identity) => {
    const view = renderHook(() =>
      useConnectedEvidenceReferences(connectedInspectionAnswer(), roots),
    );
    act(() => view.result.current.onReadPaths("run-1", ["src/feature/read.ts"], identity));
    expect(view.result.current.evidence?.readPaths).toEqual([]);
    expect(view.result.current.evidence?.inspectedPaths).toEqual([
      { scopePath: "src/feature/read.ts", sourceScopeFingerprint: identity },
    ]);
  });
});
