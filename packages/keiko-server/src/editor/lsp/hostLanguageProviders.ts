import type {
  LanguageProviderDescriptor,
  LanguageServiceOperation,
} from "@oscharko-dev/keiko-contracts";
import { isCommandAllowed, type CommandRule } from "@oscharko-dev/keiko-tools";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { resolveExecutableOutsideWorkspace } from "./lspNodeAdapter.js";
import { GO_PROVIDER_SPEC } from "./providers/goProvider.js";
import { PYTHON_PROVIDER_SPEC } from "./providers/pythonProvider.js";
import { SHELL_PROVIDER_SPEC } from "./providers/shellProvider.js";
import { JAVA_PROVIDER_SPEC } from "./providers/javaProvider.js";
import { RUST_PROVIDER_SPEC } from "./providers/rustProvider.js";
import type { LspSpawnPrepareFn } from "./lspProcessManager.js";

export interface HostLanguageProviderSpec {
  readonly id: string;
  readonly label: string;
  readonly languages: readonly string[];
  readonly operations: readonly LanguageServiceOperation[];
  readonly executableName: string;
  readonly executableArgs: readonly string[];
  readonly requiredExecutables: readonly string[];
  readonly envAllowlist: readonly string[];
  readonly fixedEnv?: Readonly<Record<string, string>> | undefined;
  readonly approvedDescendantExecutables?: readonly string[] | undefined;
  readonly envFlag: string;
  readonly semanticTokensCandidate: boolean;
  readonly networkPolicy?: "inherit" | "none" | undefined;
  readonly prepareSpawn?: LspSpawnPrepareFn | undefined;
}

export interface HostLanguageProviderDetectionDeps {
  readonly workspace: WorkspaceInfo;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly commandRules: readonly CommandRule[];
  readonly specs?: readonly HostLanguageProviderSpec[] | undefined;
  readonly ignoreActivationFlag?: boolean | undefined;
}

export const HOST_LSP_MISSING_REASON =
  "Required host language tool is missing or resolves inside the workspace." as const;
export const HOST_LSP_POLICY_BLOCKED_REASON =
  "Required host language tool is blocked by host execution policy." as const;
export const HOST_LSP_DISABLED_REASON = "Host language provider is disabled by policy." as const;

export const HOST_LANGUAGE_PROVIDER_SPECS: readonly HostLanguageProviderSpec[] = Object.freeze([
  PYTHON_PROVIDER_SPEC,
  JAVA_PROVIDER_SPEC,
  GO_PROVIDER_SPEC,
  RUST_PROVIDER_SPEC,
  SHELL_PROVIDER_SPEC,
]);

function trueLike(value: string): boolean {
  return ["1", "true", "on", "yes", "enabled"].includes(value.trim().toLowerCase());
}

function providerEnabled(spec: HostLanguageProviderSpec, processEnv: NodeJS.ProcessEnv): boolean {
  const value = processEnv[spec.envFlag];
  return value !== undefined && trueLike(value);
}

function unavailableDescriptor(
  spec: HostLanguageProviderSpec,
  reason: string,
): LanguageProviderDescriptor {
  return {
    id: spec.id,
    languages: spec.languages,
    operations: spec.operations,
    availability: "unavailable",
    unavailableReason: reason,
  };
}

function availableDescriptor(spec: HostLanguageProviderSpec): LanguageProviderDescriptor {
  return {
    id: spec.id,
    languages: spec.languages,
    operations: spec.operations,
    availability: "available",
  };
}

function commandAllowed(
  commandRules: readonly CommandRule[],
  executable: string,
  args: readonly string[],
): boolean {
  return isCommandAllowed(commandRules, executable, args).allowed;
}

function requiredExecutableAvailable(
  executable: string,
  deps: HostLanguageProviderDetectionDeps,
): boolean {
  try {
    resolveExecutableOutsideWorkspace(executable, deps.workspace, deps.processEnv);
    return true;
  } catch {
    return false;
  }
}

export function defaultHostLanguageCommandRules(): readonly CommandRule[] {
  const names = new Set<string>();
  for (const spec of HOST_LANGUAGE_PROVIDER_SPECS) {
    names.add(spec.executableName);
    for (const executable of spec.requiredExecutables) names.add(executable);
  }
  return [...names]
    .sort((left, right) => left.localeCompare(right))
    .map((executable) => ({ executable }));
}

export function isHostLanguageProviderProvisioned(
  language: string,
  deps: Omit<HostLanguageProviderDetectionDeps, "specs">,
): boolean {
  const spec = HOST_LANGUAGE_PROVIDER_SPECS.find((candidate) =>
    candidate.languages.includes(language),
  );
  if (spec === undefined) return false;
  if (!commandAllowed(deps.commandRules, spec.executableName, spec.executableArgs)) return false;
  return spec.requiredExecutables.every(
    (executable) =>
      commandAllowed(deps.commandRules, executable, []) &&
      requiredExecutableAvailable(executable, deps),
  );
}

function detectSpec(
  spec: HostLanguageProviderSpec,
  deps: HostLanguageProviderDetectionDeps,
): LanguageProviderDescriptor {
  if (deps.ignoreActivationFlag !== true && !providerEnabled(spec, deps.processEnv)) {
    return unavailableDescriptor(spec, HOST_LSP_DISABLED_REASON);
  }
  if (!commandAllowed(deps.commandRules, spec.executableName, spec.executableArgs)) {
    return unavailableDescriptor(spec, HOST_LSP_POLICY_BLOCKED_REASON);
  }
  for (const executable of spec.requiredExecutables) {
    if (!commandAllowed(deps.commandRules, executable, [])) {
      return unavailableDescriptor(spec, HOST_LSP_POLICY_BLOCKED_REASON);
    }
    if (!requiredExecutableAvailable(executable, deps)) {
      return unavailableDescriptor(spec, HOST_LSP_MISSING_REASON);
    }
  }
  return availableDescriptor(spec);
}

export function detectHostLanguageProviderDescriptors(
  deps: HostLanguageProviderDetectionDeps,
): readonly LanguageProviderDescriptor[] {
  return (deps.specs ?? HOST_LANGUAGE_PROVIDER_SPECS).map((spec) => detectSpec(spec, deps));
}
