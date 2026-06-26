// The governed remote publish gateway (Issue #476, Epic #470) — AC1–AC5.
//
// This is the SEPARATE remote execution authority the #472 kernel deferred: its command-union comment
// places remote kinds in "later slices (#476–#478) that extend this union and register their executors",
// and its local adapter allowlist excludes network verbs because "remote and provider execution is a
// later slice (#476–#478) behind a SEPARATE gateway, never this local adapter". This module is that
// gateway. It NEVER touches the local mutation adapter or its allowlist.
//
// Like the local kernel, the gateway is deterministic given its injected dependencies (snapshot, clock,
// id generator, remote adapter). It performs no IO of its own: the actual `git push` lives behind the
// injected GitRemotePublishAdapter (implemented by git-publish-node.ts on the Node subpath), so the
// orchestrator is unit-testable with a fake adapter and never opens a parallel child_process path.
//
// Pure module except for awaiting the injected adapter. Reuses the kernel's pure machinery unchanged:
// evaluateGitPreflight (push case), evaluateGitPolicy, the GitMutationLifecycleResult shape (so the
// #474 evidence builder consumes a push lifecycle with no change), and the failure taxonomy.

import type {
  GitDeliveryActionEnvelope,
  GitDeliveryActionPreview,
  GitDeliveryApprovalRequirement,
  GitDeliveryBlockReason,
  GitDeliveryConstraint,
  GitDeliveryExecutionErrorCode,
  GitDeliveryExecutionResult,
  GitDeliveryOrgPolicyPack,
  GitDeliveryPolicyContext,
  GitDeliveryPolicyDecision,
  GitDeliveryProviderCapability,
  GitDeliveryPushInputs,
  GitDeliveryRecoveryActionHint,
  GitDeliveryRecoveryDisposition,
  GitDeliveryRepoPolicyPack,
} from "@oscharko-dev/keiko-contracts";
import {
  evaluateGitPolicy,
  GIT_DELIVERY_RISK_CLASS_SEVERITY,
  GIT_DELIVERY_SCHEMA_VERSION,
  gitDeliveryBranchNameMatchesAny,
  gitDeliveryRiskClassForInputs,
} from "@oscharko-dev/keiko-contracts";
import type { GitWorktreeSnapshot } from "./git-mutation-preflight.js";
import { evaluateGitPreflight } from "./git-mutation-preflight.js";
import type {
  GitMutationLifecycleResult,
  GitMutationOutcome,
} from "./git-mutation-orchestrator.js";
import type { GitMutationFailureCategory } from "./git-mutation-taxonomy.js";
import { gitMutationCategoryForExecutionResult } from "./git-mutation-taxonomy.js";
import type { CommandRule } from "./types.js";

// ─── Push command + remote adapter port (no generic exec) ───────────────────────────────────
// GitPushCommand carries the concrete operands the content-free contract inputs deliberately omit.
// The narrow GitRemotePublishAdapter has exactly one typed method: there is intentionally no
// run(args) escape hatch, mirroring the local adapter's AC3 guarantee for the remote authority.

export interface GitPushCommand {
  readonly kind: "push";
  readonly sourceBranchName: string;
  readonly remoteAlias: string;
  readonly remoteBranchName: string;
  // Force-relevant pushes are blocked by default (AC4): the policy ceiling denies them and the argv
  // builder refuses to emit a force flag. The field exists so a force attempt is a first-class,
  // testable BLOCKED outcome rather than an unrepresentable state.
  readonly forcePush: boolean;
  readonly setUpstreamTracking: boolean;
}

// The operands handed to the executor. forcePush is intentionally ABSENT: the adapter can never force
// push because no force operand reaches it.
export interface GitPublishExecRequest {
  readonly sourceBranchName: string;
  readonly remoteAlias: string;
  readonly remoteBranchName: string;
  readonly setUpstreamTracking: boolean;
}

// The executor's structured result: the content-free contract execution result, plus the typed
// publish-rejection reason classified from git's own status phrases inside the trusted executor.
export interface GitPublishExecResult extends GitDeliveryExecutionResult {
  readonly rejectionReason?: GitPublishRejectionReason | undefined;
}

