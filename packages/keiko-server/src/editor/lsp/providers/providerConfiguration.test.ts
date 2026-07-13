import { describe, expect, it } from "vitest";

import type {
  ManagedLspPythonConfiguration,
  ManagedLspRustConfiguration,
} from "@oscharko-dev/keiko-contracts";

import { managedProviderProtocolConfiguration } from "./providerConfiguration.js";

describe("managed provider protocol configuration", () => {
  it("projects Python through the provider-owned safe adapter", () => {
    const configuration: ManagedLspPythonConfiguration = {
      schemaVersion: "1",
      language: "python",
      revision: 7,
      etag: '"lspcfg-7-abcdefghijklmnop"',
      activation: "enabled",
      runtime: { kind: "operatorApproved", runtimeId: "python-lsp" },
      provenance: {
        activation: "workspace",
        runtime: "operatorProvisioning",
        settings: "workspace",
      },
      restartRequired: false,
      restartFields: [],
      settings: {
        interpreter: { kind: "operatorApproved", runtimeId: "python-lsp" },
        venv: null,
        typeCheckingMode: "basic",
        extraPaths: [],
        configurationPrecedence: ["workspaceConfiguration", "pyproject", "builtInDefault"],
      },
    };
    expect(managedProviderProtocolConfiguration(configuration, "/workspace")).toEqual({
      revision: 7,
      initializationOptions: {},
      settings: {
        "python.analysis": {
          typeCheckingMode: "basic",
          extraPaths: [],
          diagnosticMode: "openFilesOnly",
          autoSearchPaths: false,
          useLibraryCodeForTypes: true,
          logLevel: "Error",
        },
      },
    });
  });

  it("projects Rust through the provider-owned offline adapter and preserves manager budgets", () => {
    const configuration: ManagedLspRustConfiguration = {
      schemaVersion: "1",
      language: "rust",
      revision: 8,
      etag: '"lspcfg-8-abcdefghijklmnop"',
      activation: "enabled",
      runtime: { kind: "operatorApproved", runtimeId: "rust-lsp" },
      provenance: {
        activation: "workspace",
        runtime: "operatorProvisioning",
        settings: "workspace",
      },
      restartRequired: false,
      restartFields: [],
      settings: {
        toolchain: { kind: "operatorApproved", runtimeId: "rust-lsp" },
        features: [],
        target: null,
        cfgs: [],
        noDefaultFeatures: true,
        linkedProjects: [{ kind: "workspaceRelative", path: "Cargo.toml" }],
        sysrootPolicy: "disabled",
        resourceBudget: {
          maxProjectFiles: 2_000,
          maxCargoMetadataBytes: 4_194_304,
          maxMemoryMb: 512,
          indexDeadlineMs: 15_000,
        },
        cargoMetadata: "disabled",
        dependencyDownloads: false,
        procMacros: false,
        buildScripts: false,
      },
    };

    const result = managedProviderProtocolConfiguration(configuration, "/workspace");
    expect(result).toMatchObject({
      revision: 8,
      settings: {
        "rust-analyzer": {
          cargo: { buildScripts: { enable: false }, noDeps: true },
          linkedProjects: [],
          checkOnSave: false,
          procMacro: { enable: false },
        },
      },
      resourceBudget: {
        maxFiles: 2_000,
        maxBytes: 4_194_304,
        maxMemoryMb: 512,
        indexDeadlineMs: 15_000,
      },
    });
  });
});
