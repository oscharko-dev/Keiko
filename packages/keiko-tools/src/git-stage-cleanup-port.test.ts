import { describe, expect, it, vi } from "vitest";
import type { GitIndexCleanupReport } from "@oscharko-dev/keiko-workspace/internal/git-index";

// The transaction is replaced by one that finishes with a cleanup it could not complete, so the test
// proves the port reaches the owning transaction for both staging entry points and that the
// settled result is returned unchanged.
const REPORT: GitIndexCleanupReport = {
  quarantines: 1,
  temporaryIndex: false,
  lock: true,
  descriptor: false,
};
vi.mock("@oscharko-dev/keiko-workspace/internal/git-index", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@oscharko-dev/keiko-workspace/internal/git-index")>();
  return {
    ...original,
    withGitIndexTransaction: vi.fn(
      (
        _root: string,
        _mutate: unknown,
        _accept: unknown,
        _fs: unknown,
        options: { onCleanupFailure?: (report: GitIndexCleanupReport) => void },
      ): Promise<boolean> => {
        options.onCleanupFailure?.(REPORT);
        return Promise.resolve(false);
      },
    ),
  };
});

const { stageExactFiles, unstageExactFiles } = await import("./git-stage-node.js");

function context(reports: GitIndexCleanupReport[]): Parameters<typeof unstageExactFiles>[0] {
  return {
    workspaceRoot: "/unused",
    check: () => Promise.resolve(true),
    authorized: () => true,
    run: () => Promise.reject(new Error("never run")),
    filterDriverNames: () => Promise.resolve([]),
    indexLineBreaks: () => Promise.resolve(new Map()),
    onIndexCleanupFailure: (report) => reports.push(report),
  };
}

describe("index cleanup report port", () => {
  it("reaches the transaction of an unstaging and leaves its result alone", async () => {
    const reports: GitIndexCleanupReport[] = [];
    await expect(
      unstageExactFiles(context(reports), [["restore", "--staged", "--", "a"]]),
    ).resolves.toBe(false);
    expect(reports).toEqual([REPORT]);
  });

  it("reaches the transaction of a staging and leaves its result alone", async () => {
    const reports: GitIndexCleanupReport[] = [];
    const head = { kind: "born", sha: "a".repeat(40) } as const;
    await expect(
      stageExactFiles(context(reports), {
        pathspecs: ["a.txt"],
        verified: {
          head,
          stagedTreeDigest: "0".repeat(64),
          branchName: "main",
          baseRef: "refs/heads/main",
          base: head,
        },
      }),
    ).resolves.toBe(false);
    expect(reports).toEqual([REPORT]);
  });
});
