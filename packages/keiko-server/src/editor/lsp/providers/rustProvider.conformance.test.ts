import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_LSP_PROCESS_CONFIG,
  type ManagedLspRustConfiguration,
  type WorkspaceInfo,
} from "@oscharko-dev/keiko-contracts";
import type { BackendAvailability } from "@oscharko-dev/keiko-sandbox";

import type { LspSpawnFn } from "../lspNodeAdapter.js";
import { createLspProcessManager, type LspProcessManager } from "../lspProcessManager.js";
import { createFakeLspProcess, type FakeLspController } from "../testing/fakeLspProcess.js";
import { providerConformanceResults } from "../testing/providerConformanceFixture.js";
import {
  RUST_OFFLINE_ENV,
  RUST_PROVIDER_SPEC,
  prepareRustSpawn,
  rustProtocolConfiguration,
} from "./rustProvider.js";

const NATIVE: BackendAvailability = {
  bubblewrap: true,
  unshare: false,
  seatbelt: false,
  docker: false,
  podman: false,
};
const REQUEST_METHODS = Object.freeze([
  "textDocument/diagnostic",
  "textDocument/completion",
  "textDocument/hover",
  "textDocument/documentSymbol",
  "textDocument/formatting",
  "textDocument/definition",
  "textDocument/typeDefinition",
  "textDocument/implementation",
  "textDocument/references",
  "textDocument/prepareCallHierarchy",
  "callHierarchy/incomingCalls",
  "callHierarchy/outgoingCalls",
  "textDocument/inlayHint",
  "textDocument/prepareRename",
  "textDocument/rename",
  "textDocument/codeAction",
  "textDocument/signatureHelp",
]);
let binDir = "";
let root = "";

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "keiko-rust-bin-"));
  root = mkdtempSync(join(tmpdir(), "keiko-rust-workspace-"));
  for (const name of ["cargo", "rust-analyzer", "rustc", "rustfmt"]) makeExecutable(name);
  writeFileSync(join(root, "Cargo.toml"), "[package]\nname='safe'\nversion='0.1.0'\n");
  writeFileSync(join(root, "lib.rs"), "pub fn value() -> u8 { 1 }\n");
});