export interface GitRemotePublishAdapter {
  publish(req: GitPublishExecRequest): Promise<GitPublishExecResult>;
}

// ─── Publish-rejection taxonomy (AC3 / Deliverable 3) ───────────────────────────────────────
// A richer reason set than the six content-free execution error codes, so the user reads a precise
// cause and recovers without guessing. Derived in the trusted layer from git's English status phrases
// (classifyGitPublishRejection); raw stderr never crosses the boundary, only this typed token.

export type GitPublishRejectionReason =
  | "non-fast-forward"
  | "fetch-first"
  | "no-upstream"
  | "auth-failed"
  | "permission-denied"
  | "protected-ref"
  | "remote-unavailable"
  | "unknown";

export const GIT_PUBLISH_REJECTION_REASONS: readonly GitPublishRejectionReason[] = [
  "non-fast-forward",
  "fetch-first",
  "no-upstream",
  "auth-failed",
  "permission-denied",
  "protected-ref",
  "remote-unavailable",
  "unknown",
] as const;

export function isGitPublishRejectionReason(value: unknown): value is GitPublishRejectionReason {
  return (
    typeof value === "string" &&
    (GIT_PUBLISH_REJECTION_REASONS as readonly string[]).includes(value)
  );
}

// Ordered phrase table. The first reason whose any-phrase appears in the (lower-cased, secret-redacted)
// git output wins, so specific causes are matched before generic ones. Phrases are SPECIFIC: the generic
// "failed to push some refs" / "could not read from remote repository" lines git prints for many failures
// are deliberately NOT used as discriminators — only the cause-bearing hint lines are.
const REJECTION_PHRASES: readonly (readonly [GitPublishRejectionReason, readonly string[]])[] = [
  ["non-fast-forward", ["non-fast-forward", "tip of your current branch is behind"]],
  ["fetch-first", ["fetch first", "remote contains work that you do"]],
  [
    "protected-ref",
    ["protected branch", "pre-receive hook declined", "refusing to update", "gh006"],
  ],
  // Auth markers are checked BEFORE the generic "permission denied": an SSH "Permission denied
  // (publickey)" is an AUTHENTICATION failure, whereas "remote: Permission to repo denied to user" is
  // an authorization failure caught just below.
  // Auth includes smart-HTTP 401 ("returned error: 401"), which some hosts emit without a remote: line.
  [
    "auth-failed",
    [
      "authentication failed",
      "could not read username",
      "publickey",
      "invalid username",
      "error: 401",
    ],
  ],
  // Permission includes smart-HTTP 403 ("returned error: 403"): git prints `unable to access ... returned
  // error: 403` with NO literal "forbidden", and some hosts/proxies omit the `remote: Permission` line, so
  // the bare 403 token must classify as an authorization denial (user-fixable) rather than falling through
  // to remote-unavailable (retryable).
  [
    "permission-denied",
    ["permission denied", "permission to", "error: 403", "403 forbidden", "access denied"],
  ],
  ["no-upstream", ["has no upstream branch", "no upstream configured", "set-upstream"]],
  [
    "remote-unavailable",
    [
      "could not resolve host",
      "could not read from remote",
      "connection refused",
      "timed out",
      "unable to access",
    ],
  ],
] as const;

// Pure classifier. Deterministic: same output text always yields the same reason. Matches lower-cased
// so capitalisation differences across git versions do not change the classification.
export function classifyGitPublishRejection(output: string): GitPublishRejectionReason {
  const haystack = output.toLowerCase();
  for (const [reason, phrases] of REJECTION_PHRASES) {
    if (phrases.some((phrase) => haystack.includes(phrase))) {
      return reason;
    }
  }
  return "unknown";
}

// ─── Reason → contract error code + recovery (reuses #471/#473/#474 vocabularies) ───────────
// The error code is the content-free token recorded in evidence; the recovery composes the reused
// three-way disposition with an action hint where one fits the existing vocabulary cleanly.

const REJECTION_ERROR_CODE: Readonly<
  Record<GitPublishRejectionReason, GitDeliveryExecutionErrorCode>
