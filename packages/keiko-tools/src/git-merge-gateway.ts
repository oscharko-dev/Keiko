// The governed merge gateway (Issue #478, Epic #470, ADR-0087) — AC1–AC5.
//
// This is the merge-orchestration authority the #472 kernel and the #477 PR gateway both deferred: a
// THIRD parallel execution authority, never an extension of the publish gateway or the PR gateway. A
// merge shells a distinct `gh api` REST call (`PUT /repos/{owner}/{repo}/pulls/{number}/merge`) with a
// distinct failure taxonomy (405 not-mergeable, 409 head-modified, 422 required-status-checks), so this
// gateway has its OWN narrow two-method adapter port (read readiness + execute merge), its OWN dedicated
// `gh api` allowlist, and its OWN GitHub merge-error classifier. It NEVER touches the local mutation
// adapter, the publish gateway, or the PR gateway.
//
// Like the kernel and the other gateways, it is deterministic given its injected dependencies. It
// performs no IO of its own: the actual `gh api` calls live behind the injected GitMergeAdapter
// (implemented by git-merge-node.ts on the Node subpath). It reuses the kernel's pure machinery
// unchanged: evaluateGitPreflight (merge maps to preflightNoLocalPrecondition), the
// GitMutationLifecycleResult shape (so the #474 evidence builder consumes the merge lifecycle with no
// change), and the failure taxonomy.
//
// The merge governs three gates in order: (1) preflight, (2) policy + final approval (the default pack
// makes merge approval-gated), and (3) the READINESS gate — it reads the provider's content-free
// merge-readiness facts and refuses to call the merge endpoint when a blocking blocker is present, in
// addition to the provider's own server-side enforcement (AC1).

import type {
  GitDeliveryActionEnvelope,
  GitDeliveryActionPreview,
  GitDeliveryApprovalRequirement,
  GitDeliveryBlockReason,
  GitDeliveryBranchProtection,
  GitDeliveryChecksState,
  GitDeliveryConstraint,
  GitDeliveryExecutionResult,
  GitDeliveryMergeInputs,
  GitDeliveryMergeReadiness,
  GitDeliveryMergeStrategyHint,
  GitDeliveryOrgPolicyPack,
  GitDeliveryPolicyContext,
  GitDeliveryPolicyDecision,
  GitDeliveryProviderCapability,
  GitDeliveryPullRequestState,
  GitDeliveryRepoPolicyPack,
  GitMergeReadinessSummary,
  GitMergeRejection,
  GitMergeRejectionReason,
  GitMergeStrategyPolicy,
} from "@oscharko-dev/keiko-contracts";
import {
  deriveEligibleMergeStrategies,
  evaluateGitPolicy,
  GIT_DELIVERY_MERGE_STRATEGY_HINTS,
  GIT_DELIVERY_SCHEMA_VERSION,
  gitDeliveryBranchNameMatchesAny,
  gitDeliveryRiskClassWithinCeiling,
  gitMergeReadinessFor,
  gitMergeRejectionFor,
  gitMergeRejectionToErrorCode,
} from "@oscharko-dev/keiko-contracts";
import type { CommandRule } from "@oscharko-dev/keiko-contracts";
import type { GitWorktreeSnapshot } from "./git-mutation-preflight.js";
import { evaluateGitPreflight } from "./git-mutation-preflight.js";
import type {
  GitMutationLifecycleResult,
  GitMutationOutcome,
} from "./git-mutation-orchestrator.js";
import type { GitMutationFailureCategory } from "./git-mutation-taxonomy.js";
import { gitMutationCategoryForExecutionResult } from "./git-mutation-taxonomy.js";

// ─── Merge command + narrow adapter port (no generic exec) ───────────────────────────────────────────
// The command carries the structured operands the content-free GitDeliveryMergeInputs deliberately omits
// (the branch names for policy targeting and the optional head-sha guard). The narrow GitMergeAdapter has
// exactly two typed methods: a readiness READ and a merge EXECUTE. There is no run(args) escape hatch.

