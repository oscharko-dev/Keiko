import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { GitChangedFile, GitRepositoryStatusResponse } from "@oscharko-dev/keiko-contracts";
import type { GitBranchListEntry } from "@/lib/api";

import { stagedSelectionSignature, useCommitDraftRevision } from "./commitDraftRevision";

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

const MAIN: readonly GitBranchListEntry[] = [{ name: "main", headRefHash: "aaa", current: true }];
const BRANCHED: readonly GitBranchListEntry[] = [
  { name: "main", headRefHash: "aaa", current: false },
  { name: "feature/x", headRefHash: "aaa", current: true },
];

describe("stagedSelectionSignature", () => {
  const staged = file("src/a.ts", { indexStatus: "M", staged: true });

  it("is unknown while no status is loaded, the repository is unavailable or the head is unread", () => {
    expect(stagedSelectionSignature(null, MAIN)).toBeNull();
    expect(stagedSelectionSignature(undefined, MAIN)).toBeNull();
    expect(stagedSelectionSignature(status([staged], { available: false }), MAIN)).toBeNull();
    expect(stagedSelectionSignature(status([staged], { branch: "feature/x" }), MAIN)).toBeNull();
  });

  it("stays the same across a new branch from the current commit and unstaged edits", () => {
    const before = stagedSelectionSignature(status([staged]), MAIN);
    const onBranch = stagedSelectionSignature(
      status([file("README.md", { worktreeStatus: "M", unstaged: true }), staged], {
        branch: "feature/x",
      }),
      BRANCHED,
    );
    expect(onBranch).toBe(before);
  });

  it("moves when the commit under the staged changes moves", () => {
    const before = stagedSelectionSignature(status([staged]), MAIN);
    const elsewhere: readonly GitBranchListEntry[] = [
      { name: "main", headRefHash: "aaa", current: false },
      { name: "release", headRefHash: "bbb", current: true },
    ];
    expect(stagedSelectionSignature(status([staged], { branch: "release" }), elsewhere)).not.toBe(
      before,
    );
    const committed: readonly GitBranchListEntry[] = [
      { name: "main", headRefHash: "ccc", current: true },
    ];
    expect(stagedSelectionSignature(status([staged]), committed)).not.toBe(before);
    expect(stagedSelectionSignature(status([staged], { detached: true }), MAIN)).not.toBe(before);
  });

  it("moves when a path is staged or unstaged, or its index status or origin changes", () => {
    const before = stagedSelectionSignature(status([staged]), MAIN);
    expect(stagedSelectionSignature(status([]), MAIN)).not.toBe(before);
    const added = file("src/b.ts", { indexStatus: "A", staged: true });
    expect(stagedSelectionSignature(status([staged, added]), MAIN)).not.toBe(before);
    expect(stagedSelectionSignature(status([{ ...staged, indexStatus: "D" }]), MAIN)).not.toBe(
      before,
    );
    const renamed = { ...staged, oldPath: "src/old.ts" };
    expect(stagedSelectionSignature(status([renamed]), MAIN)).not.toBe(before);
    expect(stagedSelectionSignature(status([staged], { truncated: true }), MAIN)).not.toBe(before);
  });

  it("does not depend on the order Git lists the changes in", () => {
    const b = file("src/b.ts", { indexStatus: "A", staged: true });
    expect(stagedSelectionSignature(status([staged, b]), MAIN)).toBe(
      stagedSelectionSignature(status([b, staged]), MAIN),
    );
  });
});

describe("useCommitDraftRevision", () => {
  const staged = file("src/a.ts", { indexStatus: "M", staged: true });
  type Input = {
    readonly repository: string | null;
    readonly status: GitRepositoryStatusResponse | null;
    readonly branches?: readonly GitBranchListEntry[];
    readonly staging?: number;
    readonly redemptions?: number;
  };

  function mount(initial: Input): {
    readonly revision: () => string;
    readonly next: (input: Input) => void;
  } {
    const view = renderHook(
      (input: Input) =>
        useCommitDraftRevision(input.repository, input.status, input.branches ?? MAIN, {
          staging: input.staging ?? 0,
          redemptions: input.redemptions ?? 0,
        }),
      { initialProps: initial },
    );
    return { revision: () => view.result.current, next: (input) => view.rerender(input) };
  }

  it("keeps the revision while the status and the branch list are read again after a new branch", () => {
    const hook = mount({ repository: "/repos/alpha", status: status([staged]) });
    const before = hook.revision();
    hook.next({ repository: "/repos/alpha", status: null });
    expect(hook.revision()).toBe(before);
    hook.next({ repository: "/repos/alpha", status: status([staged], { branch: "feature/x" }) });
    expect(hook.revision()).toBe(before);
    hook.next({
      repository: "/repos/alpha",
      status: status([staged], { branch: "feature/x" }),
      branches: BRANCHED,
    });
    expect(hook.revision()).toBe(before);
  });

  it("moves on a stage click and after a re-pair", () => {
    const hook = mount({ repository: "/repos/alpha", status: status([staged]) });
    const before = hook.revision();
    hook.next({ repository: "/repos/alpha", status: status([staged]), staging: 1 });
    const staged1 = hook.revision();
    expect(staged1).not.toBe(before);
    hook.next({ repository: "/repos/alpha", status: status([staged]), staging: 1, redemptions: 1 });
    expect(hook.revision()).not.toBe(staged1);
  });

  it("moves when another repository is selected, even with the same staged selection", () => {
    const hook = mount({ repository: "/repos/alpha", status: status([staged]) });
    const alpha = hook.revision();
    hook.next({ repository: "/repos/beta", status: null });
    expect(hook.revision()).not.toBe(alpha);
    hook.next({ repository: "/repos/beta", status: status([staged]) });
    expect(hook.revision()).not.toBe(alpha);
  });
});
