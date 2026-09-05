import { isSafeGitRefName } from "@oscharko-dev/keiko-contracts/runtime/git-repository";
import { realpath } from "node:fs/promises";
import {
  GIT_CHANGE_SNAPSHOT_DEFAULT_TTL_MS,
  GIT_CHANGE_SNAPSHOT_MAX_TTL_MS,
  GIT_CHANGE_SNAPSHOT_SCHEMA_VERSION,
  deriveGitChangeSnapshotOutcome,
  gitChangeSnapshotDigestFields,
  isGitChangeSnapshot,
  resolveGitChangeSnapshotLimits,
  summarizeGitChangeSnapshotCompleteness,
  validateGitChangeSnapshotResult,
} from "@oscharko-dev/keiko-contracts/runtime/git-change-snapshot";
import type {
  GitChangeSnapshot,
  GitChangeSnapshotResult,
  GitChangeSnapshotLimits,
  WorkspaceInfo,
} from "@oscharko-dev/keiko-contracts";
import {
  defaultGitProcessRunner,
  resolveGitMembership,
  comparablePath,
} from "@oscharko-dev/keiko-git";
import type { GitProcessRunner } from "@oscharko-dev/keiko-git";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import { AbortDeadlineRaceError, raceAbortDeadline } from "./abort-race.js";
import { codingWorkbenchRemoteDigest } from "./coding-context/githubIssueResolution.js";
import { githubOwnerAndRepoFromRemoteUrl } from "./gitDelivery/branchProtectionPreflight.js";
import { describeError } from "./diagnostics-log.js";
import { deriveRepositoryId } from "./task-workspace/naming.js";
import { observedGitRunner } from "./gitProcessActivity.js";
import { parsePorcelainV2Branch } from "./gitPorcelainStatus.js";
import { processServerLogSink } from "./process-log-sink.js";
import type { ServerLogSink } from "./observability/server-log.js";
import {
  GitSnapshotReadError,
  GitSnapshotUnavailableError,
  readSnapshotGit,
  resolveSnapshotRevisions,
  snapshotDiffArgs,
} from "./gitChangeSnapshotReader.js";
import type { GitSnapshotReader, SnapshotRevisions } from "./gitChangeSnapshotReader.js";
import { parseSnapshotMetadata } from "./gitChangeSnapshotMetadata.js";
import { snapshotEntries } from "./gitChangeSnapshotEntries.js";
import { resolveSnapshotBinaryFiles } from "./gitChangeSnapshotBinary.js";
import { GitChangeSnapshotRegistry } from "./gitChangeSnapshotRegistry.js";
import type { GitSnapshotContent } from "./gitChangeSnapshotRegistry.js";

export interface GitChangeSnapshotCaptureInput {
  /** Server-resolved and already-authorized workspace; never deserialize this from a request. */
  readonly workspace: WorkspaceInfo;
  readonly baseRef: string;
  readonly headRef: string;
  readonly expectedHeadSha?: string;
  /** Server-held capability identity, compared by identity, never a browser-chosen string. */
  readonly accessScope: object;
  readonly correlationId: string;
  readonly signal?: AbortSignal;
  readonly limits?: Partial<GitChangeSnapshotLimits>;
  readonly ttlMs?: number;
  readonly timeoutMs?: number;
  /**
   * Whether a successful capture keeps a readable registry reference (default true, matching the
   * service's pre-existing behavior). B2-8 — a caller that only needs the returned `snapshot`
   * fields (e.g. a throwaway connect/refresh comparison that never reads `.reference` back) must
   * pass `false` so it stops competing with retained chat/PR-description captures for the shared
   * 32-slot registry.
   */
  readonly retain?: boolean;
}

export interface GitChangeSnapshotCapture {
  readonly snapshot: GitChangeSnapshotResult;
  readonly reference?: string;
}

export interface GitChangeSnapshotRecheck {
  readonly state: "current" | "stale" | "unavailable" | "failed";
  readonly snapshot?: GitChangeSnapshotResult;
}

export interface GitChangeSnapshotService {
  capture(input: GitChangeSnapshotCaptureInput): Promise<GitChangeSnapshotCapture>;
  read(reference: string, scope: object, correlationId: string): GitSnapshotContent | undefined;
  recheck(
    reference: string,
    input: GitChangeSnapshotCaptureInput,
  ): Promise<GitChangeSnapshotRecheck>;
  /**
   * B2-8 — pins a retained reference out of the shared registry's LRU eviction so an in-flight
   * consumer (e.g. a PR-description proposal awaiting review) is not evicted by unrelated capture
   * activity. Optional: existing callers/fakes that never need protection are unaffected. Returns
   * false when the reference/scope is unknown or the reservation cap is exhausted.
   */
  reserve?(reference: string, scope: object, correlationId: string): boolean;
  /** Releases a reservation made via `reserve`, e.g. once the proposal is applied or abandoned. */
  release?(reference: string, scope: object, correlationId: string): void;
  close(): void;
}