export interface GitMergeCommand {
  readonly kind: "merge";
  readonly ownerAndRepo: string; // "owner/repo", validated by the argv builders
  readonly prExternalId: string; // provider-assigned PR number (opaque, numeric)
  readonly baseBranchName: string;
  readonly headBranchName: string;
  readonly mergeStrategy: GitDeliveryMergeStrategyHint;
  readonly deleteBranchAfterMerge: boolean;
  // Optional expected head commit SHA. When present it is forwarded as the GitHub merge `sha` guard so
  // the merge fails closed (409 head-modified) if the head advanced after readiness was read.
  readonly expectedHeadRefHash?: string | undefined;
}

export interface GitMergeReadinessRequest {
  readonly ownerAndRepo: string;
  readonly prExternalId: string;
}

export interface GitMergeExecRequest {
  readonly ownerAndRepo: string;
  readonly prExternalId: string;
  readonly headBranchName: string;
  readonly mergeStrategy: GitDeliveryMergeStrategyHint;
  readonly deleteBranchAfterMerge: boolean;
  readonly expectedHeadRefHash?: string | undefined;
}

// The neutral provider merge-readiness facts the readiness read returns. Populated by the Node adapter
// from the GitHub PR object + repo merge config; mapped to the provider-neutral contract interfaces.
export interface GitMergeProviderReadiness {
  readonly pullRequest?: GitDeliveryPullRequestState | undefined;
  readonly checks?: GitDeliveryChecksState | undefined;
  readonly branchProtection?: GitDeliveryBranchProtection | undefined;
  // The strategies the provider repository allows (read from repo merge configuration). Empty when the
  // provider read failed or did not report any.
  readonly providerCapableStrategies: readonly GitDeliveryMergeStrategyHint[];
  // Set when the provider read failed.
  readonly providerError?: boolean | undefined;
}

// The merge execution result: the content-free contract execution result, plus the typed merge
// rejection reason classified from GitHub's own error envelope, plus the merged / branch-deleted flags.
export interface GitMergeExecResult extends GitDeliveryExecutionResult {
  readonly rejectionReason?: GitMergeRejectionReason | undefined;
  readonly merged?: boolean | undefined;
  readonly branchDeleted?: boolean | undefined;
}

export interface GitMergeAdapter {
  readMergeReadiness(req: GitMergeReadinessRequest): Promise<GitMergeProviderReadiness>;
  mergePullRequest(req: GitMergeExecRequest): Promise<GitMergeExecResult>;
}

// ─── Dedicated gh-api allowlist ──────────────────────────────────────────────────────────────────────
// A closed allowlist permitting ONLY the `api` subcommand of `gh`. Structurally separate from the git
// mutation rules, the publish rules, and the PR rules. The specific REST endpoints/methods (the merge
// PUT, the readiness GETs, and the guarded branch DELETE) are enforced by the pure argv builders below;
// the allowlist denies any flag that could read an arbitrary file (`--input`) or paginate.

export const GIT_MERGE_ALLOWED_SUBCOMMANDS: readonly string[] = Object.freeze(["api"]);

export const GIT_MERGE_COMMAND_RULES: readonly CommandRule[] = Object.freeze([
  {
    executable: "gh",
    allowedSubcommands: GIT_MERGE_ALLOWED_SUBCOMMANDS,
    valueFlags: Object.freeze([
      "--method",
      "-X",
      "--hostname",
      "--jq",
      "-q",
      "-f",
      "--raw-field",
      "-F",
      "--field",
      "-H",
      "--header",
    ]),
    denyFlags: Object.freeze(["--input", "--paginate"]),
  },
]);

// ─── Pure argv builders (merge PUT, readiness GETs, guarded branch DELETE) ────────────────────────────

export class GitMergeArgvError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitMergeArgvError";
  }
}

// NUL + the C0 control range + DEL, enumerated via a string-built RegExp (no literal control chars in
// source). A ref / repo slug never legitimately contains one.
// eslint-disable-next-line no-control-regex -- intentionally matches control chars to REJECT them
const REF_CONTROL_CHAR = new RegExp("[\u0000-\u001f\u007f]");
const OWNER_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const PR_NUMBER_RE = /^[1-9][0-9]{0,9}$/;
const SHA_RE = /^[0-9a-fA-F]{7,64}$/;

