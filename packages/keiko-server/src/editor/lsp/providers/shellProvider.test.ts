import { describe, expect, it } from "vitest";

import type { ManagedLspShellConfiguration } from "@oscharko-dev/keiko-contracts";

import { SHELL_PROVIDER_SPEC, shellProtocolConfiguration } from "./shellProvider.js";

function configuration(mode: "disabled" | "workspace"): ManagedLspShellConfiguration {
  return {
    schemaVersion: "1",
    language: "shell",
    revision: 2,
    etag: '"lspcfg-2-abcdefghijklmnop"',
    activation: "enabled",
    runtime: { kind: "operatorApproved", runtimeId: "shell-lsp" },
    provenance: {
      activation: "workspace",
      runtime: "operatorProvisioning",
      settings: "workspace",
    },
    restartRequired: false,
    restartFields: [],
    settings: {
      dialect: "bash",
      sourcePolicy: "workspaceOnly",
      shellCheck: {
        mode,
        severity: "warning",
        excludedCodes: ["SC1090", "SC1091"],
        includePaths: [{ kind: "workspaceRelative", path: "scripts/lib" }],
        externalSources: false,
      },
    },
  };
}

describe("managed Bash Language Server provider", () => {
  it("advertises only tested read-only operations and isolates descendants", () => {
    expect(SHELL_PROVIDER_SPEC.operations).toEqual([
      "diagnostics",
      "completion",
      "hover",
      "symbols",
      "definition",
      "references",
    ]);
    expect(SHELL_PROVIDER_SPEC.operations).not.toContain("formatting");
    expect(SHELL_PROVIDER_SPEC.operations).not.toContain("renameApply");
    expect(SHELL_PROVIDER_SPEC.approvedDescendantExecutables).toEqual(["node", "shellcheck"]);
    expect(SHELL_PROVIDER_SPEC.envAllowlist).not.toContain("PATH");
  });

  it("maps bounded workspace-only ShellCheck settings and disables every network/formatter seam", () => {
    const result = shellProtocolConfiguration(configuration("workspace"), "/workspace");

    expect(result.settings).toEqual({
      bashIde: {
        backgroundAnalysisMaxFiles: 0,
        enableSourceErrorDiagnostics: false,
        explainshellEndpoint: "",
        includeAllWorkspaceSymbols: false,
        logLevel: "error",
        shellcheckArguments: [
          "--shell=bash",
          "--severity=warning",
          "--exclude=SC1090,SC1091",
          "--source-path=/workspace/scripts/lib",
        ],
        shellcheckExternalSources: false,
        shellcheckPath: "shellcheck",
        shfmt: { path: "", ignoreEditorconfig: true, languageDialect: "bash" },
      },
    });
  });

  it("removes ShellCheck from configuration when diagnostics are disabled", () => {
    const result = shellProtocolConfiguration(configuration("disabled"), "/workspace");

    expect(result.settings).toMatchObject({
      bashIde: { shellcheckArguments: [], shellcheckPath: "", shellcheckExternalSources: false },
    });
  });

  it("forwards the governed dialect to ShellCheck as a --shell override", () => {
    const posixConfig: ManagedLspShellConfiguration = {
      ...configuration("workspace"),
      settings: { ...configuration("workspace").settings, dialect: "posix" },
    };

    const result = shellProtocolConfiguration(posixConfig, "/workspace");

    expect(result.settings).toMatchObject({
      bashIde: { shellcheckArguments: expect.arrayContaining(["--shell=sh"]) as unknown },
    });
  });
});
