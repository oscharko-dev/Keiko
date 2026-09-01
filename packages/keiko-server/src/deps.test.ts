import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceFs, WorkspaceStat } from "@oscharko-dev/keiko-workspace";
import type {
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  MemoryAuditEvent,
  MemoryId,
  MemoryRecord,
  MemoryUserId,
} from "@oscharko-dev/keiko-contracts";
import { ATLASSIAN_CONNECTOR_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { DEFAULT_CONTEXT_PROFILE } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { standardPodModelUsePolicy } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-model-use-policy";
import { resolveAtlassianActionApprovalRegistry } from "./atlassian/actionApprovals.js";
import { resolveAtlassianSyncJobRegistry } from "./atlassian/syncService.js";
import {
  addSourceToCapsule,
  createCapsule,
  createDefaultParserRegistry,
  openKnowledgeStore,
  resolveKnowledgeStorePath,
  runIndexingJob,
  searchVectorsForScope,
} from "@oscharko-dev/keiko-local-knowledge";
import type {
  GatewayConfig,
  ModelCapability,
  ModelProviderConfig,
  OpenAIEmbeddingAdapter,
  OpenAIEmbeddingOutcome,
  OpenAIEmbeddingRequest,
} from "@oscharko-dev/keiko-model-gateway";
import {
  buildRedactor,
  buildUiHandlerDeps,
  createOperatorProvisioningQualification,
  currentGatewayEgressConfig,
  currentRedactionSecrets,
  ensureManagedTaskWorkspaceIdentity,
  redactEvidenceString,
  reconcileTaskWorkspacesAtStartup,
  type UiHandlerDeps,
} from "./deps.js";
import {
  DEFAULT_SERVER_DIAGNOSTIC_SUMMARY,
  type ServerDiagnosticRecord,
  type ServerDiagnosticSink,
} from "./diagnostics-log.js";
import type { WorkspaceReconciliationService } from "./task-workspace/types.js";
import type {
  WorkspaceInstance,
  WorkspaceReconciliationReport,
} from "@oscharko-dev/keiko-contracts";
import { TASK_WORKSPACE_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/task-workspace";
import {
  parseGatewayConfig,
  toolCallingConfigurationFingerprint,
} from "@oscharko-dev/keiko-model-gateway";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";
import { DatabaseSync } from "node:sqlite";
import { buildCspHeader } from "./csp.js";
import { UI_HOST } from "./server.js";
import { startUiTestServer } from "./ui-test-server/_support.js";
import type { DapProductionProvisioning } from "./editor/dap/dapProductionService.js";
import type { ManagedLspControlService } from "./editor/lsp/managedLspControl.js";
import { createWorkspaceScriptTrustService } from "./workspace-script-trust.js";
import { buildBinding } from "./task-workspace/binding.js";
import { assertManagedRootOwned } from "./task-workspace/managed-root.js";
import { inspectManagedGitdirIdentity } from "./task-workspace/gitdir-identity.js";
import type { WorkspaceProvisioningService } from "./task-workspace/types.js";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
} from "./observability/index.js";
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";

const tmpDirs: string[] = [];

describe("redactEvidenceString", () => {
  it("fails closed when the evidence redactor returns a non-string value", () => {
    expect(() => redactEvidenceString(() => ({ raw: true }), "secret-value")).toThrow(TypeError);
  });

  it("returns the validated redacted string", () => {
    expect(redactEvidenceString(() => "[REDACTED]", "secret-value")).toBe("[REDACTED]");
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of tmpDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}

function memoryAuditFixture(): MemoryRecord {
  return {
    id: "memory-audit-restart" as MemoryId,
    schemaVersion: "1",
    scope: { kind: "user", userId: "memory-audit-user" as MemoryUserId },
    type: "preference",
    body: "Restart audit fixture.",
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: 1_750_000_000_000,
      confidence: 0.9,
      sensitivity: "public",
    },
    validity: { validFrom: 1_750_000_000_000 },
    status: "proposed",
    pinned: false,
    tags: [],
    createdAt: 1_750_000_000_000,
    updatedAt: 1_750_000_000_000,
  };
}

function requiredMemoryVault(deps: UiHandlerDeps): NonNullable<UiHandlerDeps["memoryVault"]> {
  if (deps.memoryVault === undefined) {
    throw new TypeError("Expected production memory vault wiring.");
  }
  return deps.memoryVault;
}

function memoryAuditEvents(deps: UiHandlerDeps): readonly MemoryAuditEvent[] {
  const runId = deps.evidenceStore.list().find((value) => value.startsWith("memory-audit-"));
  if (runId === undefined) {
    throw new TypeError("Expected memory audit evidence.");
  }
  const json = deps.evidenceStore.get(runId);
  if (json === undefined) {
    throw new TypeError("Expected readable memory audit evidence.");
  }
  return JSON.parse(json) as MemoryAuditEvent[];
}

function operatorDapDocument(): Record<string, unknown> {
  const artifact = (name: string, capsulePath: string): Record<string, string> => ({
    hostPath: `/operator/runtime/${name}`,
    approvedRoot: "/operator/runtime",
    capsulePath,
  });
  return {
    schemaVersion: 1,
    adapter: {
      executableName: "js-debug",
      executableArgs: ["--server=/run/keiko-debug/dap.sock"],
      trustedRoots: ["/operator/runtime"],
      approvedPath: "/operator/runtime:/usr/bin",
    },
    launch: {
      adapterApprovedRoot: "/operator/runtime",
      node: artifact("node", "/opt/keiko-runtime/node"),
      npm: artifact("npm", "/opt/keiko-runtime/npm"),
      shell: artifact("shell", "/opt/keiko-runtime/shell"),
      npmUserConfig: artifact("npm-user", "/opt/keiko-debug/npm-user-config"),
      npmGlobalConfig: artifact("npm-global", "/opt/keiko-debug/npm-global-config"),
      backend: artifact("bwrap", "/opt/keiko-backend/bwrap"),
      runtimeClosure: [artifact("runtime-lib", "/opt/keiko-runtime/lib")],
    },
  };
}

function qualifiedOperatorDapDocument(): {
  readonly document: Record<string, unknown>;
  readonly nodePath: string;
} {
  const approvedRoot = tmp("dap-qualified-artifacts-");
  const artifact = (name: string, capsulePath: string): Record<string, string> => ({
    hostPath: join(approvedRoot, name),
    approvedRoot,
    capsulePath,
  });
  for (const name of ["js-debug", "node", "npm", "shell", "bwrap"]) {
    const path = join(approvedRoot, name);
    writeFileSync(path, name, "utf8");
    chmodSync(path, 0o700);
  }
  writeFileSync(join(approvedRoot, "npm-user"), "", "utf8");
  writeFileSync(join(approvedRoot, "npm-global"), "", "utf8");
  writeFileSync(join(approvedRoot, "runtime-lib"), "runtime", "utf8");
  return {
    nodePath: join(approvedRoot, "node"),
    document: {
      schemaVersion: 1,
      adapter: {
        executableName: "js-debug",
        executableArgs: ["--server=/run/keiko-debug/dap.sock"],
        trustedRoots: [approvedRoot],
        approvedPath: approvedRoot,
      },
      launch: {
        adapterApprovedRoot: approvedRoot,
        node: artifact("node", "/opt/keiko-runtime/node"),
        npm: artifact("npm", "/opt/keiko-runtime/npm"),
        shell: artifact("shell", "/opt/keiko-runtime/shell"),
        npmUserConfig: artifact("npm-user", "/opt/keiko-debug/npm-user-config"),
        npmGlobalConfig: artifact("npm-global", "/opt/keiko-debug/npm-global-config"),
        backend: artifact("bwrap", "/opt/keiko-backend/bwrap"),
        runtimeClosure: [artifact("runtime-lib", "/opt/keiko-runtime/lib")],
      },
    },
  };
}

function realWorkspaceFs(): WorkspaceFs {
  return {
    readFileUtf8: (absolutePath): string => readFileSync(absolutePath, "utf8"),
    stat: (absolutePath): WorkspaceStat => {
      const stats = statSync(absolutePath);
      return {
        size: stats.size,
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
        isSymbolicLink: lstatSync(absolutePath).isSymbolicLink(),
        hardLinkCount: stats.nlink,
        mtimeMs: stats.mtimeMs,
      };
    },
    readDir: (absolutePath) =>
      readdirSync(absolutePath, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        isSymbolicLink: entry.isSymbolicLink(),
      })),
    realPath: (absolutePath): string => realpathSync(absolutePath),
    exists: (absolutePath): boolean => {
      try {
        return statSync(absolutePath, { throwIfNoEntry: false }) !== undefined;
      } catch {
        return false;
      }
    },
    readFileBytes: (absolutePath, maxBytes): Promise<Uint8Array> => {
      const bytes = readFileSync(absolutePath);
      return Promise.resolve(bytes.subarray(0, Math.max(0, Math.floor(maxBytes))));
    },
  };
}

function managedWorkspaceInstance(
  repositoryRoot: string,
  managedRoot: string,
  // #3347 managed-worktree identity: resolveManagedWorkspaceRootAccess re-proves a real Git
  // linked-worktree pointer instead of trusting a path shape, so a caller that actually reaches
  // that resolver (verificationRunner.discover, provisioning.provision) must construct a genuine
  // `git worktree add` linkage and pass its real inspectManagedGitdirIdentity() result here. The
  // placeholder default keeps the other two callers below unchanged -- they exercise
  // ensureManagedTaskWorkspaceIdentity/workspaceScriptTrust directly and never validate this field.
  gitdirIdentity = "gitdir-identity",
): WorkspaceInstance {
  return {
    schemaVersion: TASK_WORKSPACE_SCHEMA_VERSION,
    workspaceId: "workspace-1",
    taskId: "coding-workbench-dev",
    repositoryId: "repo-1",
    repositoryRoot,
    baseBranch: "dev",
    taskBranch: "keiko/task/coding-workbench-dev",
    managedWorktreePath: managedRoot,
    gitdirIdentity,
    lifecycleState: "active",
    health: "healthy",
    lock: null,
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    driftMarkers: [],
    recoveryHints: [],
    auditCorrelationId: "workspace-1",
  };
}

function injectedProvisioning(instance: WorkspaceInstance): WorkspaceProvisioningService {
  const result = { instance, binding: buildBinding(instance), created: true } as const;
  return {
    provision: () => Promise.resolve(result),
    activate: () => Promise.resolve(result),
    getInstance: (workspaceId) => (workspaceId === instance.workspaceId ? instance : undefined),
  };
}

function requiredWorkspaceProvisioning(deps: UiHandlerDeps): WorkspaceProvisioningService {
  if (deps.workspaceProvisioning === undefined) throw new Error("workspace provisioning missing");
  return deps.workspaceProvisioning;
}

function requiredWorkspaceTrust(
  deps: UiHandlerDeps,
): NonNullable<UiHandlerDeps["workspaceScriptTrust"]> {
  if (deps.workspaceScriptTrust === undefined) throw new Error("workspace trust missing");
  return deps.workspaceScriptTrust;
}

function requiredManifestRootRef(store: UiStore, projectPath: string): string {
  const rootRef = store.findWorkspaceManifestRecordByProject(projectPath)?.rootProjects[0]?.rootRef;
  if (rootRef === undefined) throw new Error("manifest root missing");
  return rootRef;
}

function deterministicVector(input: string, dimensions: number): Float32Array {
  const vector = new Float32Array(dimensions);
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  vector[0] = input.length;
  for (let i = 1; i < dimensions; i += 1) {
    vector[i] = ((hash + i * 7) & 0xffff) / 0xffff;
  }
  return vector;
}

function localKnowledgeAdapter(dimensions = 1536): OpenAIEmbeddingAdapter {
  const responder = (request: OpenAIEmbeddingRequest): OpenAIEmbeddingOutcome => ({
    ok: true,
    value: {
      vector: deterministicVector(request.input, dimensions),
      modelId: request.modelId,
    },
  });
  return {
    endpoint: "https://example.test/v1",
    apiKey: ["sk-", "test"].join(""),
    request: async (request): Promise<OpenAIEmbeddingOutcome> =>
      Promise.resolve(responder(request)),
  };
}

async function drain<T>(stream: AsyncIterable<T>): Promise<readonly T[]> {
  const out: T[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

function readAllStoreBytes(dbPath: string): Buffer {
  const chunks: Buffer[] = [];
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(path)) chunks.push(readFileSync(path));
  }
  return Buffer.concat(chunks);
}

function chatCapability(
  modelId: string,
  contextWindow: number,
  maxOutputTokens: number,
  costClass: "low" | "medium" | "high" = "medium",
): ModelCapability {
  return {
    id: modelId,
    kind: "chat",
    contextWindow,
    maxOutputTokens,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: true,
    costClass,
    latencyClass: "standard",
    throughputHint: "fixture",
    preferredUseCases: ["Chat"],
    knownLimitations: [],
  };
}

function codingCapability(modelId: string): ModelCapability {
  return {
    ...chatCapability(modelId, 128_000, 4_096),
    preferredUseCases: ["Coding"],
  };
}

function verifiedCodingCapability(provider: ModelProviderConfig): ModelCapability {
  return {
    ...codingCapability(provider.modelId),
    toolCallingVerification: {
      status: "verified",
      checkedAt: new Date().toISOString(),
      probe: "gateway-tool-calling-v1",
      configurationFingerprint: toolCallingConfigurationFingerprint(provider),
    },
  };
}

function gatewayConfigWithCapabilities(
  capabilities: readonly ReturnType<typeof chatCapability>[],
): string {
  return JSON.stringify({
    providers: capabilities.map((capability) => ({
      modelId: capability.id,
      baseUrl: `https://${capability.id}.example.invalid/openai/v1`,
      apiKey: "fake-test-key",
      timeoutMs: 30000,
      maxRetries: 2,
      retryBaseDelayMs: 500,
    })),
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30000, halfOpenProbes: 2 },
    capabilities,
  });
}