function assertRef(value: string, label: string): string {
  if (value.length === 0) {
    throw new GitMergeArgvError(`${label} must not be empty`);
  }
  if (REF_CONTROL_CHAR.test(value)) {
    throw new GitMergeArgvError(`${label} must not contain control characters`);
  }
  if (/\s/.test(value)) {
    throw new GitMergeArgvError(`${label} must not contain whitespace`);
  }
  if (value.startsWith("-")) {
    throw new GitMergeArgvError(`${label} must not start with "-" (flag-injection guard)`);
  }
  if (value.includes(":")) {
    throw new GitMergeArgvError(`${label} must not contain ":"`);
  }
  return value;
}

function assertOwnerAndRepo(value: string): string {
  if (!OWNER_REPO_RE.test(value)) {
    throw new GitMergeArgvError('ownerAndRepo must match "owner/repo"');
  }
  return value;
}

function assertPrNumber(value: string): string {
  if (!PR_NUMBER_RE.test(value)) {
    throw new GitMergeArgvError("prExternalId must be a positive PR number");
  }
  return value;
}

function assertSha(value: string): string {
  if (!SHA_RE.test(value)) {
    throw new GitMergeArgvError("expectedHeadRefHash must be a hex commit SHA");
  }
  return value;
}

// Content-free GitHub `merge_method` for each strategy hint. provider-default omits the field so GitHub
// uses the repository's default merge method. Total Record: a new strategy is a compile error here.
const MERGE_METHOD_BY_STRATEGY: Readonly<Record<GitDeliveryMergeStrategyHint, string | undefined>> =
  {
    squash: "squash",
    rebase: "rebase",
    "merge-commit": "merge",
    "provider-default": undefined,
  };

// `gh api --method PUT /repos/{owner}/{repo}/pulls/{number}/merge [-f merge_method=…] [-f sha=…] --jq .merged`.
// The merge endpoint is metadata-only from this builder's perspective: it never reads a file or paginates.
export function buildMergeArgv(req: GitMergeExecRequest): readonly string[] {
  const repo = assertOwnerAndRepo(req.ownerAndRepo);
  const number = assertPrNumber(req.prExternalId);
  const method = MERGE_METHOD_BY_STRATEGY[req.mergeStrategy];
  const argv: string[] = ["api", "--method", "PUT", `/repos/${repo}/pulls/${number}/merge`];
  if (method !== undefined) {
    argv.push("-f", `merge_method=${method}`);
  }
  if (req.expectedHeadRefHash !== undefined) {
    argv.push("-f", `sha=${assertSha(req.expectedHeadRefHash)}`);
  }
  argv.push("--jq", ".merged");
  return argv;
}

// `gh api /repos/{owner}/{repo}/pulls/{number} --jq <projection>`. Reads only the content-free fields the
// readiness mapper needs (state, merged, draft, mergeable, mergeable_state, base ref, head sha).
const PR_READINESS_JQ =
  "{state:.state,merged:.merged,draft:.draft,mergeable:.mergeable,mergeable_state:.mergeable_state,base:.base.ref,head:.head.sha,headRef:.head.ref}";

export function buildMergeReadinessArgv(req: GitMergeReadinessRequest): readonly string[] {
  const repo = assertOwnerAndRepo(req.ownerAndRepo);
  const number = assertPrNumber(req.prExternalId);
  return ["api", `/repos/${repo}/pulls/${number}`, "--jq", PR_READINESS_JQ];
}

// `gh api /repos/{owner}/{repo} --jq <projection>`. Reads the repository's allowed merge strategies.
const REPO_MERGE_CONFIG_JQ =
  "{squash:.allow_squash_merge,merge:.allow_merge_commit,rebase:.allow_rebase_merge}";

export function buildRepoMergeConfigArgv(req: GitMergeReadinessRequest): readonly string[] {
  const repo = assertOwnerAndRepo(req.ownerAndRepo);
  return ["api", `/repos/${repo}`, "--jq", REPO_MERGE_CONFIG_JQ];
}

// `gh api /repos/{owner}/{repo}/commits/{sha}/status --jq .state`. Reads the head commit's combined
// check status (success / pending / failure) to refine a blocked/unstable merge state.
export function buildHeadStatusArgv(repoSlug: string, headSha: string): readonly string[] {
  const repo = assertOwnerAndRepo(repoSlug);
  const sha = assertSha(headSha);
  return ["api", `/repos/${repo}/commits/${sha}/status`, "--jq", ".state"];
}

