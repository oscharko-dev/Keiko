// Node implementation of the narrow governed merge adapter (Issue #478, Epic #470) — AC1/AC4/AC5.
//
// This is the ONLY place a governed merge operation actually executes. It builds the governed `gh api`
// argv from the pure builders (git-merge-gateway.ts) and runs them through the SAME keiko-tools no-shell
// spawn boundary (`runCommand`, exec.ts) with a DEDICATED merge allowlist (`GIT_MERGE_COMMAND_RULES`)
// that permits only `gh api` and denies file-input flags. There is no method that accepts an arbitrary
// command string and no parallel child_process path: the deny-by-default allowlist, env isolation,
// redaction, and cancellation of the shared boundary apply to the merge operation exactly as to every
// other tool.
//
// `gh` reads its own GitHub token from its keyring or from GH_TOKEN/GITHUB_TOKEN. Those names reach
// the child ONLY because this adapter runs on the governed REMOTE env lane
// (GOVERNED_GIT_REMOTE_SANDBOX_POLICY): the lane forwards the credential NAMES and the real HOME so
// gh can resolve `~/.config/gh`, and the spawn boundary keeps their VALUES in its output scrub set —
// Keiko never reads, stores, or logs the token. The readiness READ maps GitHub's
// content-free PR facts (state / draft / mergeable_state) and repo merge configuration into the
// provider-neutral contract interfaces; a non-OK merge status is classified into a typed
// GitMergeRejectionReason. Raw stdout/stderr never leave this module — only the typed facts, the
// content-free contract error code, and the typed rejection reason cross out.
//
// Lives on the `./internal/git-mutation` subpath (re-exported by git-mutation-node.ts) because it carries
// the Node execution effect; the pure port, builders, and rules it implements are on the barrel.