function parsedGatewayConfigWithCapabilities(
  capabilities: readonly ReturnType<typeof chatCapability>[],
): GatewayConfig {
  return {
    providers: capabilities.map((capability) => ({
      modelId: capability.id,
      baseUrl: `https://${capability.id}.example.invalid/openai/v1`,
      apiKey: "fake-test-key",
      timeoutMs: 30000,
      maxRetries: 2,
      retryBaseDelayMs: 500,
    })),
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30000, halfOpenProbes: 2 },
    capabilities,
  };
}

describe("buildRedactor", () => {
  it("scrubs non-pattern secret values from sensitive environment variables", () => {
    const secret = ["CORPSECRET_", "123456789"].join("");
    const redactor = buildRedactor({ KEIKO_DEFAULT_API_KEY: secret });
    expect(redactor({ message: `token=${secret}` })).toEqual({ message: "token=[REDACTED]" });
  });

  it("scrubs Figma access tokens from env and local gateway config", () => {
    const envToken = "figd_env-redaction-token";
    const configToken = "figd_config-redaction-token";
    const config = parseGatewayConfig({
      providers: [
        {
          modelId: "example-chat-model",
          baseUrl: "https://models.example.invalid/openai/v1",
          apiKey: "fake-test-key",
          timeoutMs: 30000,
          maxRetries: 2,
          retryBaseDelayMs: 500,
        },
      ],
      circuitBreaker: { failureThreshold: 5, cooldownMs: 30000, halfOpenProbes: 2 },
      figma: { accessToken: configToken },
    });
    const redactor = buildRedactor({ FIGMA_ACCESS_TOKEN: envToken }, config);

    expect(redactor({ env: envToken, config: configToken })).toEqual({
      env: "[REDACTED]",
      config: "[REDACTED]",
    });
  });
});

