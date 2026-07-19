import { describe, expect, it } from "vitest";

import {
  MANAGED_LSP_LANGUAGES,
  type ManagedLspActivationStatus,
  type ManagedLspLanguage,
} from "./managed-lsp-activation.js";
import { MANAGED_LSP_RUNTIME_SCHEMA_VERSION } from "./managed-lsp-runtime.js";
import {
  parseManagedLspControlMutationResponse,
  parseManagedLspControlRequest,
  parseManagedLspControlResponse,
} from "./managed-lsp-route.js";

const ETAG = '"lspcfg-0-abcdefghijklmnop"';
const PROVENANCE = {
  activation: "workspace",
  runtime: "operatorProvisioning",
  settings: "workspace",
} as const;

function status(
  language: ManagedLspLanguage = "python",
  configurationRevision = 0,
): ManagedLspActivationStatus {
  return {
    ok: true,
    schemaVersion: "1",
    language,
    configurationRevision,
    state: "disabled",
    reasonCode: "WORKSPACE_ACTIVATION_UNSET",
    policyResult: "allowed",
  };
}

function settings(language: ManagedLspLanguage): Record<string, unknown> {
  return {
    language,
    workspaceActivation: "unset",
    configured: false,
    restartRequired: false,
    restartFields: [],
    provenance: null,
  };
}

function configuredSettings(
  language: ManagedLspLanguage,
  provenance: Record<string, unknown> = PROVENANCE,
): Record<string, unknown> {
  return {
    language,
    workspaceActivation: "enabled",
    configured: true,
    restartRequired: false,
    restartFields: [],
    provenance,
  };
}

function pythonConfiguration(revision = 0, etag = ETAG): Record<string, unknown> {
  return {
    schemaVersion: MANAGED_LSP_RUNTIME_SCHEMA_VERSION,
    language: "python",
    revision,
    etag,
    activation: "enabled",
    runtime: { kind: "operatorApproved", runtimeId: "python.production" },
    provenance: PROVENANCE,
    restartRequired: false,
    restartFields: [],
    settings: {
      interpreter: { kind: "operatorApproved", runtimeId: "python.3.13" },
      venv: null,
      typeCheckingMode: "strict",
      extraPaths: [],
      configurationPrecedence: ["workspaceConfiguration", "pyproject", "builtInDefault"],
    },
  };
}

function defaultBase(
  language: ManagedLspLanguage,
  revision: number,
  etag: string,
): Record<string, unknown> {
  return {
    schemaVersion: "1",
    language,
    revision,
    etag,
    activation: "enabled",
    runtime: { kind: "operatorApproved", runtimeId: `${language}-lsp` },
    provenance: {
      activation: "workspace",
      runtime: "operatorProvisioning",
      settings: "builtInDefault",
    },
    restartRequired: false,
    restartFields: [],
  };
}

function pythonDefaultSettings(): Record<string, unknown> {
  return {
    interpreter: { kind: "operatorApproved", runtimeId: "python-lsp" },
    venv: null,
    typeCheckingMode: "standard",
    extraPaths: [],
    configurationPrecedence: ["workspaceConfiguration", "pyproject", "builtInDefault"],
  };
}

function goDefaultSettings(): Record<string, unknown> {
  return {
    toolchain: { kind: "operatorApproved", runtimeId: "go-lsp" },
    staticcheck: false,
    buildTags: [],
    buildFlags: { moduleMode: "readonly", trimPath: true },
    target: { goos: "linux", goarch: "amd64", minimumGoVersion: "1.24" },
    directoryFilters: [],
    dependencyMode: "offline",
    moduleDownloads: false,
  };
}

function shellDefaultSettings(): Record<string, unknown> {
  return {
    dialect: "posix",
    sourcePolicy: "workspaceOnly",
    shellCheck: {
      mode: "workspace",
      severity: "warning",
      excludedCodes: [],
      includePaths: [],
      externalSources: false,
    },
  };
}

