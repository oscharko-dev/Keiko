// The governed GitHub pull request gateway (Issue #477, Epic #470, ADR-0064) — AC1–AC5.
//
// This is the PR-orchestration authority the #472 kernel deferred to the remote slices: a PARALLEL
// execution authority to the #476 publish gateway, never an extension of it. A pull request shells
// `gh api` REST calls, not `git push`; the two are structurally independent (different binary, output
// shape, and failure taxonomy), so this gateway has its OWN narrow adapter port, its OWN dedicated
// `gh api` allowlist (create / update / get / the draft GraphQL mutations — NO merge, NO delete), and
// its OWN GitHub-error classifier. It NEVER touches the publish gateway or the local mutation adapter.
//
// Like the kernel and the publish gateway, it is deterministic given its injected dependencies
// (snapshot, clock, id generator, PR adapter). It performs no IO of its own: the actual `gh api` call
// lives behind the injected GitPullRequestAdapter (implemented by git-pr-node.ts on the Node subpath),
// so the orchestrator is unit-testable with a fake adapter and never opens a parallel child_process
// path. It reuses the kernel's pure machinery unchanged: evaluateGitPreflight (pr-create / pr-update
// map to preflightNoLocalPrecondition), the GitMutationLifecycleResult shape (so the #474 evidence
// builder consumes a PR lifecycle with no change), and the failure taxonomy.
//
// The actual PR title/body strings flow command → adapter → GitHub; the content-free contract inputs
// carry only their byte lengths, so evidence never persists raw content.

import type {
  CommandRule,
  GitDeliveryActionEnvelope,
  GitDeliveryActionPreview,
  GitDeliveryApprovalRequirement,
  GitDeliveryBlockReason,
  GitDeliveryConstraint,
  GitDeliveryExecutionResult,
  GitDeliveryOrgPolicyPack,
  GitDeliveryPolicyContext,
  GitDeliveryPolicyDecision,
  GitDeliveryPrCreateInputs,
  GitDeliveryPrUpdateInputs,
  GitDeliveryProviderCapability,
  GitDeliveryRecoveryActionHint,
  GitDeliveryRecoveryDisposition,
  GitDeliveryRepoPolicyPack,
  GitPullRequestRejectionReason,
} from "@oscharko-dev/keiko-contracts";
import {
  evaluateGitPolicy,
  gitDeliveryConstraintBlockReason,
  gitDeliveryPolicyTargetBranchName,
} from "@oscharko-dev/keiko-contracts/runtime/git-delivery-policy";
import {
  GIT_DELIVERY_SCHEMA_VERSION,
  gitDeliveryDefaultRiskClass,
} from "@oscharko-dev/keiko-contracts/runtime/git-delivery";
import { gitPrRejectionToDisposition } from "@oscharko-dev/keiko-contracts/runtime/git-pull-request";
import type { GitPullRequestIdentity } from "@oscharko-dev/keiko-contracts/runtime/git-pull-request";
import { isGitHubOwnerAndRepo } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import { isSafeGitRefName } from "@oscharko-dev/keiko-contracts/runtime/git-repository";
import type { GitWorktreeSnapshot } from "./git-mutation-preflight.js";
import { evaluateGitPreflight } from "./git-mutation-preflight.js";
import type {
  GitMutationLifecycleResult,
  GitMutationOutcome,
} from "./git-mutation-orchestrator.js";
import type { GitMutationFailureCategory } from "./git-mutation-taxonomy.js";
import { gitMutationCategoryForExecutionResult } from "./git-mutation-taxonomy.js";
import { resolveGitDeliveryApprovalGate } from "./git-approval-gate.js";

import { GIT_PR_IDENTITY_JQ } from "./git-pr-identity.js";
export { GIT_PR_IDENTITY_JQ } from "./git-pr-identity.js";

const UTF8 = new TextEncoder();

// ─── PR commands + narrow adapter port (no generic exec) ───────────────────────────────────────────
// The commands carry the concrete title/body strings the content-free contract inputs deliberately
// omit. The narrow GitPullRequestAdapter has exactly two typed methods: there is intentionally no
// run(args) escape hatch and no merge/delete method, mirroring the publish gateway's AC3 guarantee.