import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type {
  GitDeliveryBranchProtection,
  GitDeliveryChecksState,
  GitDeliveryExecutionResult,
  GitDeliveryMergeStrategyHint,
} from "@oscharko-dev/keiko-contracts";
import { GIT_DELIVERY_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/git-delivery";
import {
  buildBranchProtectionArgv,
  buildCheckRunsArgv,
  buildDeleteMergedBranchArgv,
  buildMergeArgv,
  buildMergeReadinessArgv,
  buildPullRequestReviewsArgv,
  buildRepoMergeConfigArgv,
  classifyGitMergeRejection,
  GIT_MERGE_COMMAND_RULES,
  gitMergeRejectionToErrorCode,
  mapRawMergeReadiness,
  type GitMergeAdapter,
  type GitBranchProtectionRequest,
  type GitMergeExecRequest,
  type GitMergeExecResult,
  type GitMergeProviderReadiness,
  type GitMergeReadinessRequest,
  type RawMergeReadiness,
} from "./git-merge-gateway.js";
import { CommandCancelledError, CommandTimeoutError } from "./errors.js";
import {
  nodeSpawnFn,
  runCommand,
  type ExecutableResolver,
  type HomeProvider,
  type RunCommandDeps,
  type SpawnFn,
  type CommandTerminationEvidence,
} from "./exec.js";
import {
  GOVERNED_GIT_REMOTE_SANDBOX_POLICY,
  type CommandResult,
  type SandboxPolicy,
} from "./types.js";

export interface NodeGitMergeAdapterDeps {
  readonly workspace: WorkspaceInfo;
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
  readonly now?: (() => number) | undefined;
  readonly spawn?: SpawnFn | undefined;
  // Defaults to the governed REMOTE lane (as for the publish and PR adapters): a merge — and the
  // readiness read that precedes it — legitimately egresses to GitHub and must be able to
  // authenticate, which the fully isolated default makes impossible (no GH_TOKEN/GITHUB_TOKEN,
  // empty HOME, so neither the gh keyring nor `~/.config/gh` is reachable).
  readonly policy?: SandboxPolicy | undefined;
  readonly resolveExecutable?: ExecutableResolver | undefined;
  readonly home?: HomeProvider | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
  // The termination-evidence port for every runCommand this lane performs (RunCommandDeps
  // deps-level seam, exec.ts): production composition boundaries wire it once so no call on the
  // lane is silently unobservable (PR #3354 review, comment 3887021650).
  readonly onTerminated?: ((evidence: CommandTerminationEvidence) => void) | undefined;
}

function executionResult(
  outcome: GitDeliveryExecutionResult["outcome"],
  durationMs: number,
  extra?: Partial<GitMergeExecResult>,
): GitMergeExecResult {
  return {
    schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
    outcome,
    durationMs: Math.max(0, Math.trunc(durationMs)),
    ...extra,
  };
}

interface RunContext {
  readonly runDeps: RunCommandDeps;
  readonly signal: AbortSignal;
  readonly timeoutMs: number | undefined;
}

function buildRunContext(deps: NodeGitMergeAdapterDeps): RunContext {
  return {
    runDeps: {
      workspace: deps.workspace,
      policy: deps.policy ?? GOVERNED_GIT_REMOTE_SANDBOX_POLICY,
      commandRules: GIT_MERGE_COMMAND_RULES,
      spawn: deps.spawn ?? nodeSpawnFn,
      processEnv: deps.processEnv ?? process.env,
      now: deps.now ?? Date.now,
      ...(deps.resolveExecutable !== undefined
        ? { resolveExecutable: deps.resolveExecutable }
        : {}),
      ...(deps.home !== undefined ? { home: deps.home } : {}),
      ...(deps.onTerminated !== undefined ? { onTerminated: deps.onTerminated } : {}),
    },
    signal: deps.signal ?? new AbortController().signal,
    timeoutMs: deps.timeoutMs,
  };
}

function rejectionFromExit(result: CommandResult): GitMergeExecResult {
  if (result.timedOut) {
    return executionResult("failed", result.durationMs, {
      errorCode: "timeout",
      rejectionReason: "provider-unavailable",
    });
  }
  const reason = classifyGitMergeRejection(`${result.stdout}\n${result.stderr}`);
  return executionResult("failed", result.durationMs, {
    errorCode: gitMergeRejectionToErrorCode(reason),
    rejectionReason: reason,
  });
}

function failureFromThrow(error: unknown, durationMs: number): GitMergeExecResult {
  if (error instanceof CommandTimeoutError) {
    return executionResult("failed", durationMs, {
      errorCode: "timeout",
      rejectionReason: "provider-unavailable",
    });
  }
  if (error instanceof CommandCancelledError) {
    return executionResult("aborted", durationMs);
  }
  return executionResult("failed", durationMs, { errorCode: "internal-error" });
}

async function runGh(ctx: RunContext, argv: readonly string[]): Promise<CommandResult | Error> {
  try {
    return await runCommand(
      { command: "gh", args: argv, cwd: undefined, timeoutMs: ctx.timeoutMs, signal: ctx.signal },
      ctx.runDeps,
    );
  } catch (error) {
    return error instanceof Error ? error : new Error("gh invocation failed");
  }
}

// ─── Readiness read (PR facts + repo merge config + optional head check status) ───────────────────────

interface RawPrFacts {
  readonly state?: unknown;
  readonly merged?: unknown;
  readonly draft?: unknown;
  readonly mergeable_state?: unknown;
  readonly base?: unknown;
  readonly head?: unknown;
  readonly headRef?: unknown;
}

function parseJsonObject(stdout: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function rawMergeReadinessFrom(
  facts: RawPrFacts,
  req: GitMergeReadinessRequest,
): RawMergeReadiness {
  return {
    prNumber: req.prExternalId,
    headBranchName: optionalString(facts.headRef) ?? "unknown",
    ...(optionalString(facts.state) !== undefined ? { state: optionalString(facts.state) } : {}),
    ...(typeof facts.merged === "boolean" ? { merged: facts.merged } : {}),
    ...(typeof facts.draft === "boolean" ? { draft: facts.draft } : {}),
    ...(optionalString(facts.mergeable_state) !== undefined
      ? { mergeableState: optionalString(facts.mergeable_state) }
      : {}),
    ...(optionalString(facts.base) !== undefined ? { baseRef: optionalString(facts.base) } : {}),
    ...(optionalString(facts.head) !== undefined ? { headSha: optionalString(facts.head) } : {}),
  };
}

function capableStrategiesFrom(
  cfg: Record<string, unknown>,
): readonly GitDeliveryMergeStrategyHint[] {
  const caps: GitDeliveryMergeStrategyHint[] = [];
  if (cfg.squash === true) caps.push("squash");
  if (cfg.rebase === true) caps.push("rebase");
  if (cfg.merge === true) caps.push("merge-commit");
  return caps;
}

function parseJsonArray(stdout: string): readonly Record<string, unknown>[] | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is Record<string, unknown> =>
            typeof entry === "object" && entry !== null && !Array.isArray(entry),
        )
      : undefined;
  } catch {
    return undefined;
  }
}

