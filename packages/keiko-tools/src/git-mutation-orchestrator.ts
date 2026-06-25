// The governed Git mutation orchestrator (Issue #472, Epic #470) — AC1.
//
// This is the single execution authority for governed local Git writes. Every supported mutation
// follows ONE repeatable path: resolve content-free inputs, run deterministic preflight, produce a
// content-free preview, evaluate org/repo policy, and — only when preflight passes, policy permits,
// and any required approval is satisfied — execute through the narrow local adapter and emit a
// structured result. The descriptive `GitDeliveryActionEnvelope` is always populated through the
// policy phase (it is the contract artifact preview/evidence consumers read); the `outcome` and
// `phaseReached` state precisely where enforcement halted and why, with no string parsing required.
//
// The orchestrator is deterministic given its injected dependencies (snapshot, clock, id generator,
// adapter). It performs no IO of its own: git execution lives behind the injected adapter, so the
// orchestrator is unit-testable with a fake adapter and never opens a parallel child_process path.

import type {
  GitDeliveryAbortableOperation,
  GitDeliveryActionEnvelope,
  GitDeliveryActionPreview,
  GitDeliveryApprovalRequirement,
  GitDeliveryBlockReason,
  GitDeliveryConstraint,
  GitDeliveryExecutionResult,
  GitDeliveryOrgPolicyPack,
  GitDeliveryPolicyContext,
  GitDeliveryPolicyDecision,
  GitDeliveryProviderCapability,
  GitDeliveryRecoveryStrategyHint,
  GitDeliveryRepoPolicyPack,
  GitDeliveryResolvedInputs,
} from "@oscharko-dev/keiko-contracts";
import {
  evaluateGitPolicy,
  GIT_DELIVERY_SCHEMA_VERSION,
  gitDeliveryBranchNameMatchesAny,
  gitDeliveryRiskClassWithinCeiling,
} from "@oscharko-dev/keiko-contracts";
import type { GitLocalMutationAdapter } from "./git-mutation-adapter.js";
import type {
  GitPreflightFinding,
  GitPreflightReport,
  GitWorktreeSnapshot,
} from "./git-mutation-preflight.js";
import { evaluateGitPreflight } from "./git-mutation-preflight.js";
import type {
  GitMutationFailureCategory,
  GitMutationLifecyclePhase,
} from "./git-mutation-taxonomy.js";
import { gitMutationCategoryForExecutionResult } from "./git-mutation-taxonomy.js";

// ─── Command union (the local mutation kinds this kernel executes) ──────────────────────────
// Carries concrete operands. The content-free contract inputs (counts/lengths) are DERIVED from
// these for the envelope, preflight, preview, and policy. Remote/provider kinds (push, pr-create,
// pr-update, merge) are part of the shared contract and are classified by preflight/policy, but
// their orchestrated EXECUTION is delivered by later slices (#476–#478) that extend this union and
// register their executors; #472 owns the local set.

export interface GitBranchCreateCommand {
  readonly kind: "branch-create";
  readonly branchName: string;
  readonly baseBranchName: string;
  readonly startPointRefHash: string;
}

export interface GitStageCommand {
  readonly kind: "stage";
  readonly pathspecs: readonly string[];
  readonly includeUntracked: boolean;
}

export interface GitUnstageCommand {
  readonly kind: "unstage";
  readonly pathspecs: readonly string[];
}

export interface GitCommitCommand {
  readonly kind: "commit";
  readonly message: string;
  readonly allowEmpty: boolean;
}

export interface GitAbortCommand {
  readonly kind: "abort";
  readonly operationToAbort: GitDeliveryAbortableOperation;
  readonly preserveIndexChanges: boolean;
}

export interface GitRecoveryCommand {
  readonly kind: "recovery";
  readonly recoveryStrategyHint: GitDeliveryRecoveryStrategyHint;
  readonly targetRefHash: string;
  readonly affectedPathspecs: readonly string[];
}

export type GitMutationCommand =
  | GitBranchCreateCommand
  | GitStageCommand
  | GitUnstageCommand
  | GitCommitCommand
  | GitAbortCommand
  | GitRecoveryCommand;

// ─── Request, dependencies, idempotency journal ─────────────────────────────────────────────

