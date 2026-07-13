import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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
import { executableFixtureName, writeExecutableFixture } from "./testing/executableFixture.js";

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
  return writeExecutableFixture(dir, name);
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

  it("fails closed for the shell provider (entire provider unavailable) when only ShellCheck is missing", () => {
    const spec = HOST_LANGUAGE_PROVIDER_SPECS.find((entry) => entry.id === "shell-lsp");
    if (spec === undefined) throw new Error("expected shell provider spec");
    makeExecutable("bash-language-server");
    makeExecutable("node");

    const descriptor = detect(
      spec,
      spec.requiredExecutables.map((executable) => ({ executable })),
      { PATH: binDir, KEIKO_EDITOR_LSP_SHELL: "1" },
    );

    expect(descriptor.availability).toBe("unavailable");
    expect(descriptor.unavailableReason).toBe(HOST_LSP_MISSING_REASON);
    expect(descriptor.operations).toEqual(spec.operations);
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
    symlinkSync(target, join(binDir, executableFixtureName("pyright-langserver")));

    const descriptor = detect(spec, [{ executable: "pyright-langserver" }], {
      PATH: binDir,
      KEIKO_EDITOR_LSP_PYTHON: "1",
    });

    expect(descriptor.availability).toBe("unavailable");
    expect(descriptor.unavailableReason).toBe(HOST_LSP_MISSING_REASON);
  });

  it("does not treat a workspace-local secondary executable as available for the Java provider", () => {
    const spec = HOST_LANGUAGE_PROVIDER_SPECS.find((entry) => entry.id === "java-lsp");
    if (spec === undefined) throw new Error("expected java provider spec");
    makeExecutable("jdtls");
    makeExecutable("python3");
    makeExecutable("java", workspaceRoot);

    const descriptor = detect(
      spec,
      spec.requiredExecutables.map((executable) => ({ executable })),
      { PATH: `${binDir}${delimiter}${workspaceRoot}`, KEIKO_EDITOR_LSP_JAVA: "1" },
    );

    expect(descriptor.availability).toBe("unavailable");
    expect(descriptor.unavailableReason).toBe(HOST_LSP_MISSING_REASON);
  });

  it("does not treat a PATH symlink to a workspace executable as available for a Java secondary executable", () => {
    const spec = HOST_LANGUAGE_PROVIDER_SPECS.find((entry) => entry.id === "java-lsp");
    if (spec === undefined) throw new Error("expected java provider spec");
    makeExecutable("jdtls");
    const target = makeExecutable("inside-python3", workspaceRoot);
    symlinkSync(target, join(binDir, "python3"));
    makeExecutable("java");

    const descriptor = detect(
      spec,
      spec.requiredExecutables.map((executable) => ({ executable })),
      { PATH: binDir, KEIKO_EDITOR_LSP_JAVA: "1" },
    );

    expect(descriptor.availability).toBe("unavailable");
    expect(descriptor.unavailableReason).toBe(HOST_LSP_MISSING_REASON);
  });

  it("does not treat a workspace-local secondary executable as available for the Rust provider", () => {
    const spec = HOST_LANGUAGE_PROVIDER_SPECS.find((entry) => entry.id === "rust-lsp");
    if (spec === undefined) throw new Error("expected rust provider spec");
    makeExecutable("rust-analyzer");
    makeExecutable("rustc");
    makeExecutable("rustfmt");
    makeExecutable("cargo", workspaceRoot);

    const descriptor = detect(
      spec,
      spec.requiredExecutables.map((executable) => ({ executable })),
      { PATH: `${binDir}${delimiter}${workspaceRoot}`, KEIKO_EDITOR_LSP_RUST: "1" },
    );

    expect(descriptor.availability).toBe("unavailable");
    expect(descriptor.unavailableReason).toBe(HOST_LSP_MISSING_REASON);
  });

  it("does not treat a PATH symlink to a workspace executable as available for a Rust secondary executable", () => {
    const spec = HOST_LANGUAGE_PROVIDER_SPECS.find((entry) => entry.id === "rust-lsp");
    if (spec === undefined) throw new Error("expected rust provider spec");
    makeExecutable("rust-analyzer");
    makeExecutable("cargo");
    makeExecutable("rustfmt");
    const target = makeExecutable("inside-rustc", workspaceRoot);
    symlinkSync(target, join(binDir, "rustc"));

    const descriptor = detect(
      spec,
      spec.requiredExecutables.map((executable) => ({ executable })),
      { PATH: binDir, KEIKO_EDITOR_LSP_RUST: "1" },
    );

    expect(descriptor.availability).toBe("unavailable");
    expect(descriptor.unavailableReason).toBe(HOST_LSP_MISSING_REASON);
  });
});
