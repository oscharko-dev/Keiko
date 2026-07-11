import { describe, expect, it } from "vitest";

import {
  MANAGED_LSP_BUILD_TAG_MAX_COUNT,
  MANAGED_LSP_GO_DIRECTORY_FILTER_MAX_COUNT,
  MANAGED_LSP_JAVA_CLASSPATH_MAX_COUNT,
  MANAGED_LSP_PYTHON_EXTRA_PATH_MAX_COUNT,
  MANAGED_LSP_RUNTIME_SCHEMA_VERSION,
  MANAGED_LSP_RUST_CFG_MAX_COUNT,
  MANAGED_LSP_RUST_FEATURE_MAX_COUNT,
  MANAGED_LSP_RUST_LINKED_PROJECT_MAX_COUNT,
  MANAGED_LSP_RUST_MAX_MEMORY_MB,
  MANAGED_LSP_SETTING_PRECEDENCE,
  MANAGED_LSP_SHELLCHECK_EXCLUDE_MAX_COUNT,
  MANAGED_LSP_SHELL_INCLUDE_PATH_MAX_COUNT,
  matchesManagedLspConfigurationPrecondition,
  parseManagedLspRuntimeConfiguration,
  resolveManagedLspSetting,
} from "./managed-lsp-runtime.js";

function approved(runtimeId: string): Record<string, unknown> {
  return { kind: "operatorApproved", runtimeId };
}

function contained(path: string): Record<string, unknown> {
  return { kind: "workspaceRelative", path };
}

function configuration(
  language: string,
  settings: Record<string, unknown>,
): Record<string, unknown> {
  return {
    schemaVersion: MANAGED_LSP_RUNTIME_SCHEMA_VERSION,
    language,
    revision: 7,
    etag: '"lspcfg-7-abcdefghijklmnop"',
    activation: "enabled",
    runtime: approved(`${language}.language-server.production`),
    provenance: {
      activation: "workspace",
      runtime: "operatorProvisioning",
      settings: "workspace",
    },
    restartRequired: false,
    restartFields: [],
    settings,
  };
}

function pythonSettings(): Record<string, unknown> {
  return {
    interpreter: approved("python.3.13.production"),
    venv: approved("python.venv.workspace-a"),
    typeCheckingMode: "strict",
    extraPaths: [contained("src"), contained("generated/stubs")],
    configurationFile: contained("config/pyright.json"),
    configurationPrecedence: ["workspaceConfiguration", "pyproject", "builtInDefault"],
  };
}

function goSettings(): Record<string, unknown> {
  return {
    toolchain: approved("go.1.24.production"),
    staticcheck: true,
    buildTags: ["integration"],
    buildFlags: { moduleMode: "readonly", trimPath: true },
    target: { goos: "linux", goarch: "amd64", minimumGoVersion: "1.22" },
    directoryFilters: [{ kind: "exclude", path: contained("vendor/generated") }],
    workspaceModuleFile: contained("go.work"),
    dependencyMode: "offline",
    moduleDownloads: false,
  };
}

function shellSettings(): Record<string, unknown> {
  return {
    dialect: "bash",
    sourcePolicy: "workspaceOnly",
    shellCheck: {
      mode: "workspace",
      severity: "warning",
      excludedCodes: ["SC1091"],
      includePaths: [contained("scripts/lib")],
      externalSources: false,
    },
  };
}

function javaSettings(): Record<string, unknown> {
  return {
    jdk: approved("jdk.21.production"),
    sourceLevel: "21",
    targetLevel: "21",
    classpath: [contained("lib/approved-api.jar")],
    projectRoots: [contained("services/api")],
    projectImport: "safeOffline",
    buildToolExecution: false,
    annotationProcessing: false,
    dependencyDownloads: false,
    configurationFile: contained("config/jdtls.json"),
  };
}

function rustSettings(): Record<string, unknown> {
  return {
    toolchain: approved("rust.1.85.production"),
    features: ["serde", "tracing"],
    target: "x86_64-unknown-linux-gnu",
    cfgs: [{ key: "keiko_managed", value: "enabled" }],
    noDefaultFeatures: true,
    linkedProjects: [contained("crates/app/Cargo.toml")],
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
  };
}

