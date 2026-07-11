import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

import type {
  LanguageServiceOperation,
  ManagedLspPythonConfiguration,
} from "@oscharko-dev/keiko-contracts";
import { isWithinWorkspace } from "@oscharko-dev/keiko-workspace";

import type { HostLanguageProviderSpec } from "../hostLanguageProviders.js";

const MAX_PROJECT_CONFIGURATION_BYTES = 1_048_576;

const PYTHON_OPERATIONS: readonly LanguageServiceOperation[] = Object.freeze([
  "diagnostics",
  "completion",
  "hover",
  "symbols",
  "definition",
  "typeDefinition",
  "implementation",
  "references",
  "callHierarchy",
  "inlayHints",
  "renamePrepare",
  "renameApply",
  "codeActions",
  "signatureHelp",
] as const satisfies readonly LanguageServiceOperation[]);

const PYTHON_ENV_ALLOWLIST = Object.freeze([
  "PATH",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TEMP",
  "TMP",
]);

export const PYTHON_PROVIDER_SPEC: HostLanguageProviderSpec = Object.freeze({
  id: "python-lsp",
  label: "Pyright",
  languages: Object.freeze(["python"]),
  operations: PYTHON_OPERATIONS,
  executableName: "pyright-langserver",
  executableArgs: Object.freeze(["--stdio"]),
  requiredExecutables: Object.freeze(["pyright-langserver"]),
  envAllowlist: PYTHON_ENV_ALLOWLIST,
  envFlag: "KEIKO_EDITOR_LSP_PYTHON",
  semanticTokensCandidate: true,
});

export type PythonConfigurationPrecedence =
  "pyrightconfig" | "pyproject" | "workspaceConfiguration";

export function pythonProtocolConfiguration(
  configuration: ManagedLspPythonConfiguration,
): Readonly<Record<string, unknown>> {
  return {
    "python.analysis": {
      typeCheckingMode: configuration.settings.typeCheckingMode,
      extraPaths: configuration.settings.extraPaths.map(({ path }) => path),
      diagnosticMode: "openFilesOnly",
      autoSearchPaths: false,
      useLibraryCodeForTypes: true,
      logLevel: "Error",
    },
  };
}

export function detectPythonConfigurationPrecedence(root: string): PythonConfigurationPrecedence {
  if (safeContainedFile(root, "pyrightconfig.json") !== undefined) return "pyrightconfig";
  const pyproject = safeContainedFile(root, "pyproject.toml");
  return pyproject !== undefined && /^\s*\[tool\.pyright\]\s*$/mu.test(pyproject)
    ? "pyproject"
    : "workspaceConfiguration";
}

function safeContainedFile(root: string, relativePath: string): string | undefined {
  try {
    const realRoot = realpathSync(root);
    const realFile = realpathSync(join(realRoot, relativePath));
    if (!isWithinWorkspace(realRoot, realFile)) return undefined;
    const stat = statSync(realFile);
    if (!stat.isFile() || stat.size > MAX_PROJECT_CONFIGURATION_BYTES) return undefined;
    return readFileSync(realFile, "utf8");
  } catch {
    return undefined;
  }
}
