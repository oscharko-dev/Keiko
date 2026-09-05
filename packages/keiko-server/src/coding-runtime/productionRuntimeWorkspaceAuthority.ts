import {
  isVerifiedCommitResult,
  type VerifiedCommitResult,
} from "@oscharko-dev/keiko-contracts/runtime/verified-commit";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

import {
  codingWorkbenchPolicyEffectFor,
  resolveEffectiveCodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { validateCodingWorkbenchIssueBinding } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";

import type {
  CodingWorkbenchActionClass,
  CodingWorkbenchConnectorScope,
  CodingWorkbenchMode,
  CodingWorkbenchNetworkPolicy,
  CodingWorkbenchRuntimeAuthorityFacts,
  WorkspaceInstance,
  ModelReasoningEffort,
} from "@oscharko-dev/keiko-contracts";

import type { WorkspaceLifecycleService } from "../task-workspace/types.js";
import type { CodingRuntimeLaunchResolver } from "./codingRuntimeOrchestrator.js";
import {
  codingRuntimeBudgetDigest,
  codingRuntimeFactDigest,
  type CodingRuntimeTrustedContext,
} from "./runtimeAuthorityService.js";
import { projectRuntimeAuthorityValue } from "./runtimeAuthorityProjection.js";
import {
  CodingRuntimeLaunchResolutionError,
  type CodingRuntimeLaunchResolutionFailureReason,
} from "./launchFailure.js";

const RUNTIME_TTL_MS = 30 * 60_000;

type LaunchResolutionInput = Parameters<CodingRuntimeLaunchResolver["resolve"]>[0];

export interface ProductionWorkspaceAuthorityInput {
  /** Retained last successful runtime receipt; latest proposals never replace HEAD provenance. */
  readonly verifiedCommitResult?: (runId: string) => VerifiedCommitResult | undefined;
  readonly workspaceLifecycle: Pick<WorkspaceLifecycleService, "getActive">;
  readonly managedTaskWorkspaceRoot: string;
  readonly deploymentCeiling: CodingWorkbenchMode;
  readonly readWorkspaceHead: (workspaceRoot: string, repositoryRoot: string) => string | undefined;
  readonly now?: (() => Date) | undefined;
  // When the deployment activates read-only public research (#2387), the base envelope admits the
  // network-egress action class and moves the network policy to governed-egress. This only opens
  // the CLASS; a specific fetch still requires a live research grant in the registry AND passes the
  // human-approval gate, so no grant means no outbound request (fail closed).
  readonly researchEgressEnabled?: boolean | undefined;
  readonly resolveManagedModelProfile?:
    | ((
        modelId: string | undefined,
        reasoningEffort: ModelReasoningEffort | undefined,
      ) => { readonly profileId: string; readonly reasoningEffort?: ModelReasoningEffort })
    | undefined;
}

// ADR-0138 D2 / epic #3384 correction 5: the "delivery" resource scope is never `denied` for any
// mode — it is `approval-required` in every one of them, including Full access — so withholding the
// `source-control.*` connector scopes and the `delivery-substrate` action class below
// `autonomous-delivery` cannot be what stands between a lower mode and an unapproved delivery
// effect; approval is that control (`runBoundAuthority.ts`'s mode/redemption decision). Deriving the
// grant from the matrix, instead of hardcoding it to one mode, means a future matrix edit that
// actually introduced a `denied` cell here would withhold the scope automatically. Reads uniformly
// at "medium": every risk tier resolves identically for a fixed (mode, scope) pair (ADR-0138 D2).
function deliveryScopeGranted(mode: CodingWorkbenchMode): boolean {
  return codingWorkbenchPolicyEffectFor(mode, "delivery", "medium") !== "denied";
}

// The base workspace action classes, plus the delivery-substrate/connector-access pair whenever the
// matrix does not deny the "delivery" scope for this mode (see `deliveryScopeGranted`), plus
// network-egress only when research egress is activated. Kept in lock-step with the network policy
// below so validateNetworkPolicyActionClassConsistency holds (mode !== "deny-all" iff the action
// classes include network-egress) and with `runtimeConnectorScopes` below so
// validateConnectorScopeActionClassConsistency holds (connectorScopes non-empty iff action classes
// include connector-access).
function runtimeActionClasses(
  mode: CodingWorkbenchMode,
  researchEgressEnabled: boolean | undefined,
): readonly CodingWorkbenchActionClass[] {
  const actionClasses: CodingWorkbenchActionClass[] = [
    "workspace-read",
    "workspace-write",
    "verification",
  ];
  if (mode !== "governed-assist") actionClasses.push("command-execution");
  if (deliveryScopeGranted(mode)) actionClasses.push("delivery-substrate", "connector-access");
  if (researchEgressEnabled === true || mode === "autonomous-delivery") {
    actionClasses.push("network-egress");
  }
  return actionClasses;
}

// Exported so a caller that needs to project the SAME run-context connector-scope entitlement
// outside a minted context (epic #3384 correction 7: coding-context/codingRuntimeIssueIntake.ts's
// issue-context attachment) reuses this single rule rather than restating which scopes a mode
// grants.
export const DELIVERY_CONNECTOR_SCOPES: readonly CodingWorkbenchConnectorScope[] = [
  "source-control.read",
  "source-control.write",
];

// Mirrors `deliveryScopeGranted` above: the source-control connector scopes are the Git-delivery
// authority's own scope (used by both local workspace-contained writes — stage/unstage/branch-create
// /branch-switch — and delivery-scoped writes — commit/push/pull-request/merge — see
// `gitOperationRequirements.ts`), so they follow the same not-denied rule rather than being withheld
// until `autonomous-delivery`. `productionGitDeliveryModeGrants` below is the single per-mode
// projection both this module and `gitDelivery/runBoundAuthority.test-support.ts`'s fixture derive
// from.
function runtimeConnectorScopes(mode: CodingWorkbenchMode): readonly CodingWorkbenchConnectorScope[] {
  return deliveryScopeGranted(mode) ? DELIVERY_CONNECTOR_SCOPES : [];
}

export interface ProductionGitDeliveryModeGrants {
  readonly actionClasses: readonly CodingWorkbenchActionClass[];
  readonly connectorScopes: readonly CodingWorkbenchConnectorScope[];
}

// The smallest pure per-mode projection of what this module mints, exported so a Git-delivery test
// fixture can derive the exact production shape instead of restating the formula above (AGENTS.md
// §7 / epic #3384 correction 5, item 2: `runBoundAuthority.test-support.ts`'s
// `productionScopedGitDeliveryAuthority` calls this rather than keeping its own copy). Holds
// `researchEgressEnabled` at its production default (`false`) — the network-egress action class is
// not part of the Git-delivery admission surface this projects for (network policy stays a separate,
// intentionally mode-gated fixture concern owned by #3387).
export function productionGitDeliveryModeGrants(
  mode: CodingWorkbenchMode,
): ProductionGitDeliveryModeGrants {
  return {
    actionClasses: runtimeActionClasses(mode, false),
    connectorScopes: runtimeConnectorScopes(mode),
  };
}

function runtimeNetworkPolicy(
  mode: CodingWorkbenchMode,
  researchEgressEnabled: boolean | undefined,
): CodingWorkbenchNetworkPolicy {
  if (mode === "autonomous-delivery") {
    return {
      mode: "connector-scoped-egress",
      allowLoopback: false,
      connectorScopes: DELIVERY_CONNECTOR_SCOPES,
    };
  }
  return researchEgressEnabled === true
    ? { mode: "governed-egress", allowLoopback: false, connectorScopes: [] }
    : { mode: "deny-all", allowLoopback: false, connectorScopes: [] };
}

export function resolveProductionRuntimeContext(
  input: ProductionWorkspaceAuthorityInput,
  request: LaunchResolutionInput,
): CodingRuntimeTrustedContext {
  const active = input.workspaceLifecycle.getActive();
  if (active?.instance.workspaceId !== request.workspaceId) invalidWorkspace();
  const workspaceRoot = qualifiedWorkspaceRoot(
    input,
    request.workspaceRoot,
    active.binding.activeRoot,
    active.instance,
  );
  const head = input.readWorkspaceHead(workspaceRoot, active.instance.repositoryRoot);
  if (head === undefined || active.instance.lastVerifiedHead !== head) invalidWorkspace();
  return contextFromActive(input, { ...request, workspaceRoot }, active.instance, head);
}

// eslint-disable-next-line max-lines-per-function -- Explicit authority fields form one auditable policy manifest.
function contextFromActive(
  input: ProductionWorkspaceAuthorityInput,
  request: LaunchResolutionInput,
  instance: WorkspaceInstance,
  head: string,
): CodingRuntimeTrustedContext {
  const branch = instance.taskBranch;
  const now = input.now?.() ?? new Date();
  const runtimeProfile = trustedRuntimeProfile(input, request);
  // ADR-0124 D2: authority is the fail-closed MINIMUM of the requested mode and the deployment
  // ceiling. Every capability below is derived from that minimum, never from the request. Deriving
  // from `request.requestedMode` widened authority by request: `runtimeAuthorityService` clamps only
  // the envelope's `effectiveMode` and copies these fields verbatim, so a run that asked for
  // `autonomous-delivery` under a lower ceiling was minted with a clamped mode but still carried
  // `delivery-substrate`, `connector-access`, `source-control.write` and a connector-scoped network
  // policy — which `codingToolAuthorityPort` and `gitDelivery/runBoundAuthority` both honour,
  // because they read the scopes, not the mode.
  const effectiveMode = resolveEffectiveCodingWorkbenchMode(
    request.requestedMode,
    input.deploymentCeiling,
  );
  return {
    runId: request.runId,
    operatorId: request.serverPrincipal,
    taskId: instance.taskId,
    projectId: instance.repositoryId,
    projectDigest: digest(instance.repositoryRoot),
    workspaceId: instance.workspaceId,
    workspaceRoot: request.workspaceRoot,
    branchRef: branch,
    branchHeadDigest: digest(head),
    ...issueBindingFromRequest(request, instance),
    branch: {
      baseRef: instance.baseBranch,
      headRef: branch,
      allowDetachedHead: false,
      allowedPrefixes: [branchPrefix(branch)],
    },
    deploymentCeiling: input.deploymentCeiling,
    runtimeSource: runtimeProfile.runtimeSource,
    actionClasses: runtimeActionClasses(effectiveMode, input.researchEgressEnabled),
    connectorScopes: runtimeConnectorScopes(effectiveMode),
    modelProfile: {
      profileId: runtimeProfile.profileId,
      source: runtimeProfile.modelSource,
      supportsStreaming: true,
      supportsToolCalling: true,
      ...(runtimeProfile.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: runtimeProfile.reasoningEffort }),
    },
    commandPolicy: {
      mode: effectiveMode === "governed-assist" ? "deny" : "governed",
      allow: [],
      deny: [],
      maxCommandTimeoutMs: 120_000,
      requirePerCommandApproval: effectiveMode !== "autonomous-delivery",
    },
    networkPolicy: runtimeNetworkPolicy(effectiveMode, input.researchEgressEnabled),
    gates: ["human-approval"],
    budget: {
      maxRuntimeMs: RUNTIME_TTL_MS,
      maxToolCalls: 256,
      maxPromptTokens: 200_000,
      maxPatchBytes: 262_144,
    },
    expiresAt: new Date(now.getTime() + RUNTIME_TTL_MS).toISOString(),
  };
}