// Conclusions the Checks API reports as a completed run's outcome that count as PASSING for merge
// readiness purposes ("neutral"/"skipped" are non-blocking by GitHub's own semantics). Every other
// completed conclusion (failure/cancelled/timed_out/action_required/stale) counts as FAILING; a run
// still `in_progress`/`queued` (no conclusion yet) counts as PENDING.
const PASSING_CONCLUSIONS: ReadonlySet<string> = new Set(["success", "neutral", "skipped"]);

interface RawCheckRun {
  readonly id: number;
  readonly name: string;
  readonly providerId?: number | undefined;
  readonly status?: unknown;
  readonly conclusion?: unknown;
}

interface RequiredCheck {
  readonly name: string;
  readonly providerId?: number | undefined;
}

type CheckRunTally = Pick<GitDeliveryChecksState, "total" | "passing" | "failing" | "pending">;

// Aggregate verdict precedence, strongest signal first: one failing run fails the head; otherwise one
// still-running run holds it pending; otherwise a non-empty run list passes. Zero runs is "skipped" —
// a head with no check surface to judge, which must NOT be reported as having passed one.
function overallChecksStatus(tally: CheckRunTally): GitDeliveryChecksState["overallStatus"] {
  if (tally.failing > 0) return "failing";
  if (tally.pending > 0) return "pending";
  if (tally.total > 0) return "passing";
  return "skipped";
}

function tallyCheckRuns(runs: readonly RawCheckRun[]): CheckRunTally {
  let passing = 0;
  let failing = 0;
  let pending = 0;
  for (const run of runs) {
    if (run.status !== "completed") {
      pending += 1;
      continue;
    }
    if (typeof run.conclusion === "string" && PASSING_CONCLUSIONS.has(run.conclusion)) {
      passing += 1;
    } else {
      failing += 1;
    }
  }
  return { total: runs.length, passing, failing, pending };
}

// Derives the REAL aggregate check state from the modern Checks API's per-run status/conclusion list
// — replaces the previous single combined "state" string read from the legacy Statuses API
// (`/commits/{sha}/status`), which could report only one aggregate verdict with no total/pass/fail/
// pending breakdown.
function checkGroupFromRuns(runs: readonly RawCheckRun[]): GitDeliveryChecksState {
  const tally = tallyCheckRuns(runs);
  return { ...tally, overallStatus: overallChecksStatus(tally) };
}

function shouldReadHeadChecks(
  mergeableState: string | undefined,
  requiredChecks: readonly RequiredCheck[],
): boolean {
  return (
    requiredChecks.length > 0 ||
    mergeableState === "blocked" ||
    mergeableState === "unstable" ||
    mergeableState === "unknown"
  );
}