// `gh api --method DELETE /repos/{owner}/{repo}/git/refs/heads/{branch}`. The guarded branch deletion
// performed only after a successful merge when deleteBranchAfterMerge is set.
export function buildDeleteMergedBranchArgv(
  repoSlug: string,
  headBranchName: string,
): readonly string[] {
  const repo = assertOwnerAndRepo(repoSlug);
  const branch = assertRef(headBranchName, "headBranchName");
  return ["api", "--method", "DELETE", `/repos/${repo}/git/refs/heads/${branch}`];
}

// True iff the argv begins with the single allowed `api` subcommand. Lets tests prove the
// no-generic-fallback property structurally for the merge authority.
export function gitMergeArgvIsGoverned(argv: readonly string[]): boolean {
  return argv.length > 0 && GIT_MERGE_ALLOWED_SUBCOMMANDS.includes(argv[0] ?? "");
}

// ─── Provider-rejection classifier (GitHub-specific; neutral taxonomy lives in keiko-contracts) ───────
// Ordered phrase table over the (lower-cased, secret-redacted) gh output. The FIRST matching row wins.
//
// ⚠️ ORDERING SEMANTIC (load-bearing): rate-limited MUST precede permission-denied (a GitHub rate limit
// is surfaced as HTTP 403); already-merged and head-modified MUST precede not-mergeable (all three can
// surface as HTTP 405/409). Reordering rows silently flips the classification. The ambiguous-token test
// pins this invariant — do not reorder or insert a row without re-checking it.
const REJECTION_PHRASES: readonly (readonly [GitMergeRejectionReason, readonly string[]])[] = [
  ["rate-limited", ["rate limit exceeded", "secondary rate limit", "exceeded a secondary rate"]],
  ["already-merged", ["pull request is already merged", "already merged"]],
  ["head-modified", ["head branch was modified", "base branch was modified", "was modified"]],
  ["conflict", ["merge conflict", "has conflicts", "is in conflict"]],
  [
    "approvals-missing",
    ["approving review", "review is required", "changes requested", "review required"],
  ],
  [
    "checks-failing",
    ["required status check", "status checks are required", "expected — waiting", "checks are not"],
  ],
  [
    "branch-protection",
    [
      "protected branch",
      "branch protection",
      "merge queue",
      "not allowed to merge",
      "required to be",
    ],
  ],
  [
    "permission-denied",
    ["http 401", "http 403", "bad credentials", "must have admin", "forbidden"],
  ],
  ["not-found", ["http 404", "not found"]],
  [
    "not-mergeable",
    ["http 405", "not mergeable", "method not allowed", "pull request is not mergeable"],
  ],
  [
    "provider-unavailable",
    [
      "http 502",
      "http 503",
      "http 504",
      "bad gateway",
      "service unavailable",
      "could not resolve host",
      "connection refused",
      "timed out",
      "timeout",
    ],
  ],
];

export function classifyGitMergeRejection(output: string): GitMergeRejectionReason {
  const haystack = output.toLowerCase();
  for (const [reason, phrases] of REJECTION_PHRASES) {
    if (phrases.some((phrase) => haystack.includes(phrase))) {
      return reason;
    }
  }
  return "unknown";
}

// ─── mergeable_state mapping (GitHub-specific → neutral merge readiness) ──────────────────────────────
// GitHub's PR `mergeable_state` is the single best content-free merge-readiness signal. This pure mapper
// translates it (plus draft / merged / state) into a neutral GitDeliveryPullRequestState so the contract
// readiness derivation reasons over neutral facts only. No provider field names cross into contracts.

export interface RawMergeReadiness {
  readonly state?: string | undefined; // "open" | "closed"
  readonly merged?: boolean | undefined;
  readonly draft?: boolean | undefined;
  readonly mergeableState?: string | undefined; // clean|has_hooks|unstable|dirty|blocked|behind|draft|unknown
  readonly baseRef?: string | undefined;
  readonly headSha?: string | undefined;
  readonly prNumber: string;
  readonly headBranchName: string;
}