describe("buildUiHandlerDeps — UiStore wiring (ADR-0013)", () => {
  it("uses the injected store unchanged when supplied", () => {
    const store = createInMemoryUiStore();
    const evidenceDir = tmp("ev-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: {},
      store,
    });
    expect(deps.store).toBe(store);
    expect(deps.managedLspControl).toBeDefined();
    expect(deps.voiceRecapContentAttestations).toBeDefined();
  }, 15000);

  it("materializes the managed root before content-bearing routes classify ordinary roots", async (): Promise<void> => {
    const stateDir = tmp("managed-root-composition-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: tmp("managed-root-evidence-"),
      env: {},
      uiDbPath: join(stateDir, "keiko-ui.db"),
    });

    try {
      expect(deps.managedTaskWorkspaceRoot).toBe(join(stateDir, "task-workspaces"));
      expect(statSync(join(stateDir, "task-workspaces")).isDirectory()).toBe(true);
    } finally {
      await deps.dispose?.();
    }
  });

  it("gives a managed worktree its own exact trust identity from the selected root grant", async () => {
    const stateDir = tmp("managed-root-identity-");
    const repositoryRoot = tmp("managed-root-source-");
    const managedRoot = join(stateDir, "task-workspaces", "repo-1", "workspace-1");
    // This test reaches deps.verificationRunner.discover(managedRoot) below, which resolves
    // through resolveManagedWorkspaceRootAccess and therefore genuinely re-proves a Git linked
    // worktree pointer (#3347) -- a plain mkdir no longer admits, so build a real one.
    // assertManagedRootOwned must run BEFORE anything else touches "task-workspaces": a plain
    // recursive mkdir for the repo-1 subdirectory below would otherwise create it first with the
    // process umask's default mode, so buildUiHandlerDeps' own materializedManagedRoot call later
    // finds it "already exists" and never applies the 0700 mode + ownership marker this check needs.
    assertManagedRootOwned(join(stateDir, "task-workspaces"));
    execFileSync("git", ["init", "-q"], { cwd: repositoryRoot });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repositoryRoot });
    execFileSync("git", ["config", "user.name", "Keiko Test"], { cwd: repositoryRoot });
    const packageManifest = JSON.stringify({ name: "shared" });
    writeFileSync(join(repositoryRoot, "package.json"), packageManifest);
    execFileSync("git", ["add", "package.json"], { cwd: repositoryRoot });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repositoryRoot });
    mkdirSync(join(stateDir, "task-workspaces", "repo-1"), { recursive: true });
    execFileSync(
      "git",
      ["worktree", "add", "-q", "-b", "keiko/task/coding-workbench-dev", managedRoot, "HEAD"],
      { cwd: repositoryRoot },
    );
    writeFileSync(join(managedRoot, "package.json"), packageManifest);
    const gitdirInspection = inspectManagedGitdirIdentity(managedRoot, repositoryRoot);
    if (gitdirInspection === undefined) {
      throw new Error("fixture git worktree did not produce a resolvable gitdir identity");
    }
    const instance = managedWorkspaceInstance(
      repositoryRoot,
      managedRoot,
      gitdirInspection.identity,
    );
    const store = createInMemoryUiStore();
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: tmp("managed-root-identity-evidence-"),
      env: {},
      store,
      uiDbPath: join(stateDir, "keiko-ui.db"),
      workspaceProvisioning: injectedProvisioning(instance),
    });
    const trust = requiredWorkspaceTrust(deps);
    const provisioning = requiredWorkspaceProvisioning(deps);

    try {
      store.createProject(repositoryRoot);
      expect(trust.grant(repositoryRoot)).toEqual({ trusted: true });
      await provisioning.provision({
        repositoryRequestPath: repositoryRoot,
        taskId: instance.taskId,
        baseBranch: instance.baseBranch,
        requestedBy: "operator",
      });

      expect(store.findWorkspaceManifestRecordByProject(managedRoot)).toBeDefined();
      expect(trust.status(managedRoot)).toMatchObject({
        projectId: managedRoot,
        trust: "trusted",
        reason: "derived-from-trusted-root",
      });
      const sourceRootRef = requiredManifestRootRef(store, repositoryRoot);
      const managedRootRef = requiredManifestRootRef(store, managedRoot);
      expect(managedRootRef).not.toBe(sourceRootRef);
      expect(
        JSON.parse(store.readWorkspaceTrustRecord(sourceRootRef)?.recordJson ?? "{}"),
      ).not.toEqual(JSON.parse(store.readWorkspaceTrustRecord(managedRootRef)?.recordJson ?? "{}"));
      expect(deps.verificationRunner?.discover(managedRoot).projectId).toBe(managedRoot);

      const createProject = vi.spyOn(store, "createProject");
      expect(provisioning.ensureIdentity).toBeDefined();
      provisioning.ensureIdentity?.(instance);
      expect(createProject).not.toHaveBeenCalled();
      createProject.mockRestore();

      expect(trust.revoke(managedRoot)).toEqual({ trusted: false });
      await provisioning.provision({
        repositoryRequestPath: repositoryRoot,
        taskId: instance.taskId,
        baseBranch: instance.baseBranch,
        requestedBy: "operator",
      });
      expect(trust.status(managedRoot)).toMatchObject({
        projectId: managedRoot,
        trust: "restricted",
        reason: "human-revocation",
      });
    } finally {
      await deps.dispose?.();
      store.close();
    }
  });

  it("does not infer managed trust from a registered root without a human selection grant", () => {
    const repositoryRoot = tmp("managed-root-untrusted-source-");
    const managedRoot = tmp("managed-root-untrusted-target-");
    writeFileSync(join(repositoryRoot, "package.json"), JSON.stringify({ name: "source" }));
    writeFileSync(join(managedRoot, "package.json"), JSON.stringify({ name: "managed" }));
    const instance = managedWorkspaceInstance(repositoryRoot, managedRoot);
    const store = createInMemoryUiStore();
    const workspaceScriptTrust = createWorkspaceScriptTrustService({ store });

    try {
      store.createProject(repositoryRoot);
      ensureManagedTaskWorkspaceIdentity({
        uiStore: store,
        workspaceScriptTrust,
        instance,
        initializeTrust: true,
      });

      const managedRootRef = requiredManifestRootRef(store, managedRoot);
      expect(store.readWorkspaceTrustRecord(managedRootRef)).toBeUndefined();
      expect(workspaceScriptTrust.status(managedRoot)).toMatchObject({
        projectId: managedRoot,
        trust: "restricted",
        reason: "state-unavailable",
      });
    } finally {
      store.close();
    }
  });

  it("does not derive managed trust when the package-script basis differs", () => {
    const repositoryRoot = tmp("managed-root-basis-source-");
    const managedRoot = tmp("managed-root-basis-target-");
    writeFileSync(join(repositoryRoot, "package.json"), JSON.stringify({ name: "source" }));
    writeFileSync(join(managedRoot, "package.json"), JSON.stringify({ name: "target" }));
    const instance = managedWorkspaceInstance(repositoryRoot, managedRoot);
    const store = createInMemoryUiStore();
    const workspaceScriptTrust = createWorkspaceScriptTrustService({ store });

    try {
      store.createProject(repositoryRoot);
      workspaceScriptTrust.grant(repositoryRoot);
      ensureManagedTaskWorkspaceIdentity({
        uiStore: store,
        workspaceScriptTrust,
        instance,
        initializeTrust: true,
      });

      expect(workspaceScriptTrust.status(managedRoot)).toMatchObject({
        projectId: managedRoot,
        trust: "restricted",
        reason: "state-unavailable",
      });
    } finally {
      store.close();
    }
  });

  it("fails startup when the managed workspace boundary cannot be materialized", () => {
    const stateDir = tmp("managed-root-failure-");
    writeFileSync(join(stateDir, "task-workspaces"), "occupied");

    expect(() =>
      buildUiHandlerDeps({
        configPath: undefined,
        evidenceDir: tmp("managed-root-failure-evidence-"),
        env: {},
        uiDbPath: join(stateDir, "keiko-ui.db"),
      }),
    ).toThrow("Managed task-workspace boundary initialization failed.");
  });

  // 0.3.0 audit item 7: `materializedManagedRoot` swallowed the mkdir error entirely. One caller then
  // threw a cause-less Error and the other silently returned `runtime-unqualified`, so a permission or
  // read-only-volume problem on the one directory the Coding runtime cannot work without had no
  // observable reason anywhere.
  it("diagnoses why the managed workspace boundary could not be materialized", () => {
    const records: ServerDiagnosticRecord[] = [];
    const diagnostics: ServerDiagnosticSink = {
      record: (entry) => {
        records.push(entry);
      },
    };
    const stateDir = tmp("managed-root-diagnostic-");
    writeFileSync(join(stateDir, "task-workspaces"), "occupied");

    expect(() =>
      buildUiHandlerDeps({
        configPath: undefined,
        evidenceDir: tmp("managed-root-diagnostic-evidence-"),
        env: {},
        uiDbPath: join(stateDir, "keiko-ui.db"),
        diagnostics,
      }),
    ).toThrow("Managed task-workspace boundary initialization failed.");

    expect(records).toHaveLength(1);
    expect(records[0]?.source).toBe("deps.managedTaskWorkspaceRoot");
    expect(records[0]?.operation).toBe("server.composition");
    expect(records[0]?.message).toBe("Managed task-workspace boundary materialization failed.");
    expect(records[0]?.correlationId).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
    // Content-free: the state directory path never enters the record.
    expect(JSON.stringify(records)).not.toContain(stateDir);
  });

  it("diagnoses a DAP production composition failure instead of only marking it unavailable", () => {
    const records: ServerDiagnosticRecord[] = [];
    const diagnostics: ServerDiagnosticSink = {
      record: (entry) => {
        records.push(entry);
      },
    };
    // The provisioning seam is the only injectable input to `createDapProductionService`; a throwing
    // accessor reproduces a composition fault without depending on a specific internal validator.
    const hostileProvisioning = {
      get backendQualification(): never {
        throw new Error("backend qualification exploded for /Users/op/.keiko/debug");
      },
    } as unknown as NonNullable<
      Parameters<typeof buildUiHandlerDeps>[0]["dapProductionProvisioning"]
    >;

    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: tmp("dap-composition-diagnostic-evidence-"),
      env: {},
      store: createInMemoryUiStore(),
      uiDbPath: join(tmp("dap-composition-diagnostic-state-"), "keiko-ui.db"),
      dapProductionProvisioning: hostileProvisioning,
      diagnostics,
    });

    expect(deps.dapDebug).toBeUndefined();
    const composition = records.filter((entry) => entry.source === "deps.dapProduction");
    expect(composition).toHaveLength(1);
    expect(composition[0]?.operation).toBe("server.composition");
    expect(composition[0]?.message).toBe("Debug production service composition failed.");
    expect(composition[0]?.correlationId).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
    expect(JSON.stringify(composition)).not.toContain("/Users/op/.keiko/debug");
  });

  it("constructs and composes the real fail-closed debug activation control (#2347)", async () => {
    const store = createInMemoryUiStore();
    const root = tmp("debug-activation-workspace-");
    store.createProject(root);
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: tmp("debug-activation-evidence-"),
      env: {},
      store,
      uiDbPath: join(tmp("debug-activation-state-"), "keiko-ui.db"),
    });

    const snapshot = await deps.editorSettingsControl?.read(root);
    const started = await startUiTestServer({
      staticRoot: root,
      csp: buildCspHeader([]),
      handlerDeps: deps,
    });
    const { port, server } = started;
    const response = await fetch(
      `http://${UI_HOST}:${String(port)}/api/editor/settings?root=${encodeURIComponent(root)}`,
    );
    const responseBody = (await response.json()) as {
      readonly debugging?: { readonly reasonCode: string; readonly policyResult: string };
    };
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );

    expect(deps.debugActivationControl).toBeDefined();
    expect(snapshot?.debugging).toMatchObject({
      policyResult: "denied",
    });
    expect(["PRODUCT_UNSUPPORTED", "POLICY_UNAVAILABLE"]).toContain(
      snapshot?.debugging?.reasonCode,
    );
    expect(response.status, JSON.stringify(responseBody)).toBe(200);
    expect(responseBody.debugging?.policyResult).toBe("denied");
    await deps.dispose?.();
  }, 15000);

  it("fails closed when explicit DAP provisioning lacks backend qualification (#2096)", async () => {
    const store = createInMemoryUiStore();
    const root = tmp("dap-production-workspace-");
    store.createProject(root);
    const provisioning = {
      adapter: {
        executableName: "adapter-bin",
        executableArgs: [],
        trustedRoots: ["/approved"],
        provisioningDigest: "a".repeat(64),
      },
      backendQualification: undefined,
      adapterPreflight: (): never => {
        throw new Error("not reached during composition");
      },
      launchContext: (): never => {
        throw new Error("not reached during composition");
      },
      targetCatalog: (): never => {
        throw new Error("not reached during composition");
      },
    } as unknown as DapProductionProvisioning;
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: tmp("dap-production-evidence-"),
      env: {},
      store,
      uiDbPath: join(tmp("dap-production-state-"), "keiko-ui.db"),
      dapProductionProvisioning: provisioning,
      dapProductSupport: () => "supported",
      dapDeploymentPolicy: () => "allowed",
      dapProvisioning: () => "provisioned",
    });

    expect(deps.dapDebug).toBeUndefined();
    expect(await deps.editorSettingsControl?.read(root)).toMatchObject({
      debugging: { state: "disabled" },
    });
    await deps.dispose?.();
  }, 15000);

  it("does not compose DAP from a syntactically valid document with missing artifacts", async () => {
    const store = createInMemoryUiStore();
    const root = tmp("dap-operator-document-workspace-");
    store.createProject(root);
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: tmp("dap-operator-document-evidence-"),
      env: { KEIKO_DAP_OPERATOR_PROVISIONING_JSON: JSON.stringify(operatorDapDocument()) },
      store,
      uiDbPath: join(tmp("dap-operator-document-state-"), "keiko-ui.db"),
      dapProductSupport: () => "supported",
      dapDeploymentPolicy: () => "allowed",
    });

    expect(deps.dapDebug).toBeUndefined();
    const enabled = await deps.editorSettingsControl?.mutate({
      action: "set",
      expectedRevision: 0,
      idempotencyKey: "enable-unqualified-debugging",
      realRoot: root,
      scope: "workspace",
      values: { debuggingEnabled: true },
    });
    expect(enabled).toMatchObject({
      kind: "ok",
      snapshot: { debugging: { state: "notProvisioned", reasonCode: "NOT_PROVISIONED" } },
    });
    await deps.dispose?.();
  }, 15000);

  it("requires non-spawning operator artifact qualification and denies identity drift", () => {
    const qualified = qualifiedOperatorDapDocument();
    let contentReads = 0;
    const qualification = createOperatorProvisioningQualification(
      {
        KEIKO_DAP_OPERATOR_PROVISIONING_JSON: JSON.stringify(qualified.document),
      },
      (hostPath) => {
        contentReads += 1;
        return readFileSync(hostPath);
      },
    );
    const initializationReads = contentReads;
    expect(qualification()).toBe("provisioned");
    expect(qualification()).toBe("provisioned");
    expect(contentReads).toBe(initializationReads);

    writeFileSync(qualified.nodePath, "drifted-node", "utf8");
    expect(qualification()).toBe("notProvisioned");
    expect(contentReads).toBeGreaterThan(initializationReads);
  });

  it("denies provisioning when artifact metadata changes during initial qualification", () => {
    const qualified = qualifiedOperatorDapDocument();
    let mutated = false;
    const qualification = createOperatorProvisioningQualification(
      {
        KEIKO_DAP_OPERATOR_PROVISIONING_JSON: JSON.stringify(qualified.document),
      },
      (hostPath) => {
        const content = readFileSync(hostPath);
        if (!mutated) {
          mutated = true;
          writeFileSync(qualified.nodePath, "drifted-during-qualification", "utf8");
        }
        return content;
      },
    );

    expect(mutated).toBe(true);
    expect(qualification()).toBe("notProvisioned");
  });

  it("rehashes metadata drift once and accepts an unchanged artifact identity", () => {
    const qualified = qualifiedOperatorDapDocument();
    let contentReads = 0;
    const qualification = createOperatorProvisioningQualification(
      {
        KEIKO_DAP_OPERATOR_PROVISIONING_JSON: JSON.stringify(qualified.document),
      },
      (hostPath) => {
        contentReads += 1;
        return readFileSync(hostPath);
      },
    );
    const initializationReads = contentReads;

    utimesSync(qualified.nodePath, new Date(1_000), new Date(1_000));
    expect(qualification()).toBe("provisioned");
    expect(contentReads).toBeGreaterThan(initializationReads);
    const refreshReads = contentReads;

    expect(qualification()).toBe("provisioned");
    expect(contentReads).toBe(refreshReads);
  });

  it("does not compose DAP from an invalid operator document", async () => {
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: tmp("dap-invalid-operator-document-evidence-"),
      env: { KEIKO_DAP_OPERATOR_PROVISIONING_JSON: "{not-json" },
      store: createInMemoryUiStore(),
      uiDbPath: join(tmp("dap-invalid-operator-document-state-"), "keiko-ui.db"),
    });

    expect(deps.dapDebug).toBeUndefined();
    await deps.dispose?.();
  }, 15000);

  it("creates a node store at uiDbPath when no store is injected", () => {
    const uiDir = tmp("ui-");
    const evidenceDir = tmp("ev-");
    const dbPath = join(uiDir, "keiko-ui.db");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: {},
      uiDbPath: dbPath,
    });
    expect(deps.store).toBeDefined();
    expect(deps.store.listProjects()).toEqual([]);
    deps.store.close();
  });

  it("constructs one production runtime control plane over the shared durable stores", () => {
    const uiDir = tmp("ui-runtime-");
    const evidenceDir = tmp("ev-runtime-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: {},
      uiDbPath: join(uiDir, "keiko-ui.db"),
    });

    expect(deps.codingRuntimeSnapshotStore).toBeDefined();
    expect(deps.codingRuntimeEvidenceAggregator).toBeDefined();
    expect(deps.codingRuntimeOrchestrator?.status()).toMatchObject({ state: "idle", revision: 0 });
    expect(deps.codingRuntimeEventHub).toBeDefined();
    void deps.dispose?.();
  });

  it("keeps the normal production runtime unavailable without a trusted confirmation consumer", () => {
    const createRun = vi.fn((): never => {
      throw new Error("backend must not be reached");
    });
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: tmp("ev-runtime-closed-"),
      env: {},
      uiDbPath: join(tmp("ui-runtime-closed-"), "keiko-ui.db"),
      codingRuntimeProductionPorts: {
        backend: { createRun },
        secureWorkspaceTextRead: {
          readText: () => Promise.resolve({ ok: false, reason: "denied" }),
        },
        editorAgentClient: {
          action: () => Promise.reject(new Error("editor must not be reached")),
        },
      },
    });

    expect(deps.codingRuntimeHostQualified).toBe(false);
    expect(createRun).not.toHaveBeenCalled();
    void deps.dispose?.();
  });

  it("exposes the content-free runtime mutation lease broker for qualified production runs", () => {
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: tmp("ev-runtime-lease-broker-"),
      env: {},
      uiDbPath: join(tmp("ui-runtime-lease-broker-"), "keiko-ui.db"),
      codingRuntimeStartConfirmationConsumer: { consume: () => undefined },
      codingRuntimeProductionPorts: {
        backend: {
          createRun: (): never => {
            throw new Error("backend must not be reached");
          },
        },
        secureWorkspaceTextRead: {
          readText: () => Promise.resolve({ ok: false, reason: "denied" }),
        },
        editorAgentClient: {
          action: () => Promise.reject(new Error("editor must not be reached")),
        },
      },
    });

    expect(deps.codingRuntimeHostQualified).toBe(true);
    expect(deps.runtimeMutationLease).toBeDefined();
    void deps.dispose?.();
  });

  it("wires production Local Knowledge encryption for heading metadata and retrieval citations", async () => {
    const uiDir = tmp("ui-lk-");
    const evidenceDir = tmp("ev-lk-");
    const sourceDir = tmp("lk-src-");
    const uiDbPath = join(uiDir, "keiko-ui.db");
    const heading = "Server Heading ZGRZZY-SERVER-1322";
    const html = `<html><body><h1>${heading}</h1><p>retrieval needle for encrypted heading citations</p></body></html>`;
    writeFileSync(join(sourceDir, "guide.html"), html, "utf8");

    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { KEIKO_LOCAL_KNOWLEDGE_KEY: Buffer.alloc(32, 13).toString("base64") },
      uiDbPath,
    });
    const keyProvider = deps.localKnowledgeKeyProvider;
    expect(keyProvider).toBeDefined();
    if (keyProvider === undefined) throw new Error("expected Local Knowledge key provider");

    const knowledgeDbPath = resolveKnowledgeStorePath({ runtimeStateDir: uiDir });
    const knowledgeStore = openKnowledgeStore({
      dbPath: knowledgeDbPath,
      protection: { mode: "encrypted-key-provider", keyProvider },
    });
    try {
      const capsuleId = "cap-server-lk" as KnowledgeCapsuleId;
      const sourceId = "src-server-lk" as KnowledgeSourceId;
      const identity = {
        provider: "openai",
        modelId: "text-embedding-3-small",
        vectorDimensions: 1536,
        vectorMetric: "cosine",
      } as const;
      createCapsule(knowledgeStore, {
        id: capsuleId,
        displayName: "Server encrypted Local Knowledge",
        tags: [],
        retrievalEffort: "default",
        outputMode: "answers",
        answerGroundingPolicy: "require-citations",
        modelUsePolicy: standardPodModelUsePolicy(),
        embeddingModelIdentity: identity,
        lifecycleState: "draft",
        storageReference: "server/local-knowledge",
      });
      addSourceToCapsule(knowledgeStore, capsuleId, {
        id: sourceId,
        displayName: "HTML guide",
        tags: [],
        scope: { kind: "folder", rootPath: sourceDir, recursive: true },
      });
      const adapter = localKnowledgeAdapter(identity.vectorDimensions);
      const events = await drain(
        runIndexingJob({
          capsuleId,
          parserRegistry: createDefaultParserRegistry(),
          workspaceFs: realWorkspaceFs(),
          embeddingAdapter: adapter,
          store: knowledgeStore,
          chunkingOptions: { maxTokens: 48, minTokens: 0, overlapTokens: 0 },
        }),
      );
      expect(events.some((event) => event.kind === "job-completed")).toBe(true);

      const outcome = await searchVectorsForScope(
        knowledgeStore,
        adapter,
        { capsuleIds: [capsuleId] },
        "encrypted heading citations",
        { topK: 3 },
      );
      expect(outcome.references.some((ref) => ref.citation.sectionPath?.[0] === heading)).toBe(
        true,
      );
    } finally {
      knowledgeStore.close();
      deps.store.close();
      deps.memoryVault?.close();
    }

    const bytes = readAllStoreBytes(knowledgeDbPath);
    expect(bytes.includes(Buffer.from(heading, "utf8"))).toBe(false);
    const raw = new DatabaseSync(knowledgeDbPath);
    try {
      const row = raw
        .prepare("SELECT heading_path_json FROM parsed_units WHERE heading_path_json IS NOT NULL")
        .get() as { readonly heading_path_json: string };
      expect(row.heading_path_json.startsWith("kv1.")).toBe(true);
    } finally {
      raw.close();
    }
  });

  it("seeds the launch project into the UI store as the preferred project", () => {
    const projectDir = tmp("launch-project-");
    const evidenceDir = tmp("ev-launch-");
    const dbPath = join(projectDir, ".keiko", "ui", "keiko-ui.db");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: {},
      uiDbPath: dbPath,
      initialProjectPath: projectDir,
    });

    expect(deps.preferredProjectPath).toBe(projectDir);
    expect(deps.store.listProjects().map((project) => project.path)).toEqual([projectDir]);
    deps.store.close();
    deps.memoryVault?.close();
  });

  it("composes the connected-context GitHub port for the launch project", async () => {
    const projectDir = tmp("coding-context-project-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: tmp("coding-context-evidence-"),
      env: { GITHUB_CONNECTOR_AUTHORIZED: "true" },
      initialProjectPath: projectDir,
    });

    try {
      expect(deps.codingContextGitHubPort).toBeDefined();
    } finally {
      await deps.dispose?.();
    }
  });

  it("runs the GitHub connector with the composed environment", async () => {
    const injectedBin = tmp("coding-context-injected-bin-");
    const ambientBin = tmp("coding-context-ambient-bin-");
    const writeGhStub = (directory: string, source: string): void => {
      const executable = join(directory, "gh");
      writeFileSync(executable, `#!/bin/sh\nprintf '{"source":"${source}"}'\n`, "utf8");
      chmodSync(executable, 0o700);
    };
    writeGhStub(injectedBin, "injected");
    writeGhStub(ambientBin, "ambient");
    vi.stubEnv("PATH", ambientBin);
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: tmp("coding-context-env-evidence-"),
      env: {
        GITHUB_CONNECTOR_AUTHORIZED: "true",
        GH_TOKEN: "test-injected-token",
        HOME: tmp("coding-context-env-home-"),
        PATH: injectedBin,
      },
      initialProjectPath: tmp("coding-context-env-project-"),
    });

    try {
      await expect(
        deps.codingContextGitHubPort?.readJson(["api", "repos/example/project/issues/1"]),
      ).resolves.toEqual({ source: "injected" });
    } finally {
      await deps.dispose?.();
    }
  });

  it("does not compose the connected-context GitHub port without authorization", async () => {
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: tmp("coding-context-disabled-evidence-"),
      env: { GITHUB_CONNECTOR_AUTHORIZED: "false" },
      initialProjectPath: tmp("coding-context-disabled-project-"),
    });

    try {
      expect(deps.codingContextGitHubPort).toBeUndefined();
    } finally {
      await deps.dispose?.();
    }
  });

  it("ignores retired Jira env fallback fields and keeps the custody port available", async () => {
    const diagnostics: ServerDiagnosticRecord[] = [];
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: tmp("coding-context-invalid-jira-evidence-"),
      env: {
        KEIKO_JIRA_BASE_URL: "http://invalid.example.com",
        KEIKO_JIRA_EMAIL: "operator@example.com",
        KEIKO_JIRA_API_TOKEN: "secret-token",
      },
      diagnostics: { record: (record) => diagnostics.push(record) },
    });

    try {
      expect(deps.codingContextJiraPort).toBeDefined();
      expect(diagnostics).toEqual([]);
    } finally {
      await deps.dispose?.();
    }
  });

  it("resolves the DB path via KEIKO_UI_DATA_DIR when no explicit path is supplied", () => {
    const uiDir = tmp("ui-env-");
    const evidenceDir = tmp("ev-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { KEIKO_UI_DATA_DIR: uiDir },
    });
    expect(deps.store).toBeDefined();
    expect(deps.store.listProjects()).toEqual([]);
    deps.store.close();
  });

  it("passes the injected env to the memory vault path resolver", () => {
    const memoryDir = tmp("mem-env-");
    const evidenceDir = tmp("ev-mem-env-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { KEIKO_MEMORY_DIR: memoryDir },
      store: createInMemoryUiStore(),
    });
    expect(existsSync(join(memoryDir, "keiko-memory.db"))).toBe(true);
    expect(
      deps.memoryVault?.listMemoriesAcrossScopes(deps.memoryVault.listMemoryScopes(), {
        includeExpired: true,
      }),
    ).toEqual([]);
    deps.store.close();
    deps.memoryVault?.close();
  });

  it("seeds memory audit transition state before the first post-restart mutation (#3189)", () => {
    const memoryDir = tmp("memory-audit-restart-");
    const evidenceDir = tmp("memory-audit-restart-evidence-");
    const fixture = memoryAuditFixture();
    const activityLog = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink: activityLog, level: "info" }));
    const first = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { KEIKO_MEMORY_DIR: memoryDir },
      store: createInMemoryUiStore(),
    });

    try {
      requiredMemoryVault(first).insertMemory(fixture);
    } finally {
      first.store.close();
      first.memoryVault?.close();
    }

    const restarted = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { KEIKO_MEMORY_DIR: memoryDir },
      store: createInMemoryUiStore(),
    });
    try {
      const vault = requiredMemoryVault(restarted);
      vault.updateMemory(fixture.id, { status: "archived" }, fixture.updatedAt + 1);
      vault.updateMemory(fixture.id, { tags: ["metadata-change"] }, fixture.updatedAt + 2);

      expect(memoryAuditEvents(restarted).map((event) => event.kind)).toEqual([
        "memory:proposed",
        "memory:archived",
        "memory:updated",
      ]);
    } finally {
      restarted.store.close();
      restarted.memoryVault?.close();
      resetServerLogger();
    }

    expect(activityLog.events).toContainEqual(
      expect.objectContaining({
        category: "memory",
        op: "memory.audit.state-cache.seeded",
        correlationId: UNKNOWN_CORRELATION_ID,
        extra: { recordCount: 1 },
      }),
    );
  });

  // Wave 4a (epic #3233 §8): a UiStoreSchemaVersionError previously crashed startup as a bare,
  // undiagnosed exception. Fail-closed is still correct here — this binary genuinely cannot open a
  // newer schema — but the crash must be diagnosable, mirroring every other composition-root
  // boundary in this module (see "diagnoses why the managed workspace boundary..." above).
  it("diagnoses why the UI store could not be opened, and still fails closed", () => {
    const stateDir = tmp("ui-store-open-diagnostic-");
    const uiDbPath = join(stateDir, "keiko-ui.db");
    const seed = new DatabaseSync(uiDbPath);
    seed.exec("PRAGMA journal_mode = WAL");
    seed.exec("PRAGMA user_version = 9999");
    seed.close();
    const records: ServerDiagnosticRecord[] = [];
    const diagnostics: ServerDiagnosticSink = {
      record: (entry) => {
        records.push(entry);
      },
    };

    expect(() =>
      buildUiHandlerDeps({
        configPath: undefined,
        evidenceDir: tmp("ui-store-open-diagnostic-evidence-"),
        env: {},
        uiDbPath,
        diagnostics,
      }),
    ).toThrow(/newer than this binary supports/);

    expect(records).toHaveLength(1);
    expect(records[0]?.source).toBe("deps.composePersistence");
    expect(records[0]?.operation).toBe("server.composition");
    expect(records[0]?.message).toBe(DEFAULT_SERVER_DIAGNOSTIC_SUMMARY);
    expect(records[0]?.correlationId).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
    // Content-free: the state directory path never enters the record.
    expect(JSON.stringify(records)).not.toContain(stateDir);
  });
});

