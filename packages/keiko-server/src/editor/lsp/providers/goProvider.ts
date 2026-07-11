import { join } from "node:path";

import type {
  LanguageServiceOperation,
  ManagedLspGoConfiguration,
} from "@oscharko-dev/keiko-contracts";

import type { HostLanguageProviderSpec } from "../hostLanguageProviders.js";

const GO_OPERATIONS: readonly LanguageServiceOperation[] = Object.freeze([
  "diagnostics",
  "completion",
  "hover",
  "symbols",
  "formatting",
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

const GO_ENV_ALLOWLIST = Object.freeze([
  "PATH",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TEMP",
  "TMP",
]);

export const GO_OFFLINE_ENV = Object.freeze({
  GOENV: "off",
  GOPROXY: "off",
  GOSUMDB: "off",
  GOTOOLCHAIN: "local",
  GOVCS: "off",
});

export const GO_PROVIDER_SPEC: HostLanguageProviderSpec = Object.freeze({
  id: "go-lsp",
  label: "gopls",
  languages: Object.freeze(["go"]),
  operations: GO_OPERATIONS,
  executableName: "gopls",
  executableArgs: Object.freeze([]),
  requiredExecutables: Object.freeze(["gopls"]),
  envAllowlist: GO_ENV_ALLOWLIST,
  fixedEnv: GO_OFFLINE_ENV,
  envFlag: "KEIKO_EDITOR_LSP_GO",
  semanticTokensCandidate: true,
});

export interface GoProtocolConfiguration {
  readonly settings: Readonly<Record<string, unknown>>;
  readonly initializationOptions: Readonly<Record<string, unknown>>;
}

export function goProtocolConfiguration(
  configuration: ManagedLspGoConfiguration,
  workspaceRoot: string,
): GoProtocolConfiguration {
  const settings = configuration.settings;
  return {
    settings: {
      gopls: {
        buildFlags: buildFlags(configuration),
        directoryFilters: settings.directoryFilters.map(
          (filter) => `${filter.kind === "include" ? "+" : "-"}${filter.path.path}`,
        ),
        env: {
          ...GO_OFFLINE_ENV,
          GOOS: settings.target.goos,
          GOARCH: settings.target.goarch,
          ...(settings.workspaceModuleFile === undefined
            ? {}
            : { GOWORK: join(workspaceRoot, settings.workspaceModuleFile.path) }),
        },
        importsSource: "off",
        linksInHover: false,
        staticcheck: settings.staticcheck,
        subdirWatchPatterns: "off",
        vulncheck: "Off",
      },
    },
    initializationOptions: { pullDiagnostics: true },
  };
}

function buildFlags(configuration: ManagedLspGoConfiguration): readonly string[] {
  const { buildTags, buildFlags } = configuration.settings;
  return [
    ...(buildTags.length === 0 ? [] : [`-tags=${buildTags.join(",")}`]),
    `-mod=${buildFlags.moduleMode}`,
    ...(buildFlags.trimPath ? ["-trimpath"] : []),
  ];
}