function mergeReadinessFromState(mergeableState: string | undefined): GitDeliveryMergeReadiness {
  switch (mergeableState) {
    case "clean":
    case "has_hooks":
    case "unstable":
      return { ready: true, requiredApprovalCount: 0, receivedApprovalCount: 0 };
    case "dirty":
      return {
        ready: false,
        blockingReason: "conflicts",
        requiredApprovalCount: 0,
        receivedApprovalCount: 0,
      };
    case "blocked":
    case "behind":
      return {
        ready: false,
        blockingReason: "branch-protection",
        requiredApprovalCount: 0,
        receivedApprovalCount: 0,
      };
    // "draft" is reflected by isDraft; "unknown" (still computing) yields no specific reason so the
    // contract derivation emits readiness-unknown.
    default:
      return { ready: false, requiredApprovalCount: 0, receivedApprovalCount: 0 };
  }
}

export function mapRawMergeReadiness(raw: RawMergeReadiness): GitDeliveryPullRequestState {
  const status: GitDeliveryPullRequestState["status"] = raw.merged
    ? "merged"
    : raw.state === "closed"
      ? "closed"
      : "open";
  return {
    schemaVersion: "1",
    externalId: raw.prNumber,
    status,
    isDraft: raw.draft === true || raw.mergeableState === "draft",
    headBranchName: raw.headBranchName,
    ...(raw.baseRef !== undefined
      ? { baseBranchName: raw.baseRef }
      : { baseBranchName: "unknown" }),
    mergeReadiness: mergeReadinessFromState(raw.mergeableState),
  };
}

// ─── Effective policy (preview-predicts-execute) ─────────────────────────────────────────────────────

export interface GitMergeEffectivePolicy {
  readonly outcome: "allowed" | "blocked" | "approval-gated";
  readonly blockReason?: GitDeliveryBlockReason | undefined;
}

function constraintBlock(
  constraint: GitDeliveryConstraint,
  target: string | undefined,
  capabilities: readonly GitDeliveryProviderCapability[],
): GitDeliveryBlockReason | undefined {
  if (constraint.kind === "branch-pattern") {
    const ok = target !== undefined && gitDeliveryBranchNameMatchesAny(target, constraint.patterns);
    return ok ? undefined : "policy-pack-blocked";
  }
  if (constraint.kind === "provider-capability") {
    return capabilities.includes(constraint.capability) ? undefined : "provider-capability-absent";
  }
  return gitDeliveryRiskClassWithinCeiling("merge", constraint.maxRiskClass)
    ? undefined
    : "risk-class-ceiling";
}

export function evaluateGitMergeEffectivePolicy(
  decision: GitDeliveryPolicyDecision,
  baseTarget: string | undefined,
  capabilities: readonly GitDeliveryProviderCapability[],
): GitMergeEffectivePolicy {
  if (decision.outcome === "allowed") {
    return { outcome: "allowed" };
  }
  if (decision.outcome === "blocked") {
    return { outcome: "blocked", blockReason: decision.reason };
  }
  if (decision.outcome === "approval-gated") {
    return { outcome: "approval-gated" };
  }
  for (const constraint of decision.constraints) {
    const reason = constraintBlock(constraint, baseTarget, capabilities);
    if (reason !== undefined) {
      return { outcome: "blocked", blockReason: reason };
    }
  }
  return { outcome: "allowed" };
}

// ─── Lifecycle orchestration ─────────────────────────────────────────────────────────────────────────

export interface GitMergeRequest {
  readonly command: GitMergeCommand;
  readonly approval: GitDeliveryApprovalRequirement;
}

export interface GitMergeOrchestratorDeps {
  readonly adapter: GitMergeAdapter;
  readonly snapshot: GitWorktreeSnapshot;
  readonly orgPolicyPack?: GitDeliveryOrgPolicyPack | undefined;
  readonly repoPolicyPack?: GitDeliveryRepoPolicyPack | undefined;
  readonly activeProviderCapabilities?: readonly GitDeliveryProviderCapability[] | undefined;
  // The deployment-permitted merge strategies. Defaults to all strategy hints (the provider repository
  // capability still narrows the eligible set).
  readonly strategyPolicy?: GitMergeStrategyPolicy | undefined;
  readonly now: () => number;
  readonly newActionId: () => string;
}

