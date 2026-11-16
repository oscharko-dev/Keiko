import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { CommandDeniedError } from "./errors.js";
import { runCommand } from "./exec.js";
import { createNodeGitWorktreeAdapter, GitWorktreeSpawnError } from "./git-worktree-adapter.js";

vi.mock("./exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./exec.js")>()),
  runCommand: vi.fn(),
}));

const WORKSPACE: WorkspaceInfo = {
  root: "/synthetic-workspace",
  selectedRoot: "/synthetic-workspace",
  name: "synthetic",
  version: undefined,
  testFramework: "node",
  sourceDirs: [],
  testDirs: [],
  languages: [],
  ignoreLines: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(runCommand).mockResolvedValue({
    command: "git",
    args: [],
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 0,
    timedOut: false,
    truncated: false,
  });
});
afterEach(() => vi.restoreAllMocks());

describe("worktree adapter environment boundary", () => {
  it("retains allowlisted Windows values from the copied dev BFF environment", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const parent = {
      Path: "synthetic-path",
      systemroot: "synthetic-system-root",
      Secret: "private-canary",
    };
    await createNodeGitWorktreeAdapter({
      workspace: WORKSPACE,
      processEnv: { ...parent },
    }).resolveRepositoryRoot();
    expect(vi.mocked(runCommand).mock.calls[0]?.[1].processEnv).toEqual({
      PATH: parent.Path,
      SystemRoot: parent.systemroot,
    });
  });

  it("preserves the original failure for the existing body-free cause-chain evidence", async () => {
    const cause = new CommandDeniedError("private-path-canary", "git");
    vi.mocked(runCommand).mockRejectedValue(cause);
    const pending = createNodeGitWorktreeAdapter({ workspace: WORKSPACE }).resolveRepositoryRoot();
    await expect(pending).rejects.toBeInstanceOf(GitWorktreeSpawnError);
    await expect(pending).rejects.toMatchObject({ cause });
    await expect(pending).rejects.not.toThrow("private-path-canary");
  });
});