interface RawCheckRunRecord extends Record<string, unknown> {
  readonly id: number;
  readonly name: string;
  readonly providerId: number | null;
  readonly status: string;
  readonly conclusion: string | null;
}

function isProviderRunId(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value));
}

function isRawCheckRunRecord(value: Record<string, unknown>): value is RawCheckRunRecord {
  return (
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    isProviderRunId(value.providerId) &&
    typeof value.status === "string" &&
    (value.conclusion === null || typeof value.conclusion === "string")
  );
}

function rawCheckRun(value: Record<string, unknown>): RawCheckRun | undefined {
  if (!isRawCheckRunRecord(value)) return undefined;
  const providerId = value.providerId ?? undefined;
  return {
    id: value.id,
    name: value.name,
    status: value.status,
    conclusion: value.conclusion,
    providerId,
  };
}

function checkKey(check: Pick<RawCheckRun, "name" | "providerId">): string {
  const providerKey = check.providerId === undefined ? "*" : String(check.providerId);
  return `${check.name}\u0000${providerKey}`;
}

function latestRuns(runs: readonly RawCheckRun[]): readonly RawCheckRun[] {
  const latest = new Map<string, RawCheckRun>();
  for (const run of runs) {
    const current = latest.get(checkKey(run));
    if (current === undefined || run.id > current.id) latest.set(checkKey(run), run);
  }
  return [...latest.values()];
}

function selectRequiredRun(
  requirement: RequiredCheck,
  runs: readonly RawCheckRun[],
): RawCheckRun | undefined {
  const matches = runs.filter(
    (run) =>
      run.name === requirement.name &&
      (requirement.providerId === undefined || run.providerId === requirement.providerId),
  );
  return matches.reduce<RawCheckRun | undefined>(
    (latest, run) => (latest === undefined || run.id > latest.id ? run : latest),
    undefined,
  );
}

function missingRequiredRun(requirement: RequiredCheck): RawCheckRun {
  return { id: -1, name: requirement.name, providerId: requirement.providerId, status: "queued" };
}

function classifyChecks(
  requiredChecks: readonly RequiredCheck[],
  checkRuns: readonly RawCheckRun[],
): GitDeliveryChecksState {
  const uniqueRuns = latestRuns(checkRuns);
  const selectedKeys = new Set<string>();
  const requiredRuns = requiredChecks.map((requirement) => {
    const run = selectRequiredRun(requirement, uniqueRuns);
    if (run !== undefined) selectedKeys.add(checkKey(run));
    return run ?? missingRequiredRun(requirement);
  });
  const informationalRuns = uniqueRuns.filter((run) => !selectedKeys.has(checkKey(run)));
  return {
    ...checkGroupFromRuns(requiredRuns),
    informational: checkGroupFromRuns(informationalRuns),
  };
}

async function readHeadChecks(
  ctx: RunContext,
  ownerAndRepo: string,
  headSha: string | undefined,
  requiredChecks: readonly RequiredCheck[],
): Promise<GitDeliveryChecksState | undefined> {
  if (headSha === undefined) return undefined;
  let argv: readonly string[];
  try {
    argv = buildCheckRunsArgv(ownerAndRepo, headSha);
  } catch {
    return undefined;
  }
  const result = await runGh(ctx, argv);
  if (result instanceof Error || result.exitCode !== 0) {
    return undefined;
  }
  const runs = parseJsonArray(result.stdout);
  if (runs === undefined) return undefined;
  const parsedRuns: RawCheckRun[] = [];
  for (const run of runs) {
    const parsed = rawCheckRun(run);
    if (parsed === undefined) return undefined;
    parsedRuns.push(parsed);
  }
  return classifyChecks(requiredChecks, parsedRuns);
}

interface RawReview {
  readonly user?: unknown;
  readonly state?: unknown;
}

