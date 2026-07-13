import { describe, expect, it } from "vitest";

import type { ManagedLspGoConfiguration } from "@oscharko-dev/keiko-contracts";

import { GO_PROVIDER_SPEC, goProtocolConfiguration } from "./goProvider.js";

function configuration(): ManagedLspGoConfiguration {
  return {
    schemaVersion: "1",
    language: "go",
    revision: 4,
    etag: '"lspcfg-4-abcdefghijklmnop"',
    activation: "enabled",
    runtime: { kind: "operatorApproved", runtimeId: "go-lsp" },
    provenance: {
      activation: "workspace",
      runtime: "operatorProvisioning",
      settings: "workspace",
    },
    restartRequired: false,
    restartFields: [],
    settings: {
      toolchain: { kind: "operatorApproved", runtimeId: "go-lsp" },
      staticcheck: true,
      buildTags: ["enterprise", "linuxonly"],
      buildFlags: { moduleMode: "vendor", trimPath: true },
      target: { goos: "linux", goarch: "amd64", minimumGoVersion: "1.24.0" },
      directoryFilters: [
        { kind: "include", path: { kind: "workspaceRelative", path: "cmd" } },
        { kind: "exclude", path: { kind: "workspaceRelative", path: "generated" } },
      ],
      workspaceModuleFile: { kind: "workspaceRelative", path: "go.work" },
      dependencyMode: "offline",
      moduleDownloads: false,
    },
  };
}

describe("Go/gopls managed provider", () => {
  it("forces an offline child environment without ambient Go caches or flags", () => {
    expect(GO_PROVIDER_SPEC).toMatchObject({
      id: "go-lsp",
      executableName: "gopls",
      fixedEnv: {
        CGO_ENABLED: "0",
        GOENV: "off",
        GOPROXY: "off",
        GOSUMDB: "off",
        GOTOOLCHAIN: "local",
        GOVCS: "off",
      },
    });
    expect(GO_PROVIDER_SPEC.envAllowlist).not.toEqual(
      expect.arrayContaining(["GOFLAGS", "GOPATH", "GOMODCACHE", "GOCACHE", "GOTOOLCHAIN"]),
    );
  });

  it("declares the full reviewed family and relies on live capability negotiation", () => {
    expect(GO_PROVIDER_SPEC.operations).toEqual([
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
    ]);
  });

  it("maps only reviewed gopls settings with deterministic build flags and offline defaults", () => {
    expect(goProtocolConfiguration(configuration(), "/workspace")).toEqual({
      settings: {
        gopls: {
          buildFlags: ["-tags=enterprise,linuxonly", "-mod=vendor", "-trimpath"],
          directoryFilters: ["+cmd", "-generated"],
          env: {
            CGO_ENABLED: "0",
            GOENV: "off",
            GOOS: "linux",
            GOARCH: "amd64",
            GOPROXY: "off",
            GOSUMDB: "off",
            GOTOOLCHAIN: "local",
            GOVCS: "off",
            GOWORK: "/workspace/go.work",
          },
          importsSource: "off",
          linksInHover: false,
          staticcheck: true,
          subdirWatchPatterns: "off",
          vulncheck: "Off",
        },
      },
      initializationOptions: { pullDiagnostics: true },
    });
  });

  it("changes build results deterministically when tags and module mode change", () => {
    const base = configuration();
    const changed: ManagedLspGoConfiguration = {
      ...base,
      settings: {
        ...base.settings,
        buildTags: [],
        buildFlags: { moduleMode: "readonly", trimPath: false },
      },
    };
    expect(goProtocolConfiguration(changed, "/workspace").settings).toMatchObject({
      gopls: { buildFlags: ["-mod=readonly"] },
    });
  });
});