export interface GitPrCreateCommand {
  readonly kind: "pr-create";
  readonly ownerAndRepo: string; // "owner/repo", validated by buildPrCreateArgv
  readonly headBranchName: string;
  readonly baseBranchName: string;
  readonly title: string;
  readonly body: string;
  readonly isDraft: boolean;
  /** Issue-bound delivery pins the provider host and retains complete reconciliation facts. */
  readonly canonicalGitHubIdentity?: true;
}

export interface GitPrUpdateCommand {
  readonly kind: "pr-update";
  readonly ownerAndRepo: string;
  readonly prExternalId: string; // provider-assigned PR number (opaque, numeric)
  readonly headBranchName: string;
  readonly baseBranchName: string;
  readonly title: string;
  readonly body: string;
  readonly convertToDraft: boolean;
  readonly convertFromDraft: boolean;
}

export type GitPullRequestCommand = GitPrCreateCommand | GitPrUpdateCommand;

export interface GitPrCreateExecRequest {
  readonly ownerAndRepo: string;
  readonly headBranchName: string;
  readonly baseBranchName: string;
  readonly title: string;
  readonly body: string;
  readonly isDraft: boolean;
  /** Issue-bound delivery pins the provider host and retains complete reconciliation facts. */
  readonly canonicalGitHubIdentity?: true;
}

export interface GitPrUpdateExecRequest {
  readonly ownerAndRepo: string;
  readonly prExternalId: string;
  readonly baseBranchName: string;
  readonly title: string;
  readonly body: string;
  readonly convertToDraft: boolean;
  readonly convertFromDraft: boolean;
}

// The executor's structured result: the content-free contract execution result, plus the typed
// provider-rejection reason classified from GitHub's own error envelope, plus the provider-assigned PR
// number on a successful create.
export interface GitPrExecResult extends GitDeliveryExecutionResult {
  readonly rejectionReason?: GitPullRequestRejectionReason | undefined;
  readonly createdPrExternalId?: string | undefined;
  readonly createdPrIdentity?: GitPullRequestIdentity | undefined;
}

export interface GitPullRequestAdapter {
  createPullRequest(req: GitPrCreateExecRequest): Promise<GitPrExecResult>;
  updatePullRequest(req: GitPrUpdateExecRequest): Promise<GitPrExecResult>;
  readPullRequest?: GitPullRequestInspectionAdapter["readPullRequest"];
  findPullRequestsByHead?: GitPullRequestInspectionAdapter["findPullRequestsByHead"];
  readBranchHead?: GitPullRequestInspectionAdapter["readBranchHead"];
}

// #3389: the draft->ready transition, deliberately isolated from `updatePullRequest` — no title/body/
// base PATCH is ever bundled with it. `expectedHeadSha`/`expectedBaseSha` are the facts the governed
// caller's one-use approval was minted against; the adapter re-reads the live PR identity immediately
// before AND after the mutation and refuses (a `precondition-failed` result, never a spawn) on any
// mismatch — a mint-time approval can never be redeemed against a PR that has since moved.
export interface GitPrMarkReadyExecRequest {
  readonly ownerAndRepo: string;
  readonly prExternalId: string;
  readonly expectedHeadSha: string;
  readonly expectedBaseSha: string;
}

export interface GitPrMarkReadyExecResult extends GitDeliveryExecutionResult {
  readonly rejectionReason?: GitPullRequestRejectionReason | undefined;
  // The identity observed by the immediately-preceding or immediately-following re-read, present on
  // every outcome that reached a read (absent only when the read itself failed outright).
  readonly observedIdentity?: GitPullRequestIdentity | undefined;
}

/** A separate, narrower port from `GitPullRequestAdapter` (AC3/AC4: no merge, no issue-close, and the
 * transition never widens to accept title/body/base — see git-pr-node.ts for the sole implementation). */
export interface GitPullRequestMarkReadyAdapter {
  markPullRequestReady(req: GitPrMarkReadyExecRequest): Promise<GitPrMarkReadyExecResult>;
}

export type GitPrInspectionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: GitPullRequestRejectionReason | "invalid-response" };

export interface GitPrReadRequest {
  readonly ownerAndRepo: string;
  readonly prExternalId: string;
}

export interface GitPrReadHeadRequest {
  readonly ownerAndRepo: string;
  readonly headBranchName: string;
}