function issueBindingFromRequest(
  request: LaunchResolutionInput,
  instance: WorkspaceInstance,
): Pick<CodingRuntimeTrustedContext, "issueBinding"> {
  if (request.issueBinding === undefined) return {};
  const binding = validateCodingWorkbenchIssueBinding(request.issueBinding);
  if (
    !binding.ok ||
    binding.value.repositoryId !== instance.repositoryId ||
    binding.value.defaultBaseRef !== instance.baseBranch
  )
    invalidWorkspace();
  return { issueBinding: structuredClone(binding.value) };
}

type TrustedRuntimeProfile = Pick<CodingRuntimeTrustedContext, "runtimeSource"> & {
  readonly modelSource: CodingRuntimeTrustedContext["modelProfile"]["source"];
  readonly profileId: string;
  readonly reasoningEffort?: ModelReasoningEffort | undefined;
};

function codexSelectionFailure(
  request: LaunchResolutionInput,
): CodingRuntimeLaunchResolutionFailureReason | undefined {
  if (request.modelId !== undefined && request.reasoningEffort !== undefined) {
    return "codex-model-and-reasoning-unsupported";
  }
  if (request.modelId !== undefined) return "codex-model-selection-unsupported";
  if (request.reasoningEffort !== undefined) return "codex-reasoning-effort-unsupported";
  return undefined;
}