// GitHub does not dedupe a reviewer's review history server-side: a reviewer who requested changes
// and later approved appears TWICE, and only their LATEST review is their current disposition. This
// reduces to "latest state per reviewer" (in submission order, which is what the reviews endpoint
// returns) before counting APPROVED — counting every APPROVED row unconditionally would overcount a
// reviewer who approved, was asked to re-review, and had not yet done so.
function approvedReviewCountFrom(reviews: readonly RawReview[]): number {
  const latestByUser = new Map<string, string>();
  for (const review of reviews) {
    if (typeof review.user !== "string" || typeof review.state !== "string") continue;
    latestByUser.set(review.user, review.state);
  }
  let approved = 0;
  for (const state of latestByUser.values()) {
    if (state === "APPROVED") approved += 1;
  }
  return approved;
}

// Best-effort read of the PR's received approval count. A read failure (network, permission, or an
// unparseable body) yields 0 — the same "no known approvals" default the hardcoded value used to
// report unconditionally, but now only as a fallback rather than the permanent answer.
async function readReceivedApprovalCount(
  ctx: RunContext,
  req: GitMergeReadinessRequest,
): Promise<number> {
  let argv: readonly string[];
  try {
    argv = buildPullRequestReviewsArgv(req);
  } catch {
    return 0;
  }
  const result = await runGh(ctx, argv);
  if (result instanceof Error || result.exitCode !== 0) return 0;
  const reviews = parseJsonArray(result.stdout);
  return reviews === undefined ? 0 : approvedReviewCountFrom(reviews);
}

interface BranchProtectionProjection {
  readonly protection: GitDeliveryBranchProtection;
  readonly requiredChecks: readonly RequiredCheck[];
}

function requiredCheck(value: unknown): RequiredCheck | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || record.name.length === 0) return undefined;
  if (record.providerId === null) return { name: record.name };
  if (typeof record.providerId !== "number" || !Number.isSafeInteger(record.providerId)) {
    return undefined;
  }
  return { name: record.name, providerId: record.providerId };
}

function uniqueRequiredChecks(values: readonly unknown[]): readonly RequiredCheck[] | undefined {
  const unique = new Map<string, RequiredCheck>();
  for (const value of values) {
    const check = requiredCheck(value);
    if (check === undefined) return undefined;
    unique.set(checkKey(check), check);
  }
  return [...unique.values()];
}

interface RawBranchProtection extends Record<string, unknown> {
  readonly deletionAllowed: boolean;
  readonly forcePushAllowed: boolean;
  readonly linearHistoryRequired: boolean;
  readonly signaturesRequired: boolean;
  readonly requiredReviewCount: number;
  readonly requiredChecks: readonly unknown[];
}

function isRawBranchProtection(value: Record<string, unknown>): value is RawBranchProtection {
  return (
    typeof value.deletionAllowed === "boolean" &&
    typeof value.forcePushAllowed === "boolean" &&
    typeof value.linearHistoryRequired === "boolean" &&
    typeof value.signaturesRequired === "boolean" &&
    typeof value.requiredReviewCount === "number" &&
    Number.isSafeInteger(value.requiredReviewCount) &&
    value.requiredReviewCount >= 0 &&
    Array.isArray(value.requiredChecks)
  );
}

function parseBranchProtection(stdout: string): BranchProtectionProjection | undefined {
  const value = parseJsonObject(stdout);
  if (value === undefined || !isRawBranchProtection(value)) return undefined;
  const requiredChecks = uniqueRequiredChecks(value.requiredChecks);
  if (requiredChecks === undefined) return undefined;
  return {
    protection: {
      deletionAllowed: value.deletionAllowed,
      forcePushAllowed: value.forcePushAllowed,
      linearHistoryRequired: value.linearHistoryRequired,
      signaturesRequired: value.signaturesRequired,
      requiredReviewCount: value.requiredReviewCount,
      requiredStatusCheckCount: requiredChecks.length,
    },
    requiredChecks,
  };
}

type BranchProtectionRead =
  | { readonly outcome: "protected"; readonly projection: BranchProtectionProjection }
  | { readonly outcome: "unprotected" }
  | { readonly outcome: "error" };