export interface GitMutationRequest {
  readonly command: GitMutationCommand;
  // The operator's approval state for this action. `{ required: false }` means no approval was
  // supplied; a granted approval is validated (and expiry-checked) when policy is approval-gated.
  readonly approval: GitDeliveryApprovalRequirement;
  // When set with a journal, a re-submitted request that already executed returns its prior result
  // instead of mutating the repository twice.
  readonly idempotencyKey?: string | undefined;
}

// A successfully executed mutation is recorded here so a retry with the same idempotency key short-
// circuits. Only `succeeded` outcomes are recorded — a failed or blocked action did not apply, so
// re-running it is the caller's intended retry, not a double-apply.
export interface GitMutationJournal {
  lookup(idempotencyKey: string): GitMutationLifecycleResult | undefined;
  record(idempotencyKey: string, result: GitMutationLifecycleResult): void;
}

export interface GitMutationOrchestratorDeps {
  readonly adapter: GitLocalMutationAdapter;
  readonly snapshot: GitWorktreeSnapshot;
  readonly orgPolicyPack?: GitDeliveryOrgPolicyPack | undefined;
  readonly repoPolicyPack?: GitDeliveryRepoPolicyPack | undefined;
  readonly activeProviderCapabilities?: readonly GitDeliveryProviderCapability[] | undefined;
  // Injected clock (approval-expiry comparison) and id generator (no randomness in this module).
  readonly now: () => number;
  readonly newActionId: () => string;
  readonly journal?: GitMutationJournal | undefined;
}

// ─── Outcome union (AC4 — status bound to category and payload) ──────────────────────────────

export type GitMutationOutcome =
  | { readonly status: "succeeded"; readonly executionResult: GitDeliveryExecutionResult }
  | { readonly status: "approval-required"; readonly requiredApprovers: readonly string[] }
  | {
      readonly status: "blocked";
      readonly category: "policy-block";
      readonly blockReason: GitDeliveryBlockReason;
    }
  | {
      readonly status: "blocked";
      readonly category: "preflight-block";
      readonly findings: readonly GitPreflightFinding[];
    }
  | {
      readonly status: "failed";
      readonly category: "execution-failure" | "provider-failure";
      readonly executionResult: GitDeliveryExecutionResult;
    }
  | {
      readonly status: "recovery-required";
      readonly category: "recovery-required";
      readonly executionResult: GitDeliveryExecutionResult;
    };

export interface GitMutationLifecycleResult {
  readonly envelope: GitDeliveryActionEnvelope;
  readonly outcome: GitMutationOutcome;
  readonly phaseReached: GitMutationLifecyclePhase;
  readonly preflight: GitPreflightReport;
}

// Convenience accessor: the failure category for any non-success outcome, or undefined for a
// success / approval hold. Lets consumers branch on category without re-deriving it.
export function gitMutationOutcomeFailureCategory(
  outcome: GitMutationOutcome,
): GitMutationFailureCategory | undefined {
  if (
    outcome.status === "blocked" ||
    outcome.status === "failed" ||
    outcome.status === "recovery-required"
  ) {
    return outcome.category;
  }
  return undefined;
}

const UTF8 = new TextEncoder();

// ─── Phase 1: resolve content-free inputs ────────────────────────────────────────────────────

function deriveResolvedInputs(
  command: GitMutationCommand,
  snapshot: GitWorktreeSnapshot,
): GitDeliveryResolvedInputs {
  switch (command.kind) {
    case "branch-create":
      return {
        kind: "branch-create",
        branchName: command.branchName,
        baseBranchName: command.baseBranchName,
        startPointRefHash: command.startPointRefHash,
      };
    case "stage":
      return {
        kind: "stage",
        pathCount: command.pathspecs.length,
        includesUntracked: command.includeUntracked,
      };
    case "unstage":
      return { kind: "unstage", pathCount: command.pathspecs.length };
    case "commit":
      return {
        kind: "commit",
        messageByteLength: UTF8.encode(command.message).length,
        stagedPathCount: snapshot.stagedFileCount,
        allowEmptyCommit: command.allowEmpty,
      };
    case "abort":
      return {
        kind: "abort",
        operationToAbort: command.operationToAbort,
        preserveIndexChanges: command.preserveIndexChanges,
      };
    case "recovery":
      return {
        kind: "recovery",
        recoveryStrategyHint: command.recoveryStrategyHint,
        targetRefHash: command.targetRefHash,
        affectedPathCount: command.affectedPathspecs.length,
      };
    default:
      return assertNever(command);
  }
}