export interface GitMergeLifecycleResult {
  readonly lifecycle: GitMutationLifecycleResult;
  // The merge-readiness summary read from the provider (present whenever the readiness gate was reached).
  readonly readiness?: GitMergeReadinessSummary | undefined;
  readonly rejection?: GitMergeRejection | undefined;
  readonly merged?: boolean | undefined;
  readonly branchDeleted?: boolean | undefined;
}

function mergeResolvedInputs(command: GitMergeCommand): GitDeliveryMergeInputs {
  return {
    kind: "merge",
    prExternalId: command.prExternalId,
    mergeStrategyHint: command.mergeStrategy,
    deleteBranchAfterMerge: command.deleteBranchAfterMerge,
  };
}

function buildMergePreview(command: GitMergeCommand): GitDeliveryActionPreview {
  return {
    schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
    affectedBranchName: command.baseBranchName,
    wouldCreateRemoteBranch: false,
    // A merge lands a commit on the base branch, which typically triggers the base branch's checks.
    wouldTriggerChecks: true,
  };
}

function assembleEnvelope(
  actionId: string,
  inputs: GitDeliveryMergeInputs,
  policyDecision: GitDeliveryPolicyDecision,
  approval: GitDeliveryApprovalRequirement,
  preview: GitDeliveryActionPreview,
  executionResult: GitDeliveryExecutionResult | undefined,
): GitDeliveryActionEnvelope {
  return {
    schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
    actionId,
    kind: inputs.kind,
    resolvedInputs: inputs,
    policyDecision,
    approvalRequirement: approval,
    preview,
    ...(executionResult !== undefined ? { executionResult } : {}),
  };
}

type MergeGate =
  | { readonly proceed: true }
  | {
      readonly proceed: false;
      readonly status: "approval-required";
      readonly approvers: readonly string[];
    }
  | {
      readonly proceed: false;
      readonly status: "policy-block";
      readonly reason: GitDeliveryBlockReason;
    };

function approvalState(
  approval: GitDeliveryApprovalRequirement,
  now: number,
): "valid" | "absent" | "expired" {
  if (!approval.required) {
    return "absent";
  }
  if (approval.expiresAtMs !== undefined && approval.expiresAtMs <= now) {
    return "expired";
  }
  return "valid";
}

function resolveMergeGate(
  decision: GitDeliveryPolicyDecision,
  approval: GitDeliveryApprovalRequirement,
  target: string | undefined,
  capabilities: readonly GitDeliveryProviderCapability[],
  now: number,
): MergeGate {
  if (decision.outcome === "allowed") {
    return { proceed: true };
  }
  if (decision.outcome === "blocked") {
    return { proceed: false, status: "policy-block", reason: decision.reason };
  }
  if (decision.outcome === "approval-gated") {
    const state = approvalState(approval, now);
    if (state === "valid") return { proceed: true };
    if (state === "expired") {
      return { proceed: false, status: "policy-block", reason: "approval-expired" };
    }
    return { proceed: false, status: "approval-required", approvers: decision.requiredApprovers };
  }
  for (const constraint of decision.constraints) {
    const reason = constraintBlock(constraint, target, capabilities);
    if (reason !== undefined) {
      return { proceed: false, status: "policy-block", reason };
    }
  }
  return { proceed: true };
}

function mergeOutcomeFor(result: GitDeliveryExecutionResult): GitMutationOutcome {
  if (result.outcome === "succeeded") {
    return { status: "succeeded", executionResult: result };
  }
  const category: GitMutationFailureCategory =
    gitMutationCategoryForExecutionResult(result) ?? "execution-failure";
  if (category === "recovery-required") {
    return { status: "recovery-required", category, executionResult: result };
  }
  if (category === "provider-failure") {
    return { status: "failed", category, executionResult: result };
  }
  return { status: "failed", category: "execution-failure", executionResult: result };
}

interface MergePrep {
  readonly inputs: GitDeliveryMergeInputs;
  readonly preflight: ReturnType<typeof evaluateGitPreflight>;
  readonly preview: GitDeliveryActionPreview;
  readonly policyDecision: GitDeliveryPolicyDecision;
  readonly actionId: string;
}