function javaDefaultSettings(): Record<string, unknown> {
  return {
    jdk: { kind: "operatorApproved", runtimeId: "java-lsp" },
    sourceLevel: "21",
    targetLevel: "21",
    classpath: [],
    projectRoots: [],
    projectImport: "safeOffline",
    buildToolExecution: false,
    annotationProcessing: false,
    dependencyDownloads: false,
  };
}

function rustDefaultSettings(): Record<string, unknown> {
  return {
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
  };
}

function defaultSettings(language: ManagedLspLanguage): Record<string, unknown> {
  if (language === "python") return pythonDefaultSettings();
  if (language === "go") return goDefaultSettings();
  if (language === "shell") return shellDefaultSettings();
  if (language === "java") return javaDefaultSettings();
  return rustDefaultSettings();
}

function configurationDefaults(revision = 0, etag = ETAG): readonly Record<string, unknown>[] {
  return MANAGED_LSP_LANGUAGES.map((language) => ({
    ...defaultBase(language, revision, etag),
    settings: defaultSettings(language),
  }));
}

function response(): Record<string, unknown> {
  return {
    storeState: "absent",
    revision: 0,
    etag: ETAG,
    evidenceCount: 0,
    languages: MANAGED_LSP_LANGUAGES.map((language) => status(language)),
    settings: MANAGED_LSP_LANGUAGES.map(settings),
    configurations: [],
    configurationDefaults: configurationDefaults(),
    health: [],
    providerMetadata: [
      {
        language: "python",
        configurationSource: "workspaceConfiguration",
        runtimeIdentitySource: "interpreter",
      },
    ],
  };
}

describe("managed-LSP route request parser", () => {
  it("accepts the canonical control request", () => {
    expect(
      parseManagedLspControlRequest({
        root: "/workspace/a",
        language: "python",
        action: "restart",
        expectedRevision: 0,
      }),
    ).toMatchObject({ ok: true });
  });

  it.each([
    [
      "unknown field",
      {
        root: "/workspace/a",
        language: "python",
        action: "restart",
        expectedRevision: 0,
        raw: true,
      },
    ],
    [
      "unknown action",
      { root: "/workspace/a", language: "python", action: "spawn", expectedRevision: 0 },
    ],
    [
      "unsafe revision",
      { root: "/workspace/a", language: "python", action: "restart", expectedRevision: -1 },
    ],
    [
      "unexpected configuration",
      {
        root: "/workspace/a",
        language: "python",
        action: "restart",
        expectedRevision: 0,
        configuration: {},
      },
    ],
  ])("rejects a malformed request with %s", (_label, value) => {
    expect(parseManagedLspControlRequest(value)).toMatchObject({ ok: false });
  });
});