// The branch a policy branch-pattern constraint is evaluated against: the new branch for a create,
// otherwise the branch HEAD points at (undefined when detached).
function targetBranchName(
  command: GitMutationCommand,
  snapshot: GitWorktreeSnapshot,
): string | undefined {
  if (command.kind === "branch-create") {
    return command.branchName;
  }
  return snapshot.currentBranchName;
}

// ─── Phase 3: content-free preview ─────────────────────────────────────────────────────────────

function buildPreview(
  command: GitMutationCommand,
  snapshot: GitWorktreeSnapshot,
): GitDeliveryActionPreview {
  const affected = targetBranchName(command, snapshot);
  const base = {
    schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
    wouldCreateRemoteBranch: false, // local kernel never touches a remote
    wouldTriggerChecks: false,
  } as const;
  const fileCount = previewFileCount(command, snapshot);
  return {
    ...base,
    ...(affected !== undefined ? { affectedBranchName: affected } : {}),
    ...(fileCount !== undefined ? { estimatedFileCount: fileCount } : {}),
  };
}

function previewFileCount(
  command: GitMutationCommand,
  snapshot: GitWorktreeSnapshot,
): number | undefined {
  switch (command.kind) {
    case "stage":
    case "unstage":
      return command.pathspecs.length;
    case "commit":
      return snapshot.stagedFileCount;
    case "recovery":
      return command.affectedPathspecs.length;
    case "branch-create":
    case "abort":
      return undefined;
    default:
      return assertNever(command);
  }
}

// ─── Phase 4: policy gate ────────────────────────────────────────────────────────────────────
// A resolved gate decision: either proceed to execution, hold for approval, or block with a typed
// reason. Approval-required and policy-block are returned to the caller without executing.

type PolicyGate =
  | { readonly proceed: true }
  | {
      readonly proceed: false;
      readonly status: "approval-required";
      readonly requiredApprovers: readonly string[];
    }
  | {
      readonly proceed: false;
      readonly status: "policy-block";
      readonly blockReason: GitDeliveryBlockReason;
    };