afterEach(() => {
  rmSync(binDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function makeExecutable(name: string): void {
  const path = join(binDir, name);
  writeFileSync(path, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  chmodSync(path, 0o755);
}

function workspace(): WorkspaceInfo {
  return {
    root,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: ["rust"],
    ignoreLines: [],
  };
}

function configuration(): ManagedLspRustConfiguration {
  return {
    schemaVersion: "1",
    language: "rust",
    revision: 9,
    etag: '"lspcfg-9-abcdefghijklmnop"',
    activation: "enabled",
    runtime: { kind: "operatorApproved", runtimeId: "rust-analyzer-2026-07-06" },
    provenance: { activation: "workspace", runtime: "operatorProvisioning", settings: "workspace" },
    restartRequired: false,
    restartFields: [],
    settings: {
      toolchain: { kind: "operatorApproved", runtimeId: "rust-1.97.0" },
      features: [],
      target: null,
      cfgs: [],
      noDefaultFeatures: true,
      linkedProjects: [{ kind: "workspaceRelative", path: "Cargo.toml" }],
      sysrootPolicy: "disabled",
      resourceBudget: {
        maxProjectFiles: 1_000,
        maxCargoMetadataBytes: 1_000_000,
        maxMemoryMb: 512,
        indexDeadlineMs: 10_000,
      },
      cargoMetadata: "offline",
      dependencyDownloads: false,
      procMacros: false,
      buildScripts: false,
    },
  };
}

function initializeResult(): unknown {
  return {
    capabilities: {
      textDocumentSync: 2,
      diagnosticProvider: true,
      completionProvider: {},
      hoverProvider: true,
      documentSymbolProvider: true,
      documentFormattingProvider: true,
      definitionProvider: true,
      typeDefinitionProvider: true,
      implementationProvider: true,
      referencesProvider: true,
      callHierarchyProvider: true,
      inlayHintProvider: true,
      renameProvider: { prepareProvider: true },
      codeActionProvider: true,
      signatureHelpProvider: {},
      semanticTokensProvider: { full: true, legend: { tokenTypes: [], tokenModifiers: [] } },
    },
  };
}

function manager(controller: FakeLspController): LspProcessManager {
  const protocol = rustProtocolConfiguration(configuration());
  const spawn: LspSpawnFn = (_executable, _args, env) => {
    childEnvironment = env;
    return controller.handle;
  };
  return createLspProcessManager({
    config: {
      ...DEFAULT_LSP_PROCESS_CONFIG,
      managerId: RUST_PROVIDER_SPEC.id,
      executableName: RUST_PROVIDER_SPEC.executableName,
      executableArgs: RUST_PROVIDER_SPEC.executableArgs,
      envAllowlist: RUST_PROVIDER_SPEC.envAllowlist,
      networkPolicy: "none",
    },
    workspace: workspace(),
    processEnv: hostileProcessEnvironment(),
    fixedEnv: RUST_OFFLINE_ENV,
    approvedDescendantExecutables: RUST_PROVIDER_SPEC.approvedDescendantExecutables,
    commandRules: RUST_PROVIDER_SPEC.requiredExecutables.map((executable) => ({ executable })),
    spawn,
    prepareSpawn: (input) =>
      prepareRustSpawn(input, {
        availability: NATIVE,
        platform: "linux",
        resolveExecutable: () => "/usr/bin/bwrap",
      }),
    protocol: {
      language: "rust",
      candidateOperations: RUST_PROVIDER_SPEC.operations,
      semanticTokensCandidate: true,
      configurationRevision: configuration().revision,
      configuration: protocol.settings,
      initializationOptions: protocol.initializationOptions,
      resourceBudget: protocol.resourceBudget,
    },
  });
}

let childEnvironment: Readonly<Record<string, string>> = {};

function hostileProcessEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: binDir,
    HOME: root,
    CARGO_HOME: root,
    RUSTUP_HOME: root,
    RUSTC_WRAPPER: join(root, "payload"),
    CARGO_TARGET_DIR: join(root, "target"),
  };
}

describe("rust-analyzer fake-protocol security conformance", () => {
  it("negotiates and serves the complete candidate surface without ambient authority", async () => {
    const messages: { method: string; params: unknown }[] = [];
    const original = readFileSync(join(root, "lib.rs"), "utf8");
    const controller = createFakeLspProcess({
      initializeResult: initializeResult(),
      results: providerConformanceResults(join(root, "lib.rs"), true),
      onMessage: (method, params): void => {
        messages.push({ method, params });
      },
    });
    const processManager = manager(controller);
    await expect.poll(() => processManager.getLspProcessStatus()).toBe("READY");

    for (const method of REQUEST_METHODS) {
      await expect(
        processManager.sendRequest(method, {}, new AbortController().signal),
      ).resolves.not.toBeUndefined();
    }

    expect(processManager.getNegotiatedCapabilities()).toMatchObject({
      candidateOperations: RUST_PROVIDER_SPEC.operations,
      negotiatedOperations: [...RUST_PROVIDER_SPEC.operations].sort(),
      semanticTokens: { supported: true, legendVersion: 1 },
    });
    expect(childEnvironment).toMatchObject(RUST_OFFLINE_ENV);
    for (const inherited of ["HOME", "RUSTC_WRAPPER"]) {
      expect(childEnvironment).not.toHaveProperty(inherited);
    }
    const runtimeRoot = dirname(childEnvironment.CARGO_HOME ?? "");
    for (const name of [
      "CARGO_HOME",
      "RUSTUP_HOME",
      "CARGO_TARGET_DIR",
      "XDG_CACHE_HOME",
      "TMPDIR",
      "TMP",
      "TEMP",
    ]) {
      const path = childEnvironment[name];
      expect(path).toBeDefined();
      expect(path?.startsWith(root)).toBe(false);
    }
    expect(privateToolNames(childEnvironment.PATH)).toEqual(["cargo", "rustc", "rustfmt"]);
    expect(readFileSync(join(root, "lib.rs"), "utf8")).toBe(original);
    expect(existsSync(join(root, "payload-ran"))).toBe(false);
    expect(messages.some(({ method }) => method === "workspace/executeCommand")).toBe(false);

    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      processManager.sendRequest("textDocument/hover", {}, cancelled.signal),
    ).rejects.toMatchObject({
      code: "CANCELLED",
    });
    await processManager.dispose();
    expect(existsSync(runtimeRoot)).toBe(false);
  });

  it("recovers through the bounded shared crash supervisor with a fresh fake process", async () => {
    const controllers: FakeLspController[] = [];
    const spawn: LspSpawnFn = () => {
      const controller = createFakeLspProcess({ initializeResult: initializeResult() });
      controllers.push(controller);
      return controller.handle;
    };
    const protocol = rustProtocolConfiguration(configuration());
    const processManager = createLspProcessManager({
      config: {
        ...DEFAULT_LSP_PROCESS_CONFIG,
        managerId: RUST_PROVIDER_SPEC.id,
        executableName: RUST_PROVIDER_SPEC.executableName,
        executableArgs: [],
        envAllowlist: RUST_PROVIDER_SPEC.envAllowlist,
        networkPolicy: "none",
      },
      workspace: workspace(),
      processEnv: hostileProcessEnvironment(),
      fixedEnv: RUST_OFFLINE_ENV,
      approvedDescendantExecutables: RUST_PROVIDER_SPEC.approvedDescendantExecutables,
      commandRules: RUST_PROVIDER_SPEC.requiredExecutables.map((executable) => ({ executable })),
      spawn,
      prepareSpawn: (input) => ({ ...input, executable: "/usr/bin/true" }),
      protocol: {
        language: "rust",
        candidateOperations: RUST_PROVIDER_SPEC.operations,
        semanticTokensCandidate: true,
        configurationRevision: 9,
        configuration: protocol.settings,
        initializationOptions: protocol.initializationOptions,
        resourceBudget: protocol.resourceBudget,
      },
    });
    await expect.poll(() => processManager.getLspProcessStatus()).toBe("READY");
    controllers[0]?.crash();
    await expect.poll(() => controllers.length).toBe(2);
    await expect.poll(() => processManager.getLspProcessStatus()).toBe("READY");
    expect(processManager.getHealthSnapshot()?.restartCount).toBe(1);
    await processManager.dispose();
  });
});

function privateToolNames(path: string | undefined): readonly string[] {
  if (path === undefined) return [];
  return ["cargo", "rustc", "rustfmt"].filter((name) => existsSync(join(path, name)));
}