// #3347 P1: the production-composed workspaceRootAccessResolver's ordinary-root catch used to
// collapse a denied root and a merely missing/unreadable one to the same bare `undefined`, losing
// the correlated workspace.root.denied activity-log line for the denied case. These tests exercise
// the REAL buildUiHandlerDeps-composed resolver (never a hand-rolled fake) end to end: a denied root
// must both stay refused AND emit the correlated, body-free denial event; a genuinely missing root
// must stay refused WITHOUT being misreported as a security denial. (The resolver itself still
// returns `undefined` for both — every current caller shares that one contract — so this pins the
// distinction the resolver can now make internally, not a status-code difference at any specific
// route; TerminalManager.resolveWorkspaceRootAccess's CWD_DENIED-vs-PROJECT_NOT_FOUND mapping is
// terminal.ts's own concern and out of this change's file scope.)
describe("buildUiHandlerDeps — workspaceRootAccessResolver denial logging (#3347 P1)", () => {
  it("logs a correlated workspace.root.denied event for a denied ordinary root", () => {
    const activityLog = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink: activityLog, level: "debug" }));
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: tmp("ev-denied-root-"),
      env: {},
      store: createInMemoryUiStore(),
    });
    // A denied path SEGMENT (".aws") refuses at the lexical check inside
    // resolveExistingAllowedWorkspaceRealRoot before any real filesystem read, so the directory
    // need not exist on disk (same fixture shape as grounded-orchestrator.denied-root-log.test.ts).
    const deniedRoot = join(tmp("denied-root-parent-"), ".aws", "workspace");
    const correlationId = "deps-denied-root-000001";

    let access: ReturnType<NonNullable<UiHandlerDeps["workspaceRootAccessResolver"]>>;
    try {
      access = deps.workspaceRootAccessResolver?.(deniedRoot, correlationId);
    } finally {
      deps.store.close();
      resetServerLogger();
    }

    expect(access).toBeUndefined();
    const denialEvents = activityLog.events.filter((event) => event.op === "workspace.root.denied");
    expect(denialEvents).toHaveLength(1);
    expect(denialEvents[0]).toMatchObject({
      level: "warn",
      category: "security",
      correlationId,
      errorKind: "WORKSPACE_PATH_DENIED",
      extra: { decision: "denied" },
    });
    // Body-free: the denied path itself never enters the logged event.
    expect(JSON.stringify(denialEvents[0])).not.toContain(deniedRoot);
  });

  it("refuses a genuinely missing ordinary root without misreporting it as a denial", () => {
    const activityLog = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink: activityLog, level: "debug" }));
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: tmp("ev-missing-root-"),
      env: {},
      store: createInMemoryUiStore(),
    });
    const missingRoot = join(tmp("missing-root-parent-"), "does-not-exist");
    const correlationId = "deps-missing-root-000001";

    let access: ReturnType<NonNullable<UiHandlerDeps["workspaceRootAccessResolver"]>>;
    try {
      access = deps.workspaceRootAccessResolver?.(missingRoot, correlationId);
    } finally {
      deps.store.close();
      resetServerLogger();
    }

    expect(access).toBeUndefined();
    expect(activityLog.events.some((event) => event.op === "workspace.root.denied")).toBe(false);
  });
});

