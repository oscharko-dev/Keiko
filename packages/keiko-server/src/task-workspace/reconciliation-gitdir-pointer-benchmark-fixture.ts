export const BENCHMARK_GITDIR_TARGET =
  "/managed/root/some-repo-abc123/.git/worktrees/keiko-task-def456";

export function benchmarkGitdirPointer(leadingSpaces: number, trailingSpaces: number): string {
  return (
    `gitdir:${" ".repeat(leadingSpaces)}` +
    `${BENCHMARK_GITDIR_TARGET}${" ".repeat(trailingSpaces)}\n`
  );
}
