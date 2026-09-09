import { isCodeTaskGitCommitSha } from "@oscharko-dev/keiko-contracts/runtime/code-task-acceptance";
import type {
  GitChangeSnapshotFailureReason,
  GitChangeSnapshotUnavailableReason,
} from "@oscharko-dev/keiko-contracts";
import type { GitProcessResult, GitProcessRunner } from "@oscharko-dev/keiko-git";

export class GitSnapshotReadError extends Error {
  public constructor(public readonly reason: GitChangeSnapshotFailureReason) {
    super("Git snapshot read failed");
    this.name = "GitSnapshotReadError";
  }
}

export class GitSnapshotUnavailableError extends Error {
  public constructor(
    public readonly reason: GitChangeSnapshotUnavailableReason,
    public readonly revisions: Partial<SnapshotRevisions> = {},
  ) {
    super("Git snapshot unavailable");
    this.name = "GitSnapshotUnavailableError";
  }
}

export interface SnapshotRevisions {
  readonly baseSha: string;
  readonly headSha: string;
  readonly mergeBaseSha: string;
}

export interface GitSnapshotReader {
  readonly cwd: string;
  readonly runner: GitProcessRunner;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export const SNAPSHOT_METADATA_BYTES = 8 * 1024 * 1024;

function requireProcess(result: GitProcessResult): void {
  if (result.aborted === true) throw new GitSnapshotReadError("cancelled");
  if (result.timedOut === true) throw new GitSnapshotReadError("timeout");
  if (result.refusal !== undefined) throw new GitSnapshotReadError("unsafe-repository");
  if (result.exitCode === 127) throw new GitSnapshotReadError("git-missing");
  if (result.exitCode !== 0 && !result.truncated) throw new GitSnapshotReadError("git-error");
}

export async function readSnapshotGit(
  reader: GitSnapshotReader,
  args: readonly string[],
  maxBytes = SNAPSHOT_METADATA_BYTES,
  allowTruncation = false,
): Promise<GitProcessResult> {
  const result = await reader.runner(args, {
    cwd: reader.cwd,
    maxBytes,
    timeoutMs: reader.timeoutMs,
    abortSignal: reader.signal,
  });
  requireProcess(result);
  if (result.truncated && !allowTruncation) throw new GitSnapshotReadError("metadata-truncated");
  return result;
}

async function resolveRevision(
  reader: GitSnapshotReader,
  ref: string,
): Promise<string | undefined> {
  const result = await reader.runner(
    ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    {
      cwd: reader.cwd,
      maxBytes: 256,
      timeoutMs: reader.timeoutMs,
      abortSignal: reader.signal,
      expectedExitCodes: [128],
    },
  );
  if (result.exitCode === 128 && !result.truncated && result.refusal === undefined)
    return undefined;
  requireProcess(result);
  if (result.truncated) throw new GitSnapshotReadError("metadata-truncated");
  const sha = result.stdout.trim();
  if (!isCodeTaskGitCommitSha(sha)) throw new GitSnapshotReadError("malformed-output");
  return sha;
}

async function resolveRefPair(
  reader: GitSnapshotReader,
  baseRef: string,
  headRef: string,
): Promise<Pick<SnapshotRevisions, "baseSha" | "headSha">> {
  const baseSha = await resolveRevision(reader, baseRef);
  const headSha = await resolveRevision(reader, headRef);
  if (baseSha === undefined || headSha === undefined) {
    throw new GitSnapshotUnavailableError("missing-ref", {
      ...(baseSha === undefined ? {} : { baseSha }),
      ...(headSha === undefined ? {} : { headSha }),
    });
  }
  if (baseSha === headSha)
    throw new GitSnapshotUnavailableError("identical-revisions", { baseSha, headSha });
  return { baseSha, headSha };
}

export async function resolveSnapshotRevisions(
  reader: GitSnapshotReader,
  baseRef: string,
  headRef: string,
): Promise<SnapshotRevisions> {
  const format = await readSnapshotGit(reader, ["rev-parse", "--show-object-format"], 64);
  if (format.stdout.trim() !== "sha1")
    throw new GitSnapshotUnavailableError("unsupported-object-format");
  const { baseSha, headSha } = await resolveRefPair(reader, baseRef, headRef);
  const result = await reader.runner(["merge-base", "--all", baseSha, headSha], {
    cwd: reader.cwd,
    maxBytes: 1024,
    timeoutMs: reader.timeoutMs,
    abortSignal: reader.signal,
    expectedExitCodes: [1],
  });
  if (result.exitCode === 1 && !result.truncated)
    throw new GitSnapshotUnavailableError("no-merge-base", { baseSha, headSha });
  requireProcess(result);
  const mergeBaseSha = result.stdout.trim();
  if (!isCodeTaskGitCommitSha(mergeBaseSha) || result.truncated)
    throw new GitSnapshotReadError("malformed-output");
  if (mergeBaseSha === headSha)
    throw new GitSnapshotUnavailableError("head-behind-base", { baseSha, headSha, mergeBaseSha });
  return { baseSha, headSha, mergeBaseSha };
}

/** Version-1 comparison pins: never inherit an ambient diff algorithm, prefix, or rename policy. */
export function snapshotDiffArgs(
  revisions: SnapshotRevisions,
  lane: readonly string[],
): readonly string[] {
  const config = [
    "core.quotepath=false",
    "diff.noprefix=false",
    "diff.mnemonicPrefix=false",
    "diff.relative=false",
    "diff.renames=copies",
    "diff.algorithm=myers",
    "diff.indentHeuristic=false",
    "diff.suppressBlankEmpty=false",
    "diff.interHunkContext=0",
    `attr.tree=${revisions.headSha}`,
    `core.attributesFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
  ];
  return [
    ...config.flatMap((value) => ["-c", value]),
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    // Binary classification comes from immutable blob prefixes, never mutable attributes/drivers.
    "--text",
    "--no-relative",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--diff-algorithm=myers",
    "--no-indent-heuristic",
    "--find-renames=50%",
    "--find-copies=50%",
    "--find-copies-harder",
    "-l2000",
    "--submodule=short",
    "--ignore-submodules=none",
    `-O${process.platform === "win32" ? "NUL" : "/dev/null"}`,
    ...lane,
    revisions.mergeBaseSha,
    revisions.headSha,
    "--",
  ];
}