/** Read methods share the existing provider adapter and credential boundary. */
export interface GitPullRequestInspectionAdapter extends GitPullRequestAdapter {
  readPullRequest(req: GitPrReadRequest): Promise<GitPrInspectionResult<GitPullRequestIdentity>>;
  findPullRequestsByHead(
    req: GitPrReadHeadRequest,
  ): Promise<GitPrInspectionResult<readonly GitPullRequestIdentity[]>>;
  readBranchHead(req: GitPrReadHeadRequest): Promise<GitPrInspectionResult<string>>;
}

function inspectionRepository(value: string): string {
  if (!isGitHubOwnerAndRepo(value)) throw new GitPrArgvError("Invalid repository identity");
  return value;
}

function inspectionBranch(value: string): string {
  if (!isSafeGitRefName(value) || value.startsWith("refs/"))
    throw new GitPrArgvError("Invalid branch identity");
  return value;
}

function inspectionArgv(endpoint: string, projection: string): readonly string[] {
  return ["api", "--hostname", "github.com", "--method", "GET", endpoint, "--jq", projection];
}

export function buildPrReadArgv(req: GitPrReadRequest): readonly string[] {
  const repo = inspectionRepository(req.ownerAndRepo);
  return inspectionArgv(
    `/repos/${repo}/pulls/${assertPrNumber(req.prExternalId)}`,
    GIT_PR_IDENTITY_JQ,
  );
}

export function buildPrReadByHeadArgv(req: GitPrReadHeadRequest): readonly string[] {
  const repo = inspectionRepository(req.ownerAndRepo);
  const branch = inspectionBranch(req.headBranchName);
  const owner = repo.split("/")[0] ?? "";
  // Two results already prove ambiguity. Omitting base ensures retargeted PRs remain visible.
  const query = `state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=2&page=1`;
  return inspectionArgv(`/repos/${repo}/pulls?${query}`, `[.[] | ${GIT_PR_IDENTITY_JQ}]`);
}

