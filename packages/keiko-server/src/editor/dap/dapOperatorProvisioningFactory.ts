import { posix } from "node:path";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import type { CommandTaskCatalog } from "@oscharko-dev/keiko-contracts";
import { isCommandAllowed, type CommandRule } from "@oscharko-dev/keiko-tools";

import type { DapAdapterPreflightDeps } from "./dapNodeAdapter.js";
import type { DebugCapsulePlanBinding } from "./debugCapsulePlan.js";
import type { DebugLaunchCatalogDeps } from "./debugLaunchCatalog.js";
import type { DebugLaunchContextResolverDeps } from "./debugLaunchContext.js";
import type { DapProductionProvisioning } from "./dapProductionService.js";
import type { DapProcessStartInput } from "./dapProcessManager.js";
import type {
  DapOperatorProvisionedArtifact,
  DapOperatorProvisioningDocument,
} from "./dapOperatorProvisioning.js";

interface DapOperatorWorkspace {
  readonly root: string;
  readonly projectId: string;
  readonly trusted: boolean;
}

export interface DapOperatorProvisioningFactoryOptions {
  readonly document: DapOperatorProvisioningDocument;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly fs: WorkspaceFs;
  readonly discover: (projectId: string) => CommandTaskCatalog;
  readonly workspaceForPartition: (partition: string) => DapOperatorWorkspace | undefined;
  readonly workspaceForRoot: (root: string) => DapOperatorWorkspace | undefined;
}

function unavailableWorkspace(): never {
  throw new Error("INVALID_DEBUG_WORKSPACE_BINDING");
}

// ADR-0136 D4 "require command-rule approval" — an independent, argv-inspecting Layer-1 check.
// Deliberately NOT derived from debug-launch-policy.ts's structureAllowed()/expectedArgs(): if a
// future change ever loosens that exact-match Layer-2 comparison, this hand-authored CommandRule
// denylist still blocks the argv shapes that load or execute code outside the closed launch plan.
// Mirrors terminal-policy.ts's isTerminalCommandAllowed, which composes the shared isCommandAllowed
// as its own independent layer ahead of a per-command flag policy.
const DEBUG_LAUNCH_DENIED_FLAGS: readonly string[] = Object.freeze([
  // node: flags that load or execute code beyond the closed single-target/npm-run launch shape.
  "--require",
  "-r",
  "--eval",
  "-e",
  "--print",
  "-p",
  "--loader",
  "--experimental-loader",
  "--import",
  "--inspect",
  "--inspect-brk",
  "--inspect-port",
  // npm (invoked here as a node target for the catalog launch): flags that run an arbitrary shell
  // command or widen scope beyond the fixed, reviewed tuple (ADR-0018 S-H2 class of flag).
  "-c",
  "--call",
  "--prefix",
  "--global",
  "-g",
]);

function debugLaunchCommandRules(nodeCapsulePath: string): readonly CommandRule[] {
  return Object.freeze([
    { executable: posix.basename(nodeCapsulePath), denyFlags: DEBUG_LAUNCH_DENIED_FLAGS },
  ]);
}

// Builds the production Layer-1 callback: independent of Layer-2's exact-match pinning, it
// resolves its own CommandRule allowlist from the already-approved node capsule identity and then
// inspects the full argv for denied flags via the shared isCommandAllowed decision function.
function debugLaunchCommandApproved(
  nodeCapsulePath: string,
): (executable: string, args: readonly string[]) => boolean {
  const rules = debugLaunchCommandRules(nodeCapsulePath);
  return (executable, args): boolean =>
    isCommandAllowed(rules, posix.basename(executable), args).allowed;
}

function artifact(value: DapOperatorProvisionedArtifact): DapOperatorProvisionedArtifact {
  return value;
}

function workspaceForBinding(
  options: DapOperatorProvisioningFactoryOptions,
  binding: DebugCapsulePlanBinding,
): DapOperatorWorkspace {
  return options.workspaceForPartition(binding.workspacePartitionKey) ?? unavailableWorkspace();
}

function targetCatalog(
  options: DapOperatorProvisioningFactoryOptions,
  root: string,
): DebugLaunchCatalogDeps {
  const workspace = options.workspaceForRoot(root) ?? unavailableWorkspace();
  return {
    workspaceRoot: workspace.root,
    projectId: workspace.projectId,
    workspaceTrusted: workspace.trusted,
    fs: options.fs,
    discover: options.discover,
  };
}

function launchContext(
  options: DapOperatorProvisioningFactoryOptions,
  binding: DebugCapsulePlanBinding,
): Omit<DebugLaunchContextResolverDeps, "backendQualification"> {
  const workspace = workspaceForBinding(options, binding);
  const launch = options.document.launch;
  return {
    ...targetCatalog(options, workspace.root),
    adapterApprovedRoot: launch.adapterApprovedRoot,
    node: artifact(launch.node),
    npm: artifact(launch.npm),
    shell: artifact(launch.shell),
    npmUserConfig: artifact(launch.npmUserConfig),
    npmGlobalConfig: artifact(launch.npmGlobalConfig),
    backend: artifact(launch.backend),
    runtimeClosure: launch.runtimeClosure.map(artifact),
    platform: process.platform,
    layer1Allowed: debugLaunchCommandApproved(launch.node.capsulePath),
    ...(launch.containerImage === undefined ? {} : { containerImage: launch.containerImage }),
  };
}

function adapterPreflight(
  options: DapOperatorProvisioningFactoryOptions,
  partition: string,
): DapAdapterPreflightDeps {
  const workspace = options.workspaceForPartition(partition) ?? unavailableWorkspace();
  const adapter = options.document.adapter;
  return {
    workspaceRoot: workspace.root,
    // Resolution is restricted to the operator-declared path before the independent trusted-root
    // check. The ambient service PATH must not influence either adapter discovery or preflight.
    processEnv: { ...options.processEnv, PATH: adapter.approvedPath },
    approvedPath: adapter.approvedPath,
    commandAllowed: (executable, args): boolean =>
      executable === adapter.executableName &&
      args.length === adapter.executableArgs.length &&
      args.every((value, index) => value === adapter.executableArgs[index]),
  };
}

/** Converts a validated declarative operator document into server-owned DAP function ports. */
export function createDapOperatorProvisioning(
  options: DapOperatorProvisioningFactoryOptions,
): DapProductionProvisioning {
  const adapter = options.document.adapter;
  return Object.freeze({
    adapter: {
      executableName: adapter.executableName,
      executableArgs: adapter.executableArgs,
      trustedRoots: adapter.trustedRoots,
      provisioningDigest: adapter.provisioningDigest,
      envAllowlist: adapter.envAllowlist,
      fixedEnv: adapter.fixedEnv,
    },
    backendQualification: Object.freeze({
      backend: artifact(options.document.launch.backend),
      platform: process.platform,
    }),
    adapterPreflight: (identity: DapProcessStartInput["identity"]) =>
      adapterPreflight(options, identity.workspacePartitionKey),
    launchContext: (binding: DebugCapsulePlanBinding) => launchContext(options, binding),
    targetCatalog: (root: string) => targetCatalog(options, root),
  });
}
