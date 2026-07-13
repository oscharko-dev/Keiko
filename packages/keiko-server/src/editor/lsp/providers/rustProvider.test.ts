import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ManagedLspRustConfiguration, WorkspaceInfo } from "@oscharko-dev/keiko-contracts";
import type { BackendAvailability } from "@oscharko-dev/keiko-sandbox";

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
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-rust-provider-"));
  mkdirSync(join(root, "crates", "app", "src"), { recursive: true });
  writeFileSync(
    join(root, "crates", "app", "Cargo.toml"),
    "[package]\nname='app'\nversion='0.1.0'\n",
  );
  writeFileSync(join(root, "crates", "app", "src", "lib.rs"), "pub fn value() -> u8 { 1 }\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function configuration(): ManagedLspRustConfiguration {
  return {
    schemaVersion: "1",
    language: "rust",
    revision: 5,
    etag: '"lspcfg-5-abcdefghijklmnop"',
    activation: "enabled",
    runtime: { kind: "operatorApproved", runtimeId: "rust-analyzer-2026-07-06" },
    provenance: { activation: "workspace", runtime: "operatorProvisioning", settings: "workspace" },
    restartRequired: false,
    restartFields: [],
    settings: {
      toolchain: { kind: "operatorApproved", runtimeId: "rust-1.97.0" },
      features: ["serde", "tracing"],
      target: "x86_64-unknown-linux-gnu",
      cfgs: [
        { key: "keiko_managed", value: "enabled" },
        { key: "reviewed", value: null },
      ],
      noDefaultFeatures: true,
      linkedProjects: [{ kind: "workspaceRelative", path: "crates/app/Cargo.toml" }],
      sysrootPolicy: "approvedToolchain",
      resourceBudget: {
        maxProjectFiles: 20_000,
        maxCargoMetadataBytes: 4_194_304,
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

describe("managed rust-analyzer provider", () => {
  it("advertises the complete negotiated surface through a private offline toolchain", () => {
    expect(RUST_PROVIDER_SPEC).toMatchObject({
      executableName: "rust-analyzer",
      requiredExecutables: ["cargo", "rust-analyzer", "rustc", "rustfmt"],
      approvedDescendantExecutables: ["cargo", "rustc", "rustfmt"],
      fixedEnv: RUST_OFFLINE_ENV,
      networkPolicy: "none",
      semanticTokensCandidate: true,
    });
    expect(RUST_PROVIDER_SPEC.operations).toHaveLength(15);
    expect(RUST_PROVIDER_SPEC.envAllowlist).not.toContain("PATH");
    expect(RUST_PROVIDER_SPEC.envAllowlist).not.toContain("CARGO_HOME");
    expect(RUST_PROVIDER_SPEC.envAllowlist).not.toContain("RUSTUP_HOME");
  });

  it("only references vitest paths that actually exist in the operator troubleshooting doc", () => {
    const docUrl = new URL(
      "../../../../../../docs/troubleshooting/managed-rust-language-provider.md",
      import.meta.url,
    );
    const doc = readFileSync(docUrl, "utf8");
    const [command] = /npm exec vitest -- run [^\n`]+/.exec(doc) ?? [];
    expect(command).toBeDefined();
    expect(command).not.toContain("rustProvider.security.test.ts");
    const referencedPaths = (command ?? "")
      .replace("npm exec vitest -- run ", "")
      .split(/\s+/u)
      .filter((path) => path.length > 0);
    expect(referencedPaths.length).toBeGreaterThan(0);
    for (const relativePath of referencedPaths) {
      const fileUrl = new URL(`../../../../../../${relativePath}`, import.meta.url);
      expect(existsSync(fileUrl)).toBe(true);
    }
  });

  it("maps typed settings to the exact closed rust-analyzer configuration", () => {
    const result = rustProtocolConfiguration(configuration());
    const expected = {
      cachePriming: { enable: false, numThreads: 2 },
      cargo: {
        allTargets: false,
        autoreload: false,
        buildScripts: { enable: false, rebuildOnSave: false, useRustcWrapper: false },
        cfgs: ['keiko_managed="enabled"', "reviewed"],
        features: ["serde", "tracing"],
        metadataExtraArgs: ["--offline"],
        noDefaultFeatures: true,
        noDeps: true,
        sysroot: "discover",
        target: "x86_64-unknown-linux-gnu",
      },
      checkOnSave: false,
      files: { watcher: "client" },
      hover: { actions: { debug: { enable: false }, enable: false, run: { enable: false } } },
      lens: { debug: { enable: false }, enable: false, run: { enable: false } },
      linkedProjects: ["crates/app/Cargo.toml"],
      lru: { capacity: 128 },
      numThreads: 2,
      procMacro: { attributes: { enable: false }, enable: false },
    };
    expect(result).toStrictEqual({
      settings: { "rust-analyzer": expected },
      initializationOptions: expected,
      resourceBudget: {
        maxFiles: 20_000,
        maxBytes: 4_194_304,
        maxMemoryMb: 1_024,
        indexDeadlineMs: 30_000,
      },
    });
    const serialized = JSON.stringify(result);
    for (const unsafeKey of ["extraEnv", "overrideCommand", "configPath", "discoverConfig"]) {
      expect(serialized).not.toContain(unsafeKey);
    }
  });

  it("removes every linked Cargo metadata path when metadata is disabled", () => {
    const configured = configuration();
    const result = rustProtocolConfiguration({
      ...configured,
      settings: { ...configured.settings, cargoMetadata: "disabled" },
    });
    expect(result.initializationOptions).toMatchObject({
      cargo: { autoreload: false, metadataExtraArgs: [], noDeps: true },
      linkedProjects: [],
    });
    expect(JSON.stringify(result)).not.toContain("crates/app/Cargo.toml");
  });

  it("wraps rust-analyzer in an attested native no-egress boundary", () => {
    const prepared = prepareRustSpawn(
      {
        executable: "/opt/rust/bin/rust-analyzer",
        args: [],
        env: {},
        workspace: workspace(),
        processEnv: {},
      },
      { availability: NATIVE, platform: "linux", resolveExecutable: () => "/usr/bin/bwrap" },
    );
    expect(prepared.executable).toBe("/usr/bin/bwrap");
    expect(prepared.args).toContain("--unshare-net");
    expect(prepared.args).toContain("/opt/rust/bin/rust-analyzer");
    prepared.cleanup?.();
  });

  it("creates unique private 0700 runtime roots and removes each generation on cleanup", () => {
    const first = prepareForTest();
    const second = prepareForTest();
    const firstRoot = dirname(first.env.CARGO_HOME ?? "");
    const secondRoot = dirname(second.env.CARGO_HOME ?? "");
    expect(firstRoot).not.toBe(secondRoot);
    for (const prepared of [first, second]) {
      const paths = [
        prepared.env.CARGO_HOME,
        prepared.env.RUSTUP_HOME,
        prepared.env.CARGO_TARGET_DIR,
        prepared.env.XDG_CACHE_HOME,
        prepared.env.TMPDIR,
      ];
      for (const path of paths) {
        expect(path).toBeDefined();
        expect(statSync(path ?? "").mode & 0o777).toBe(0o700);
        expect(path?.startsWith(root)).toBe(false);
      }
    }
    first.cleanup?.();
    second.cleanup?.();
    expect(existsSync(firstRoot)).toBe(false);
    expect(existsSync(secondRoot)).toBe(false);
  });

  it("fails before spawn and exposes a monitor when the typed resource budget is exceeded", () => {
    const input = {
      executable: "/opt/rust/bin/rust-analyzer",
      args: [],
      env: {},
      workspace: workspace(),
      processEnv: {},
      resourceBudget: { maxFiles: 100, maxBytes: 1_000_000 },
    };
    const prepared = prepareRustSpawn(input, {
      availability: NATIVE,
      platform: "linux",
      resolveExecutable: () => "/usr/bin/bwrap",
    });
    expect(prepared.resourceBudgetSatisfied?.()).toBe(true);
    writeFileSync(join(prepared.env.CARGO_HOME ?? "", "oversized.bin"), "x".repeat(1_000_000));
    expect(prepared.resourceBudgetSatisfied?.()).toBe(false);
    prepared.cleanup?.();
    expect(() =>
      prepareRustSpawn(
        { ...input, resourceBudget: { maxFiles: 100, maxBytes: 10 } },
        { availability: NATIVE, platform: "linux", resolveExecutable: () => "/usr/bin/bwrap" },
      ),
    ).toThrow();
  });

  it("fails closed when approved descendants resolve to Rustup shims", () => {
    expect(() =>
      prepareRustSpawn(
        {
          executable: "/opt/rust/bin/rust-analyzer",
          args: [],
          env: {},
          workspace: workspace(),
          processEnv: {},
        },
        { usesRustupShims: () => true },
      ),
    ).toThrow("standalone approved toolchain");
  });

  it("fails closed without an enforcing native backend", () => {
    expect(() =>
      prepareRustSpawn(
        {
          executable: "/opt/rust/bin/rust-analyzer",
          args: [],
          env: {},
          workspace: workspace(),
          processEnv: {},
        },
        { availability: { ...NATIVE, bubblewrap: false }, platform: "linux" },
      ),
    ).toThrow("egress isolation unavailable");
  });

  it.each([
    ["build script", "build.rs", "fn main() {}"],
    ["toolchain override", "rust-toolchain.toml", "[toolchain]\nchannel='nightly'"],
    ["rust project", "rust-project.json", "{}"],
    ["Cargo config", ".cargo/config.toml", "[build]\nrustc-wrapper='./payload'"],
    [
      "registry/source replacement",
      ".cargo/config.toml",
      "[source.crates-io]\nreplace-with='mirror'\n\n[source.mirror]\nregistry='https://mirror.example/index'\n\n[registries.mirror]\nindex='https://mirror.example/index'",
    ],
    ["custom build declaration", "Cargo.toml", "[package]\nname='app'\nbuild='payload.rs'"],
    ["quoted build declaration", "Cargo.toml", "[package]\nname='app'\n\"build\"='payload.rs'"],
    ["proc macro declaration", "Cargo.toml", "[lib]\nproc-macro=true"],
    ["quoted proc macro declaration", "Cargo.toml", '[lib]\n"proc-macro"=true'],
    ["escaping path dependency", "Cargo.toml", "[dependencies]\nevil={path='../outside'}"],
  ])("rejects hostile %s metadata before spawn", (_label, relativePath, contents) => {
    const path = join(root, relativePath);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents, "utf8");
    expect(() =>
      prepareRustSpawn(
        {
          executable: "/opt/rust/bin/rust-analyzer",
          args: [],
          env: {},
          workspace: workspace(),
          processEnv: {},
        },
        { availability: NATIVE, platform: "linux", resolveExecutable: () => "/usr/bin/bwrap" },
      ),
    ).toThrow("rejects executable or escaping project metadata");
  });

  it("rejects symlinked metadata without following it", () => {
    const outside = mkdtempSync(join(tmpdir(), "keiko-rust-outside-"));
    writeFileSync(join(outside, "Cargo.toml"), "[package]\nname='outside'\nversion='0.1.0'\n");
    symlinkSync(outside, join(root, "linked-outside"));
    expect(() =>
      prepareRustSpawn(
        {
          executable: "/opt/rust/bin/rust-analyzer",
          args: [],
          env: {},
          workspace: workspace(),
          processEnv: {},
        },
        { availability: NATIVE, platform: "linux", resolveExecutable: () => "/usr/bin/bwrap" },
      ),
    ).toThrow();
    rmSync(outside, { recursive: true, force: true });
  });
});

function prepareForTest(): ReturnType<typeof prepareRustSpawn> {
  return prepareRustSpawn(
    {
      executable: "/opt/rust/bin/rust-analyzer",
      args: [],
      env: {},
      workspace: workspace(),
      processEnv: {},
    },
    { availability: NATIVE, platform: "linux", resolveExecutable: () => "/usr/bin/bwrap" },
  );
}
