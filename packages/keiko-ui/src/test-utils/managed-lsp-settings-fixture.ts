import type {
  ManagedLspGoConfiguration,
  ManagedLspJavaConfiguration,
  ManagedLspLanguage,
  ManagedLspPythonConfiguration,
  ManagedLspRuntimeConfiguration,
  ManagedLspRustConfiguration,
  ManagedLspShellConfiguration,
} from "@oscharko-dev/keiko-contracts";

export const MANAGED_LSP_TEST_LANGUAGES = ["python", "go", "shell", "java", "rust"] as const;

type SettingsSource = "builtInDefault" | "workspace";

interface FixtureContext {
  readonly revision: number;
  readonly etag: string;
  readonly settingsSource: SettingsSource;
}

function base<T extends ManagedLspLanguage>(
  language: T,
  context: FixtureContext,
): Pick<
  ManagedLspRuntimeConfiguration,
  | "schemaVersion"
  | "revision"
  | "etag"
  | "activation"
  | "runtime"
  | "provenance"
  | "restartRequired"
  | "restartFields"
> & { readonly language: T } {
  return {
    schemaVersion: "1",
    language,
    revision: context.revision,
    etag: context.etag,
    activation: "enabled",
    runtime: { kind: "operatorApproved", runtimeId: `${language}-lsp` },
    provenance: {
      activation: "workspace",
      runtime: "operatorProvisioning",
      settings: context.settingsSource,
    },
    restartRequired: false,
    restartFields: [],
  };
}

function pythonFixture(context: FixtureContext): ManagedLspPythonConfiguration {
  return {
    ...base("python", context),
    settings: {
      interpreter: { kind: "operatorApproved", runtimeId: "python-lsp" },
      venv: null,
      typeCheckingMode: "standard",
      extraPaths: [],
      configurationPrecedence: ["workspaceConfiguration", "pyproject", "builtInDefault"],
    },
  };
}

function goFixture(context: FixtureContext): ManagedLspGoConfiguration {
  return {
    ...base("go", context),
    settings: {
      toolchain: { kind: "operatorApproved", runtimeId: "go-lsp" },
      staticcheck: false,
      buildTags: [],
      buildFlags: { moduleMode: "readonly", trimPath: true },
      target: { goos: "linux", goarch: "amd64", minimumGoVersion: "1.24" },
      directoryFilters: [],
      dependencyMode: "offline",
      moduleDownloads: false,
    },
  };
}

function shellFixture(context: FixtureContext): ManagedLspShellConfiguration {
  return {
    ...base("shell", context),
    settings: {
      dialect: "posix",
      sourcePolicy: "workspaceOnly",
      shellCheck: {
        mode: "workspace",
        severity: "warning",
        excludedCodes: [],
        includePaths: [],
        externalSources: false,
      },
    },
  };
}

function javaFixture(context: FixtureContext): ManagedLspJavaConfiguration {
  return {
    ...base("java", context),
    settings: {
      jdk: { kind: "operatorApproved", runtimeId: "java-lsp" },
      sourceLevel: "21",
      targetLevel: "21",
      classpath: [],
      projectRoots: [],
      projectImport: "safeOffline",
      buildToolExecution: false,
      annotationProcessing: false,
      dependencyDownloads: false,
    },
  };
}

function rustFixture(context: FixtureContext): ManagedLspRustConfiguration {
  return {
    ...base("rust", context),
    settings: {
      toolchain: { kind: "operatorApproved", runtimeId: "rust-lsp" },
      features: [],
      target: null,
      cfgs: [],
      noDefaultFeatures: false,
      linkedProjects: [],
      sysrootPolicy: "disabled",
      resourceBudget: {
        maxProjectFiles: 20_000,
        maxCargoMetadataBytes: 4_194_304,
        maxMemoryMb: 1_024,
        indexDeadlineMs: 30_000,
      },
      cargoMetadata: "disabled",
      dependencyDownloads: false,
      procMacros: false,
      buildScripts: false,
    },
  };
}

export function managedLspTestConfiguration(
  language: ManagedLspLanguage,
  settingsSource: SettingsSource,
  revision: number,
  etag: string,
): ManagedLspRuntimeConfiguration {
  const context = { revision, etag, settingsSource };
  if (language === "python") return pythonFixture(context);
  if (language === "go") return goFixture(context);
  if (language === "shell") return shellFixture(context);
  if (language === "java") return javaFixture(context);
  return rustFixture(context);
}

export function managedLspTestConfigurationDefaults(
  revision: number,
  etag: string,
): readonly ManagedLspRuntimeConfiguration[] {
  return MANAGED_LSP_TEST_LANGUAGES.map((language) =>
    managedLspTestConfiguration(language, "builtInDefault", revision, etag),
  );
}