describe("buildUiHandlerDeps — coding-sidecar model-source wiring", () => {
  it("creates a dedicated coding-workbench evidence store by default", () => {
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: tmp("ev-sidecar-store-"),
      env: {},
      store: createInMemoryUiStore(),
    });

    expect(deps.codingWorkbenchEvidenceStore).toBeDefined();
    expect(deps.codingWorkbenchEvidenceStore).not.toBe(deps.evidenceStore);
  });

  it("creates a server-owned autonomous delivery approval store by default", () => {
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: tmp("ev-autonomous-store-"),
      env: {},
      store: createInMemoryUiStore(),
    });

    expect(deps.autonomousDeliveryApprovalStore).toBeDefined();
    expect(deps.autonomousDeliveryDeploymentCeiling).toBeUndefined();
  });

  it("derives the OpenAI API-key-through-gateway model source from the selected coding-safe provider", () => {
    const configPath = join(tmp("ev-sidecar-openai-"), "keiko.config.json");
    const provider: ModelProviderConfig = {
      modelId: "gpt-4.1-mini",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "fake-test-key",
      timeoutMs: 30000,
      maxRetries: 2,
      retryBaseDelayMs: 500,
    };
    writeFileSync(
      configPath,
      JSON.stringify({
        providers: [provider],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30000, halfOpenProbes: 2 },
        capabilities: [verifiedCodingCapability(provider)],
      }),
      "utf8",
    );
    const deps = buildUiHandlerDeps({
      configPath,
      evidenceDir: tmp("ev-sidecar-openai-store-"),
      env: {},
      store: createInMemoryUiStore(),
    });

    expect(deps.codingSidecarGatewayModelSourceResolver?.()).toBe("openai-api-key-through-gateway");
  });

  it("tracks runtime gateway config updates instead of freezing the initial sidecar model source", () => {
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: tmp("ev-sidecar-runtime-"),
      env: {},
      store: createInMemoryUiStore(),
    });

    expect(deps.codingSidecarGatewayModelSourceResolver?.()).toBe("keiko-model-gateway");

    const provider: ModelProviderConfig = {
      modelId: "gpt-4.1-mini",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "fake-test-key",
      timeoutMs: 30000,
      maxRetries: 2,
      retryBaseDelayMs: 500,
    };
    deps.gatewayConfig?.set(
      parseGatewayConfig({
        providers: [provider],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30000, halfOpenProbes: 2 },
        capabilities: [verifiedCodingCapability(provider)],
      }),
      true,
    );

    expect(deps.codingSidecarGatewayModelSourceResolver?.()).toBe("openai-api-key-through-gateway");
  });
});

