import { describe, expect, it } from "vitest";
import type { GitChangedFile, GitRepositoryStatusResponse } from "@oscharko-dev/keiko-contracts";

import { stagedSelectionSignature } from "./commitDraftRevision";

function file(path: string, overrides: Partial<GitChangedFile> = {}): GitChangedFile {
  return {
    path,
    indexStatus: " ",
    worktreeStatus: " ",
    staged: false,
    unstaged: false,
    untracked: false,
    conflicted: false,
    ...overrides,
  } as GitChangedFile;
}

function status(
  changes: readonly GitChangedFile[],
  overrides: Partial<GitRepositoryStatusResponse> = {},
): GitRepositoryStatusResponse {
  return {
    schemaVersion: "1",
    root: "/repos/alpha",
    state: "clean",
    available: true,
    branch: "main",
    detached: false,
    clean: false,
    stagedCount: changes.filter((change) => change.staged).length,
    unstagedCount: 0,
    untrackedCount: 0,
    conflictedCount: 0,
    changes,
    truncated: false,
    maxChanges: 1000,
    ...overrides,
  } as GitRepositoryStatusResponse;
}

describe("stagedSelectionSignature", () => {
  const staged = file("src/a.ts", { indexStatus: "M", staged: true });

  it("is unknown while no status is loaded or the repository is unavailable", () => {
    expect(stagedSelectionSignature(null)).toBeNull();
    expect(stagedSelectionSignature(undefined)).toBeNull();
    expect(stagedSelectionSignature(status([staged], { available: false }))).toBeNull();
  });

  it("stays the same across a new branch and unstaged edits that keep the staged selection", () => {
    const before = stagedSelectionSignature(status([staged]));
    const onBranch = stagedSelectionSignature(
      status([file("README.md", { worktreeStatus: "M", unstaged: true }), staged], {
        branch: "feature/x",
      }),
    );
    expect(onBranch).toBe(before);
  });

  it("moves when a path is staged or unstaged, or its index status or origin changes", () => {
    const before = stagedSelectionSignature(status([staged]));
    expect(stagedSelectionSignature(status([]))).not.toBe(before);
    expect(
      stagedSelectionSignature(
        status([staged, file("src/b.ts", { indexStatus: "A", staged: true })]),
      ),
    ).not.toBe(before);
    expect(stagedSelectionSignature(status([{ ...staged, indexStatus: "D" }]))).not.toBe(before);
    expect(stagedSelectionSignature(status([{ ...staged, oldPath: "src/old.ts" }]))).not.toBe(
      before,
    );
    expect(stagedSelectionSignature(status([staged], { truncated: true }))).not.toBe(before);
  });

  it("does not depend on the order Git lists the changes in", () => {
    const b = file("src/b.ts", { indexStatus: "A", staged: true });
    expect(stagedSelectionSignature(status([staged, b]))).toBe(
      stagedSelectionSignature(status([b, staged])),
    );
  });
});
