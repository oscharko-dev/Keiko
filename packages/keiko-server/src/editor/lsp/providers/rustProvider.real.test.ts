import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_LSP_PROCESS_CONFIG,
  type ManagedLspRustConfiguration,
  type WorkspaceInfo,
} from "@oscharko-dev/keiko-contracts";

import { createLspProcessManager, type LspProcessManager } from "../lspProcessManager.js";
import { RUST_OFFLINE_ENV, RUST_PROVIDER_SPEC, rustProtocolConfiguration } from "./rustProvider.js";

const SUPPORTED_RUST_ANALYZER_RELEASE = "2026-07-06";
const SUPPORTED_RUST_VERSION = "1.97.0";
const provisionedBinDir = process.env.KEIKO_TEST_RUST_LSP_BIN_DIR;
const rustAnalyzer = join(provisionedBinDir ?? "", "rust-analyzer");
const cargo = join(provisionedBinDir ?? "", "cargo");
const rustc = join(provisionedBinDir ?? "", "rustc");
const rustfmt = join(provisionedBinDir ?? "", "rustfmt");
const provisioned =
  provisionedBinDir !== undefined &&
  [rustAnalyzer, cargo, rustc, rustfmt].every((path) => existsSync(path));
const suiteName = provisioned
  ? `real rust-analyzer ${SUPPORTED_RUST_ANALYZER_RELEASE} with Rust ${SUPPORTED_RUST_VERSION} offline smoke`
  : "real rust-analyzer offline smoke (skipped: KEIKO_TEST_RUST_LSP_BIN_DIR is not provisioned)";

describe.skipIf(!provisioned)(suiteName, () => {
  let root = "";
  let manager: LspProcessManager | undefined;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "keiko-real-rust-analyzer-"));
    writeFileSync(join(root, "Cargo.toml"), "[package]\nname='safe'\nversion='0.1.0'\n");
    writeFileSync(join(root, "lib.rs"), "pub fn value() -> u8 { 1 }\n", "utf8");
  });

  afterAll(async () => {
    await manager?.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it("pins provisioned binaries and answers a read-only request under enforced isolation", async () => {
    const env = provisionedEnvironment();
    expect(execFileSync(rustAnalyzer, ["--version"], { encoding: "utf8", env })).toContain(
      SUPPORTED_RUST_VERSION,
    );
    expect(execFileSync(rustc, ["--version"], { encoding: "utf8", env })).toContain(
      SUPPORTED_RUST_VERSION,
    );
    expect(execFileSync(cargo, ["--version"], { encoding: "utf8", env })).toContain(
      SUPPORTED_RUST_VERSION,
    );

    manager = realManager(env);
    await expect.poll(() => manager?.getLspProcessStatus(), { timeout: 30_000 }).toBe("READY");
    const uri = pathToFileURL(join(root, "lib.rs")).href;
    manager.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "rust",
        version: 1,
        text: readFileSync(join(root, "lib.rs"), "utf8"),
      },
    });
    await expect(
      manager.sendRequest(
        "textDocument/hover",
        { textDocument: { uri }, position: { line: 0, character: 8 } },
        new AbortController().signal,
      ),
    ).resolves.toBeDefined();
    expect(manager.getNegotiatedCapabilities()?.negotiatedOperations).toContain("hover");
  }, 45_000);

  function realManager(processEnv: NodeJS.ProcessEnv): LspProcessManager {
    const protocol = rustProtocolConfiguration(configuration());
    return createLspProcessManager({
      config: {
        ...DEFAULT_LSP_PROCESS_CONFIG,
        managerId: RUST_PROVIDER_SPEC.id,
        executableName: RUST_PROVIDER_SPEC.executableName,
        executableArgs: [],
        envAllowlist: RUST_PROVIDER_SPEC.envAllowlist,
        networkPolicy: "none",
      },
      workspace: workspace(),
      processEnv,
      fixedEnv: RUST_OFFLINE_ENV,
      approvedDescendantExecutables: RUST_PROVIDER_SPEC.approvedDescendantExecutables,
      commandRules: RUST_PROVIDER_SPEC.requiredExecutables.map((executable) => ({ executable })),
      prepareSpawn: RUST_PROVIDER_SPEC.prepareSpawn,
      protocol: {
        language: "rust",
        candidateOperations: RUST_PROVIDER_SPEC.operations,
        semanticTokensCandidate: true,
        configurationRevision: 1,
        configuration: protocol.settings,
        initializationOptions: protocol.initializationOptions,
        resourceBudget: protocol.resourceBudget,
      },
    });
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
});

function provisionedEnvironment(): NodeJS.ProcessEnv {
  return { PATH: `${provisionedBinDir ?? ""}${delimiter}${process.env.PATH ?? ""}` };
}

function configuration(): ManagedLspRustConfiguration {
  return {
    schemaVersion: "1",
    language: "rust",
    revision: 1,
    etag: '"lspcfg-1-abcdefghijklmnop"',
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
      sysrootPolicy: "approvedToolchain",
      resourceBudget: {
        maxProjectFiles: 2_000,
        maxCargoMetadataBytes: 8_388_608,
        maxMemoryMb: 1_024,
        indexDeadlineMs: 30_000,
      },
      cargoMetadata: "offline",
      dependencyDownloads: false,
      procMacros: false,
      buildScripts: false,
    },
  };
}
