import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

import type {
  CodingWorkbenchRuntimeAuthorityFacts,
  WorkspaceInstance,
} from "@oscharko-dev/keiko-contracts";

import type { WorkspaceLifecycleService } from "../task-workspace/types.js";
import { productionWorkspaceDigest } from "./productionManagedWorktreeTools.js";
import type { QualifiedProductionCodingRuntime } from "./productionCodingRuntimeHost.js";
import {
  codingRuntimeBudgetDigest,
  codingRuntimeFactDigest,
  type CodingRuntimeTrustedContext,
} from "./runtimeAuthorityService.js";
import { projectRuntimeAuthorityValue } from "./runtimeAuthorityProjection.js";

const RUNTIME_TTL_MS = 30 * 60_000;

type LaunchResolutionInput = Parameters<
  QualifiedProductionCodingRuntime["mintLaunch"]["resolve"]
>[0];

export interface ProductionWorkspaceAuthorityInput {
  readonly workspaceLifecycle: WorkspaceLifecycleService;
  readonly managedTaskWorkspaceRoot: string;
  /**
   * Bounded repository-head observation owned by the existing workspace/Git boundary. Production
   * composition supplies the reconciled workspace snapshot; tests may inject a stricter live seam.
   */
  readonly readWorkspaceHead: (workspaceRoot: string, repositoryRoot: string) => string | undefined;
}

export function resolveProductionRuntimeContext(
  input: ProductionWorkspaceAuthorityInput,
  request: LaunchResolutionInput,
): CodingRuntimeTrustedContext {
  const active = input.workspaceLifecycle.getActive();
  if (active?.instance.workspaceId !== request.workspaceId) invalidWorkspace();
  if (
    active.binding.activeRoot !== request.workspaceRoot ||
    !liveInstanceUsable(input, active.instance)
  ) {
    invalidWorkspace();
  }
  const head = input.readWorkspaceHead(request.workspaceRoot, active.instance.repositoryRoot);
  if (head === undefined || active.instance.lastVerifiedHead !== head) invalidWorkspace();
  return contextFromActive(request, active.instance, head);
}

function contextFromActive(
  request: LaunchResolutionInput,
  instance: WorkspaceInstance,
  head: string,
): CodingRuntimeTrustedContext {
  const branch = instance.taskBranch;
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
    deploymentCeiling: "autonomous-delivery",
    runtimeSource: "keiko-sidecar",
    actionClasses: ["workspace-read", "workspace-write", "verification"],
    connectorScopes: [],
    modelProfile: {
      profileId: "coding-safe-openai-compatible",
      source: "keiko-model-gateway",
      supportsStreaming: true,
      supportsToolCalling: true,
    },
    commandPolicy: {
      mode: "deny",
      allow: [],
      deny: [],
      maxCommandTimeoutMs: 1,
      requirePerCommandApproval: true,
    },
    // The sidecar's BFF gateway is server-owned transport, not delegated runtime network egress.
    networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] },
    gates: ["human-approval"],
    budget: {
      maxRuntimeMs: RUNTIME_TTL_MS,
      maxToolCalls: 256,
      maxPromptTokens: 200_000,
      maxPatchBytes: 262_144,
    },
    expiresAt: new Date(Date.now() + RUNTIME_TTL_MS).toISOString(),
  };
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
      workspaceRootDigest: productionWorkspaceDigest(context.workspaceRoot),
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
    const head = input.readWorkspaceHead(
      context.workspaceRoot,
      active?.instance.repositoryRoot ?? "",
    );
    return (
      active?.instance.workspaceId === context.workspaceId &&
      active.binding.activeRoot === context.workspaceRoot &&
      liveInstanceUsable(input, active.instance) &&
      head !== undefined &&
      digest(head) === context.branchHeadDigest
    );
  } catch {
    return false;
  }
}

export function trustedManagedWorkspaceRoot(root: string): boolean {
  try {
    return isAbsolute(root) && realpathSync(root) === root;
  } catch {
    return false;
  }
}

function liveInstanceUsable(
  input: ProductionWorkspaceAuthorityInput,
  instance: WorkspaceInstance,
): boolean {
  const managed = realpathSync(input.managedTaskWorkspaceRoot);
  const root = realpathSync(instance.managedWorktreePath);
  const rel = relative(managed, root);
  return (
    instance.lifecycleState === "active" &&
    instance.health === "healthy" &&
    instance.driftMarkers.length === 0 &&
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`)
  );
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