> = {
  "non-fast-forward": "precondition-failed",
  "fetch-first": "precondition-failed",
  "no-upstream": "precondition-failed",
  "auth-failed": "provider-rejected",
  "permission-denied": "provider-rejected",
  "protected-ref": "provider-rejected",
  "remote-unavailable": "network-failure",
  unknown: "provider-rejected",
} as const;

export function gitPublishRejectionToErrorCode(
  reason: GitPublishRejectionReason,
): GitDeliveryExecutionErrorCode {
  return REJECTION_ERROR_CODE[reason];
}

const REJECTION_DISPOSITION: Readonly<
  Record<GitPublishRejectionReason, GitDeliveryRecoveryDisposition>
> = {
  "non-fast-forward": "user-fixable",
  "fetch-first": "user-fixable",
  "no-upstream": "user-fixable",
  "auth-failed": "user-fixable",
  "permission-denied": "user-fixable",
  "protected-ref": "user-fixable",
  "remote-unavailable": "retryable",
  unknown: "user-fixable",
} as const;

// Action hint only where the #473 vocabulary fits cleanly; auth/permission/unknown intentionally carry
// NO hint (the precise rejectionReason is the user-facing signal) rather than a misleading one.
const REJECTION_ACTION_HINT: Readonly<
  Record<GitPublishRejectionReason, GitDeliveryRecoveryActionHint | undefined>
> = {
  "non-fast-forward": "resolve-conflicts",
  "fetch-first": "resolve-conflicts",
  "no-upstream": "configure-upstream",
  "auth-failed": undefined,
  "permission-denied": undefined,
  "protected-ref": "adjust-policy-target",
  "remote-unavailable": "retry",
  unknown: undefined,
} as const;

// The live recovery descriptor surfaced for a rejected publish. Composes the precise tools-level reason
// with the reused contract disposition + (optional) action hint.
export interface GitPublishRejection {
  readonly reason: GitPublishRejectionReason;
  readonly disposition: GitDeliveryRecoveryDisposition;
  readonly actionHint?: GitDeliveryRecoveryActionHint | undefined;
}

export function gitPublishRejectionFor(reason: GitPublishRejectionReason): GitPublishRejection {
  const actionHint = REJECTION_ACTION_HINT[reason];
  return {
    reason,
    disposition: REJECTION_DISPOSITION[reason],
    ...(actionHint !== undefined ? { actionHint } : {}),
  };
}

// ─── Dedicated push allowlist + pure argv builder (force refused) ────────────────────────────
// A closed allowlist permitting ONLY `push`. Structurally separate from the local mutation rules and
// the read-only inspection rules. Mirrors their defence-in-depth flag denials so a smuggled global flag
// is rejected before spawn even though argv is built only from typed operands.

export const GIT_PUBLISH_ALLOWED_SUBCOMMANDS: readonly string[] = Object.freeze(["push"]);

export const GIT_PUBLISH_COMMAND_RULES: readonly CommandRule[] = Object.freeze([
  {
    executable: "git",
    allowedSubcommands: GIT_PUBLISH_ALLOWED_SUBCOMMANDS,
    valueFlags: Object.freeze([
      "-C",
      "-c",
      "--git-dir",
      "--work-tree",
      "--namespace",
      "--exec-path",
    ]),
    denyFlags: Object.freeze([
      "-C",
      "-c",
      "--config-env",
      "--git-dir",
      "--work-tree",
      "--namespace",
      "--exec-path",
      "--ext-diff",
      "--textconv",
      "--no-index",
      "--contents",
      "--output",
      // Force / history-rewrite flags are denied at the boundary as well as refused by the builder.
      "--force",
      "-f",
      "--force-with-lease",
      "--force-if-includes",
      "--mirror",
      "--delete",
      "-d",
    ]),
  },
]);

export class GitPublishArgvError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitPublishArgvError";
  }
}

// NUL and the rest of the C0 control range plus DEL. A git ref never legitimately contains one;
// rejecting them is defence-in-depth above git's own ref validation. NUL is NOT matched by \s, so
// the control range is enumerated via a string-built RegExp (no literal control chars in source).
// eslint-disable-next-line no-control-regex -- intentionally matches control chars to REJECT them
const REF_CONTROL_CHAR = new RegExp("[\u0000-\u001f\u007f]");