function managedSelectionFailure(
  request: LaunchResolutionInput,
): CodingRuntimeLaunchResolutionFailureReason | undefined {
  if (request.modelId !== undefined && request.reasoningEffort !== undefined) {
    return "managed-model-and-reasoning-unqualified";
  }
  if (request.modelId !== undefined) return "managed-model-unqualified";
  if (request.reasoningEffort !== undefined) return "managed-reasoning-effort-unqualified";
  return undefined;
}

function codexRuntimeProfile(request: LaunchResolutionInput): TrustedRuntimeProfile {
  const failure = codexSelectionFailure(request);
  if (failure !== undefined) throw new CodingRuntimeLaunchResolutionError(failure);
  return {
    runtimeSource: "codex-cli-adapter",
    modelSource: "chatgpt-codex-subscription-profile",
    profileId: "codex-subscription",
  };
}

function managedRuntimeProfile(
  input: ProductionWorkspaceAuthorityInput,
  request: LaunchResolutionInput,
): TrustedRuntimeProfile {
  const selected = input.resolveManagedModelProfile?.(request.modelId, request.reasoningEffort);
  const failure = managedSelectionFailure(request);
  if (selected === undefined && failure !== undefined) {
    throw new CodingRuntimeLaunchResolutionError(failure);
  }
  return {
    runtimeSource: "keiko-sidecar",
    modelSource: "keiko-model-gateway",
    profileId: selected?.profileId ?? "coding-safe-openai-compatible",
    ...(selected?.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: selected.reasoningEffort }),
  };
}

