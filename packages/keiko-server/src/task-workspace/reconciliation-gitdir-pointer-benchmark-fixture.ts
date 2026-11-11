// A pointer target of the host's own form: on Windows a target that is not a local drive path is
// refused before parsing (#4068 W7), so a POSIX target would measure that refusal instead.
export const BENCHMARK_GITDIR_TARGET =
  process.platform === "win32"
    ? String.raw`C:\managed\root\some-repo-abc123\.git\worktrees\keiko-task-def456`
    : "/managed/root/some-repo-abc123/.git/worktrees/keiko-task-def456";

export function benchmarkGitdirPointer(leadingSpaces: number, trailingSpaces: number): string {
  return (
    `gitdir:${" ".repeat(leadingSpaces)}` +
    `${BENCHMARK_GITDIR_TARGET}${" ".repeat(trailingSpaces)}\n`
  );
}