export interface GitChangeSnapshotServiceOptions {
  readonly runner?: GitProcessRunner;
  readonly logSink?: ServerLogSink;
  readonly now?: () => number;
}

function immutableLocalRunner(runner: GitProcessRunner): GitProcessRunner {
  return async (args, options) =>
    await runner(["--no-lazy-fetch", "--no-replace-objects", ...args], options);
}

function boundedDuration(value: number | undefined, fallback: number, maximum: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

async function repositoryReader(reader: GitSnapshotReader): Promise<GitSnapshotReader> {
  const root = await realpath(reader.cwd);
  const membership = await resolveGitMembership(
    root,
    async (args, options) => await readSnapshotGit(reader, args, options.maxBytes),
    { timeoutMs: reader.timeoutMs, abortSignal: reader.signal },
  );
  if (!membership.ok || membership.membership.prefix !== "")
    throw new GitSnapshotReadError("unsafe-repository");
  const repositoryRoot = await realpath(membership.membership.repositoryRoot);
  if (comparablePath(root) !== comparablePath(repositoryRoot))
    throw new GitSnapshotReadError("unsafe-repository");
  return { ...reader, cwd: repositoryRoot };
}

async function remoteDigest(reader: GitSnapshotReader): Promise<string | undefined> {
  const result = await reader.runner(["config", "--local", "--get", "remote.origin.url"], {
    cwd: reader.cwd,
    maxBytes: 4096,
    timeoutMs: reader.timeoutMs,
    abortSignal: reader.signal,
    expectedExitCodes: [1],
  });
  if (result.exitCode === 1 && !result.truncated) return undefined;
  if (result.aborted === true) throw new GitSnapshotReadError("cancelled");
  if (result.timedOut === true) throw new GitSnapshotReadError("timeout");
  if (result.exitCode !== 0 || result.truncated) throw new GitSnapshotReadError("git-error");
  const identity = githubOwnerAndRepoFromRemoteUrl(result.stdout.trim());
  return identity === undefined ? undefined : codingWorkbenchRemoteDigest(identity);
}

async function readSnapshotContent(
  reader: GitSnapshotReader,
  revisions: SnapshotRevisions,
  limits: GitChangeSnapshotLimits,
): Promise<{
  readonly parsed: ReturnType<typeof snapshotEntries>;
  readonly divergence: ReturnType<typeof parsePorcelainV2Branch>;
  readonly completeness: ReturnType<typeof summarizeGitChangeSnapshotCompleteness>;
}> {
  const raw = await readSnapshotGit(
    reader,
    snapshotDiffArgs(revisions, ["--raw", "-z", "--no-abbrev"]),
  );
  const numstat = await readSnapshotGit(reader, snapshotDiffArgs(revisions, ["--numstat", "-z"]));
  const metadata = await resolveSnapshotBinaryFiles(
    reader,
    parseSnapshotMetadata(raw.stdout, numstat.stdout),
    limits.maxFiles,
    revisions,
  );
  const paths = metadata
    .slice(0, limits.maxFiles)
    .filter((entry) => !entry.binary)
    .flatMap((entry) => (entry.oldPath === undefined ? [entry.path] : [entry.oldPath, entry.path]));
  const patch = await readSnapshotGit(
    reader,
    [
      ...snapshotDiffArgs(revisions, [
        "--patch",
        "--full-index",
        "--unified=3",
        "--inter-hunk-context=0",
      ]),
      ...new Set(paths.map((path) => `:(literal)${path}`)),
    ],
    limits.maxTotalBytes,
    true,
  );
  const parsed = snapshotEntries(metadata, patch.stdout, patch.truncated, limits);
  const divergence = await readLocalDivergence(reader);
  const completeness = summarizeGitChangeSnapshotCompleteness({
    entries: parsed.entries,
    totalFiles: metadata.length,
    bytes: parsed.bytes,
  });
  return { parsed, divergence, completeness };
}

async function readLocalDivergence(
  reader: GitSnapshotReader,
): Promise<ReturnType<typeof parsePorcelainV2Branch>> {
  const status = await readSnapshotGit(reader, [
    "status",
    "--porcelain=v2",
    "--branch",
    "-z",
    "--untracked-files=all",
  ]);
  return parsePorcelainV2Branch(status.stdout);
}

async function produceSnapshot(
  reader: GitSnapshotReader,
  input: GitChangeSnapshotCaptureInput,
  capturedAt: number,
): Promise<GitSnapshotContent> {
  const revisions = await resolveSnapshotRevisions(reader, input.baseRef, input.headRef);
  if (input.expectedHeadSha !== undefined && revisions.headSha !== input.expectedHeadSha)
    throw new GitSnapshotUnavailableError("head-mismatch", revisions);
  const canonicalRemote = await remoteDigest(reader);
  const limits = resolveGitChangeSnapshotLimits(input.limits);
  const { parsed, divergence, completeness } = await readSnapshotContent(reader, revisions, limits);
  await verifySnapshotBinding(reader, input, revisions, canonicalRemote);
  const fields = {
    schemaVersion: GIT_CHANGE_SNAPSHOT_SCHEMA_VERSION,
    repositoryId: deriveRepositoryId(reader.cwd),
    ...(canonicalRemote === undefined ? {} : { remoteDigest: canonicalRemote }),
    baseRef: input.baseRef,
    headRef: input.headRef,
    ...revisions,
    capturedAt: new Date(capturedAt).toISOString(),
    expiresAt: new Date(
      capturedAt +
        boundedDuration(
          input.ttlMs,
          GIT_CHANGE_SNAPSHOT_DEFAULT_TTL_MS,
          GIT_CHANGE_SNAPSHOT_MAX_TTL_MS,
        ),
    ).toISOString(),
    outcome: deriveGitChangeSnapshotOutcome(completeness),
    limits,
    completeness,
    entries: parsed.entries,
    localDivergence: {
      stagedCount: divergence.stagedCount,
      unstagedCount: divergence.unstagedCount,
      untrackedCount: divergence.untrackedCount,
      conflictedCount: divergence.conflictedCount,
    },
  };
  return {
    snapshot: {
      ...fields,
      snapshotDigest: sha256Hex(canonicalise(gitChangeSnapshotDigestFields(fields))),
    },
    files: parsed.files,
  };
}

async function verifySnapshotBinding(
  reader: GitSnapshotReader,
  input: GitChangeSnapshotCaptureInput,
  revisions: SnapshotRevisions,
  expectedRemote: string | undefined,
): Promise<void> {
  const live = await resolveSnapshotRevisions(reader, input.baseRef, input.headRef);
  const liveRemote = await remoteDigest(reader);
  if (
    live.baseSha !== revisions.baseSha ||
    live.headSha !== revisions.headSha ||
    live.mergeBaseSha !== revisions.mergeBaseSha ||
    liveRemote !== expectedRemote
  ) {
    throw new GitSnapshotUnavailableError("revision-mismatch", live);
  }
}

function captureFailure(
  input: GitChangeSnapshotCaptureInput,
  now: number,
  error: unknown,
): GitChangeSnapshotResult {
  const common = {
    schemaVersion: GIT_CHANGE_SNAPSHOT_SCHEMA_VERSION,
    repositoryId: deriveRepositoryId(input.workspace.root),
    capturedAt: new Date(now).toISOString(),
    ...(isSafeGitRefName(input.baseRef) ? { baseRef: input.baseRef } : {}),
    ...(isSafeGitRefName(input.headRef) ? { headRef: input.headRef } : {}),
  };
  if (error instanceof GitSnapshotUnavailableError)
    return { ...common, outcome: "unavailable", reason: error.reason, ...error.revisions };
  const reason = error instanceof GitSnapshotReadError ? error.reason : "git-error";
  const deadlineReason =
    error instanceof AbortDeadlineRaceError ? deadlineFailureReason(error) : reason;
  return { ...common, outcome: "failed", reason: deadlineReason, errorKind: deadlineReason };
}

function deadlineFailureReason(error: AbortDeadlineRaceError): "cancelled" | "timeout" {
  return error.reason === "aborted" ? "cancelled" : "timeout";
}

function logCapture(
  log: ServerLogSink,
  input: GitChangeSnapshotCaptureInput,
  snapshot: GitChangeSnapshotResult,
  error?: unknown,
): void {
  log.write({
    category: "process",
    op: "git.snapshot.capture",
    correlationId: input.correlationId,
    ...(snapshot.outcome === "failed" ? { level: "warn", errorKind: snapshot.errorKind } : {}),
    extra: {
      outcome: snapshot.outcome,
      repositoryId: snapshot.repositoryId,
      ...(isGitChangeSnapshot(snapshot)
        ? {
            snapshotDigest: snapshot.snapshotDigest,
            fileCount: snapshot.completeness.files,
            omittedFiles: snapshot.completeness.omittedFiles,
            truncatedFiles: snapshot.completeness.truncatedFiles,
          }
        : { reason: snapshot.reason }),
      ...(error === undefined ? {} : describeError(error)),
    },
  });
}

interface ServiceContext {
  readonly now: () => number;
  readonly log: ServerLogSink;
  readonly runner: GitProcessRunner;
  readonly registry: GitChangeSnapshotRegistry;
}

async function captureSnapshot(
  ctx: ServiceContext,
  input: GitChangeSnapshotCaptureInput,
  retain: boolean,
): Promise<GitChangeSnapshotCapture> {
  const startedAt = ctx.now();
  try {
    if (!isSafeGitRefName(input.baseRef) || !isSafeGitRefName(input.headRef))
      throw new GitSnapshotUnavailableError("invalid-ref");
    const timeoutMs = boundedDuration(input.timeoutMs, 30_000, 120_000);
    const content = await raceAbortDeadline(
      async ({ signal }) => {
        const reader = await repositoryReader({
          cwd: input.workspace.root,
          runner: observedGitRunner(ctx.runner, ctx.log, input.correlationId),
          signal,
          timeoutMs,
        });
        return await produceSnapshot(reader, input, startedAt);
      },
      { deadlineAtMs: startedAt + timeoutMs, nowMs: ctx.now, signal: input.signal },
    );
    if (!validateGitChangeSnapshotResult(content.snapshot).ok)
      throw new GitSnapshotReadError("malformed-output");
    const reference = retain
      ? ctx.registry.put(content, input.accessScope, input.correlationId)
      : undefined;
    logCapture(ctx.log, input, content.snapshot);
    return { snapshot: content.snapshot, ...(reference === undefined ? {} : { reference }) };
  } catch (error) {
    const snapshot = captureFailure(input, startedAt, error);
    logCapture(ctx.log, input, snapshot, error);
    return { snapshot };
  }
}

async function recheckSnapshot(
  ctx: ServiceContext,
  reference: string,
  input: GitChangeSnapshotCaptureInput,
): Promise<GitChangeSnapshotRecheck> {
  const retained = ctx.registry.get(reference, input.accessScope, input.correlationId);
  if (retained === undefined)
    return {
      state: ctx.registry.wasExpired(reference, input.accessScope) ? "stale" : "unavailable",
    };
  const fresh = await captureSnapshot(ctx, { ...input, limits: retained.snapshot.limits }, false);
  const state = recheckState(retained.snapshot, fresh.snapshot);
  if (state !== "current") ctx.registry.revoke(reference, input.accessScope, input.correlationId);
  ctx.log.write({
    category: "process",
    op: "git.snapshot.recheck",
    correlationId: input.correlationId,
    extra: { state },
  });
  return { state, snapshot: fresh.snapshot };
}

export function createGitChangeSnapshotService(
  options: GitChangeSnapshotServiceOptions = {},
): GitChangeSnapshotService {
  const runner = options.runner ?? defaultGitProcessRunner;
  const now = options.now ?? Date.now;
  const log = options.logSink ?? processServerLogSink();
  const registry = new GitChangeSnapshotRegistry(log, now);
  const ctx = {
    now,
    log,
    registry,
    runner: immutableLocalRunner(runner),
  };
  return {
    capture: async (input) => await captureSnapshot(ctx, input, input.retain ?? true),
    read: (reference, scope, correlationId) => registry.get(reference, scope, correlationId),
    recheck: async (reference, input): Promise<GitChangeSnapshotRecheck> =>
      await recheckSnapshot(ctx, reference, input),
    reserve: (reference, scope, correlationId) => registry.reserve(reference, scope, correlationId),
    release: (reference, scope, correlationId): void => {
      registry.release(reference, scope, correlationId);
    },
    close: (): void => {
      registry.close();
    },
  };
}

function recheckState(
  previous: GitChangeSnapshot,
  fresh: GitChangeSnapshotResult,
): GitChangeSnapshotRecheck["state"] {
  if (!isGitChangeSnapshot(fresh)) return fresh.outcome === "failed" ? "failed" : "stale";
  return previous.snapshotDigest === fresh.snapshotDigest &&
    previous.repositoryId === fresh.repositoryId
    ? "current"
    : "stale";
}
