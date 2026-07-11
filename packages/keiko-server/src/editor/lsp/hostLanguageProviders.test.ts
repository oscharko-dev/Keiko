import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CommandRule } from "@oscharko-dev/keiko-tools";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import {
  detectHostLanguageProviderDescriptors,
  HOST_LANGUAGE_PROVIDER_SPECS,
  HOST_LSP_DISABLED_REASON,
  HOST_LSP_MISSING_REASON,
  HOST_LSP_POLICY_BLOCKED_REASON,
  type HostLanguageProviderSpec,
} from "./hostLanguageProviders.js";

let binDir = "";
let workspaceRoot = "";

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "keiko-host-lsp-bin-"));
  workspaceRoot = mkdtempSync(join(tmpdir(), "keiko-host-lsp-ws-"));
});

afterEach(() => {
  rmSync(binDir, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function workspace(root = workspaceRoot): WorkspaceInfo {
  return {
    root,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

function makeExecutable(name: string, dir = binDir): string {
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\n", "utf8");
  chmodSync(path, 0o755);
  return path;
}

function detect(
  spec: HostLanguageProviderSpec,
  rules: readonly CommandRule[] = [{ executable: spec.executableName }],
  env: NodeJS.ProcessEnv = { PATH: binDir },
): ReturnType<typeof detectHostLanguageProviderDescriptors>[number] {
  const [descriptor] = detectHostLanguageProviderDescriptors({
    workspace: workspace(),
    processEnv: env,
    commandRules: rules,
    specs: [spec],
  });
  if (descriptor === undefined) throw new Error("expected descriptor");
  return descriptor;
}

describe("detectHostLanguageProviderDescriptors", () => {
  it("reports an available descriptor when the executable is allowlisted and resolves outside the workspace", () => {
    const spec = HOST_LANGUAGE_PROVIDER_SPECS.find((entry) => entry.id === "python-lsp");
    if (spec === undefined) throw new Error("expected python provider spec");
    makeExecutable("pyright-langserver");

    const descriptor = detect(spec, [{ executable: "pyright-langserver" }], {
      PATH: binDir,
      KEIKO_EDITOR_LSP_PYTHON: "enabled",
    });

    expect(descriptor).toMatchObject({
      id: "python-lsp",
      languages: ["python"],
      availability: "available",
    });
    expect(descriptor.operations).toEqual(spec.operations);
    expect(descriptor.unavailableReason).toBeUndefined();
  });

  it("reports missing when the required executable is absent", () => {
    const spec = HOST_LANGUAGE_PROVIDER_SPECS.find((entry) => entry.id === "go-lsp");
    if (spec === undefined) throw new Error("expected go provider spec");

    const descriptor = detect(spec, [{ executable: "gopls" }], {
      PATH: binDir,
      KEIKO_EDITOR_LSP_GO: "1",
    });

    expect(descriptor.availability).toBe("unavailable");
    expect(descriptor.unavailableReason).toBe(HOST_LSP_MISSING_REASON);
  });

  it("reports policy-blocked when the command rule does not allow the provider executable", () => {
    const spec = HOST_LANGUAGE_PROVIDER_SPECS.find((entry) => entry.id === "rust-lsp");
    if (spec === undefined) throw new Error("expected rust provider spec");
    makeExecutable("rust-analyzer");

    const descriptor = detect(spec, [], { PATH: binDir, KEIKO_EDITOR_LSP_RUST: "true" });

    expect(descriptor.availability).toBe("unavailable");
    expect(descriptor.unavailableReason).toBe(HOST_LSP_POLICY_BLOCKED_REASON);
  });

  it("reports disabled when the per-provider policy flag is false-like", () => {
    const spec = HOST_LANGUAGE_PROVIDER_SPECS.find((entry) => entry.id === "python-lsp");
    if (spec === undefined) throw new Error("expected python provider spec");
    makeExecutable("pyright-langserver");

    const descriptor = detect(spec, [{ executable: "pyright-langserver" }], {
      PATH: binDir,
      KEIKO_EDITOR_LSP_PYTHON: "off",
    });

    expect(descriptor.availability).toBe("unavailable");
    expect(descriptor.unavailableReason).toBe(HOST_LSP_DISABLED_REASON);
  });

  it("reports disabled when the per-provider policy flag is absent", () => {
    const spec = HOST_LANGUAGE_PROVIDER_SPECS.find((entry) => entry.id === "python-lsp");
    if (spec === undefined) throw new Error("expected python provider spec");
    makeExecutable("pyright-langserver");

    const descriptor = detect(spec);

    expect(descriptor.availability).toBe("unavailable");
    expect(descriptor.unavailableReason).toBe(HOST_LSP_DISABLED_REASON);
  });

  it("does not treat a workspace-local executable as available", () => {
    const spec = HOST_LANGUAGE_PROVIDER_SPECS.find((entry) => entry.id === "python-lsp");
    if (spec === undefined) throw new Error("expected python provider spec");
    makeExecutable("pyright-langserver", workspaceRoot);

    const descriptor = detect(spec, [{ executable: "pyright-langserver" }], {
      PATH: workspaceRoot,
      KEIKO_EDITOR_LSP_PYTHON: "1",
    });

    expect(descriptor.availability).toBe("unavailable");
    expect(descriptor.unavailableReason).toBe(HOST_LSP_MISSING_REASON);
  });

  it("does not treat a PATH symlink to a workspace executable as available", () => {
    const spec = HOST_LANGUAGE_PROVIDER_SPECS.find((entry) => entry.id === "python-lsp");
    if (spec === undefined) throw new Error("expected python provider spec");
    const target = makeExecutable("inside-pyright", workspaceRoot);
    symlinkSync(target, join(binDir, "pyright-langserver"));

    const descriptor = detect(spec, [{ executable: "pyright-langserver" }], {
      PATH: binDir,
      KEIKO_EDITOR_LSP_PYTHON: "1",
    });

    expect(descriptor.availability).toBe("unavailable");
    expect(descriptor.unavailableReason).toBe(HOST_LSP_MISSING_REASON);
  });
});