export function buildPrReadBranchHeadArgv(req: GitPrReadHeadRequest): readonly string[] {
  const repo = inspectionRepository(req.ownerAndRepo);
  const branch = inspectionBranch(req.headBranchName);
  return inspectionArgv(
    `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    "{ref,sha:.object.sha,type:.object.type}",
  );
}

// ─── Dedicated gh-api allowlist ─────────────────────────────────────────────────────────────────────
// A closed allowlist permitting ONLY the `api` subcommand of `gh`. Structurally separate from the git
// mutation rules and the git publish rules. The specific REST endpoints/methods (no merge, no delete)
// are enforced by the pure argv builders below; the allowlist denies any flag that could read an
// arbitrary file (`--input`) or paginate beyond the targeted resource.

export const GIT_PULL_REQUEST_ALLOWED_SUBCOMMANDS: readonly string[] = Object.freeze(["api"]);

export const GIT_PULL_REQUEST_COMMAND_RULES: readonly CommandRule[] = Object.freeze([
  {
    executable: "gh",
    allowedSubcommands: GIT_PULL_REQUEST_ALLOWED_SUBCOMMANDS,
    // gh value flags, declared so the subcommand resolver stays correct even if a flag ever preceded
    // the `api` token (the builders always emit `api` first).
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
    // Deny flags that read arbitrary files / stream bodies from disk.
    denyFlags: Object.freeze(["--input", "--paginate"]),
  },
]);

// ─── Pure argv builders (safe endpoints only; no merge/delete) ───────────────────────────────────────

export class GitPrArgvError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitPrArgvError";
  }
}

// NUL + the C0 control range + DEL, enumerated via unicode escapes in a regex literal (no literal control chars in
// source). A ref / repo slug never legitimately contains one.
// eslint-disable-next-line no-control-regex -- intentionally matches control chars to REJECT them
const REF_CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
// Title is a single line: reject the whole control range.
// eslint-disable-next-line no-control-regex -- intentionally matches control chars to REJECT them
const TITLE_CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
// Body permits TAB (09), LF (0a), CR (0d); every other control char + NUL + DEL is rejected.
// eslint-disable-next-line no-control-regex -- intentionally matches control chars to REJECT them
const BODY_CONTROL_CHAR = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const OWNER_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const PR_NUMBER_RE = /^[1-9]\d{0,9}$/;

function assertRef(value: string, label: string): string {
  if (value.length === 0) {
    throw new GitPrArgvError(`${label} must not be empty`);
  }
  if (REF_CONTROL_CHAR.test(value)) {
    throw new GitPrArgvError(`${label} must not contain control characters`);
  }
  if (/\s/.test(value)) {
    throw new GitPrArgvError(`${label} must not contain whitespace`);
  }
  if (value.startsWith("-")) {
    throw new GitPrArgvError(`${label} must not start with "-" (flag-injection guard)`);
  }
  if (value.includes(":")) {
    throw new GitPrArgvError(`${label} must not contain ":"`);
  }
  return value;
}

function assertOwnerAndRepo(value: string): string {
  if (!OWNER_REPO_RE.test(value)) {
    throw new GitPrArgvError('ownerAndRepo must match "owner/repo"');
  }
  return value;
}

function assertPrNumber(value: string): string {
  if (!PR_NUMBER_RE.test(value)) {
    throw new GitPrArgvError("prExternalId must be a positive PR number");
  }
  return value;
}

function assertTitle(value: string): string {
  if (value.length === 0) {
    throw new GitPrArgvError("title must not be empty");
  }
  if (TITLE_CONTROL_CHAR.test(value)) {
    throw new GitPrArgvError("title must not contain control characters");
  }
  return value;
}

function assertBody(value: string): string {
  if (BODY_CONTROL_CHAR.test(value)) {
    throw new GitPrArgvError("body must not contain disallowed control characters");
  }
  return value;
}

function canonicalCreateHost(value: unknown, repository: string): readonly string[] {
  if (value === undefined) return [];
  if (value !== true || !isGitHubOwnerAndRepo(repository))
    throw new GitPrArgvError("canonical GitHub identity requires a valid repository");
  return ["--hostname", "github.com"];
}

// `gh api --method POST /repos/{owner}/{repo}/pulls -f title=… -f body=… -f head=… -f base=… -F draft=…`.
// `-f` (raw-field) sends a literal string (no `@file` interpretation); `-F` typed-field carries the
// boolean draft flag. The body may contain newlines and `=`; gh splits each `field=value` on the FIRST
// `=` only, and the argv is passed as a vector (no shell), so the value is opaque.
export function buildPrCreateArgv(req: GitPrCreateExecRequest): readonly string[] {
  const repo = assertOwnerAndRepo(req.ownerAndRepo);
  const head = assertRef(req.headBranchName, "headBranchName");
  const base = assertRef(req.baseBranchName, "baseBranchName");
  const title = assertTitle(req.title);
  const body = assertBody(req.body);
  return [
    "api",
    "--method",
    "POST",
    `/repos/${repo}/pulls`,
    ...canonicalCreateHost(req.canonicalGitHubIdentity, req.ownerAndRepo),
    "-f",
    `title=${title}`,
    "-f",
    `body=${body}`,
    "-f",
    `head=${head}`,
    "-f",
    `base=${base}`,
    "-F",
    `draft=${req.isDraft ? "true" : "false"}`,
  ];
}

// `gh api --method PATCH /repos/{owner}/{repo}/pulls/{number} -f title=… -f body=… -f base=…`. The REST
// update endpoint adjusts metadata only; draft↔ready is a separate GraphQL transition (below).
export function buildPrUpdateArgv(req: GitPrUpdateExecRequest): readonly string[] {
  const repo = assertOwnerAndRepo(req.ownerAndRepo);
  const number = assertPrNumber(req.prExternalId);
  const base = assertRef(req.baseBranchName, "baseBranchName");
  const title = assertTitle(req.title);
  const body = assertBody(req.body);
  return [
    "api",
    "--method",
    "PATCH",
    `/repos/${repo}/pulls/${number}`,
    "-f",
    `title=${title}`,
    "-f",
    `body=${body}`,
    "-f",
    `base=${base}`,
  ];
}

const GITHUB_NODE_ID_RE = /^[A-Za-z0-9_=-]+$/;

function assertNodeId(value: string): string {
  if (value.length === 0 || !GITHUB_NODE_ID_RE.test(value)) {
    throw new GitPrArgvError("pull request node id is malformed");
  }
  return value;
}

const MARK_READY_MUTATION =
  "mutation($pullRequestId:ID!){markPullRequestReadyForReview(input:{pullRequestId:$pullRequestId}){pullRequest{isDraft}}}";
const CONVERT_DRAFT_MUTATION =
  "mutation($pullRequestId:ID!){convertPullRequestToDraft(input:{pullRequestId:$pullRequestId}){pullRequest{isDraft}}}";

// `gh api graphql -f query=<mutation> -f pullRequestId=<nodeId>`. The REST PATCH cannot toggle draft
// state (GitHub exposes it only through GraphQL); these mutations perform the draft↔ready transition.
export function buildPrMarkReadyGraphqlArgv(nodeId: string): readonly string[] {
  const id = assertNodeId(nodeId);
  return ["api", "graphql", "-f", `query=${MARK_READY_MUTATION}`, "-f", `pullRequestId=${id}`];
}

export function buildPrConvertDraftGraphqlArgv(nodeId: string): readonly string[] {
  const id = assertNodeId(nodeId);
  return ["api", "graphql", "-f", `query=${CONVERT_DRAFT_MUTATION}`, "-f", `pullRequestId=${id}`];
}

// True iff the argv begins with the single allowed `api` subcommand. Lets tests prove the
// no-generic-fallback property structurally for the PR authority.
export function gitPrArgvIsGoverned(argv: readonly string[]): boolean {
  return argv.length > 0 && GIT_PULL_REQUEST_ALLOWED_SUBCOMMANDS.includes(argv[0] ?? "");
}

// ─── Provider-rejection classifier (GitHub-specific; neutral taxonomy lives in keiko-contracts) ─────
// Ordered phrase table over the (lower-cased, secret-redacted) gh output. GitHub surfaces failures as
// an HTTP status line plus a JSON body envelope ({message, errors:[{field,code}]}); the specific
// status/message tokens discriminate. Rate-limit (HTTP 403 with a rate-limit message) is matched
// BEFORE the generic permission denial, and already-exists (HTTP 422 with a specific message) before
// the generic validation failure.

// ⚠️ ORDERING SEMANTIC (load-bearing): rate-limited MUST precede permission-denied (a GitHub rate limit
// is surfaced as HTTP 403), and already-exists MUST precede validation-error (both are HTTP 422). The
// classifier returns on the FIRST matching row, so reordering rows silently flips the classification. Do
// not reorder or insert a row without re-checking this invariant (covered by the ambiguous-token test).
const REJECTION_PHRASES: readonly (readonly [GitPullRequestRejectionReason, readonly string[]])[] =
  [
    ["already-exists", ["a pull request already exists", "already exists for"]],
    ["rate-limited", ["rate limit exceeded", "secondary rate limit", "exceeded a secondary rate"]],
    [
      "permission-denied",
      [
        "http 401",
        "http 403",
        "bad credentials",
        "must have admin",
        "resource not accessible",
        "forbidden",
      ],
    ],
    ["not-found", ["http 404", "not found"]],
    [
      "head-unpublished",
      ["head sha can't be blank", "field: head", '"field":"head"', "no ref found"],
    ],
    ["base-missing", ["field: base", '"field":"base"', "base does not exist"]],
    [
      "validation-error",
      ["http 422", "validation failed", "unprocessable", "no commits between", "invalid request"],
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

export function classifyGitPullRequestRejection(output: string): GitPullRequestRejectionReason {
  const haystack = output.toLowerCase();
  for (const [reason, phrases] of REJECTION_PHRASES) {
    if (phrases.some((phrase) => haystack.includes(phrase))) {
      return reason;
    }
  }
  return "unknown";
}

// Action hint only where the #473 vocabulary fits cleanly; the precise rejectionReason is the primary
// user-facing signal, so most reasons intentionally carry NO hint rather than a misleading one.
const REJECTION_ACTION_HINT: Readonly<
  Record<GitPullRequestRejectionReason, GitDeliveryRecoveryActionHint | undefined>
> = {
  "already-exists": undefined,
  "base-missing": undefined,
  "head-unpublished": "configure-upstream",
  "validation-error": undefined,
  "permission-denied": undefined,
  "not-found": undefined,
  "rate-limited": "wait-for-provider",
  "provider-unavailable": "wait-for-provider",
  unknown: undefined,
} as const;

export interface GitPullRequestRejection {
  readonly reason: GitPullRequestRejectionReason;
  readonly disposition: GitDeliveryRecoveryDisposition;
  readonly actionHint?: GitDeliveryRecoveryActionHint | undefined;
}

export function gitPullRequestRejectionFor(
  reason: GitPullRequestRejectionReason,
): GitPullRequestRejection {
  const actionHint = REJECTION_ACTION_HINT[reason];
  return {
    reason,
    disposition: gitPrRejectionToDisposition(reason),
    ...(actionHint !== undefined ? { actionHint } : {}),
  };
}

// ─── Effective policy (preview-predicts-execute) ─────────────────────────────────────────────────────

export interface GitPullRequestEffectivePolicy {
  readonly outcome: "allowed" | "blocked" | "approval-gated";
  readonly blockReason?: GitDeliveryBlockReason | undefined;
}

// Delegates to the contract-owned resolver so this gate and every preview surface resolve a
// `constrained` decision identically.
function constraintBlock(
  constraint: GitDeliveryConstraint,
  target: string | undefined,
  capabilities: readonly GitDeliveryProviderCapability[],
  actionKind: "pr-create" | "pr-update",
): GitDeliveryBlockReason | undefined {
  return gitDeliveryConstraintBlockReason(constraint, {
    riskClass: gitDeliveryDefaultRiskClass(actionKind),
    targetBranchName: target,
    activeProviderCapabilities: capabilities,
  });
}

// The EFFECTIVE policy outcome for a specific PR base target: a `constrained` decision is resolved
// against the base branch (a protected/unlisted base reads as blocked). Approval state is not
// considered here (the preview has no approval), so an approval-gated decision reads as approval-gated.
export function evaluateGitPullRequestEffectivePolicy(
  decision: GitDeliveryPolicyDecision,
  baseTarget: string | undefined,
  capabilities: readonly GitDeliveryProviderCapability[],
  actionKind: "pr-create" | "pr-update",
): GitPullRequestEffectivePolicy {
  if (decision.outcome === "allowed") {
    return { outcome: "allowed" };
  }
  if (decision.outcome === "blocked") {
    return { outcome: "blocked", blockReason: decision.reason };
  }
  const constraints =
    decision.outcome === "approval-gated" ? (decision.constraints ?? []) : decision.constraints;
  for (const constraint of constraints) {
    const reason = constraintBlock(constraint, baseTarget, capabilities, actionKind);
    if (reason !== undefined) {
      return { outcome: "blocked", blockReason: reason };
    }
  }
  return decision.outcome === "constrained"
    ? { outcome: "allowed" }
    : { outcome: "approval-gated" };
}

// ─── Lifecycle orchestration ─────────────────────────────────────────────────────────────────────────

export interface GitPullRequestRequest {
  readonly command: GitPullRequestCommand;
  readonly approval: GitDeliveryApprovalRequirement;
}

export interface GitPullRequestOrchestratorDeps {
  readonly adapter: GitPullRequestAdapter;
  readonly snapshot: GitWorktreeSnapshot;
  readonly orgPolicyPack?: GitDeliveryOrgPolicyPack | undefined;
  readonly repoPolicyPack?: GitDeliveryRepoPolicyPack | undefined;
  readonly activeProviderCapabilities?: readonly GitDeliveryProviderCapability[] | undefined;
  readonly now: () => number;
  readonly newActionId: () => string;
}

export interface GitPullRequestLifecycleResult {
  readonly lifecycle: GitMutationLifecycleResult;
  readonly rejection?: GitPullRequestRejection | undefined;
  readonly createdPrExternalId?: string | undefined;
  readonly createdPrIdentity?: GitPullRequestIdentity | undefined;
}

function prResolvedInputs(
  command: GitPullRequestCommand,
): GitDeliveryPrCreateInputs | GitDeliveryPrUpdateInputs {
  if (command.kind === "pr-create") {
    return {
      kind: "pr-create",
      headBranchName: command.headBranchName,
      baseBranchName: command.baseBranchName,
      titleByteLength: UTF8.encode(command.title).length,
      bodyByteLength: UTF8.encode(command.body).length,
      isDraft: command.isDraft,
    };
  }
  return {
    kind: "pr-update",
    prExternalId: command.prExternalId,
    headBranchName: command.headBranchName,
    baseBranchName: command.baseBranchName,
    titleByteLength: UTF8.encode(command.title).length,
    bodyByteLength: UTF8.encode(command.body).length,
    convertToDraft: command.convertToDraft,
    convertFromDraft: command.convertFromDraft,
  };
}

function buildPrPreview(command: GitPullRequestCommand): GitDeliveryActionPreview {
  return {
    schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
    affectedBranchName: command.headBranchName,
    wouldCreateRemoteBranch: false,
    wouldTriggerChecks: true,
  };
}

function assembleEnvelope(
  actionId: string,
  inputs: GitDeliveryPrCreateInputs | GitDeliveryPrUpdateInputs,
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
  } as GitDeliveryActionEnvelope;
}

type PrGate =
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

function resolvePrGate(
  decision: GitDeliveryPolicyDecision,
  approval: GitDeliveryApprovalRequirement,
  target: string | undefined,
  capabilities: readonly GitDeliveryProviderCapability[],
  actionKind: "pr-create" | "pr-update",
  now: number,
): PrGate {
  if (decision.outcome === "allowed") {
    return { proceed: true };
  }
  if (decision.outcome === "blocked") {
    return { proceed: false, status: "policy-block", reason: decision.reason };
  }
  const constraints =
    decision.outcome === "approval-gated" ? (decision.constraints ?? []) : decision.constraints;
  for (const constraint of constraints) {
    const reason = constraintBlock(constraint, target, capabilities, actionKind);
    if (reason !== undefined) {
      return { proceed: false, status: "policy-block", reason };
    }
  }
  if (decision.outcome === "constrained") return { proceed: true };
  return resolvePrApprovalGate(decision, approval, now);
}

// Split out of resolvePrGate to keep that function under the repository complexity cap.
// KEIKO-0535: delegates to the one shared approval-gate resolver (git-approval-gate.ts) instead of
// re-deriving valid/expired/absent + KEIKO-0147's identity check locally, then maps the canonical
// result onto this file's own PrGate shape — the same shape every existing caller already
// consumes, so behavior is unchanged.
function resolvePrApprovalGate(
  decision: GitDeliveryPolicyDecision & { outcome: "approval-gated" },
  approval: GitDeliveryApprovalRequirement,
  now: number,
): PrGate {
  const gate = resolveGitDeliveryApprovalGate(decision, approval, now);
  if (gate.proceed) {
    return { proceed: true };
  }
  if (gate.status === "approval-required") {
    return { proceed: false, status: "approval-required", approvers: gate.approvers };
  }
  return { proceed: false, status: "policy-block", reason: gate.blockReason };
}

function prOutcomeFor(result: GitDeliveryExecutionResult): GitMutationOutcome {
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

interface PrPrep {
  readonly inputs: GitDeliveryPrCreateInputs | GitDeliveryPrUpdateInputs;
  readonly preflight: ReturnType<typeof evaluateGitPreflight>;
  readonly preview: GitDeliveryActionPreview;
  readonly policyDecision: GitDeliveryPolicyDecision;
  readonly actionId: string;
}

function preparePr(request: GitPullRequestRequest, deps: GitPullRequestOrchestratorDeps): PrPrep {
  const inputs = prResolvedInputs(request.command);
  const capabilities = deps.activeProviderCapabilities ?? [];
  const context: GitDeliveryPolicyContext = {
    actionKind: request.command.kind,
    // ONE derivation, shared with every preview surface (contracts): a PR targets its BASE branch.
    targetBranchName: gitDeliveryPolicyTargetBranchName(inputs),
    activeProviderCapabilities: capabilities,
  };
  return {
    inputs,
    preflight: evaluateGitPreflight(inputs, deps.snapshot),
    preview: buildPrPreview(request.command),
    policyDecision: evaluateGitPolicy(deps.orgPolicyPack, deps.repoPolicyPack, context),
    actionId: deps.newActionId(),
  };
}

function lifecycleFor(
  prep: PrPrep,
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

async function runPrAdapter(
  command: GitPullRequestCommand,
  adapter: GitPullRequestAdapter,
): Promise<GitPrExecResult> {
  try {
    if (command.kind === "pr-create") {
      return await adapter.createPullRequest({
        ownerAndRepo: command.ownerAndRepo,
        headBranchName: command.headBranchName,
        baseBranchName: command.baseBranchName,
        title: command.title,
        body: command.body,
        isDraft: command.isDraft,
        ...(command.canonicalGitHubIdentity === undefined
          ? {}
          : { canonicalGitHubIdentity: command.canonicalGitHubIdentity }),
      });
    }
    return await adapter.updatePullRequest({
      ownerAndRepo: command.ownerAndRepo,
      prExternalId: command.prExternalId,
      baseBranchName: command.baseBranchName,
      title: command.title,
      body: command.body,
      convertToDraft: command.convertToDraft,
      convertFromDraft: command.convertFromDraft,
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

function prExecutionEvidence(result: GitPrExecResult): GitDeliveryExecutionResult {
  const { schemaVersion, outcome, durationMs, externalId, errorCode, partialDetail } = result;
  return {
    schemaVersion,
    outcome,
    durationMs,
    ...(externalId === undefined ? {} : { externalId }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(partialDetail === undefined
      ? {}
      : {
          partialDetail: {
            attemptedUnitCount: partialDetail.attemptedUnitCount,
            succeededUnitCount: partialDetail.succeededUnitCount,
          },
        }),
  };
}

function createdIdentityResult(
  result: GitPrExecResult,
): Pick<GitPullRequestLifecycleResult, "createdPrIdentity"> {
  return result.outcome === "succeeded" && result.createdPrIdentity !== undefined
    ? { createdPrIdentity: result.createdPrIdentity }
    : {};
}

/**
 * Runs ONE governed pull request operation end-to-end: derive PR inputs → preflight (no local
 * precondition) → preview → policy → (only when policy permits and any approval is satisfied) execute
 * through the narrow PR adapter. Returns a kernel-shaped lifecycle result (so the #474 evidence builder
 * records it unchanged) plus the live provider-rejection descriptor when the provider rejected the
 * operation, and the provider-assigned PR number on a successful create.
 */
export async function runGitPullRequest(
  request: GitPullRequestRequest,
  deps: GitPullRequestOrchestratorDeps,
): Promise<GitPullRequestLifecycleResult> {
  const prep = preparePr(request, deps);

  if (!prep.preflight.ok) {
    const outcome: GitMutationOutcome = {
      status: "blocked",
      category: "preflight-block",
      findings: prep.preflight.blocking,
    };
    return { lifecycle: lifecycleFor(prep, request.approval, outcome, "preflight", undefined) };
  }

  const gate = resolvePrGate(
    prep.policyDecision,
    request.approval,
    request.command.baseBranchName,
    deps.activeProviderCapabilities ?? [],
    request.command.kind,
    deps.now(),
  );
  if (!gate.proceed) {
    const outcome: GitMutationOutcome =
      gate.status === "approval-required"
        ? { status: "approval-required", requiredApprovers: gate.approvers }
        : { status: "blocked", category: "policy-block", blockReason: gate.reason };
    return { lifecycle: lifecycleFor(prep, request.approval, outcome, "policy", undefined) };
  }

  const result = await runPrAdapter(request.command, deps.adapter);
  const executionEvidence = prExecutionEvidence(result);
  const outcome = prOutcomeFor(executionEvidence);
  const lifecycle = lifecycleFor(prep, request.approval, outcome, "result", executionEvidence);
  const { createdPrExternalId } = result;
  if (result.outcome !== "succeeded" && result.outcome !== "aborted") {
    const reason = result.rejectionReason ?? "unknown";
    return {
      lifecycle,
      rejection: gitPullRequestRejectionFor(reason),
      ...(createdPrExternalId !== undefined ? { createdPrExternalId } : {}),
    };
  }
  return {
    lifecycle,
    ...(createdPrExternalId !== undefined ? { createdPrExternalId } : {}),
    ...createdIdentityResult(result),
  };
}

// Re-export the contract bridges so the server/UI consume the error-code mapping from this gateway,
// keeping the publish/PR gateway surfaces symmetric.
export { gitPrRejectionToErrorCode } from "@oscharko-dev/keiko-contracts/runtime/git-pull-request";

export * from "./git-pr-body.js";