function isNotFound(result: CommandResult): boolean {
  return result.exitCode !== 0 && /\bHTTP\s+404\b/u.test(result.stderr);
}

async function readBranchProtection(
  ctx: RunContext,
  req: GitBranchProtectionRequest,
): Promise<BranchProtectionRead> {
  let argv: readonly string[];
  try {
    argv = buildBranchProtectionArgv(req);
  } catch {
    return { outcome: "error" };
  }
  const result = await runGh(ctx, argv);
  if (result instanceof Error) return { outcome: "error" };
  if (isNotFound(result)) return { outcome: "unprotected" };
  if (result.exitCode !== 0) return { outcome: "error" };
  const projection = parseBranchProtection(result.stdout);
  return projection === undefined ? { outcome: "error" } : { outcome: "protected", projection };
}

export type GitBranchProtectionReadResult =
  | { readonly outcome: "protected"; readonly protection: GitDeliveryBranchProtection }
  | { readonly outcome: "unprotected" }
  | { readonly outcome: "unavailable" };

export async function readNodeGitBranchProtection(
  deps: NodeGitMergeAdapterDeps,
  req: GitBranchProtectionRequest,
): Promise<GitBranchProtectionReadResult> {
  const result = await readBranchProtection(buildRunContext(deps), req);
  if (result.outcome === "protected") {
    return { outcome: "protected", protection: result.projection.protection };
  }
  return result.outcome === "unprotected" ? { outcome: "unprotected" } : { outcome: "unavailable" };
}

// Reads the PR object (facts only, un-enriched with approval counts). Returns undefined on any
// argv-construction, transport, or parse failure — the caller maps that to a provider-error readiness.
async function readPrObject(
  ctx: RunContext,
  req: GitMergeReadinessRequest,
): Promise<Record<string, unknown> | undefined> {
  let prArgv: readonly string[];
  try {
    prArgv = buildMergeReadinessArgv(req);
  } catch {
    return undefined;
  }
  const prResult = await runGh(ctx, prArgv);
  if (prResult instanceof Error || prResult.exitCode !== 0) return undefined;
  return parseJsonObject(prResult.stdout);
}

// Best-effort read of the repository's allowed merge strategies. A read failure yields an empty set,
// the same "no capable strategies known" default the caller has always used for this read.
async function readCapableStrategies(
  ctx: RunContext,
  req: GitMergeReadinessRequest,
): Promise<readonly GitDeliveryMergeStrategyHint[]> {
  let cfgArgv: readonly string[];
  try {
    cfgArgv = buildRepoMergeConfigArgv(req);
  } catch {
    return [];
  }
  const cfgResult = await runGh(ctx, cfgArgv);
  if (cfgResult instanceof Error || cfgResult.exitCode !== 0) return [];
  const cfgObj = parseJsonObject(cfgResult.stdout);
  return cfgObj !== undefined ? capableStrategiesFrom(cfgObj) : [];
}

function successfulProviderReadiness(
  raw: RawMergeReadiness,
  providerCapableStrategies: readonly GitDeliveryMergeStrategyHint[],
  checks: GitDeliveryChecksState | undefined,
  projection: BranchProtectionProjection | undefined,
): GitMergeProviderReadiness {
  return {
    pullRequest: mapRawMergeReadiness(raw),
    providerCapableStrategies,
    ...(checks !== undefined ? { checks } : {}),
    ...(projection !== undefined ? { branchProtection: projection.protection } : {}),
    ...(raw.headSha !== undefined ? { headRefHash: raw.headSha } : {}),
  };
}

