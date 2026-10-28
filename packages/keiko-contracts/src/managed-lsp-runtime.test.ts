import { describe, expect, expectTypeOf, it } from "vitest";
import {
  installIgnoredProtocolMetadata,
  observeCapturedExtent,
  protocolEnumerationInput,
} from "./__tests__/support/protocol-observation-mechanics.js";

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
  type ManagedLspRuntimeParseResult as SourceRuntimeResult,
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

  it("accepts legacyEnvironment activation provenance alongside non-legacy runtime/settings provenance", () => {
    expect(
      parseManagedLspRuntimeConfiguration({
        ...pythonConfiguration(),
        provenance: {
          activation: "legacyEnvironment",
          runtime: "operatorProvisioning",
          settings: "workspace",
        },
      }).ok,
    ).toBe(true);
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

  it("rejects hostile Go build tags and traversal in directory filters or the workspace module file", () => {
    for (const unsafeTags of [
      ["-tags=inject"],
      ["good", "tag;rm -rf /"],
      ["tag with space"],
      ["tag,-mod=mod"],
      ["../escape"],
    ]) {
      expect(
        parseManagedLspRuntimeConfiguration(
          configuration("go", { ...goSettings(), buildTags: unsafeTags }),
        ).ok,
      ).toBe(false);
    }
    expect(
      parseManagedLspRuntimeConfiguration(
        configuration("go", {
          ...goSettings(),
          directoryFilters: [{ kind: "exclude", path: contained("../escape") }],
        }),
      ).ok,
    ).toBe(false);
    expect(
      parseManagedLspRuntimeConfiguration(
        configuration("go", { ...goSettings(), workspaceModuleFile: contained("../go.work") }),
      ).ok,
    ).toBe(false);
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

import {
  parseManagedLspRuntimeConfiguration as publicRuntime,
  type ManagedLspRuntimeParseResult,
} from "@oscharko-dev/keiko-contracts/runtime/managed-lsp-runtime";

describe.each([
  ["source", parseManagedLspRuntimeConfiguration],
  ["public", publicRuntime],
] as const)("3918 runtime owning admission %s", (_surface, parse) => {
  it("retains the complete healthy Go configuration and settings", () => {
    const input = configuration("go", goSettings());
    const result = parse(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(input);
    expect(result.value.settings).toBe(input.settings);
    if (result.value.language === "go") expect(result.value.settings.moduleDownloads).toBe(false);
  });
  it("refuses an absent physical build tag", () => {
    expect(
      parse(configuration("go", { ...goSettings(), buildTags: new Array<unknown>(1) })),
    ).toEqual({
      ok: false,
      errors: ["runtime configuration is invalid or contains unknown fields"],
    });
  });
  it("refuses a malformed physical build tag concealed by caller every", () => {
    const buildTags = [42];
    Object.defineProperty(buildTags, "every", { value: (): boolean => true });
    expect(parse(configuration("go", { ...goSettings(), buildTags }))).toEqual({
      ok: false,
      errors: ["runtime configuration is invalid or contains unknown fields"],
    });
  });
  it("refuses a malformed path concealed by caller validation and projection", () => {
    const extraPaths = [{}];
    Object.defineProperty(extraPaths, "every", { value: (): boolean => true });
    Object.defineProperty(extraPaths, "map", { value: (): string[] => ["src"] });
    expect(parse(configuration("python", { ...pythonSettings(), extraPaths }))).toEqual({
      ok: false,
      errors: ["runtime configuration is invalid or contains unknown fields"],
    });
  });
});

describe.each([
  ["source", parseManagedLspRuntimeConfiguration],
  ["public", publicRuntime],
] as const)("3918 managed-lsp-runtime captured extent %s", (_surface, parse) => {
  function inspectExtent(
    laterExtent: number,
    firstObservation: { readonly first: unknown } = { first: 1 },
  ): {
    readonly result: boolean;
    readonly indexReads: number;
    readonly lengths: readonly unknown[];
  } {
    const values: unknown[] = ["integration"];
    const observation = observeCapturedExtent(
      values,
      laterExtent,
      firstObservation,
      () => MANAGED_LSP_BUILD_TAG_MAX_COUNT + 1,
    );
    const { observed } = observation;
    return {
      result: parse(configuration("go", { ...goSettings(), buildTags: observed })).ok,
      indexReads: observation.indexReads,
      lengths: observation.lengths,
    };
  }
  it("preserves a healthy actual captured extent", () => {
    const observation = inspectExtent(1);
    expect(observation.result).toBe(true);
    expect(observation.lengths.slice(0, 2)).toEqual([1, 1]);
    expect(observation.indexReads).toBeGreaterThan(0);
  });
  it.each([NaN, undefined])("preserves original first-limit refusal for %s", (first) => {
    const observation = inspectExtent(1, { first });
    expect(observation).toEqual({ result: false, indexReads: 0, lengths: [first] });
  });

  it.each([MANAGED_LSP_BUILD_TAG_MAX_COUNT + 1, Infinity, 0.5, -1])(
    "refuses captured extent %s before indexing",
    (extent) => {
      const observation = inspectExtent(extent);
      expect({
        accepted: observation.result,
        indexReads: observation.indexReads,
        firstTwoLengths: observation.lengths.slice(0, 2),
      }).toEqual({
        accepted: false,
        indexReads: 0,
        firstTwoLengths: [1, extent],
      });
    },
  );
});

describe.each([
  ["source", parseManagedLspRuntimeConfiguration],
  ["public", publicRuntime],
] as const)("3918 runtime original exclusion-limit %s", (_surface, parse) => {
  it.each([NaN, undefined])(
    "preserves the original negative first-cap path observation %s",
    (first) => {
      let lengths = 0;
      const paths = new Proxy([contained("src")], {
        get(target, key, receiver): unknown {
          if (key === "length") return lengths++ === 0 ? first : target.length;
          const datum: unknown = Reflect.get(target, key, receiver);
          return datum;
        },
      });
      const result = parse(configuration("python", { ...pythonSettings(), extraPaths: paths }));
      expect(result.ok).toBe(true);
      if (result.ok && result.value.language === "python")
        expect(result.value.settings.extraPaths).toBe(paths);
      expect(lengths).toBeGreaterThan(1);
    },
  );
});

export function parsePublicManagedLspRuntimeConfiguration(
  input: unknown,
): ManagedLspRuntimeParseResult {
  const result = publicRuntime(input);
  return result;
}

describe("Managed LSP runtime configuration public parser (#3918)", () => {
  it("pins independent source public and forwarding checked runtime types", () => {
    expectTypeOf(parseManagedLspRuntimeConfiguration).parameter(0).toEqualTypeOf<unknown>();
    expectTypeOf(publicRuntime).parameter(0).toEqualTypeOf<unknown>();
    expectTypeOf(parsePublicManagedLspRuntimeConfiguration).parameter(0).toEqualTypeOf<unknown>();
    expectTypeOf(parseManagedLspRuntimeConfiguration).returns.toEqualTypeOf<SourceRuntimeResult>();
    expectTypeOf(publicRuntime).returns.toEqualTypeOf<ManagedLspRuntimeParseResult>();
    expectTypeOf(
      parsePublicManagedLspRuntimeConfiguration,
    ).returns.toEqualTypeOf<ManagedLspRuntimeParseResult>();
    expectTypeOf(publicRuntime).returns.not.toBeAny();
    type Success = Extract<ReturnType<typeof publicRuntime>, { readonly ok: true }>;
    type Failure = Extract<ReturnType<typeof publicRuntime>, { readonly ok: false }>;
    type Go = Extract<Success["value"], { readonly language: "go" }>;
    expectTypeOf<Success["value"]["language"]>().toEqualTypeOf<
      "python" | "go" | "shell" | "java" | "rust"
    >();
    expectTypeOf<Success["value"]["revision"]>().toEqualTypeOf<number>();
    expectTypeOf<Go["settings"]["moduleDownloads"]>().toEqualTypeOf<false>();
    expectTypeOf<Failure["errors"]>().toEqualTypeOf<readonly string[]>();
  });

  it("retains all five bounded configurations and settings identities", () => {
    for (const entry of [
      { language: "python", settings: pythonSettings() },
      { language: "go", settings: goSettings() },
      { language: "shell", settings: shellSettings() },
      { language: "java", settings: javaSettings() },
      { language: "rust", settings: rustSettings() },
    ]) {
      const input = configuration(entry.language, entry.settings);
      const result = parsePublicManagedLspRuntimeConfiguration(input);
      expect(result).toEqual({ ok: true, value: input });
      if (!result.ok) throw new TypeError("healthy public managed LSP runtime refused");
      expect(result.value).toBe(input);
      expect(result.value.settings).toBe(entry.settings);
    }
  });

  it("refuses raw shapes provenance authority paths and cross-language settings", () => {
    for (const input of [null, [], 1, "configuration"])
      expect(parsePublicManagedLspRuntimeConfiguration(input)).toEqual({
        ok: false,
        errors: ["runtime configuration must be an object"],
      });
    for (const input of [
      { ...pythonConfiguration(), revision: 8 },
      {
        ...pythonConfiguration(),
        provenance: {
          activation: "workspace",
          runtime: "legacyEnvironment",
          settings: "workspace",
        },
      },
      configuration("go", { ...goSettings(), moduleDownloads: true }),
      configuration("python", { ...pythonSettings(), extraPaths: [contained("../outside")] }),
      configuration("python", goSettings()),
      { ...pythonConfiguration(), raw: true },
    ])
      expect(parsePublicManagedLspRuntimeConfiguration(input)).toEqual({
        ok: false,
        errors: ["runtime configuration is invalid or contains unknown fields"],
      });
  });
});

for (const surface of ["source", "public"] as const) {
  it(`${surface}: preserves protocol key enumeration before closed-field refusal`, async () => {
    const module =
      surface === "source"
        ? await import("./managed-lsp-runtime.js")
        : await import("@oscharko-dev/keiko-contracts/runtime/managed-lsp-runtime");
    const trace: string[] = [];
    const value = protocolEnumerationInput(trace);
    expect(module.parseManagedLspRuntimeConfiguration(value)).toEqual({
      ok: false,
      errors: ["payload could not be inspected: TypeError"],
    });
    expect(trace).toEqual([
      "ownKeys",
      "descriptor:unexpected",
      "descriptor:schemaVersion",
      "get:schemaVersion",
    ]);
  });

  it(`${surface}: retains ignored symbol and non-enumerable protocol metadata`, async () => {
    const module =
      surface === "source"
        ? await import("./managed-lsp-runtime.js")
        : await import("@oscharko-dev/keiko-contracts/runtime/managed-lsp-runtime");
    const value = pythonConfiguration();
    let reads = 0;
    installIgnoredProtocolMetadata(value, (): void => {
      reads += 1;
    });
    expect(module.parseManagedLspRuntimeConfiguration(value).ok).toBe(true);
    expect(reads).toBe(0);
  });

  it(`${surface}: rejects a non-string protocol vocabulary member without coercion`, async () => {
    const module =
      surface === "source"
        ? await import("./managed-lsp-runtime.js")
        : await import("@oscharko-dev/keiko-contracts/runtime/managed-lsp-runtime");
    let coercions = 0;
    const foreign = {
      toString: (): never => {
        coercions += 1;
        throw new TypeError("Protocol enum coercion");
      },
    };
    const value = { ...pythonConfiguration(), activation: foreign };
    expect(module.parseManagedLspRuntimeConfiguration(value)).toEqual({
      ok: false,
      errors: ["runtime configuration is invalid or contains unknown fields"],
    });
    expect(coercions).toBe(0);
  });
}
