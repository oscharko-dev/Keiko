// Request-local worktree hints reuse the hardened, observed Git boundary. These hints do not
// admit evidence: the normal discovery/read path still owns file eligibility and every floor.
import { createHash } from "node:crypto";
import { relative } from "node:path";
import {
  isPathWithinSelectedScope,
  isValidScopePath,
  validateSelectedScope,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  containsPath,
  defaultGitProcessRunner,
  GIT_BASE_ARGS,
  resolveGitMembership,
  type GitProcessResult,
  type GitProcessRunner,
} from "@oscharko-dev/keiko-git";
import { isGeneratedRankingPath } from "@oscharko-dev/keiko-workflows";
import {
  compileIgnore,
  containedRealPathInfo,
  isDenied,
  isIgnored,
  resolveWithinWorkspace,
  type SearchScope,
  type WorkspaceFs,
} from "@oscharko-dev/keiko-workspace";
import { isCanonicalAllowedContainedPath } from "@oscharko-dev/keiko-workspace/internal/realpath-policy";
import { AbortDeadlineRaceError, raceAbortDeadline } from "./abort-race.js";
import { correlationIdOrUnknown } from "./correlation.js";
import {
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSink,
} from "./diagnostics-log.js";
import { observedGitRunner } from "./gitProcessActivity.js";
import { parsePorcelainV2Changes, type PorcelainV2Change } from "./gitPorcelainStatus.js";
import type { ServerLogSink } from "./observability/index.js";
import { processServerLogSink } from "./process-log-sink.js";

const STATUS_MAX_BYTES = 512 * 1024;
const STATUS_TIMEOUT_MS = 1_500;
const RECENT_PATH_CAP = 64;

export interface WorktreeRecencyInputs {
  readonly scope: SelectedScope;
  readonly searchScope: SearchScope;
  readonly workspaceKind: "git-repository" | "directory";
  readonly fs: WorkspaceFs;
  readonly nowMs: () => number;
  readonly deadlineAtMs: number;
  readonly observationAllowed?: boolean;
  readonly signal?: AbortSignal | undefined;
  readonly gitRunner?: GitProcessRunner | undefined;
  readonly activityLog?: ServerLogSink | undefined;
  readonly diagnostics?: ServerDiagnosticSink | undefined;
  readonly correlationId?: string | undefined;
}

export interface WorktreeRecencyObservation {
  readonly worktreeStatusState: "available" | "unavailable" | "skipped";
  readonly worktreeStatusDisposition: "not-git" | "unavailable" | "applied" | "skipped-budget";
  readonly worktreeObservedFileCount: number;
  readonly worktreeInScopeFileCount: number;
  readonly worktreeDeletedFileCount: number;
}

export interface WorktreeRecencyResult {
  readonly paths: readonly PorcelainV2Change[];
  readonly observation: WorktreeRecencyObservation;
  readonly statusDigest?: string;
}

function stopped(inputs: WorktreeRecencyInputs): boolean {
  return (
    inputs.observationAllowed === false ||
    inputs.signal?.aborted === true ||
    Number.isNaN(inputs.deadlineAtMs) ||
    inputs.nowMs() >= inputs.deadlineAtMs
  );
}

function empty(
  disposition: WorktreeRecencyObservation["worktreeStatusDisposition"],
): WorktreeRecencyResult {
  return {
    paths: [],
    observation: {
      worktreeStatusState: disposition === "unavailable" ? "unavailable" : "skipped",
      worktreeStatusDisposition: disposition,
      worktreeObservedFileCount: 0,
      worktreeInScopeFileCount: 0,
      worktreeDeletedFileCount: 0,
    },
  };
}

function selectedPath(inputs: WorktreeRecencyInputs, path: string): boolean {
  return (
    isValidScopePath(path, { mustBeRelative: true }) &&
    !isDenied(path) &&
    isPathWithinSelectedScope(inputs.scope, new Set(inputs.scope.relativePaths), path)
  );
}

function safeFile(stat: ReturnType<WorkspaceFs["stat"]>): boolean {
  return stat.isFile && !stat.isSymbolicLink && (stat.hardLinkCount ?? 1) <= 1;
}

function admittedPath(inputs: WorktreeRecencyInputs, path: string): boolean {
  if (stopped(inputs) || !selectedPath(inputs, path)) return false;
  if (
    isGeneratedRankingPath(path) ||
    isIgnored(compileIgnore(inputs.searchScope.workspace.ignoreLines), path, false)
  )
    return false;
  try {
    const root = inputs.searchScope.workspace.root;
    const contained = containedRealPathInfo(inputs.fs, root, resolveWithinWorkspace(root, path));
    if (stopped(inputs)) return false;
    if (
      !isCanonicalAllowedContainedPath(contained, root, path) ||
      !selectedPath(inputs, contained.realRelative.replaceAll("\\", "/"))
    )
      return false;
    const stat = inputs.fs.stat(contained.path);
    return !stopped(inputs) && safeFile(stat);
  } catch {
    return false;
  }
}

function scopedChange(change: PorcelainV2Change, prefix: string): PorcelainV2Change | undefined {
  if (prefix.length === 0) return change;
  const marker = `${prefix}/`;
  return change.path.startsWith(marker)
    ? { ...change, path: change.path.slice(marker.length) }
    : undefined;
}

