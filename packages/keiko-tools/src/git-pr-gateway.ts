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
  GIT_DELIVERY_SCHEMA_VERSION,
  gitDeliveryBranchNameMatchesAny,
  gitDeliveryRiskClassWithinCeiling,
  gitPrRejectionToDisposition,
  gitPrRejectionToErrorCode,
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
}

export interface GitPullRequestAdapter {
  createPullRequest(req: GitPrCreateExecRequest): Promise<GitPrExecResult>;
  updatePullRequest(req: GitPrUpdateExecRequest): Promise<GitPrExecResult>;
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

// NUL + the C0 control range + DEL, enumerated via a string-built RegExp (no literal control chars in
// source). A ref / repo slug never legitimately contains one.
// eslint-disable-next-line no-control-regex -- intentionally matches control chars to REJECT them
const REF_CONTROL_CHAR = new RegExp("[\u0000-\u001f\u007f]");
// Title is a single line: reject the whole control range.
// eslint-disable-next-line no-control-regex -- intentionally matches control chars to REJECT them
const TITLE_CONTROL_CHAR = new RegExp("[\u0000-\u001f\u007f]");
// Body permits TAB (09), LF (0a), CR (0d); every other control char + NUL + DEL is rejected.
// eslint-disable-next-line no-control-regex -- intentionally matches control chars to REJECT them
const BODY_CONTROL_CHAR = new RegExp("[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]");
const OWNER_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const PR_NUMBER_RE = /^[1-9][0-9]{0,9}$/;

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

function constraintBlock(
  constraint: GitDeliveryConstraint,
  target: string | undefined,
  capabilities: readonly GitDeliveryProviderCapability[],
  actionKind: "pr-create" | "pr-update",
): GitDeliveryBlockReason | undefined {
  if (constraint.kind === "branch-pattern") {
    const ok = target !== undefined && gitDeliveryBranchNameMatchesAny(target, constraint.patterns);
    return ok ? undefined : "policy-pack-blocked";
  }
  if (constraint.kind === "provider-capability") {
    return capabilities.includes(constraint.capability) ? undefined : "provider-capability-absent";
  }
  return gitDeliveryRiskClassWithinCeiling(actionKind, constraint.maxRiskClass)
    ? undefined
    : "risk-class-ceiling";
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
  if (decision.outcome === "approval-gated") {
    return { outcome: "approval-gated" };
  }
  for (const constraint of decision.constraints) {
    const reason = constraintBlock(constraint, baseTarget, capabilities, actionKind);
    if (reason !== undefined) {
      return { outcome: "blocked", blockReason: reason };
    }
  }
  return { outcome: "allowed" };
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
  if (decision.outcome === "approval-gated") {
    const state = approvalState(approval, now);
    if (state === "valid") return { proceed: true };
    if (state === "expired") {
      return { proceed: false, status: "policy-block", reason: "approval-expired" };
    }
    return { proceed: false, status: "approval-required", approvers: decision.requiredApprovers };
  }
  for (const constraint of decision.constraints) {
    const reason = constraintBlock(constraint, target, capabilities, actionKind);
    if (reason !== undefined) {
      return { proceed: false, status: "policy-block", reason };
    }
  }
  return { proceed: true };
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
    targetBranchName: request.command.baseBranchName,
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
  const outcome = prOutcomeFor(result);
  const lifecycle = lifecycleFor(prep, request.approval, outcome, "result", result);
  const createdPrExternalId = result.createdPrExternalId;
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
  };
}

// Re-export the contract bridges so the server/UI consume the error-code mapping from this gateway,
// keeping the publish/PR gateway surfaces symmetric.
export { gitPrRejectionToErrorCode };
