import {
  isVerifiedCommitResult,
  type VerifiedCommitResult,
} from "@oscharko-dev/keiko-contracts/runtime/verified-commit";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

import { resolveEffectiveCodingWorkbenchMode } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { validateCodingWorkbenchIssueBinding } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";

import type {
  CodingWorkbenchActionClass,
  CodingWorkbenchConnectorScope,
  CodingWorkbenchMode,
  CodingWorkbenchRuntimeAuthorityFacts,
  WorkspaceInstance,
  ModelReasoningEffort,
} from "@oscharko-dev/keiko-contracts";

import type { WorkspaceLifecycleService } from "../task-workspace/types.js";
import type { CodingRuntimeLaunchResolver } from "./codingRuntimeOrchestrator.js";
import {
  codingRuntimeActionClassesForMode,
  codingRuntimeBudgetDigest,
  codingRuntimeCommandPolicyForMode,
  codingRuntimeConnectorScopesForMode,
  codingRuntimeFactDigest,
  codingRuntimeNetworkPolicyForMode,
  type CodingRuntimeTrustedContext,
} from "./runtimeAuthorityService.js";
import { projectRuntimeAuthorityValue } from "./runtimeAuthorityProjection.js";
import {
  CodingRuntimeLaunchResolutionError,
  type CodingRuntimeLaunchResolutionFailureReason,
} from "./launchFailure.js";

const RUNTIME_TTL_MS = 30 * 60_000;
const DEFAULT_RUNTIME_PROMPT_TOKENS = 200_000;
const MAX_RUNTIME_PROMPT_TOKENS = 2_000_000;

function checkedRuntimePromptTokenBudget(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_RUNTIME_PROMPT_TOKENS) {
    throw new RangeError("Coding runtime prompt token budget is outside the supported range.");
  }
  return value;
}

export function configuredRuntimePromptTokenBudget(value: string | undefined): number {
  if (value === undefined) return DEFAULT_RUNTIME_PROMPT_TOKENS;
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new RangeError("Coding runtime prompt token budget must be a positive integer.");
  }
  return checkedRuntimePromptTokenBudget(Number(value));
}

type LaunchResolutionInput = Parameters<CodingRuntimeLaunchResolver["resolve"]>[0];

export interface ProductionWorkspaceAuthorityInput {
  /** Retained last successful runtime receipt; latest proposals never replace HEAD provenance. */
  readonly verifiedCommitResult?: (runId: string) => VerifiedCommitResult | undefined;
  readonly workspaceLifecycle: Pick<WorkspaceLifecycleService, "getActive">;
  readonly managedTaskWorkspaceRoot: string;
  readonly deploymentCeiling: CodingWorkbenchMode;
  /** Trusted deployment ceiling for a newly minted run; never changes an existing envelope. */
  readonly promptTokenBudget?: number | undefined;
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

// Exported so a caller that needs to project the SAME run-context connector-scope entitlement
// outside a minted context (epic #3384 correction 7: coding-context/codingRuntimeIssueIntake.ts's
// issue-context attachment) reuses this single rule rather than restating which scopes a mode
// grants.
export { DELIVERY_CONNECTOR_SCOPES } from "./runtimeAuthorityService.js";

export interface ProductionGitDeliveryModeGrants {
  readonly actionClasses: readonly CodingWorkbenchActionClass[];
  readonly connectorScopes: readonly CodingWorkbenchConnectorScope[];
}

// The smallest pure per-mode projection of what this module mints, exported so a Git-delivery test
// fixture can derive the exact production shape instead of restating the formula above (AGENTS.md
// §7 / epic #3384 correction 5, item 2: `runBoundAuthority.test-support.ts`'s
// `productionScopedGitDeliveryAuthority` calls this rather than keeping its own copy). Holds
// `researchEgressEnabled` at its production default (`false`): `network-egress` is therefore present
// only for `autonomous-delivery` (matching `runtimeActionClasses`'s own unconditional branch for
// that mode) and absent for `governed-assist`/`supervised-coding`, exactly what those modes mint
// outside an active research-egress grant.
export function productionGitDeliveryModeGrants(
  mode: CodingWorkbenchMode,
): ProductionGitDeliveryModeGrants {
  return {
    actionClasses: codingRuntimeActionClassesForMode(mode, false),
    connectorScopes: codingRuntimeConnectorScopesForMode(mode),
  };
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
    actionClasses: codingRuntimeActionClassesForMode(effectiveMode, input.researchEgressEnabled),
    connectorScopes: codingRuntimeConnectorScopesForMode(effectiveMode),
    modelProfile: {
      profileId: runtimeProfile.profileId,
      source: runtimeProfile.modelSource,
      supportsStreaming: true,
      supportsToolCalling: true,
      ...(runtimeProfile.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: runtimeProfile.reasoningEffort }),
    },
    commandPolicy: codingRuntimeCommandPolicyForMode(effectiveMode),
    networkPolicy: codingRuntimeNetworkPolicyForMode(effectiveMode, input.researchEgressEnabled),
    gates: ["human-approval"],
    budget: {
      maxRuntimeMs: RUNTIME_TTL_MS,
      maxToolCalls: 256,
      maxPromptTokens: checkedRuntimePromptTokenBudget(
        input.promptTokenBudget ?? DEFAULT_RUNTIME_PROMPT_TOKENS,
      ),
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
