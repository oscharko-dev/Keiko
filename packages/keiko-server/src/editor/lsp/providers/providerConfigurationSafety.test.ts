import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ManagedLspPythonConfiguration } from "@oscharko-dev/keiko-contracts";

import { providerConfigurationPathsContained } from "./providerConfigurationSafety.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-provider-config-safety-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function configuration(path: string): ManagedLspPythonConfiguration {
  return {
    schemaVersion: "1",
    language: "python",
    revision: 1,
    etag: '"lspcfg-1-abcdefghijklmnop"',
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
      extraPaths: [{ kind: "workspaceRelative", path }],
      configurationPrecedence: ["workspaceConfiguration", "pyproject", "builtInDefault"],
    },
  };
}

describe("provider configuration path containment", () => {
  it("accepts existing workspace-contained paths", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "src"));
    expect(providerConfigurationPathsContained(root, configuration("src"))).toBe(true);
  });

  it("rejects missing paths and symlinks escaping the workspace", () => {
    const root = temporaryRoot();
    expect(providerConfigurationPathsContained(root, configuration("missing"))).toBe(false);
    const outside = temporaryRoot();
    symlinkSync(outside, join(root, "escaped"));
    expect(providerConfigurationPathsContained(root, configuration("escaped"))).toBe(false);
  });
});