function approvalIsValid(
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

function resolveApprovalGate(
  approvers: readonly string[],
  approval: GitDeliveryApprovalRequirement,
  now: number,
): PolicyGate {
  const state = approvalIsValid(approval, now);
  if (state === "valid") {
    return { proceed: true };
  }
  if (state === "expired") {
    return { proceed: false, status: "policy-block", blockReason: "approval-expired" };
  }
  return { proceed: false, status: "approval-required", requiredApprovers: approvers };
}

// Maps an unsatisfied constraint to its typed block reason. A satisfied constraint returns undefined.
function constraintBlockReason(
  constraint: GitDeliveryConstraint,
  inputs: GitDeliveryResolvedInputs,
  target: string | undefined,
  capabilities: readonly GitDeliveryProviderCapability[],
): GitDeliveryBlockReason | undefined {
  if (constraint.kind === "branch-pattern") {
    const matches =
      target !== undefined && gitDeliveryBranchNameMatchesAny(target, constraint.patterns);
    return matches ? undefined : "policy-pack-blocked";
  }
  if (constraint.kind === "provider-capability") {
    return capabilities.includes(constraint.capability) ? undefined : "provider-capability-absent";
  }
  // risk-class-ceiling
  return gitDeliveryRiskClassWithinCeiling(inputs.kind, constraint.maxRiskClass)
    ? undefined
    : "risk-class-ceiling";
}

function resolveConstrainedGate(
  constraints: readonly GitDeliveryConstraint[],
  inputs: GitDeliveryResolvedInputs,
  target: string | undefined,
  capabilities: readonly GitDeliveryProviderCapability[],
): PolicyGate {
  for (const constraint of constraints) {
    const reason = constraintBlockReason(constraint, inputs, target, capabilities);
    if (reason !== undefined) {
      return { proceed: false, status: "policy-block", blockReason: reason };
    }
  }
  return { proceed: true };
}

function resolvePolicyGate(
  decision: GitDeliveryPolicyDecision,
  inputs: GitDeliveryResolvedInputs,
  request: GitMutationRequest,
  target: string | undefined,
  capabilities: readonly GitDeliveryProviderCapability[],
  now: number,
): PolicyGate {
  if (decision.outcome === "allowed") {
    return { proceed: true };
  }
  if (decision.outcome === "blocked") {
    return { proceed: false, status: "policy-block", blockReason: decision.reason };
  }
  if (decision.outcome === "approval-gated") {
    return resolveApprovalGate(decision.requiredApprovers, request.approval, now);
  }
  return resolveConstrainedGate(decision.constraints, inputs, target, capabilities);
}

// ─── Phase 5: execution dispatch ─────────────────────────────────────────────────────────────

function dispatchExecution(
  command: GitMutationCommand,
  adapter: GitLocalMutationAdapter,
): Promise<GitDeliveryExecutionResult> {
  switch (command.kind) {
    case "branch-create":
      return adapter.createBranch({
        branchName: command.branchName,
        startPointRefHash: command.startPointRefHash,
      });
    case "stage":
      return adapter.stage({ pathspecs: command.pathspecs });
    case "unstage":
      return adapter.unstage({ pathspecs: command.pathspecs });
    case "commit":
      return adapter.commit({ message: command.message, allowEmpty: command.allowEmpty });
    case "abort":
      return adapter.abort({ operationToAbort: command.operationToAbort });
    case "recovery":
      return adapter.recover({
        recoveryStrategyHint: command.recoveryStrategyHint,
        targetRefHash: command.targetRefHash,
        pathspecs: command.affectedPathspecs,
      });
    default:
      return assertNever(command);
  }
}

function outcomeForExecution(result: GitDeliveryExecutionResult): GitMutationOutcome {
  if (result.outcome === "succeeded") {
    return { status: "succeeded", executionResult: result };
  }
  const category: GitMutationFailureCategory =
    gitMutationCategoryForExecutionResult(result) ?? "execution-failure";
  if (category === "recovery-required") {
    return { status: "recovery-required", category, executionResult: result };
  }
  if (category === "preflight-block" || category === "policy-block") {
    // Execution results never carry these categories; classify conservatively rather than widen the
    // failed-outcome union.
    return { status: "failed", category: "execution-failure", executionResult: result };
  }
  return { status: "failed", category, executionResult: result };
}

// ─── Envelope assembly ─────────────────────────────────────────────────────────────────────────

function assembleEnvelope(
  actionId: string,
  inputs: GitDeliveryResolvedInputs,
  policyDecision: GitDeliveryPolicyDecision,
  approval: GitDeliveryApprovalRequirement,
  preview: GitDeliveryActionPreview,
  executionResult: GitDeliveryExecutionResult | undefined,
): GitDeliveryActionEnvelope {
  // kind === inputs.kind holds by construction, so the literal is a sound member of the envelope
  // union; the single cast mirrors the contract module's own validated-construction idiom.
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

// ─── Orchestration entry point ───────────────────────────────────────────────────────────────

// The descriptive artifacts computed once per lifecycle: content-free inputs, the preflight report,
// the preview, the policy decision, and the action id. Every gate and the final result are built
// from this prep so the resolve→preflight→preview→policy work happens exactly once.
interface LifecyclePrep {
  readonly request: GitMutationRequest;
  readonly inputs: GitDeliveryResolvedInputs;
  readonly preflight: GitPreflightReport;
  readonly preview: GitDeliveryActionPreview;
  readonly target: string | undefined;
  readonly capabilities: readonly GitDeliveryProviderCapability[];
  readonly policyDecision: GitDeliveryPolicyDecision;
  readonly actionId: string;
}

function prepareLifecycle(
  request: GitMutationRequest,
  deps: GitMutationOrchestratorDeps,
): LifecyclePrep {
  const { command } = request;
  const { snapshot } = deps;
  const inputs = deriveResolvedInputs(command, snapshot);
  const target = targetBranchName(command, snapshot);
  const capabilities = deps.activeProviderCapabilities ?? [];
  const policyContext: GitDeliveryPolicyContext = {
    actionKind: inputs.kind,
    activeProviderCapabilities: capabilities,
    ...(target !== undefined ? { targetBranchName: target } : {}),
  };
  return {
    request,
    inputs,
    preflight: evaluateGitPreflight(inputs, snapshot),
    preview: buildPreview(command, snapshot),
    target,
    capabilities,
    policyDecision: evaluateGitPolicy(deps.orgPolicyPack, deps.repoPolicyPack, policyContext),
    actionId: deps.newActionId(),
  };
}

function buildLifecycleResult(
  prep: LifecyclePrep,
  outcome: GitMutationOutcome,
  phaseReached: GitMutationLifecyclePhase,
  executionResult?: GitDeliveryExecutionResult,
): GitMutationLifecycleResult {
  return {
    envelope: assembleEnvelope(
      prep.actionId,
      prep.inputs,
      prep.policyDecision,
      prep.request.approval,
      prep.preview,
      executionResult,
    ),
    outcome,
    phaseReached,
    preflight: prep.preflight,
  };
}

export async function runGitMutation(
  request: GitMutationRequest,
  deps: GitMutationOrchestratorDeps,
): Promise<GitMutationLifecycleResult> {
  const journaled = lookupJournal(request, deps);
  if (journaled !== undefined) {
    return journaled;
  }

  const prep = prepareLifecycle(request, deps);

  // Enforcement gate 1: a blocking preflight finding halts before policy enforcement and execution.
  if (!prep.preflight.ok) {
    return buildLifecycleResult(
      prep,
      { status: "blocked", category: "preflight-block", findings: prep.preflight.blocking },
      "preflight",
    );
  }

  // Enforcement gate 2: policy must permit (and any required approval must be satisfied).
  const gate = resolvePolicyGate(
    prep.policyDecision,
    prep.inputs,
    request,
    prep.target,
    prep.capabilities,
    deps.now(),
  );
  if (!gate.proceed) {
    const outcome: GitMutationOutcome =
      gate.status === "approval-required"
        ? { status: "approval-required", requiredApprovers: gate.requiredApprovers }
        : { status: "blocked", category: "policy-block", blockReason: gate.blockReason };
    return buildLifecycleResult(prep, outcome, "policy");
  }

  // Execute through the narrow adapter and emit the structured result.
  const executionResult = await runAdapter(request.command, deps.adapter);
  const result = buildLifecycleResult(
    prep,
    outcomeForExecution(executionResult),
    "result",
    executionResult,
  );
  recordJournal(request, deps, result);
  return result;
}

function lookupJournal(
  request: GitMutationRequest,
  deps: GitMutationOrchestratorDeps,
): GitMutationLifecycleResult | undefined {
  if (request.idempotencyKey === undefined || deps.journal === undefined) {
    return undefined;
  }
  return deps.journal.lookup(request.idempotencyKey);
}

function recordJournal(
  request: GitMutationRequest,
  deps: GitMutationOrchestratorDeps,
  result: GitMutationLifecycleResult,
): void {
  if (
    request.idempotencyKey !== undefined &&
    deps.journal !== undefined &&
    result.outcome.status === "succeeded"
  ) {
    deps.journal.record(request.idempotencyKey, result);
  }
}

// Adapter calls are isolated so a thrown/rejected adapter (timeout, denial, internal fault) becomes
// a structured internal-error result rather than propagating out of the orchestrator.
async function runAdapter(
  command: GitMutationCommand,
  adapter: GitLocalMutationAdapter,
): Promise<GitDeliveryExecutionResult> {
  try {
    return await dispatchExecution(command, adapter);
  } catch {
    return {
      schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
      outcome: "failed",
      durationMs: 0,
      errorCode: "internal-error",
    };
  }
}

function assertNever(command: never): never {
  throw new Error(`unhandled git mutation command: ${JSON.stringify(command)}`);
}

// In-memory idempotency journal. Suitable for a single orchestration host; a durable journal (the
// evidence ledger, #474) implements the same port over persistent storage.
export function createInMemoryGitMutationJournal(): GitMutationJournal {
  const store = new Map<string, GitMutationLifecycleResult>();
  return {
    lookup: (key: string): GitMutationLifecycleResult | undefined => store.get(key),
    record: (key: string, result: GitMutationLifecycleResult): void => {
      store.set(key, result);
    },
  };
}
