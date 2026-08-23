import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

import type {
  CodingWorkbenchActionClass,
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

const RUNTIME_TTL_MS = 30 * 60_000;

type LaunchResolutionInput = Parameters<CodingRuntimeLaunchResolver["resolve"]>[0];

export interface ProductionWorkspaceAuthorityInput {
  readonly workspaceLifecycle: WorkspaceLifecycleService;
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

// The base workspace action classes, plus network-egress only when research egress is activated.
// Kept in lock-step with the network policy below so validateNetworkPolicyActionClassConsistency
// holds (mode !== "deny-all" iff the action classes include network-egress).
function researchActionClasses(
  researchEgressEnabled: boolean | undefined,
): readonly CodingWorkbenchActionClass[] {
  const base: readonly CodingWorkbenchActionClass[] = [
    "workspace-read",
    "workspace-write",
    "verification",
  ];
  return researchEgressEnabled === true ? [...base, "network-egress"] : base;
}

function researchNetworkPolicy(
  researchEgressEnabled: boolean | undefined,
): CodingWorkbenchNetworkPolicy {
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
  return {
    operatorId: request.serverPrincipal,
    taskId: instance.taskId,
    projectId: instance.repositoryId,
    projectDigest: digest(instance.repositoryRoot),
    workspaceId: instance.workspaceId,
    workspaceRoot: request.workspaceRoot,
    branchRef: branch,
    branchHeadDigest: digest(head),
    branch: {
      baseRef: instance.baseBranch,
      headRef: branch,
      allowDetachedHead: false,
      allowedPrefixes: [branchPrefix(branch)],
    },
    deploymentCeiling: input.deploymentCeiling,
    runtimeSource: runtimeProfile.runtimeSource,
    actionClasses: researchActionClasses(input.researchEgressEnabled),
    connectorScopes: [],
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
      mode: "deny",
      allow: [],
      deny: [],
      maxCommandTimeoutMs: 1,
      requirePerCommandApproval: true,
    },
    networkPolicy: researchNetworkPolicy(input.researchEgressEnabled),
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

type TrustedRuntimeProfile = Pick<CodingRuntimeTrustedContext, "runtimeSource"> & {
  readonly modelSource: CodingRuntimeTrustedContext["modelProfile"]["source"];
  readonly profileId: string;
  readonly reasoningEffort?: ModelReasoningEffort | undefined;
};

function codexRuntimeProfile(request: LaunchResolutionInput): TrustedRuntimeProfile {
  if (request.modelId !== undefined || request.reasoningEffort !== undefined) {
    throw new Error("runtime-model-selection-unsupported");
  }
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
  if (
    selected === undefined &&
    (request.modelId !== undefined || request.reasoningEffort !== undefined)
  ) {
    throw new Error("runtime-model-selection-unqualified");
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
      trustedHeadMatches(active.instance, context, head)
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
  instance: WorkspaceInstance,
  context: CodingRuntimeTrustedContext,
  head: string | undefined,
): boolean {
  return (
    head !== undefined &&
    instance.lastVerifiedHead === head &&
    digest(head) === context.branchHeadDigest
  );
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