describe("managed-LSP route response parser", () => {
  it("accepts canonical control and mutation envelopes", () => {
    expect(parseManagedLspControlResponse(response())).toMatchObject({ ok: true });
    expect(
      parseManagedLspControlResponse({
        ...response(),
        storeState: "ready",
        settings: MANAGED_LSP_LANGUAGES.map((language) =>
          language === "python" ? configuredSettings(language) : settings(language),
        ),
        configurations: [pythonConfiguration()],
      }),
    ).toMatchObject({ ok: true });
    expect(
      parseManagedLspControlMutationResponse({
        kind: "ok",
        changed: true,
        revision: 0,
        etag: ETAG,
        status: status(),
      }),
    ).toMatchObject({ ok: true });
  });

  it("preserves a language configuration across an unrelated language activation revision", () => {
    const snapshotRevision = 2;
    const snapshotEtag = '"lspcfg-2-abcdefghijklmnop"';
    expect(
      parseManagedLspControlResponse({
        ...response(),
        storeState: "ready",
        revision: snapshotRevision,
        etag: snapshotEtag,
        languages: MANAGED_LSP_LANGUAGES.map((language) =>
          language === "go"
            ? {
                ...status(language, snapshotRevision),
                state: "available",
                reasonCode: "AVAILABLE",
              }
            : status(language, snapshotRevision),
        ),
        settings: MANAGED_LSP_LANGUAGES.map((language) =>
          language === "python"
            ? configuredSettings(language)
            : {
                ...settings(language),
                ...(language === "go" ? { workspaceActivation: "enabled" } : {}),
              },
        ),
        configurations: [pythonConfiguration(1, '"lspcfg-1-abcdefghijklmnop"')],
        configurationDefaults: configurationDefaults(snapshotRevision, snapshotEtag),
      }),
    ).toMatchObject({ ok: true });
  });

  it.each([
    [
      "activation revision drift",
      {
        ...response(),
        languages: MANAGED_LSP_LANGUAGES.map((language) =>
          status(language, language === "python" ? 1 : 0),
        ),
      },
    ],
    [
      "configuration without a configured settings summary",
      { ...response(), configurations: [pythonConfiguration()] },
    ],
    [
      "configured settings summary without a configuration",
      {
        ...response(),
        settings: MANAGED_LSP_LANGUAGES.map((language) =>
          language === "python" ? configuredSettings(language) : settings(language),
        ),
      },
    ],
    [
      "configuration provenance drift",
      {
        ...response(),
        settings: MANAGED_LSP_LANGUAGES.map((language) =>
          language === "python"
            ? configuredSettings(language, {
                ...PROVENANCE,
                activation: "operatorProvisioning",
              })
            : settings(language),
        ),
        configurations: [pythonConfiguration()],
      },
    ],
  ])("rejects hostile cross-envelope inconsistency: %s", (_label, value) => {
    expect(parseManagedLspControlResponse(value)).toMatchObject({ ok: false });
  });

  it.each([
    ["missing fields", { languages: [] }],
    ["empty activation coverage", { ...response(), languages: [] }],
    ["missing activation language", { ...response(), languages: [status("python")] }],
    ["empty settings coverage", { ...response(), settings: [] }],
    ["missing settings language", { ...response(), settings: [settings("python")] }],
    ["missing configuration default", { ...response(), configurationDefaults: [] }],
    [
      "browser-writable default provenance",
      {
        ...response(),
        configurationDefaults: configurationDefaults().map((entry, index) =>
          index === 0
            ? {
                ...entry,
                provenance: {
                  activation: "workspace",
                  runtime: "operatorProvisioning",
                  settings: "workspace",
                },
              }
            : entry,
        ),
      },
    ],
    ["forged ETag", { ...response(), etag: '"lspcfg-1-abcdefghijklmnop"' }],
    [
      "future configuration revision",
      {
        ...response(),
        configurations: [pythonConfiguration(1, '"lspcfg-1-abcdefghijklmnop"')],
      },
    ],
    [
      "mixed configuration ETag",
      {
        ...response(),
        configurations: [pythonConfiguration(0, '"lspcfg-0-ponmlkjihgfedcba"')],
      },
    ],
    ["unknown top-level field", { ...response(), rawBody: "secret" }],
    ["malformed status", { ...response(), languages: [{ ...status(), state: "enabled" }] }],
    [
      "drifted provider metadata",
      {
        ...response(),
        providerMetadata: [{ language: "python", configurationSource: "environment" }],
      },
    ],
  ])("rejects a malformed control response with %s", (_label, value) => {
    expect(parseManagedLspControlResponse(value)).toMatchObject({ ok: false });
  });

  it("rejects malformed mutation status envelopes", () => {
    expect(
      parseManagedLspControlMutationResponse({
        kind: "ok",
        revision: 0,
        etag: ETAG,
      }),
    ).toMatchObject({ ok: false });
  });

  it("fails closed without throwing when inspection traps throw", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys: (): never => {
          throw new Error("blocked");
        },
      },
    );

    expect(parseManagedLspControlResponse(hostile)).toMatchObject({ ok: false });
  });
});