function prepareMerge(request: GitMergeRequest, deps: GitMergeOrchestratorDeps): MergePrep {
  const inputs = mergeResolvedInputs(request.command);
  const capabilities = deps.activeProviderCapabilities ?? [];
  const context: GitDeliveryPolicyContext = {
    actionKind: "merge",
    targetBranchName: request.command.baseBranchName,
    activeProviderCapabilities: capabilities,
  };
  return {
    inputs,
    preflight: evaluateGitPreflight(inputs, deps.snapshot),
    preview: buildMergePreview(request.command),
    policyDecision: evaluateGitPolicy(deps.orgPolicyPack, deps.repoPolicyPack, context),
    actionId: deps.newActionId(),
  };
}

function lifecycleFor(
  prep: MergePrep,
  approval: GitDeliveryApprovalRequirement,
  outcome: GitMutationOutcome,
  phaseReached: GitMutationLifecycleResult["phaseReached"],
  executionResult: GitDeliveryExecutionResult | undefined,
): GitMutationLifecycleResult {
  return {
    envelope: assembleEnvelope(
      prep.actionId,
      prep.inputs,
      prep.policyDecision,
      approval,
      prep.preview,
      executionResult,
    ),
    outcome,
    phaseReached,
    preflight: prep.preflight,
  };
}

// Reads the provider readiness through the adapter, never throwing: a thrown read becomes a
// provider-error readiness so the readiness gate blocks fail-closed.
async function readReadiness(
  command: GitMergeCommand,
  deps: GitMergeOrchestratorDeps,
): Promise<{ provider: GitMergeProviderReadiness; summary: GitMergeReadinessSummary }> {
  let provider: GitMergeProviderReadiness;
  try {
    provider = await deps.adapter.readMergeReadiness({
      ownerAndRepo: command.ownerAndRepo,
      prExternalId: command.prExternalId,
    });
  } catch {
    provider = { providerCapableStrategies: [], providerError: true };
  }
  const strategyPolicy = deps.strategyPolicy ?? {
    allowedStrategies: [...GIT_DELIVERY_MERGE_STRATEGY_HINTS],
  };
  const eligibility = deriveEligibleMergeStrategies(
    command.mergeStrategy,
    strategyPolicy,
    provider.providerCapableStrategies,
  );
  const summary = gitMergeReadinessFor({
    ...(provider.pullRequest !== undefined ? { pullRequest: provider.pullRequest } : {}),
    ...(provider.checks !== undefined ? { checks: provider.checks } : {}),
    ...(provider.branchProtection !== undefined
      ? { branchProtection: provider.branchProtection }
      : {}),
    strategyEligible: eligibility.requestedEligible,
    ...(provider.providerError === true ? { providerError: true } : {}),
  });
  return { provider, summary };
}

async function runMergeAdapter(
  command: GitMergeCommand,
  adapter: GitMergeAdapter,
): Promise<GitMergeExecResult> {
  try {
    return await adapter.mergePullRequest({
      ownerAndRepo: command.ownerAndRepo,
      prExternalId: command.prExternalId,
      headBranchName: command.headBranchName,
      mergeStrategy: command.mergeStrategy,
      deleteBranchAfterMerge: command.deleteBranchAfterMerge,
      ...(command.expectedHeadRefHash !== undefined
        ? { expectedHeadRefHash: command.expectedHeadRefHash }
        : {}),
    });
  } catch {
    return {
      schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
      outcome: "failed",
      durationMs: 0,
      errorCode: "internal-error",
    };
  }
}

function providerPullRequestMatchesCommand(
  command: GitMergeCommand,
  pullRequest: GitDeliveryPullRequestState | undefined,
): boolean {
  return (
    pullRequest?.externalId === command.prExternalId &&
    pullRequest.baseBranchName === command.baseBranchName &&
    pullRequest.headBranchName === command.headBranchName
  );
}

function providerMismatchReadiness(summary: GitMergeReadinessSummary): GitMergeReadinessSummary {
  return {
    ...summary,
    mergeable: false,
    blockers: [
      { code: "provider-error", severity: "blocking", remediation: "internal" },
      ...summary.blockers,
    ],
  };
}