function trustedRuntimeProfile(
  input: ProductionWorkspaceAuthorityInput,
  request: LaunchResolutionInput,
): TrustedRuntimeProfile {
  return request.runtimePreference === "codex-subscription"
    ? codexRuntimeProfile(request)
    : managedRuntimeProfile(input, request);
}

export function productionRuntimeAuthorityFacts(
  input: ProductionWorkspaceAuthorityInput,
  context: CodingRuntimeTrustedContext,
): CodingWorkbenchRuntimeAuthorityFacts {
  if (!productionWorkspaceMatches(input, context)) throw new Error("runtime-workspace-drift");
  const branch = projectedBranch(context.branch);
  const modelProfile = {
    ...context.modelProfile,
    profileId: projectRuntimeAuthorityValue("profile", context.modelProfile.profileId),
  };
  return {
    binding: {
      taskId: projectRuntimeAuthorityValue("task", context.taskId),
      projectId: projectRuntimeAuthorityValue("project", context.projectId),
      projectDigest: context.projectDigest,
      workspaceId: projectRuntimeAuthorityValue("workspace", context.workspaceId),
      workspaceRootDigest: digest(context.workspaceRoot),
      branchRef: projectRuntimeAuthorityValue("branch", context.branchRef),
      branchHeadDigest: context.branchHeadDigest,
    },
    actionClasses: context.actionClasses,
    connectorScopes: context.connectorScopes,
    runtimeSource: context.runtimeSource,
    modelSource: context.modelProfile.source,
    budgetDigest: codingRuntimeBudgetDigest(context.budget),
    commandPolicyDigest: codingRuntimeFactDigest(context.commandPolicy),
    networkPolicyDigest: codingRuntimeFactDigest(context.networkPolicy),
    gatesDigest: codingRuntimeFactDigest(context.gates),
    branchConstraintsDigest: codingRuntimeFactDigest(branch),
    modelProfileDigest: codingRuntimeFactDigest(modelProfile),
    issueBindingDigest: context.issueBinding?.bindingDigest,
  };
}

function projectedBranch(
  branch: CodingRuntimeTrustedContext["branch"],
): CodingRuntimeTrustedContext["branch"] {
  const headRef = projectRuntimeAuthorityValue("branch", branch.headRef);
  return {
    ...branch,
    baseRef: projectRuntimeAuthorityValue("branch", branch.baseRef),
    headRef,
    allowedPrefixes: [headRef],
  };
}

