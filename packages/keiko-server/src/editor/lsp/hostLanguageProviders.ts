import {
  DEFAULT_LSP_PROCESS_CONFIG,
  type LanguageProviderDescriptor,
  type LanguageServiceOperation,
} from "@oscharko-dev/keiko-contracts";
import { isCommandAllowed, type CommandRule } from "@oscharko-dev/keiko-tools";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { resolveExecutableOutsideWorkspace } from "./lspNodeAdapter.js";

export interface HostLanguageProviderSpec {
  readonly id: string;
  readonly label: string;
  readonly languages: readonly string[];
  readonly operations: readonly LanguageServiceOperation[];
  readonly executableName: string;
  readonly executableArgs: readonly string[];
  readonly requiredExecutables: readonly string[];
  readonly envAllowlist: readonly string[];
  readonly envFlag: string;
}

export interface HostLanguageProviderDetectionDeps {
  readonly workspace: WorkspaceInfo;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly commandRules: readonly CommandRule[];
  readonly specs?: readonly HostLanguageProviderSpec[] | undefined;
}

export const HOST_LSP_MISSING_REASON =
  "Required host language tool is missing or resolves inside the workspace." as const;
export const HOST_LSP_POLICY_BLOCKED_REASON =
  "Required host language tool is blocked by host execution policy." as const;
export const HOST_LSP_DISABLED_REASON = "Host language provider is disabled by policy." as const;

const DEFAULT_HOST_LSP_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  ...DEFAULT_LSP_PROCESS_CONFIG.envAllowlist,
  "TMPDIR",
  "TEMP",
  "TMP",
  "PYTHONPATH",
  "VIRTUAL_ENV",
  "GOMODCACHE",
  "GOCACHE",
  "GOPATH",
  "JAVA_HOME",
  "RUSTUP_HOME",
  "CARGO_HOME",
]);

export const HOST_LANGUAGE_PROVIDER_SPECS: readonly HostLanguageProviderSpec[] = Object.freeze([
  Object.freeze({
    id: "python-lsp",
    label: "Pyright",
    languages: Object.freeze(["python"]),
    operations: Object.freeze([
      "diagnostics",
      "completion",
      "hover",
      "symbols",
    ] as const satisfies readonly LanguageServiceOperation[]),
    executableName: "pyright-langserver",
    executableArgs: Object.freeze(["--stdio"]),
    requiredExecutables: Object.freeze(["pyright-langserver"]),
    envAllowlist: DEFAULT_HOST_LSP_ENV_ALLOWLIST,
    envFlag: "KEIKO_EDITOR_LSP_PYTHON",
  }),
  Object.freeze({
    id: "java-lsp",
    label: "Eclipse JDT LS",
    languages: Object.freeze(["java"]),
    operations: Object.freeze([
      "diagnostics",
      "completion",
      "hover",
      "symbols",
      "formatting",
    ] as const satisfies readonly LanguageServiceOperation[]),
    executableName: "jdtls",
    executableArgs: Object.freeze([]),
    requiredExecutables: Object.freeze(["java", "jdtls"]),
    envAllowlist: DEFAULT_HOST_LSP_ENV_ALLOWLIST,
    envFlag: "KEIKO_EDITOR_LSP_JAVA",
  }),
  Object.freeze({
    id: "go-lsp",
    label: "gopls",
    languages: Object.freeze(["go"]),
    operations: Object.freeze([
      "diagnostics",
      "completion",
      "hover",
      "symbols",
      "formatting",
    ] as const satisfies readonly LanguageServiceOperation[]),
    executableName: "gopls",
    executableArgs: Object.freeze([]),
    requiredExecutables: Object.freeze(["gopls"]),
    envAllowlist: DEFAULT_HOST_LSP_ENV_ALLOWLIST,
    envFlag: "KEIKO_EDITOR_LSP_GO",
  }),
  Object.freeze({
    id: "rust-lsp",
    label: "rust-analyzer",
    languages: Object.freeze(["rust"]),
    operations: Object.freeze([
      "diagnostics",
      "completion",
      "hover",
      "symbols",
      "formatting",
    ] as const satisfies readonly LanguageServiceOperation[]),
    executableName: "rust-analyzer",
    executableArgs: Object.freeze([]),
    requiredExecutables: Object.freeze(["rust-analyzer"]),
    envAllowlist: DEFAULT_HOST_LSP_ENV_ALLOWLIST,
    envFlag: "KEIKO_EDITOR_LSP_RUST",
  }),
  Object.freeze({
    id: "shell-lsp",
    label: "Bash Language Server",
    languages: Object.freeze(["shell"]),
    operations: Object.freeze([
      "diagnostics",
      "completion",
      "hover",
      "symbols",
    ] as const satisfies readonly LanguageServiceOperation[]),
    executableName: "bash-language-server",
    executableArgs: Object.freeze(["start"]),
    requiredExecutables: Object.freeze(["bash-language-server", "shellcheck"]),
    envAllowlist: DEFAULT_HOST_LSP_ENV_ALLOWLIST,
    envFlag: "KEIKO_EDITOR_LSP_SHELL",
  }),
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

function detectSpec(
  spec: HostLanguageProviderSpec,
  deps: HostLanguageProviderDetectionDeps,
): LanguageProviderDescriptor {
  if (!providerEnabled(spec, deps.processEnv)) {
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