describe("buildUiHandlerDeps — Gateway env fallback", () => {
  it("builds a safe gateway config from KEIKO_MODEL_* env when the config file is missing", () => {
    const store = createInMemoryUiStore();
    const evidenceDir = tmp("ev-env-");
    const deps = buildUiHandlerDeps({
      configPath: join(evidenceDir, "missing-keiko.config.json"),
      evidenceDir,
      env: {
        KEIKO_MODEL_EXAMPLE_CHAT_MODEL_BASE_URL: "https://models.example.invalid/openai/v1",
        KEIKO_MODEL_EXAMPLE_CHAT_MODEL_API_KEY: "fake-test-key",
      },
      store,
    });

    expect(deps.configPresent).toBe(true);
    expect(deps.config?.providers.map((provider) => provider.modelId)).toEqual([
      "example-chat-model",
    ]);
    expect(deps.config?.providers[0]?.baseUrl).toBe("https://models.example.invalid/openai/v1");
    expect(deps.config?.providers[0]?.apiKey).toBe("fake-test-key");
    store.close();
  });

  it("derives model-keyed context profiles from configured chat capabilities", () => {
    const store = createInMemoryUiStore();
    const evidenceDir = tmp("ev-context-profile-");
    const configPath = join(evidenceDir, "keiko.config.json");
    writeFileSync(
      configPath,
      gatewayConfigWithCapabilities([
        chatCapability("chat-32k", 32_000, 2_048, "high"),
        chatCapability("chat-128k", 128_000, 8_000, "low"),
        chatCapability("chat-200k", 200_000, 12_000, "medium"),
      ]),
      "utf8",
    );
    const deps = buildUiHandlerDeps({
      configPath,
      evidenceDir,
      env: {},
      store,
    });
    const resolve = deps.contextProfileForModel;
    expect(resolve).toBeDefined();
    if (resolve === undefined) throw new Error("expected contextProfileForModel");

    const profile32 = resolve("chat-32k");
    const profile128 = resolve("chat-128k");
    const profile200 = resolve("chat-200k");
    expect(profile32.effectiveInputBudget).toBe(28_952);
    expect(profile128.effectiveInputBudget).toBe(DEFAULT_CONTEXT_PROFILE.effectiveInputBudget);
    expect(profile200.effectiveInputBudget).toBe(181_750);
    expect(deps.contextProfile).toEqual(profile128);
    store.close();
  });

  it("resolves model-keyed context profiles against the live runtime gateway config", () => {
    const store = createInMemoryUiStore();
    const evidenceDir = tmp("ev-context-profile-live-");
    const configPath = join(evidenceDir, "keiko.config.json");
    writeFileSync(
      configPath,
      gatewayConfigWithCapabilities([chatCapability("chat-live", 32_000, 2_048, "high")]),
      "utf8",
    );
    const deps = buildUiHandlerDeps({
      configPath,
      evidenceDir,
      env: {},
      store,
    });
    const resolve = deps.contextProfileForModel;
    if (resolve === undefined) throw new Error("expected contextProfileForModel");
    const gatewayConfig = deps.gatewayConfig;
    if (gatewayConfig === undefined) throw new Error("expected runtime gateway config");
    const updatedConfig: GatewayConfig = parsedGatewayConfigWithCapabilities([
      chatCapability("chat-live", 200_000, 12_000),
    ]);

    expect(resolve("chat-live").effectiveInputBudget).toBe(28_952);

    gatewayConfig.set(updatedConfig, true);

    expect(resolve("chat-live").effectiveInputBudget).toBe(181_750);
    store.close();
  });

  it("does not cache unknown model ids across live runtime gateway config updates", () => {
    const store = createInMemoryUiStore();
    const evidenceDir = tmp("ev-context-profile-unknown-");
    const configPath = join(evidenceDir, "keiko.config.json");
    writeFileSync(
      configPath,
      gatewayConfigWithCapabilities([chatCapability("chat-known", 32_000, 2_048, "high")]),
      "utf8",
    );
    const deps = buildUiHandlerDeps({
      configPath,
      evidenceDir,
      env: {},
      store,
    });
    const resolve = deps.contextProfileForModel;
    if (resolve === undefined) throw new Error("expected contextProfileForModel");
    const gatewayConfig = deps.gatewayConfig;
    if (gatewayConfig === undefined) throw new Error("expected runtime gateway config");
    const updatedConfig: GatewayConfig = parsedGatewayConfigWithCapabilities([
      chatCapability("chat-later", 200_000, 12_000),
    ]);

    expect(resolve("chat-later")).toBe(DEFAULT_CONTEXT_PROFILE);

    gatewayConfig.set(updatedConfig, true);

    expect(resolve("chat-later").effectiveInputBudget).toBe(181_750);
    store.close();
  });

  it("applies KEIKO_MODEL_* custom API key headers in env-only mode", () => {
    const store = createInMemoryUiStore();
    const evidenceDir = tmp("ev-env-header-");
    const deps = buildUiHandlerDeps({
      configPath: join(evidenceDir, "missing-keiko.config.json"),
      evidenceDir,
      env: {
        KEIKO_MODEL_EXAMPLE_CHAT_MODEL_BASE_URL: "https://models.example.invalid/openai/v1",
        KEIKO_MODEL_EXAMPLE_CHAT_MODEL_API_KEY: "fake-test-key",
        KEIKO_MODEL_EXAMPLE_CHAT_MODEL_API_KEY_HEADER_NAME: "X-Litellm-Key",
      },
      store,
    });

    expect(deps.configPresent).toBe(true);
    expect(deps.config?.providers[0]?.apiKeyHeaderName).toBe("x-litellm-key");
    store.close();
  });

  it("does not publish every registry model from KEIKO_DEFAULT_* alone", () => {
    const store = createInMemoryUiStore();
    const evidenceDir = tmp("ev-env-default-only-");
    const deps = buildUiHandlerDeps({
      configPath: join(evidenceDir, "missing-keiko.config.json"),
      evidenceDir,
      env: {
        KEIKO_DEFAULT_BASE_URL: "https://models.example.invalid/openai/v1",
        KEIKO_DEFAULT_API_KEY: "fake-default-key",
      },
      store,
    });

    expect(deps.configPresent).toBe(false);
    expect(deps.config).toBeUndefined();
    store.close();
  });

  it("exposes env-only egress for Figma even when no model provider is configured", () => {
    const store = createInMemoryUiStore();
    const evidenceDir = tmp("ev-env-egress-only-");
    const deps = buildUiHandlerDeps({
      configPath: join(evidenceDir, "missing-keiko.config.json"),
      evidenceDir,
      env: {
        KEIKO_HTTP_PROXY: "http://proxy.example.invalid:8080",
        KEIKO_CA_BUNDLE_PATH: "/tmp/corp-root-ca.pem",
      },
      store,
    });

    expect(deps.configPresent).toBe(false);
    expect(deps.config).toBeUndefined();
    expect(currentGatewayEgressConfig(deps)).toEqual({
      httpProxy: "http://proxy.example.invalid:8080/",
      caBundlePath: "/tmp/corp-root-ca.pem",
    });
    expect(currentRedactionSecrets(deps)).toContain("http://proxy.example.invalid:8080/");
    expect(currentRedactionSecrets(deps)).toContain("/tmp/corp-root-ca.pem");
    store.close();
  });

  it("exposes config-file egress for Figma even when no model provider is configured", () => {
    const store = createInMemoryUiStore();
    const evidenceDir = tmp("ev-file-egress-only-");
    const configPath = join(evidenceDir, "keiko.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        egress: {
          httpsProxy: "http://proxy.config.invalid:8443",
          noProxy: "localhost,127.0.0.1",
          caBundlePath: "/etc/keiko/corp-root-ca.pem",
        },
      }),
      "utf8",
    );
    const deps = buildUiHandlerDeps({
      configPath,
      evidenceDir,
      env: {},
      store,
    });

    expect(deps.configPresent).toBe(false);
    expect(deps.config).toBeUndefined();
    expect(deps.egress).toEqual({
      httpsProxy: "http://proxy.config.invalid:8443/",
      noProxy: ["localhost", "127.0.0.1"],
      caBundlePath: "/etc/keiko/corp-root-ca.pem",
    });
    expect(currentGatewayEgressConfig(deps)).toEqual(deps.egress);
    expect(currentRedactionSecrets(deps)).toContain("http://proxy.config.invalid:8443/");
    expect(currentRedactionSecrets(deps)).toContain("/etc/keiko/corp-root-ca.pem");
    expect(
      deps.redactor({
        proxy: "http://proxy.config.invalid:8443/",
        ca: "/etc/keiko/corp-root-ca.pem",
      }),
    ).toEqual({ proxy: "[REDACTED]", ca: "[REDACTED]" });
    store.close();
  });

  it("includes Figma env tokens and migrates config tokens out of current redaction secrets", () => {
    const store = createInMemoryUiStore();
    const evidenceDir = tmp("ev-figma-redaction-");
    const configPath = join(evidenceDir, "keiko.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        providers: [
          {
            modelId: "example-chat-model",
            baseUrl: "https://models.example.invalid/openai/v1",
            apiKey: "fake-test-key",
            timeoutMs: 30000,
            maxRetries: 2,
            retryBaseDelayMs: 500,
          },
        ],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30000, halfOpenProbes: 2 },
        figma: { accessToken: "figd_config-redaction-token" },
      }),
      "utf8",
    );
    const deps = buildUiHandlerDeps({
      configPath,
      evidenceDir,
      env: { FIGMA_ACCESS_TOKEN: "figd_env-redaction-token" },
      store,
    });

    expect(currentRedactionSecrets(deps)).toContain("figd_env-redaction-token");
    expect(currentRedactionSecrets(deps)).not.toContain("figd_config-redaction-token");
    expect(readFileSync(configPath, "utf8")).not.toContain("figd_config-redaction-token");
    store.close();
  });

  it("includes resolved reranker config secrets and topology in current redaction secrets", () => {
    const store = createInMemoryUiStore();
    const evidenceDir = tmp("ev-reranker-redaction-");
    const configPath = join(evidenceDir, "keiko.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        providers: [
          {
            modelId: "example-chat-model",
            baseUrl: "https://models.example.invalid/openai/v1",
            apiKey: "fake-test-key",
            timeoutMs: 30000,
            maxRetries: 2,
            retryBaseDelayMs: 500,
          },
        ],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30000, halfOpenProbes: 2 },
        reranker: {
          modelId: "qwen3-reranker",
          baseUrl: "https://reranker.example.invalid/v1",
          apiKey: "reranker-config-secret",
        },
      }),
      "utf8",
    );
    const deps = buildUiHandlerDeps({
      configPath,
      evidenceDir,
      env: {},
      store,
    });

    expect(currentRedactionSecrets(deps)).toContain("reranker-config-secret");
    expect(currentRedactionSecrets(deps)).toContain("https://reranker.example.invalid/v1");
    expect(readFileSync(configPath, "utf8")).not.toContain("reranker-config-secret");
    expect(
      deps.redactor({
        secret: "reranker-config-secret",
        endpoint: "https://reranker.example.invalid/v1",
      }),
    ).toEqual({ secret: "[REDACTED]", endpoint: "[REDACTED]" });
    store.close();
  });
});