function assertRef(value: string, label: string): string {
  if (value.length === 0) {
    throw new GitPublishArgvError(`${label} must not be empty`);
  }
  if (REF_CONTROL_CHAR.test(value)) {
    throw new GitPublishArgvError(`${label} must not contain control characters`);
  }
  if (/\s/.test(value)) {
    throw new GitPublishArgvError(`${label} must not contain whitespace`);
  }
  if (value.startsWith("-")) {
    throw new GitPublishArgvError(`${label} must not start with "-" (flag-injection guard)`);
  }
  if (value.includes(":")) {
    throw new GitPublishArgvError(`${label} must not contain ":" (refspec-injection guard)`);
  }
  return value;
}

// Builds the single governed push argv. An explicit `src:dst` refspec is always used so the push target
// is never inferred from ambient `push.default` config. AC4: a force push is REFUSED here — there is no
// branch in this builder that can emit a force flag.
export function buildPushArgv(command: GitPushCommand): readonly string[] {
  if (command.forcePush) {
    throw new GitPublishArgvError("force push is not permitted (AC4 — blocked by default)");
  }
  const remote = assertRef(command.remoteAlias, "remoteAlias");
  const source = assertRef(command.sourceBranchName, "sourceBranchName");
  const target = assertRef(command.remoteBranchName, "remoteBranchName");
  const argv = ["push"];
  if (command.setUpstreamTracking) {
    argv.push("--set-upstream");
  }
  argv.push(remote, `${source}:${target}`);
  return argv;
}

// ─── Lifecycle orchestration ─────────────────────────────────────────────────────────────────

export interface GitPublishRequest {
  readonly command: GitPushCommand;
  readonly approval: GitDeliveryApprovalRequirement;
}

export interface GitPublishOrchestratorDeps {
  readonly adapter: GitRemotePublishAdapter;
  readonly snapshot: GitWorktreeSnapshot;
  readonly orgPolicyPack?: GitDeliveryOrgPolicyPack | undefined;
  readonly repoPolicyPack?: GitDeliveryRepoPolicyPack | undefined;
  readonly activeProviderCapabilities?: readonly GitDeliveryProviderCapability[] | undefined;
  readonly now: () => number;
  readonly newActionId: () => string;
}

// The publish lifecycle result: the kernel-shaped lifecycle (consumed unchanged by the #474 evidence
// builder) plus the live publish-rejection descriptor, present only when the push executed and the
// remote rejected it.
export interface GitPublishLifecycleResult {
  readonly lifecycle: GitMutationLifecycleResult;
  readonly rejection?: GitPublishRejection | undefined;
}

function pushResolvedInputs(command: GitPushCommand): GitDeliveryPushInputs {
  return {
    kind: "push",
    sourceBranchName: command.sourceBranchName,
    remoteAlias: command.remoteAlias,
    remoteBranchName: command.remoteBranchName,
    forcePush: command.forcePush,
    setUpstreamTracking: command.setUpstreamTracking,
  };
}

// The remote target a branch-pattern policy constraint is evaluated against: the published-to branch,
// so a protected/shared REMOTE target is judged by policy, not the local source name.
function buildPushPreview(
  command: GitPushCommand,
  snapshot: GitWorktreeSnapshot,
): GitDeliveryActionPreview {
  return {
    schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
    affectedBranchName: command.remoteBranchName,
    wouldCreateRemoteBranch: command.setUpstreamTracking && !snapshot.hasUpstream,
    wouldTriggerChecks: true,
  };
}

function assemblePushEnvelope(
  actionId: string,
  inputs: GitDeliveryPushInputs,
  policyDecision: GitDeliveryPolicyDecision,
  approval: GitDeliveryApprovalRequirement,
  preview: GitDeliveryActionPreview,
  executionResult: GitDeliveryExecutionResult | undefined,
): GitDeliveryActionEnvelope {
  return {
    schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
    actionId,
    kind: "push",
    resolvedInputs: inputs,
    policyDecision,
    approvalRequirement: approval,
    preview,
    ...(executionResult !== undefined ? { executionResult } : {}),
  };
}