function collectedObservation(
  inputs: WorktreeRecencyInputs,
  stdout: string,
  prefix: string,
): WorktreeRecencyResult {
  const changes = parsePorcelainV2Changes(stdout);
  const paths: PorcelainV2Change[] = [];
  const seen = new Set<string>();
  let deleted = 0;
  for (const raw of changes) {
    if (stopped(inputs)) return empty("skipped-budget");
    const change = scopedChange(raw, prefix);
    if (change === undefined || !selectedPath(inputs, change.path) || seen.has(change.path))
      continue;
    seen.add(change.path);
    if (change.status === "deleted") deleted += 1;
    else if (paths.length < RECENT_PATH_CAP && admittedPath(inputs, change.path))
      paths.push(change);
  }
  return {
    paths,
    statusDigest: createHash("sha256").update(stdout).digest("hex"),
    observation: {
      // Available is a bounded scoped observation, not a promise of exhaustive enumeration.
      worktreeStatusState: "available",
      worktreeStatusDisposition: "applied",
      worktreeObservedFileCount: changes.length,
      worktreeInScopeFileCount: paths.length,
      worktreeDeletedFileCount: deleted,
    },
  };
}

function stage<T>(
  inputs: WorktreeRecencyInputs,
  operation: Parameters<typeof raceAbortDeadline<T>>[0],
): Promise<T> {
  return raceAbortDeadline(operation, {
    nowMs: inputs.nowMs,
    deadlineAtMs: Math.min(inputs.deadlineAtMs, inputs.nowMs() + STATUS_TIMEOUT_MS),
    signal: inputs.signal,
  });
}

function completeResult(result: GitProcessResult): boolean {
  return (
    result.exitCode === 0 &&
    !result.truncated &&
    result.timedOut !== true &&
    result.aborted !== true
  );
}

function selectedStatusPathspecs(scope: SelectedScope): readonly string[] {
  const paths = scope.kind === "workspace-root" ? ["."] : scope.relativePaths;
  return paths.map((path) => `:(literal)${path}`);
}

async function resolveMembership(
  inputs: WorktreeRecencyInputs,
  runner: GitProcessRunner,
  root: string,
): Promise<Awaited<ReturnType<typeof resolveGitMembership>> | undefined> {
  const observation = { incomplete: false };
  const membership = await stage(inputs, ({ signal, timeoutMs }) =>
    resolveGitMembership(
      root,
      async (args, options): Promise<GitProcessResult> => {
        const result = await runner(args, options);
        observation.incomplete = !completeResult(result);
        return result;
      },
      { timeoutMs, abortSignal: signal },
    ),
  );
  return observation.incomplete ? undefined : membership;
}

async function readStatus(
  inputs: WorktreeRecencyInputs,
  runner: GitProcessRunner,
): Promise<WorktreeRecencyResult> {
  const root = inputs.fs.realPath(inputs.scope.workspaceRoot);
  if (stopped(inputs)) return empty("skipped-budget");
  if (root !== inputs.fs.realPath(inputs.searchScope.workspace.root) || stopped(inputs))
    return empty("unavailable");
  const membership = await resolveMembership(inputs, runner, root);
  if (membership?.ok !== true || stopped(inputs)) return empty("unavailable");
  const repositoryRoot = inputs.fs.realPath(membership.membership.repositoryRoot);
  if (!containsPath(repositoryRoot, root)) return empty("unavailable");
  const prefix = relative(repositoryRoot, root).replaceAll("\\", "/");
  const result = await stage(inputs, ({ signal, timeoutMs }) =>
    runner(
      [
        ...GIT_BASE_ARGS,
        "-C",
        root,
        "status",
        "--porcelain=v2",
        "-z",
        "--untracked-files=all",
        "--",
        ...selectedStatusPathspecs(inputs.scope),
      ],
      { cwd: root, maxBytes: STATUS_MAX_BYTES, timeoutMs, abortSignal: signal },
    ),
  );
  if (!completeResult(result)) return empty("unavailable");
  return stopped(inputs)
    ? empty("skipped-budget")
    : collectedObservation(inputs, result.stdout, prefix);
}

export async function observeWorktreeRecency(
  inputs: WorktreeRecencyInputs,
): Promise<WorktreeRecencyResult> {
  if (stopped(inputs)) return empty("skipped-budget");
  if (inputs.workspaceKind !== "git-repository") return empty("not-git");
  if (!validateSelectedScope(inputs.scope).ok) return empty("unavailable");
  const runner = observedGitRunner(
    inputs.gitRunner ?? defaultGitProcessRunner,
    inputs.activityLog ?? processServerLogSink(),
    inputs.correlationId,
  );
  try {
    return await readStatus(
      {
        ...inputs,
        deadlineAtMs: Math.min(inputs.deadlineAtMs, inputs.nowMs() + STATUS_TIMEOUT_MS),
      },
      runner,
    );
  } catch (error) {
    if (stopped(inputs) || error instanceof AbortDeadlineRaceError) return empty("skipped-budget");
    emitServerDiagnostic(inputs.diagnostics, {
      ...serverDiagnosticFromError({
        correlationId: correlationIdOrUnknown(inputs.correlationId),
        operation: "worktree-status",
        source: "grounded-worktree-recency",
        error,
        redact: (value) => value,
        now: inputs.nowMs,
      }),
      diagnosticOutcome: "source-skipped",
    });
    return empty("unavailable");
  }
}