async function completeMergeReadiness(
  ctx: RunContext,
  req: GitMergeReadinessRequest,
  factsOnly: RawMergeReadiness,
  providerCapableStrategies: readonly GitDeliveryMergeStrategyHint[],
  receivedApprovalCount: number,
  projection: BranchProtectionProjection | undefined,
): Promise<GitMergeProviderReadiness> {
  const requiredApprovalCount = projection?.protection.requiredReviewCount ?? 0;
  const raw: RawMergeReadiness = { ...factsOnly, receivedApprovalCount, requiredApprovalCount };
  const requiredChecks = projection?.requiredChecks ?? [];
  const mustReadChecks = shouldReadHeadChecks(raw.mergeableState, requiredChecks);
  const checks = mustReadChecks
    ? await readHeadChecks(ctx, req.ownerAndRepo, raw.headSha, requiredChecks)
    : undefined;
  if (mustReadChecks && checks === undefined) {
    return { providerCapableStrategies, providerError: true };
  }
  return successfulProviderReadiness(raw, providerCapableStrategies, checks, projection);
}

async function readMergeReadiness(
  ctx: RunContext,
  req: GitMergeReadinessRequest,
): Promise<GitMergeProviderReadiness> {
  const prObj = await readPrObject(ctx, req);
  if (prObj === undefined) {
    return { providerCapableStrategies: [], providerError: true };
  }
  const factsOnly = rawMergeReadinessFrom(prObj, req);

  // The repo-config, reviews, and branch-protection reads are independent of each other and of the
  // PR object already in hand, so they run concurrently rather than as three sequential round-trips.
  const [providerCapableStrategies, receivedApprovalCount, branchProtection] = await Promise.all([
    readCapableStrategies(ctx, req),
    readReceivedApprovalCount(ctx, req),
    readBranchProtection(ctx, req),
  ]);
  if (branchProtection.outcome === "error") {
    return { providerCapableStrategies, providerError: true };
  }
  const projection =
    branchProtection.outcome === "protected" ? branchProtection.projection : undefined;
  return completeMergeReadiness(
    ctx,
    req,
    factsOnly,
    providerCapableStrategies,
    receivedApprovalCount,
    projection,
  );
}

// ─── Merge execute (+ guarded, non-fatal branch deletion) ─────────────────────────────────────────────

function parseMerged(stdout: string): boolean {
  return stdout.trim() === "true";
}

// Deletes the merged head branch best-effort. A failed deletion NEVER fails the merge (the merge already
// succeeded); it only reports branchDeleted=false.
async function deleteMergedBranch(ctx: RunContext, req: GitMergeExecRequest): Promise<boolean> {
  let argv: readonly string[];
  try {
    argv = buildDeleteMergedBranchArgv(req.ownerAndRepo, req.headBranchName);
  } catch {
    return false;
  }
  const result = await runGh(ctx, argv);
  return !(result instanceof Error) && result.exitCode === 0;
}

async function mergePullRequest(
  ctx: RunContext,
  req: GitMergeExecRequest,
): Promise<GitMergeExecResult> {
  let argv: readonly string[];
  try {
    argv = buildMergeArgv(req);
  } catch {
    return executionResult("failed", 0, { errorCode: "internal-error" });
  }
  const result = await runGh(ctx, argv);
  if (result instanceof Error) {
    return failureFromThrow(result, 0);
  }
  if (result.exitCode !== 0) {
    return rejectionFromExit(result);
  }
  const merged = parseMerged(result.stdout);
  if (!req.deleteBranchAfterMerge || !merged) {
    return executionResult("succeeded", result.durationMs, { merged });
  }
  const branchDeleted = await deleteMergedBranch(ctx, req);
  return executionResult("succeeded", result.durationMs, { merged, branchDeleted });
}

export function createNodeGitMergeAdapter(deps: NodeGitMergeAdapterDeps): GitMergeAdapter {
  const ctx = buildRunContext(deps);
  return {
    readMergeReadiness: (req: GitMergeReadinessRequest): Promise<GitMergeProviderReadiness> =>
      readMergeReadiness(ctx, req),
    mergePullRequest: (req: GitMergeExecRequest): Promise<GitMergeExecResult> =>
      mergePullRequest(ctx, req),
  };
}