// ─── Policy gate (mirrors the kernel's, over the same contract primitives) ───────────────────

type PublishGate =
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

function constraintBlock(
  constraint: GitDeliveryConstraint,
  target: string | undefined,
  capabilities: readonly GitDeliveryProviderCapability[],
  pushInputs: GitDeliveryPushInputs,
): GitDeliveryBlockReason | undefined {
  if (constraint.kind === "branch-pattern") {
    const ok = target !== undefined && gitDeliveryBranchNameMatchesAny(target, constraint.patterns);
    return ok ? undefined : "policy-pack-blocked";
  }
  if (constraint.kind === "provider-capability") {
    return capabilities.includes(constraint.capability) ? undefined : "provider-capability-absent";
  }
  // The FORCE-AWARE risk class: a force push escalates to recovery-or-rewrite (severity 4), so the
  // publish ceiling (severity 2) blocks it (AC4). A future pack with a recovery-or-rewrite ceiling is
  // the "explicit policy path" that could permit force; the default publish ceiling does not.
  const pushSeverity = GIT_DELIVERY_RISK_CLASS_SEVERITY[gitDeliveryRiskClassForInputs(pushInputs)];
  const ceilingSeverity = GIT_DELIVERY_RISK_CLASS_SEVERITY[constraint.maxRiskClass];
  return pushSeverity <= ceilingSeverity ? undefined : "risk-class-ceiling";
}

// The EFFECTIVE policy outcome for a specific push target, evaluating a `constrained` decision's
// constraints against the target (which `evaluateGitPolicy` deliberately leaves to the caller). The
// read-only preview reuses this so it predicts the execute outcome exactly: a constrained-but-passing
// target reads as "allowed", a failing one as "blocked" with the precise reason. Approval state is not
// considered (the preview has no approval), so an approval-gated decision reads as "approval-gated".
export interface GitPublishEffectivePolicy {
  readonly outcome: "allowed" | "blocked" | "approval-gated";
  readonly blockReason?: GitDeliveryBlockReason | undefined;
}

export function evaluateGitPublishEffectivePolicy(
  decision: GitDeliveryPolicyDecision,
  target: string | undefined,
  capabilities: readonly GitDeliveryProviderCapability[],
  pushInputs: GitDeliveryPushInputs,
): GitPublishEffectivePolicy {
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
    const reason = constraintBlock(constraint, target, capabilities, pushInputs);
    if (reason !== undefined) {
      return { outcome: "blocked", blockReason: reason };
    }
  }
  return { outcome: "allowed" };
}

function resolvePublishGate(
  decision: GitDeliveryPolicyDecision,
  approval: GitDeliveryApprovalRequirement,
  target: string | undefined,
  capabilities: readonly GitDeliveryProviderCapability[],
  pushInputs: GitDeliveryPushInputs,
  now: number,
): PublishGate {
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
    const reason = constraintBlock(constraint, target, capabilities, pushInputs);
    if (reason !== undefined) {
      return { proceed: false, status: "policy-block", reason };
    }
  }
  return { proceed: true };
}

// ─── Execution outcome mapping (reuses the taxonomy) ─────────────────────────────────────────