// The readiness gate result: proceed to execute, or block (with the lifecycle to return).
function readinessBlockLifecycle(
  prep: MergePrep,
  approval: GitDeliveryApprovalRequirement,
  summary: GitMergeReadinessSummary,
  providerError: boolean,
): GitMutationLifecycleResult {
  if (providerError) {
    // A provider read failure is an internal/transport failure, not a policy block.
    const executionResult: GitDeliveryExecutionResult = {
      schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
      outcome: "failed",
      durationMs: 0,
      errorCode: "internal-error",
    };
    return lifecycleFor(
      prep,
      approval,
      { status: "failed", category: "execution-failure", executionResult },
      "policy",
      executionResult,
    );
  }
  // Otherwise the merge is blocked by unmet provider/branch-protection merge requirements; the precise,
  // content-free blocker list is carried on the GitMergeLifecycleResult.readiness for the UI/recovery.
  void summary;
  return lifecycleFor(
    prep,
    approval,
    { status: "blocked", category: "policy-block", blockReason: "protected-branch" },
    "policy",
    undefined,
  );
}

/**
 * Runs ONE governed merge operation end-to-end: derive merge inputs → preflight (no local precondition)
 * → policy + final approval gate → READINESS gate (read provider facts; block when not mergeable) → (only
 * when all gates pass) execute through the narrow merge adapter. Returns a kernel-shaped lifecycle result
 * (so the #474 evidence builder records it unchanged) plus the readiness summary, the live merge-rejection
 * descriptor when the provider rejected the merge, and the merged / branch-deleted flags.
 */
// The readiness gate + (when mergeable) the merge execution. Reached only after preflight and the
// policy/approval gate have passed.
async function runReadinessAndMerge(
  prep: MergePrep,
  request: GitMergeRequest,
  deps: GitMergeOrchestratorDeps,
): Promise<GitMergeLifecycleResult> {
  // Readiness gate: the merge is not attempted when a blocking blocker is present (AC1).
  const { provider, summary } = await readReadiness(request.command, deps);
  if (!summary.mergeable) {
    return {
      lifecycle: readinessBlockLifecycle(
        prep,
        request.approval,
        summary,
        provider.providerError === true,
      ),
      readiness: summary,
    };
  }
  if (!providerPullRequestMatchesCommand(request.command, provider.pullRequest)) {
    const mismatchReadiness = providerMismatchReadiness(summary);
    return {
      lifecycle: readinessBlockLifecycle(prep, request.approval, mismatchReadiness, true),
      readiness: mismatchReadiness,
    };
  }

  const result = await runMergeAdapter(request.command, deps.adapter);
  const lifecycle = lifecycleFor(prep, request.approval, mergeOutcomeFor(result), "result", result);
  const base: GitMergeLifecycleResult = {
    lifecycle,
    readiness: summary,
    ...(result.merged !== undefined ? { merged: result.merged } : {}),
    ...(result.branchDeleted !== undefined ? { branchDeleted: result.branchDeleted } : {}),
  };
  if (result.outcome !== "succeeded" && result.outcome !== "aborted") {
    return { ...base, rejection: gitMergeRejectionFor(result.rejectionReason ?? "unknown") };
  }
  return base;
}

export async function runGitMerge(
  request: GitMergeRequest,
  deps: GitMergeOrchestratorDeps,
): Promise<GitMergeLifecycleResult> {
  const prep = prepareMerge(request, deps);

  if (!prep.preflight.ok) {
    const outcome: GitMutationOutcome = {
      status: "blocked",
      category: "preflight-block",
      findings: prep.preflight.blocking,
    };
    return { lifecycle: lifecycleFor(prep, request.approval, outcome, "preflight", undefined) };
  }

  const gate = resolveMergeGate(
    prep.policyDecision,
    request.approval,
    request.command.baseBranchName,
    deps.activeProviderCapabilities ?? [],
    deps.now(),
  );
  if (!gate.proceed) {
    const outcome: GitMutationOutcome =
      gate.status === "approval-required"
        ? { status: "approval-required", requiredApprovers: gate.approvers }
        : { status: "blocked", category: "policy-block", blockReason: gate.reason };
    return { lifecycle: lifecycleFor(prep, request.approval, outcome, "policy", undefined) };
  }

  return runReadinessAndMerge(prep, request, deps);
}

// Re-export the contract bridge so the server/UI consume the error-code mapping from this gateway,
// keeping the publish/PR/merge gateway surfaces symmetric.
export { gitMergeRejectionToErrorCode };