describe("buildUiHandlerDeps — H1 production redactor wired into UiStore", () => {
  it("redacts API-key-shaped env value from persisted shortResult (H1)", () => {
    // Build deps with a real env containing a synthetic API-key-shaped secret.
    // The secret MUST NOT appear verbatim in the on-disk DB after a message is persisted.
    const SECRET = ["sk-", "keiko-test-h1-NOT-A-REAL-SECRET"].join("");
    const uiDir = tmp("h1-");
    const evidenceDir = tmp("h1-ev-");
    const dbPath = join(uiDir, "keiko-ui.db");

    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { KEIKO_DEFAULT_API_KEY: SECRET },
      uiDbPath: dbPath,
    });

    // Create the minimum store entities to reach createMessage.
    const proj = deps.store.createProject(uiDir);
    const chat = deps.store.createChat(proj.path, "t", "m");
    deps.store.createMessage({
      chatId: chat.id,
      role: "system",
      content: "content",
      timestamp: Date.now(),
      runId: "run-redacted",
      workflowId: undefined,
      workflowStatus: "running",
      shortResult: `leak ${SECRET} tail`,
      taskType: "verify",
    });

    // shortResult returned by listMessages must not contain the literal secret.
    const messages = deps.store.listMessages(chat.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.shortResult).not.toContain(SECRET);
    expect(messages[0]?.shortResult).toContain("[REDACTED]");

    deps.store.close();

    // On-disk raw row must also not contain the literal secret.
    const db = new DatabaseSync(dbPath);
    const row = db.prepare("SELECT short_result FROM chat_messages LIMIT 1").get() as {
      short_result: string | null;
    };
    db.close();
    expect(row.short_result).not.toContain(SECRET);
    expect(row.short_result).toContain("[REDACTED]");
  });

  // Issue #66 — the PATCH route's updateMessage seam must hit the same production redactor as
  // createMessage. The bug we are guarding against (memory #62 H1) is shipping a default-identity
  // redactor through createNodeUiStore for updateMessage while createMessage uses the real one.
  // The test uses the REAL buildUiHandlerDeps (no injection) and reads the raw row off disk.
  it("redacts API-key-shaped env value through updateMessage (#66 PATCH H1)", () => {
    const SECRET = ["sk-", "keiko-test-h1-patch-NOT-A-REAL-SECRET"].join("");
    const uiDir = tmp("h1p-");
    const evidenceDir = tmp("h1p-ev-");
    const dbPath = join(uiDir, "keiko-ui.db");

    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { KEIKO_DEFAULT_API_KEY: SECRET },
      uiDbPath: dbPath,
    });

    const proj = deps.store.createProject(uiDir);
    const chat = deps.store.createChat(proj.path, "t", "m");
    const created = deps.store.createMessage({
      chatId: chat.id,
      role: "system",
      content: "running",
      timestamp: Date.now(),
      runId: "r-66",
      workflowId: undefined,
      workflowStatus: "running",
      shortResult: undefined,
      taskType: "verify",
    });

    deps.store.updateMessage(created.id, {
      workflowStatus: "completed",
      shortResult: `leak ${SECRET} tail`,
    });

    const reread = deps.store.listMessages(chat.id);
    expect(reread).toHaveLength(1);
    expect(reread[0]?.shortResult).not.toContain(SECRET);
    expect(reread[0]?.shortResult).toContain("[REDACTED]");
    expect(reread[0]?.workflowStatus).toBe("completed");

    deps.store.close();

    const db = new DatabaseSync(dbPath);
    const row = db
      .prepare("SELECT short_result FROM chat_messages WHERE id = ?")
      .get(created.id) as { short_result: string | null };
    db.close();
    expect(row.short_result).not.toContain(SECRET);
    expect(row.short_result).toContain("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// currentGatewayEgressConfig — fail-open env parse fix (item 1)
// ---------------------------------------------------------------------------

describe("currentGatewayEgressConfig — fault-tolerant env egress parsing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a credentialed HTTPS_PROXY does not silently produce undefined egress — caBundlePath survives", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = createInMemoryUiStore();
    const evidenceDir = tmp("ev-egress-ft-");
    const deps = buildUiHandlerDeps({
      configPath: join(evidenceDir, "missing-keiko.config.json"),
      evidenceDir,
      env: {
        HTTPS_PROXY: "http://user:pass@corp-proxy.invalid:8080",
        KEIKO_CA_BUNDLE_PATH: "/etc/keiko/corp-ca.pem",
      },
      store,
    });
    const egress = currentGatewayEgressConfig(deps);
    // Bad HTTPS_PROXY must NOT cause caBundlePath to be silently dropped.
    expect(egress?.caBundlePath).toBe("/etc/keiko/corp-ca.pem");
    expect(egress?.httpsProxy).toBeUndefined();
    // A warning must have been logged naming the env var, never the value.
    expect(warn).toHaveBeenCalled();
    const warningText = (warn.mock.calls[0] as string[])[0] ?? "";
    expect(warningText).toContain("HTTPS_PROXY");
    expect(warningText).not.toContain("pass");
    store.close();
  });

  it("a malformed HTTP_PROXY does not discard a valid noProxy setting", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = createInMemoryUiStore();
    const evidenceDir = tmp("ev-egress-noproxy-");
    const deps = buildUiHandlerDeps({
      configPath: join(evidenceDir, "missing-keiko.config.json"),
      evidenceDir,
      env: {
        HTTP_PROXY: "ftp://invalid-scheme.invalid",
        NO_PROXY: "localhost,127.0.0.1",
      },
      store,
    });
    const egress = currentGatewayEgressConfig(deps);
    expect(egress?.httpProxy).toBeUndefined();
    expect(egress?.noProxy).toEqual(["localhost", "127.0.0.1"]);
    expect(warn).toHaveBeenCalled();
    store.close();
  });
});

// ---------------------------------------------------------------------------
// reconcileTaskWorkspacesAtStartup — synchronous-throw guard (Issue #447 / S4822 fix)
// ---------------------------------------------------------------------------

describe("reconcileTaskWorkspacesAtStartup", () => {
  function fakeReconciliationService(
    reconcile: WorkspaceReconciliationService["reconcile"],
  ): WorkspaceReconciliationService {
    return {
      report: (): WorkspaceReconciliationReport => {
        throw new Error("report() must never be called by startup reconciliation");
      },
      reconcile,
    };
  }

  it("is a no-op when no reconciliation service was composed", () => {
    expect(() => {
      reconcileTaskWorkspacesAtStartup(undefined);
    }).not.toThrow();
  });

  it("does not throw when reconcile() rejects and records a body-free diagnostic", async () => {
    const failure = new Error("sensitive reconciliation IO path");
    failure.stack =
      "Error: sensitive reconciliation IO path\n    at reconcile (file:///app/packages/keiko-server/dist/task-workspace/reconciliation.js:12:4)";
    const rejection = Promise.reject(failure);
    const service = fakeReconciliationService(() => rejection);
    const records: ServerDiagnosticRecord[] = [];

    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    expect(() => {
      reconcileTaskWorkspacesAtStartup(service, { record: (record) => records.push(record) });
    }).not.toThrow();

    // Flush microtasks so the `.catch` on the detached promise has a chance to settle before
    // asserting no unhandled rejection leaked to the process.
    await rejection.catch(() => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));

    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      correlationId: "unknown-correlation-id",
      errorClass: "Error",
      frames: ["packages/keiko-server/dist/task-workspace/reconciliation.js:12:4"],
      message: DEFAULT_SERVER_DIAGNOSTIC_SUMMARY,
      operation: "task-workspace.reconcile.startup",
      source: "task-workspace.bootstrap",
    });
    expect(JSON.stringify(records)).not.toContain("sensitive");
  });

  it("records a synchronous reconcile throw without failing construction", async () => {
    // A non-conforming implementation (e.g. a test double, or a degraded environment) could throw
    // synchronously instead of returning a rejected Promise. Startup construction must still
    // remain available — the persisted classification stays untouched until the next pass.
    const service = fakeReconciliationService(() => {
      throw new Error("synchronous reconciliation failure");
    });
    const records: ServerDiagnosticRecord[] = [];

    expect(() => {
      reconcileTaskWorkspacesAtStartup(service, { record: (record) => records.push(record) });
    }).not.toThrow();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      correlationId: "unknown-correlation-id",
      errorClass: "Error",
      operation: "task-workspace.reconcile.startup",
    });
    expect(JSON.stringify(records)).not.toContain("synchronous reconciliation failure");
  });

  it("does not throw when reconcile() resolves normally", async () => {
    let called = false;
    const report: WorkspaceReconciliationReport = {
      schemaVersion: TASK_WORKSPACE_SCHEMA_VERSION,
      generatedAt: new Date(0).toISOString(),
      entries: [],
      activeRestoration: { kind: "none" },
    };
    const service = fakeReconciliationService(() => {
      called = true;
      return Promise.resolve(report);
    });

    expect(() => {
      reconcileTaskWorkspacesAtStartup(service);
    }).not.toThrow();
    await Promise.resolve();
    expect(called).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Coding-runtime deployment ceiling and readiness reason threading (#2475)
// ---------------------------------------------------------------------------

describe("buildUiHandlerDeps — coding-runtime ceiling and unavailable reason (#2475)", () => {
  function depsWithEnv(
    env: NodeJS.ProcessEnv,
    ceilingOption?: "supervised-coding",
  ): ReturnType<typeof buildUiHandlerDeps> {
    return buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: tmp("ev-ceiling-"),
      env,
      uiDbPath: join(tmp("ceiling-state-"), "keiko-ui.db"),
      ...(ceilingOption === undefined ? {} : { codingRuntimeDeploymentCeiling: ceilingOption }),
    });
  }

  it("resolves the ceiling from the option, then the environment, then governed-assist", () => {
    const fromOption = depsWithEnv(
      { KEIKO_CODING_DEPLOYMENT_CEILING: "autonomous-delivery" },
      "supervised-coding",
    );
    expect(fromOption.codingRuntimeDeploymentCeiling).toBe("supervised-coding");
    const fromEnv = depsWithEnv({ KEIKO_CODING_DEPLOYMENT_CEILING: "supervised-coding" });
    expect(fromEnv.codingRuntimeDeploymentCeiling).toBe("supervised-coding");
    const fromDefault = depsWithEnv({});
    expect(fromDefault.codingRuntimeDeploymentCeiling).toBe("governed-assist");
  });

  it("ignores an unrecognized ceiling environment value fail-closed", () => {
    for (const value of ["", "yolo", "AUTONOMOUS-DELIVERY", "supervised_coding"]) {
      const deps = depsWithEnv({ KEIKO_CODING_DEPLOYMENT_CEILING: value });
      expect(deps.codingRuntimeDeploymentCeiling).toBe("governed-assist");
    }
  });

  it("threads the precise activation unavailable reason for the readiness projection", () => {
    // No packaged install and no dev-lane opt-in: activation is honestly platform-unqualified.
    const unqualified = depsWithEnv({});
    expect(unqualified.codingRuntimeHostQualified).toBe(false);
    expect(unqualified.codingRuntimeUnavailableReason).toBe("platform-unqualified");
    // The kill switch dominates every other prerequisite.
    const disabled = depsWithEnv({ KEIKO_CODING_SIDECAR_DISABLED: "1" });
    expect(disabled.codingRuntimeUnavailableReason).toBe("runtime-disabled");
  });
});

// Epic #2285 Wave 2 audit follow-up (#2628). The only production wiring of
// "revoke trust -> stop running managed language servers" lives in buildPeripherals: the
// fallback WorkspaceScriptTrustService is created with an onRestricted callback that calls
// propagateManagedLspRestriction. When callers inject a trust service — which is how the
// route/integration suites construct one — the fallback branch is skipped and, without the
// fix, the restriction is silently dropped for the composition that production tests use.
// Both tests below drive the real assembly (buildUiHandlerDeps) and observe the injected
// managedLspControl's restrict() calls to prove the propagation on both paths.
describe("buildUiHandlerDeps — workspace-trust revocation stops managed language servers (#2628)", () => {
  const TRUST_LSP_MANIFEST = JSON.stringify({
    name: "trust-lsp-fixture",
    scripts: { test: "vitest run" },
    devDependencies: { vitest: "1.0.0" },
  });

  interface RestrictionRecorder {
    readonly control: ManagedLspControlService;
    readonly restricted: string[];
  }

  function recordingManagedLspControl(): RestrictionRecorder {
    const restricted: string[] = [];
    const notUsed = (name: string): (() => Promise<never>) => {
      return () => Promise.reject(new Error(`ManagedLspControlService.${name} not used in test`));
    };
    return {
      restricted,
      control: {
        stateDir: "/nonexistent-managed-lsp-state",
        read: notUsed("read"),
        readConfiguration: notUsed("readConfiguration"),
        mutate: notUsed("mutate"),
        restrict: (realRoot: string): Promise<void> => {
          restricted.push(realRoot);
          return Promise.resolve();
        },
      },
    };
  }

  function seedTrustFixture(prefix: string): { root: string; canonicalRoot: string } {
    const root = tmp(prefix);
    writeFileSync(join(root, "package.json"), TRUST_LSP_MANIFEST, "utf8");
    return { root, canonicalRoot: realpathSync(root) };
  }

  it("propagates revoke to the managed-LSP control when the trust service is the fallback service (regression pin)", async () => {
    const store = createInMemoryUiStore();
    const { root, canonicalRoot } = seedTrustFixture("keiko-trust-lsp-fallback-");
    store.createProject(root);
    const lsp = recordingManagedLspControl();
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: tmp("keiko-trust-lsp-fallback-ev-"),
      env: {},
      store,
      uiDbPath: join(tmp("keiko-trust-lsp-fallback-state-"), "keiko-ui.db"),
      managedLspControl: lsp.control,
    });
    try {
      deps.workspaceScriptTrust?.grant(root);
      expect(lsp.restricted).toEqual([]);
      deps.workspaceScriptTrust?.revoke(root);
      expect(lsp.restricted).toEqual([canonicalRoot]);
    } finally {
      await deps.dispose?.();
    }
  }, 15000);

  it("unsubscribes the injected trust service on dispose so a later revoke cannot reach a disposed managedLspControl (#2628)", async () => {
    // Guards the Qodo finding on PR #2688: resolveTrustAndManagedLspControl subscribes a
    // listener that captures the assembly-scoped managedLspControl closure; if the
    // injected trust service outlives the deps (test doubles reused across assemblies),
    // dispose() must remove the listener so a subsequent revoke does not fire into a
    // disposed dependency graph.
    const store = createInMemoryUiStore();
    const { root, canonicalRoot } = seedTrustFixture("keiko-trust-lsp-unsub-");
    store.createProject(root);
    const injectedTrust = createWorkspaceScriptTrustService({ store });
    const firstLsp = recordingManagedLspControl();
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: tmp("keiko-trust-lsp-unsub-ev-"),
      env: {},
      store,
      uiDbPath: join(tmp("keiko-trust-lsp-unsub-state-"), "keiko-ui.db"),
      workspaceScriptTrust: injectedTrust,
      managedLspControl: firstLsp.control,
    });
    injectedTrust.grant(root);
    injectedTrust.revoke(root);
    expect(firstLsp.restricted).toEqual([canonicalRoot]);
    await deps.dispose?.();
    firstLsp.restricted.length = 0;
    // Re-grant then revoke; the disposed deps' listener must not re-fire.
    injectedTrust.grant(root);
    injectedTrust.revoke(root);
    expect(firstLsp.restricted).toEqual([]);
  }, 15000);

  it("propagates revoke to the managed-LSP control when the trust service is INJECTED (failure-first, #2628)", async () => {
    // Before the fix, this call sequence produces `lsp.restricted === []` because
    // buildPeripherals only wires propagateManagedLspRestriction into the fallback
    // WorkspaceScriptTrustService and silently drops it whenever a trust service is
    // supplied via BuildHandlerDepsOptions.workspaceScriptTrust. After the fix,
    // propagation is wired regardless of injection, so revoke reaches the managed LSP
    // control and the injected recorder captures the canonical root.
    const store = createInMemoryUiStore();
    const { root, canonicalRoot } = seedTrustFixture("keiko-trust-lsp-injected-");
    store.createProject(root);
    const injectedTrust = createWorkspaceScriptTrustService({ store });
    const lsp = recordingManagedLspControl();
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: tmp("keiko-trust-lsp-injected-ev-"),
      env: {},
      store,
      uiDbPath: join(tmp("keiko-trust-lsp-injected-state-"), "keiko-ui.db"),
      workspaceScriptTrust: injectedTrust,
      managedLspControl: lsp.control,
    });
    try {
      injectedTrust.grant(root);
      expect(lsp.restricted).toEqual([]);
      injectedTrust.revoke(root);
      expect(lsp.restricted).toEqual([canonicalRoot]);
    } finally {
      await deps.dispose?.();
    }
  }, 15000);
});