function publishOutcomeFor(result: GitDeliveryExecutionResult): GitMutationOutcome {
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

interface PublishPrep {
  readonly inputs: GitDeliveryPushInputs;
  readonly preflight: ReturnType<typeof evaluateGitPreflight>;
  readonly preview: GitDeliveryActionPreview;
  readonly policyDecision: GitDeliveryPolicyDecision;
  readonly actionId: string;
}

function preparePublish(request: GitPublishRequest, deps: GitPublishOrchestratorDeps): PublishPrep {
  const inputs = pushResolvedInputs(request.command);
  const capabilities = deps.activeProviderCapabilities ?? [];
  const context: GitDeliveryPolicyContext = {
    actionKind: "push",
    targetBranchName: request.command.remoteBranchName,
    activeProviderCapabilities: capabilities,
  };
  return {
    inputs,
    preflight: evaluateGitPreflight(inputs, deps.snapshot),
    preview: buildPushPreview(request.command, deps.snapshot),
    policyDecision: evaluateGitPolicy(deps.orgPolicyPack, deps.repoPolicyPack, context),
    actionId: deps.newActionId(),
  };
}

function lifecycleFor(
  prep: PublishPrep,
  approval: GitDeliveryApprovalRequirement,
  outcome: GitMutationOutcome,
  phaseReached: GitMutationLifecycleResult["phaseReached"],
  executionResult: GitDeliveryExecutionResult | undefined,
): GitMutationLifecycleResult {
  return {
    envelope: assemblePushEnvelope(
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

// Isolates the adapter call so a thrown/rejected adapter becomes a structured internal-error result
// (an argv-builder refusal of a force push lands here too) rather than escaping the gateway.
async function runPublishAdapter(
  command: GitPushCommand,
  adapter: GitRemotePublishAdapter,
): Promise<GitPublishExecResult> {
  try {
    // Build the argv eagerly so a force-push refusal (AC4) is a structured failure, never a spawn.
    buildPushArgv(command);
    return await adapter.publish({
      sourceBranchName: command.sourceBranchName,
      remoteAlias: command.remoteAlias,
      remoteBranchName: command.remoteBranchName,
      setUpstreamTracking: command.setUpstreamTracking,
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
 * Runs ONE governed publish end-to-end: derive push inputs → preflight (push case) → preview → policy →
 * (only when preflight passes, policy permits, approval satisfied) execute through the narrow remote
 * adapter. Returns a kernel-shaped lifecycle result (so the #474 evidence builder records it unchanged)
 * plus the live publish-rejection descriptor when the remote rejected an executed push.
 */
export async function runGitPublish(
  request: GitPublishRequest,
  deps: GitPublishOrchestratorDeps,
): Promise<GitPublishLifecycleResult> {
  const prep = preparePublish(request, deps);

  // Gate 1: a blocking preflight finding halts before policy and execution.
  if (!prep.preflight.ok) {
    const outcome: GitMutationOutcome = {
      status: "blocked",
      category: "preflight-block",
      findings: prep.preflight.blocking,
    };
    return { lifecycle: lifecycleFor(prep, request.approval, outcome, "preflight", undefined) };
  }

  // Gate 2: policy must permit (and any required approval must be satisfied).
  const gate = resolvePublishGate(
    prep.policyDecision,
    request.approval,
    request.command.remoteBranchName,
    deps.activeProviderCapabilities ?? [],
    prep.inputs,
    deps.now(),
  );
  if (!gate.proceed) {
    const outcome: GitMutationOutcome =
      gate.status === "approval-required"
        ? { status: "approval-required", requiredApprovers: gate.approvers }
        : { status: "blocked", category: "policy-block", blockReason: gate.reason };
    return { lifecycle: lifecycleFor(prep, request.approval, outcome, "policy", undefined) };
  }

  // Execute through the narrow remote adapter and classify any rejection.
  const result = await runPublishAdapter(request.command, deps.adapter);
  const outcome = publishOutcomeFor(result);
  const lifecycle = lifecycleFor(prep, request.approval, outcome, "result", result);
  // Attach a publish-rejection descriptor only for a genuine remote/precondition rejection. An ABORTED
  // outcome (the run was cancelled) is not a remote rejection, so it carries no "user-fixable" recovery
  // hint — surfacing one would mislead the operator into thinking the remote refused the push.
  if (result.outcome !== "succeeded" && result.outcome !== "aborted") {
    const reason = result.rejectionReason ?? "unknown";
    return { lifecycle, rejection: gitPublishRejectionFor(reason) };
  }
  return { lifecycle };
}

// True iff the argv begins with the single allowed publish subcommand. Lets tests prove the
// no-generic-fallback property structurally for the remote authority.
export function gitPublishArgvIsGoverned(argv: readonly string[]): boolean {
  return argv.length > 0 && GIT_PUBLISH_ALLOWED_SUBCOMMANDS.includes(argv[0] ?? "");
}