function pythonConfiguration(): Record<string, unknown> {
  return configuration("python", pythonSettings());
}

describe("managed LSP runtime configuration", () => {
  it("pins the version and frozen low-to-high source precedence", () => {
    expect(MANAGED_LSP_RUNTIME_SCHEMA_VERSION).toBe("1");
    expect(MANAGED_LSP_SETTING_PRECEDENCE).toStrictEqual([
      "builtInDefault",
      "legacyEnvironment",
      "operatorProvisioning",
      "workspace",
    ]);
    expect(Object.isFrozen(MANAGED_LSP_SETTING_PRECEDENCE)).toBe(true);
  });

  it("resolves every source-presence permutation deterministically", () => {
    for (const legacy of [undefined, "legacy"] as const) {
      for (const operator of [undefined, "operator"] as const) {
        for (const workspace of [undefined, "workspace"] as const) {
          const resolved = resolveManagedLspSetting({
            builtInDefault: "default",
            ...(legacy === undefined ? {} : { legacyEnvironment: legacy }),
            ...(operator === undefined ? {} : { operatorProvisioning: operator }),
            ...(workspace === undefined ? {} : { workspace }),
          });
          expect(resolved.value).toBe(workspace ?? operator ?? legacy ?? "default");
        }
      }
    }
  });

  it("accepts bounded Python identity, paths, and explicit configuration precedence", () => {
    const parsed = parseManagedLspRuntimeConfiguration(pythonConfiguration());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(
        matchesManagedLspConfigurationPrecondition(parsed.value, {
          revision: 7,
          etag: '"lspcfg-7-abcdefghijklmnop"',
        }),
      ).toBe(true);
      expect(
        matchesManagedLspConfigurationPrecondition(parsed.value, {
          revision: 6,
          etag: '"lspcfg-7-abcdefghijklmnop"',
        }),
      ).toBe(false);
    }
  });

  it.each([
    ["go", goSettings()],
    ["shell", shellSettings()],
    ["java", javaSettings()],
    ["rust", rustSettings()],
  ])("accepts complete bounded %s settings", (language, settings) => {
    expect(parseManagedLspRuntimeConfiguration(configuration(language, settings)).ok).toBe(true);
  });

  it.each([
    ["top-level argv", { ...pythonConfiguration(), argv: ["--unsafe"] }],
    ["free-form environment", { ...pythonConfiguration(), env: { TOKEN: "secret" } }],
    ["runtime command", { ...pythonConfiguration(), runtime: { command: "/bin/sh" } }],
    ["settings argv", configuration("python", { ...pythonSettings(), executableArgs: [] })],
    [
      "absolute path",
      configuration("python", {
        ...pythonSettings(),
        configurationFile: contained("/etc/passwd"),
      }),
    ],
    [
      "traversal path",
      configuration("python", { ...pythonSettings(), extraPaths: [contained("../secret")] }),
    ],
    [
      "legacy env as persisted settings source",
      {
        ...pythonConfiguration(),
        provenance: {
          activation: "legacyEnvironment",
          runtime: "legacyEnvironment",
          settings: "legacyEnvironment",
        },
      },
    ],
    ["schema skew", { ...pythonConfiguration(), schemaVersion: "2" }],
    ["sixth language", configuration("sql", pythonSettings())],
  ])("rejects %s", (_label, input) => {
    expect(parseManagedLspRuntimeConfiguration(input).ok).toBe(false);
  });

  it("bounds Python extra paths and requires the canonical configuration precedence", () => {
    const paths = Array.from({ length: MANAGED_LSP_PYTHON_EXTRA_PATH_MAX_COUNT }, (_, index) =>
      contained(`python/path-${String(index)}`),
    );
    expect(
      parseManagedLspRuntimeConfiguration(
        configuration("python", { ...pythonSettings(), extraPaths: paths }),
      ).ok,
    ).toBe(true);
    expect(
      parseManagedLspRuntimeConfiguration(
        configuration("python", {
          ...pythonSettings(),
          extraPaths: [...paths, contained("python/over")],
        }),
      ).ok,
    ).toBe(false);
    expect(
      parseManagedLspRuntimeConfiguration(
        configuration("python", {
          ...pythonSettings(),
          configurationPrecedence: ["pyproject", "workspaceConfiguration", "builtInDefault"],
        }),
      ).ok,
    ).toBe(false);
  });

  it("bounds Go tags, typed flags, targets, directory filters, and offline defaults", () => {
    const tags = Array.from(
      { length: MANAGED_LSP_BUILD_TAG_MAX_COUNT },
      (_, index) => `tag${String(index)}`,
    );
    const filters = Array.from(
      { length: MANAGED_LSP_GO_DIRECTORY_FILTER_MAX_COUNT },
      (_, index) => ({ kind: "exclude", path: contained(`generated/${String(index)}`) }),
    );
    expect(
      parseManagedLspRuntimeConfiguration(
        configuration("go", { ...goSettings(), buildTags: tags, directoryFilters: filters }),
      ).ok,
    ).toBe(true);
    expect(
      parseManagedLspRuntimeConfiguration(
        configuration("go", { ...goSettings(), buildTags: [...tags, "over"] }),
      ).ok,
    ).toBe(false);
    for (const unsafe of [
      { ...goSettings(), buildFlags: { argv: ["-mod=mod"] } },
      { ...goSettings(), target: { goos: "plan9", goarch: "amd64", minimumGoVersion: "1.22" } },
      { ...goSettings(), moduleDownloads: true },
      { ...goSettings(), dependencyMode: "online" },
      { ...goSettings(), directoryFilters: [...filters, filters[0]] },
    ]) {
      expect(parseManagedLspRuntimeConfiguration(configuration("go", unsafe)).ok).toBe(false);
    }
  });

  it("bounds Shell dialect, ShellCheck exclusions/include paths, and workspace-only sourcing", () => {
    const excludedCodes = Array.from(
      { length: MANAGED_LSP_SHELLCHECK_EXCLUDE_MAX_COUNT },
      (_, index) => `SC${String(1000 + index)}`,
    );
    const includePaths = Array.from(
      { length: MANAGED_LSP_SHELL_INCLUDE_PATH_MAX_COUNT },
      (_, index) => contained(`scripts/lib-${String(index)}`),
    );
    const bounded = {
      ...shellSettings(),
      shellCheck: {
        mode: "workspace",
        severity: "warning",
        excludedCodes,
        includePaths,
        externalSources: false,
      },
    };
    expect(parseManagedLspRuntimeConfiguration(configuration("shell", bounded)).ok).toBe(true);
    for (const unsafe of [
      { ...shellSettings(), dialect: "zsh" },
      { ...shellSettings(), sourcePolicy: "host" },
      {
        ...shellSettings(),
        shellCheck: {
          mode: "workspace",
          severity: "critical",
          excludedCodes: [],
          includePaths: [],
          externalSources: false,
        },
      },
      {
        ...shellSettings(),
        shellCheck: {
          mode: "workspace",
          severity: "warning",
          excludedCodes: ["--external-sources"],
          includePaths: [],
          externalSources: false,
        },
      },
      {
        ...shellSettings(),
        shellCheck: {
          mode: "workspace",
          severity: "warning",
          excludedCodes: [],
          includePaths: [contained("../host")],
          externalSources: false,
        },
      },
      {
        ...shellSettings(),
        shellCheck: {
          mode: "workspace",
          severity: "warning",
          excludedCodes: [],
          includePaths: [],
          externalSources: true,
        },
      },
    ]) {
      expect(parseManagedLspRuntimeConfiguration(configuration("shell", unsafe)).ok).toBe(false);
    }
    const hostileSeverity = {
      toString: (): never => {
        throw new Error("must not be invoked");
      },
    };
    expect(
      parseManagedLspRuntimeConfiguration(
        configuration("shell", {
          ...shellSettings(),
          shellCheck: {
            mode: "workspace",
            severity: hostileSeverity,
            excludedCodes: [],
            includePaths: [],
            externalSources: false,
          },
        }),
      ).ok,
    ).toBe(false);
  });

  it("bounds Java JDK, levels, contained roots/classpath, and safe-only import", () => {
    const classpath = Array.from({ length: MANAGED_LSP_JAVA_CLASSPATH_MAX_COUNT }, (_, index) =>
      contained(`lib/dependency-${String(index)}.jar`),
    );
    expect(
      parseManagedLspRuntimeConfiguration(configuration("java", { ...javaSettings(), classpath }))
        .ok,
    ).toBe(true);
    for (const unsafe of [
      { ...javaSettings(), classpath: [...classpath, contained("lib/over.jar")] },
      { ...javaSettings(), projectRoots: [contained("/outside/project")] },
      { ...javaSettings(), sourceLevel: "25", targetLevel: "17" },
      { ...javaSettings(), projectImport: "executeBuildTools" },
      { ...javaSettings(), buildToolExecution: true },
      { ...javaSettings(), annotationProcessing: true },
      { ...javaSettings(), dependencyDownloads: true },
    ]) {
      expect(parseManagedLspRuntimeConfiguration(configuration("java", unsafe)).ok).toBe(false);
    }
  });

  it("bounds Rust features/cfgs/targets/projects/budgets and makes execution unavailable", () => {
    const features = Array.from(
      { length: MANAGED_LSP_RUST_FEATURE_MAX_COUNT },
      (_, index) => `feature_${String(index)}`,
    );
    const cfgs = Array.from({ length: MANAGED_LSP_RUST_CFG_MAX_COUNT }, (_, index) => ({
      key: `keiko_cfg_${String(index)}`,
      value: null,
    }));
    const projects = Array.from({ length: MANAGED_LSP_RUST_LINKED_PROJECT_MAX_COUNT }, (_, index) =>
      contained(`crates/${String(index)}/Cargo.toml`),
    );
    expect(
      parseManagedLspRuntimeConfiguration(
        configuration("rust", {
          ...rustSettings(),
          features,
          cfgs,
          linkedProjects: projects,
        }),
      ).ok,
    ).toBe(true);
    for (const unsafe of [
      { ...rustSettings(), features: [...features, "over"] },
      { ...rustSettings(), features: ["--all-features"] },
      { ...rustSettings(), target: "../../host" },
      { ...rustSettings(), linkedProjects: [contained("../Cargo.toml")] },
      { ...rustSettings(), sysrootPolicy: "hostPath" },
      { ...rustSettings(), dependencyDownloads: true },
      { ...rustSettings(), procMacros: true },
      { ...rustSettings(), buildScripts: true },
      {
        ...rustSettings(),
        resourceBudget: {
          ...(rustSettings().resourceBudget as Record<string, unknown>),
          maxMemoryMb: MANAGED_LSP_RUST_MAX_MEMORY_MB + 1,
        },
      },
    ]) {
      expect(parseManagedLspRuntimeConfiguration(configuration("rust", unsafe)).ok).toBe(false);
    }
  });

  it("enforces revision-bound ETags and restart-field consistency", () => {
    expect(
      parseManagedLspRuntimeConfiguration({
        ...pythonConfiguration(),
        etag: '"lspcfg-6-abcdefghijklmnop"',
      }).ok,
    ).toBe(false);
    expect(
      parseManagedLspRuntimeConfiguration({
        ...pythonConfiguration(),
        restartRequired: false,
        restartFields: ["settings"],
      }).ok,
    ).toBe(false);
    expect(
      parseManagedLspRuntimeConfiguration({
        ...pythonConfiguration(),
        restartRequired: true,
        restartFields: ["runtime", "settings"],
      }).ok,
    ).toBe(true);
  });

  it("never throws on hostile objects", () => {
    const hostile = Object.defineProperty({}, "schemaVersion", {
      get(): never {
        throw new Error("hostile getter");
      },
    });
    expect(() => parseManagedLspRuntimeConfiguration(hostile)).not.toThrow();
    expect(parseManagedLspRuntimeConfiguration(hostile).ok).toBe(false);
  });
});
