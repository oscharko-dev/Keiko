import { join } from "node:path";

import type {
  LanguageServiceOperation,
  ManagedLspShellConfiguration,
  ManagedLspShellCheckSettings,
} from "@oscharko-dev/keiko-contracts";

import type { HostLanguageProviderSpec } from "../hostLanguageProviders.js";

const SHELL_OPERATIONS: readonly LanguageServiceOperation[] = Object.freeze([
  "diagnostics",
  "completion",
  "hover",
  "symbols",
  "definition",
  "references",
] as const satisfies readonly LanguageServiceOperation[]);

const SHELL_ENV_ALLOWLIST = Object.freeze(["LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP"]);

export const SHELL_PROVIDER_SPEC: HostLanguageProviderSpec = Object.freeze({
  id: "shell-lsp",
  label: "Bash Language Server",
  languages: Object.freeze(["shell"]),
  operations: SHELL_OPERATIONS,
  executableName: "bash-language-server",
  executableArgs: Object.freeze(["start"]),
  requiredExecutables: Object.freeze(["bash-language-server", "node", "shellcheck"]),
  envAllowlist: SHELL_ENV_ALLOWLIST,
  fixedEnv: Object.freeze({ BASH_IDE_LOG_LEVEL: "error" }),
  approvedDescendantExecutables: Object.freeze(["node", "shellcheck"]),
  envFlag: "KEIKO_EDITOR_LSP_SHELL",
  semanticTokensCandidate: false,
});

export interface ShellProtocolConfiguration {
  readonly settings: Readonly<Record<string, unknown>>;
  readonly initializationOptions: Readonly<Record<string, unknown>>;
}

function shellCheckArguments(
  settings: ManagedLspShellCheckSettings,
  workspaceRoot: string,
): readonly string[] {
  return [
    `--severity=${settings.severity}`,
    ...(settings.excludedCodes.length === 0
      ? []
      : [`--exclude=${settings.excludedCodes.join(",")}`]),
    ...settings.includePaths.map((path) => `--source-path=${join(workspaceRoot, path.path)}`),
  ];
}

export function shellProtocolConfiguration(
  configuration: ManagedLspShellConfiguration,
  workspaceRoot: string,
): ShellProtocolConfiguration {
  const settings = configuration.settings;
  const shellCheckEnabled = settings.shellCheck.mode === "workspace";
  return {
    settings: {
      bashIde: {
        backgroundAnalysisMaxFiles: 0,
        enableSourceErrorDiagnostics: false,
        explainshellEndpoint: "",
        includeAllWorkspaceSymbols: false,
        logLevel: "error",
        shellcheckArguments: shellCheckEnabled
          ? shellCheckArguments(settings.shellCheck, workspaceRoot)
          : [],
        shellcheckExternalSources: false,
        shellcheckPath: shellCheckEnabled ? "shellcheck" : "",
        shfmt: {
          path: "",
          ignoreEditorconfig: true,
          languageDialect: settings.dialect,
        },
      },
    },
    initializationOptions: {},
  };
}
