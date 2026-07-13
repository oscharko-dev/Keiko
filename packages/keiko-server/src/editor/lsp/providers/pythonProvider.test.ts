import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ManagedLspPythonConfiguration } from "@oscharko-dev/keiko-contracts";

import {
  PYTHON_PROVIDER_SPEC,
  detectPythonConfigurationPrecedence,
  pythonProtocolConfiguration,
  resolvePythonRuntimeIdentitySource,
} from "./pythonProvider.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-python-provider-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function configuration(rootEtag = '"lspcfg-2-abcdefghijklmnop"'): ManagedLspPythonConfiguration {
  return {
    schemaVersion: "1",
    language: "python",
    revision: 2,
    etag: rootEtag,
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
      typeCheckingMode: "strict",
      extraPaths: [{ kind: "workspaceRelative", path: "src/python" }],
      configurationPrecedence: ["workspaceConfiguration", "pyproject", "builtInDefault"],
    },
  };
}

describe("Python/Pyright managed provider", () => {
  it("uses operator-provisioned Pyright without ambient Python environment passthrough", () => {
    expect(PYTHON_PROVIDER_SPEC).toMatchObject({
      id: "python-lsp",
      executableName: "pyright-langserver",
      executableArgs: ["--stdio"],
      envFlag: "KEIKO_EDITOR_LSP_PYTHON",
    });
    expect(PYTHON_PROVIDER_SPEC.envAllowlist).not.toContain("PYTHONPATH");
    expect(PYTHON_PROVIDER_SPEC.envAllowlist).not.toContain("VIRTUAL_ENV");
  });

  it("declares the complete candidate family and relies on live negotiation to narrow it", () => {
    expect(PYTHON_PROVIDER_SPEC.operations).toEqual([
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
    ]);
  });

  it("maps only bounded workspace settings and never emits runtime ids or executable paths", () => {
    const protocol = pythonProtocolConfiguration(configuration());
    expect(protocol).toEqual({
      "python.analysis": {
        typeCheckingMode: "strict",
        extraPaths: ["src/python"],
        diagnosticMode: "openFilesOnly",
        autoSearchPaths: false,
        useLibraryCodeForTypes: true,
        logLevel: "Error",
      },
    });
    expect(JSON.stringify(protocol)).not.toContain("python-lsp");
    expect(JSON.stringify(protocol)).not.toContain("PYTHONPATH");
  });

  it("reports deterministic pyrightconfig then pyproject then workspace precedence", () => {
    const root = temporaryRoot();
    expect(detectPythonConfigurationPrecedence(root)).toBe("workspaceConfiguration");
    writeFileSync(join(root, "pyproject.toml"), "[tool.pyright]\ntypeCheckingMode='basic'\n");
    expect(detectPythonConfigurationPrecedence(root)).toBe("pyproject");
    writeFileSync(join(root, "pyrightconfig.json"), "{}\n");
    expect(detectPythonConfigurationPrecedence(root)).toBe("pyrightconfig");
  });

  it("ignores oversized, malformed, and workspace-escaping project configuration", () => {
    const root = temporaryRoot();
    const outside = join(temporaryRoot(), "outside.json");
    writeFileSync(outside, "{}\n");
    symlinkSync(outside, join(root, "pyrightconfig.json"));
    writeFileSync(join(root, "pyproject.toml"), "x".repeat(1_048_577));
    expect(detectPythonConfigurationPrecedence(root)).toBe("workspaceConfiguration");
  });

  it("deterministically prefers an approved venv over the bare interpreter identity", () => {
    const settings = configuration().settings;
    expect(resolvePythonRuntimeIdentitySource(settings)).toBe("interpreter");
    expect(
      resolvePythonRuntimeIdentitySource({
        ...settings,
        venv: { kind: "operatorApproved", runtimeId: "python-venv-lsp" },
      }),
    ).toBe("venv");
  });
});