// Fail closed on every failure, including a proof that could not run (IDENTITY_PROOF_FAILED): the
// lifecycle service logs that one at its source with its cause, so "does not match" here is never
// the only evidence of a transient disk failure (#3376 review).
export function productionWorkspaceMatches(
  input: ProductionWorkspaceAuthorityInput,
  context: CodingRuntimeTrustedContext,
): boolean {
  try {
    const active = input.workspaceLifecycle.getActive();
    if (active === undefined) return false;
    const workspaceRoot = qualifiedWorkspaceRoot(
      input,
      context.workspaceRoot,
      active.binding.activeRoot,
      active.instance,
    );
    const head = input.readWorkspaceHead(workspaceRoot, active.instance.repositoryRoot);
    return (
      trustedIdentityMatches(active.instance, context) &&
      trustedBranchMatches(active.instance, context) &&
      trustedHeadMatches(input, active.instance, context, head)
    );
  } catch {
    return false;
  }
}

function trustedIdentityMatches(
  instance: WorkspaceInstance,
  context: CodingRuntimeTrustedContext,
): boolean {
  return (
    instance.taskId === context.taskId &&
    instance.repositoryId === context.projectId &&
    digest(instance.repositoryRoot) === context.projectDigest &&
    instance.workspaceId === context.workspaceId
  );
}

function trustedBranchMatches(
  instance: WorkspaceInstance,
  context: CodingRuntimeTrustedContext,
): boolean {
  return (
    instance.baseBranch === context.branch.baseRef &&
    instance.taskBranch === context.branchRef &&
    instance.taskBranch === context.branch.headRef &&
    !context.branch.allowDetachedHead &&
    context.branch.allowedPrefixes.length === 1 &&
    context.branch.allowedPrefixes[0] === branchPrefix(instance.taskBranch)
  );
}

function trustedHeadMatches(
  input: ProductionWorkspaceAuthorityInput,
  instance: WorkspaceInstance,
  context: CodingRuntimeTrustedContext,
  head: string | undefined,
): boolean {
  if (head === undefined || instance.lastVerifiedHead !== head) return false;
  if (digest(head) === context.branchHeadDigest) return true;
  if (context.runId === undefined) return false;
  const receipt = input.verifiedCommitResult?.(context.runId);
  if (!isVerifiedCommitResult(receipt) || receipt.status !== "succeeded") return false;
  return [
    receipt.runId === context.runId,
    receipt.headSha === head,
    receipt.workspaceDigest === digest(context.workspaceRoot),
    receipt.issueBindingDigest === context.issueBinding?.bindingDigest,
  ].every(Boolean);
}

export function trustedManagedWorkspaceRoot(root: string): boolean {
  try {
    return isAbsolute(root) && realpathSync(root) === root;
  } catch {
    return false;
  }
}

function qualifiedWorkspaceRoot(
  input: ProductionWorkspaceAuthorityInput,
  requestRoot: string,
  activeRoot: string,
  instance: WorkspaceInstance,
): string {
  const managed = realpathSync(input.managedTaskWorkspaceRoot);
  const request = canonicalRoot(requestRoot);
  const active = canonicalRoot(activeRoot);
  const root = canonicalRoot(instance.managedWorktreePath);
  const rel = relative(managed, root);
  if (
    request !== active ||
    active !== root ||
    instance.lifecycleState !== "active" ||
    instance.health !== "healthy" ||
    instance.driftMarkers.length !== 0 ||
    rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${sep}`)
  ) {
    invalidWorkspace();
  }
  return root;
}

function canonicalRoot(root: string): string {
  if (!isAbsolute(root)) invalidWorkspace();
  const canonical = realpathSync(root);
  if (canonical !== root) invalidWorkspace();
  return canonical;
}

function branchPrefix(branch: string): string {
  const slash = branch.indexOf("/");
  return slash < 0 ? `${branch.slice(0, Math.min(branch.length, 8))}-` : branch.slice(0, slash + 1);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function invalidWorkspace(): never {
  throw new Error("runtime-workspace-unqualified");
}
