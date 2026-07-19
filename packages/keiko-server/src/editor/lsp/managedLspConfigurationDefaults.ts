import {
  type ManagedLspGoArchitecture,
  type ManagedLspGoConfiguration,
  type ManagedLspGoOperatingSystem,
  type ManagedLspJavaConfiguration,
  type ManagedLspLanguage,
  type ManagedLspPythonConfiguration,
  type ManagedLspRuntimeConfiguration,
  type ManagedLspRustConfiguration,
  type ManagedLspShellConfiguration,
} from "@oscharko-dev/keiko-contracts";

import { GO_PROVIDER_SPEC } from "./providers/goProvider.js";
import { JAVA_PROVIDER_SPEC } from "./providers/javaProvider.js";
import { PYTHON_PROVIDER_SPEC } from "./providers/pythonProvider.js";
import { RUST_PROVIDER_SPEC } from "./providers/rustProvider.js";
import { SHELL_PROVIDER_SPEC } from "./providers/shellProvider.js";

interface DefaultContext {
  readonly revision: number;
  readonly etag: string;
}

function initialBase<T extends ManagedLspLanguage>(
  language: T,
  runtimeId: string,
  context: DefaultContext,
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
    runtime: { kind: "operatorApproved", runtimeId },
    provenance: {
      activation: "workspace",
      runtime: "operatorProvisioning",
      settings: "builtInDefault",
    },
    restartRequired: false,
    restartFields: [],
  };
}

function pythonDefault(context: DefaultContext): ManagedLspPythonConfiguration {
  const runtimeId = PYTHON_PROVIDER_SPEC.id;
  return {
    ...initialBase("python", runtimeId, context),
    settings: {
      interpreter: { kind: "operatorApproved", runtimeId },
      venv: null,
      typeCheckingMode: "standard",
      extraPaths: [],
      configurationPrecedence: ["workspaceConfiguration", "pyproject", "builtInDefault"],
    },
  };
}

function goOperatingSystem(platform: NodeJS.Platform): ManagedLspGoOperatingSystem {
  if (platform === "darwin" || platform === "freebsd" || platform === "linux") return platform;
  return platform === "win32" ? "windows" : "linux";
}

function goArchitecture(architecture: NodeJS.Architecture): ManagedLspGoArchitecture {
  if (architecture === "arm64" || architecture === "arm") return architecture;
  if (architecture === "ia32") return "386";
  return "amd64";
}

function goDefault(
  context: DefaultContext,
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): ManagedLspGoConfiguration {
  const runtimeId = GO_PROVIDER_SPEC.id;
  return {
    ...initialBase("go", runtimeId, context),
    settings: {
      toolchain: { kind: "operatorApproved", runtimeId },
      staticcheck: false,
      buildTags: [],
      buildFlags: { moduleMode: "readonly", trimPath: true },
      target: {
        goos: goOperatingSystem(platform),
        goarch: goArchitecture(architecture),
        minimumGoVersion: "1.24",
      },
      directoryFilters: [],
      dependencyMode: "offline",
      moduleDownloads: false,
    },
  };
}

function shellDefault(context: DefaultContext): ManagedLspShellConfiguration {
  return {
    ...initialBase("shell", SHELL_PROVIDER_SPEC.id, context),
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

function javaDefault(context: DefaultContext): ManagedLspJavaConfiguration {
  const runtimeId = JAVA_PROVIDER_SPEC.id;
  return {
    ...initialBase("java", runtimeId, context),
    settings: {
      jdk: { kind: "operatorApproved", runtimeId },
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

function rustDefault(context: DefaultContext): ManagedLspRustConfiguration {
  const runtimeId = RUST_PROVIDER_SPEC.id;
  return {
    ...initialBase("rust", runtimeId, context),
    settings: {
      toolchain: { kind: "operatorApproved", runtimeId },
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

export function managedLspConfigurationDefaults(
  revision: number,
  etag: string,
  platform: NodeJS.Platform = process.platform,
  architecture: NodeJS.Architecture = process.arch,
): readonly ManagedLspRuntimeConfiguration[] {
  const context = { revision, etag };
  return Object.freeze([
    pythonDefault(context),
    goDefault(context, platform, architecture),
    shellDefault(context),
    javaDefault(context),
    rustDefault(context),
  ]);
}