describe("buildUiHandlerDeps — Atlassian registry isolation (KEIKO-0565, PR #3289 review)", () => {
  it("keeps two independently composed deps graphs from sharing approvals, sync jobs, or activity", async () => {
    const depsA = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: tmp("atlassian-isolation-a-"),
      env: {},
      store: createInMemoryUiStore(),
    });
    const depsB = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: tmp("atlassian-isolation-b-"),
      env: {},
      store: createInMemoryUiStore(),
    });
    try {
      // The composition root already builds two distinct instances per graph...
      expect(depsA.atlassianActionApprovalRegistry).toBeDefined();
      expect(depsA.atlassianActionApprovalRegistry).not.toBe(depsB.atlassianActionApprovalRegistry);
      expect(depsA.atlassianSyncJobRegistry).toBeDefined();
      expect(depsA.atlassianSyncJobRegistry).not.toBe(depsB.atlassianSyncJobRegistry);

      // ...and THE regression assertion: the resolver every real consumer (syncRoutes.ts,
      // writeActionRoutes.ts, actionActivity.ts, syncService.ts) actually calls at runtime must
      // pick each graph's OWN instance, never the process-wide module singleton — that mismatch
      // (consumers bypassing these already-isolated fields) was the actual KEIKO-0565 gap.
      expect(resolveAtlassianActionApprovalRegistry(depsA)).toBe(
        depsA.atlassianActionApprovalRegistry,
      );
      expect(resolveAtlassianSyncJobRegistry(depsA)).toBe(depsA.atlassianSyncJobRegistry);

      // Create an approval through depsA's resolved registry only; depsB's must not see it.
      const created = resolveAtlassianActionApprovalRegistry(depsA).create({
        approval: {
          schemaVersion: "1",
          approvalId: "apr_isolation-test",
          connectorId: "jira:isolation-test",
          provider: "jira",
          actionType: "add-issue-comment",
          actionClass: "connector-write",
          requiredScope: "issue-tracker.write",
          risk: "low",
          reviewReason: "deterministic-risk-approval-required",
          correlationId: "req_isolation-test",
          requestedAt: 1,
          expiresAt: Number.MAX_SAFE_INTEGER,
        },
        authority: {
          runId: "run-isolation-test",
          envelopeDigest: "digest-isolation-test",
          workspaceRoot: "/repo",
        },
        authRef: "atlassian:jira:isolation-test",
        payload: {
          kind: "write-action",
          action: { type: "add-issue-comment", issueKey: "PROJ-1", commentText: "isolation" },
        },
      });
      expect(created.ok).toBe(true);
      expect(resolveAtlassianActionApprovalRegistry(depsA).listPending()).toHaveLength(1);
      expect(resolveAtlassianActionApprovalRegistry(depsB).listPending()).toHaveLength(0);

      // Record a sync-activity entry through depsA's resolved registry only; depsB's must not
      // see it either — the same registry backs both jobs and the activity ring.
      resolveAtlassianSyncJobRegistry(depsA).recordActivity({
        schemaVersion: ATLASSIAN_CONNECTOR_SCHEMA_VERSION,
        activityId: "act_isolation-test",
        occurredAt: Date.now(),
        connectorId: "jira:isolation-test",
        provider: "jira",
        actionType: "add-issue-comment",
        actionClass: "connector-write",
        disposition: "allowed",
        outcome: "succeeded",
        correlationId: "req_isolation-test",
        durationMs: 0,
      });
      expect(
        resolveAtlassianSyncJobRegistry(depsA).listActivity("jira:isolation-test"),
      ).toHaveLength(1);
      expect(
        resolveAtlassianSyncJobRegistry(depsB).listActivity("jira:isolation-test"),
      ).toHaveLength(0);
    } finally {
      await depsA.dispose?.();
      await depsB.dispose?.();
    }
  }, 15000);
});

// Regression: #2906 round 2. createUiHandlerDispose never reset either graph-owned Atlassian
// registry: a pending approval or recorded activity written on a graph SURVIVED that graph's own
// dispose() call, indistinguishable from live state. Pins that dispose() actually clears both
// registries on the graph it belongs to, and that a SEPARATE, still-active graph is unaffected
// either way -- writes made on A never land on B, whether A is later disposed or not.
describe("buildUiHandlerDeps — Atlassian registry disposal (#2906 round 2)", () => {
  it("dispose() clears graph A's pending approvals and sync activity without touching graph B", async () => {
    const depsA = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: tmp("atlassian-dispose-a-"),
      env: {},
      store: createInMemoryUiStore(),
    });
    const depsB = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: tmp("atlassian-dispose-b-"),
      env: {},
      store: createInMemoryUiStore(),
    });
    try {
      const created = resolveAtlassianActionApprovalRegistry(depsA).create({
        approval: {
          schemaVersion: "1",
          approvalId: "apr_dispose-test",
          connectorId: "jira:dispose-test",
          provider: "jira",
          actionType: "add-issue-comment",
          actionClass: "connector-write",
          requiredScope: "issue-tracker.write",
          risk: "low",
          reviewReason: "deterministic-risk-approval-required",
          correlationId: "req_dispose-test",
          requestedAt: 1,
          expiresAt: Number.MAX_SAFE_INTEGER,
        },
        authority: {
          runId: "run-dispose-test",
          envelopeDigest: "digest-dispose-test",
          workspaceRoot: "/repo",
        },
        authRef: "atlassian:jira:dispose-test",
        payload: {
          kind: "write-action",
          action: { type: "add-issue-comment", issueKey: "PROJ-1", commentText: "dispose" },
        },
      });
      expect(created.ok).toBe(true);
      resolveAtlassianSyncJobRegistry(depsA).recordActivity({
        schemaVersion: ATLASSIAN_CONNECTOR_SCHEMA_VERSION,
        activityId: "act_dispose-test",
        occurredAt: Date.now(),
        connectorId: "jira:dispose-test",
        provider: "jira",
        actionType: "add-issue-comment",
        actionClass: "connector-write",
        disposition: "allowed",
        outcome: "succeeded",
        correlationId: "req_dispose-test",
        durationMs: 0,
      });
      expect(resolveAtlassianActionApprovalRegistry(depsA).listPending()).toHaveLength(1);
      expect(resolveAtlassianSyncJobRegistry(depsA).listActivity("jira:dispose-test")).toHaveLength(
        1,
      );

      // Disposing graph A must clear ITS OWN registries -- before the fix, createUiHandlerDispose
      // never called reset(), so both the pending approval and the recorded activity survived
      // disposal, indistinguishable from a live graph.
      await depsA.dispose?.();
      expect(resolveAtlassianActionApprovalRegistry(depsA).listPending()).toHaveLength(0);
      expect(resolveAtlassianSyncJobRegistry(depsA).listActivity("jira:dispose-test")).toHaveLength(
        0,
      );

      // Graph B was never touched: no write from A ever landed there, disposing A notwithstanding.
      expect(resolveAtlassianActionApprovalRegistry(depsB).listPending()).toHaveLength(0);
      expect(resolveAtlassianSyncJobRegistry(depsB).listActivity("jira:dispose-test")).toHaveLength(
        0,
      );
    } finally {
      await depsB.dispose?.();
    }
  }, 15000);
});
