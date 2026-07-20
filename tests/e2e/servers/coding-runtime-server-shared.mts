// Shared TEST-ONLY server composition for the Code-task browser journeys (#2483). The two
// scripted entries and the real-binary production-discovery entry differ only in fixture identity,
// question behavior, app-session pairing, and runtime source; the workspace, BFF, static UI, CSP,
// shutdown, and deterministic provider-boundary wiring live here once.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import type {
  GatewayRequest,
  GatewayStreamChunk,
  NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import { createNodeGitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";

import { SESSION_PAIRING_LAUNCHER_SECRET_ENV } from "../../../packages/keiko-server/src/coding-app-session/launcherSessionPairingPort.js";
import { createCodingRuntimeEvidenceAggregator } from "../../../packages/keiko-server/src/coding-runtime/codingRuntimeEvidenceAggregator.js";
import {
  createScriptedOpenCodeHarness,
  scriptedFunctionalPortable,
  type ScriptedOpenCodeHarness,
} from "../../../packages/keiko-server/src/coding-runtime/opencodeFunctionalHarness/_support.js";
import {
  createFunctionalRuntimeResolver,
  functionalGatewayConfig,
  productionDiscoveryBffDeps,
  scriptedResponse,
  type ScriptState,
} from "../../../packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.functional/_support.js";
import { readProductionWorkspaceHead } from "../../../packages/keiko-server/src/coding-runtime/productionWorkspaceHeadReader.js";
import {
  buildCspHeader,
  extractInlineScriptHashes,
} from "../../../packages/keiko-server/src/csp.js";
import { buildUiHandlerDeps, type UiHandlerDeps } from "../../../packages/keiko-server/src/deps.js";
import {
  createVerificationRunnerManager,
  type VerificationRunnerManager,
} from "../../../packages/keiko-server/src/editor/verificationRunner.js";
import { createUiServer, UI_HOST } from "../../../packages/keiko-server/src/server.js";
import { createInMemoryUiStore } from "../../../packages/keiko-server/src/store/index.js";
import { runMigrations } from "../../../packages/keiko-server/src/store/schema.js";
import { buildActiveWorkspacePointerStoreOverDatabase } from "../../../packages/keiko-server/src/task-workspace/active-store.js";
import { createWorkspaceLifecycleService } from "../../../packages/keiko-server/src/task-workspace/lifecycle.js";
import { createWorkspaceMutexRegistry } from "../../../packages/keiko-server/src/task-workspace/mutex.js";
import { createWorkspaceProvisioningService } from "../../../packages/keiko-server/src/task-workspace/provisioning.js";
import { createWorkspaceReconciliationService } from "../../../packages/keiko-server/src/task-workspace/reconciliation.js";
import { buildWorkspaceInstanceStoreOverDatabase } from "../../../packages/keiko-server/src/task-workspace/store.js";
import type { WorkspaceProvisioningService } from "../../../packages/keiko-server/src/task-workspace/types.js";

type WorkspaceAdapterFactory = (
  workspace: Parameters<typeof createNodeGitWorktreeAdapter>[0]["workspace"],
) => ReturnType<typeof createNodeGitWorktreeAdapter>;

interface JourneyWorkspaceServices {
  readonly provisioning: ReturnType<typeof createWorkspaceProvisioningService>;
  readonly lifecycle: ReturnType<typeof createWorkspaceLifecycleService>;
  readonly reconciliation: ReturnType<typeof createWorkspaceReconciliationService>;
}

export interface CodingRuntimeJourneyServerConfig {
  readonly fixtureId: string;
  readonly fixtureLabel: string;
  readonly runtime: "scripted" | "production-discovery";
  readonly includeQuestion: boolean;
  readonly defaultPort: number;
  readonly originalContent: string;
  readonly editedContent: string;
  readonly targetRelativePath: string;
  readonly stateDir: () => string;
  readonly repositoryRoot: (stateDir: string) => string;
  readonly managedRoot: (stateDir: string) => string;
  readonly launcherSessionSecret?: string | undefined;
}

interface JourneyComposition {
  readonly deps: UiHandlerDeps;
  readonly scripted?: ScriptedOpenCodeHarness | undefined;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

function createRepositoryFixture(config: CodingRuntimeJourneyServerConfig, stateDir: string): void {
  const repository = config.repositoryRoot(stateDir);
  mkdirSync(dirname(join(repository, config.targetRelativePath)), { recursive: true });
  git(repository, ["init", "-q", "-b", "main"]);
  git(repository, ["config", "user.email", `${config.fixtureId}@keiko.example`]);
  git(repository, ["config", "user.name", `Keiko ${config.fixtureLabel}`]);
  git(repository, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repository, config.targetRelativePath), config.originalContent);
  writeFileSync(
    join(repository, "package.json"),
    JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(0)"' } }),
  );
  git(repository, ["add", "."]);
  git(repository, ["commit", "-q", "-m", `${config.fixtureId} fixture`]);
}

function createWorkspaceServices(managedRoot: string): JourneyWorkspaceServices {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  const adapter: WorkspaceAdapterFactory = (workspace) =>
    createNodeGitWorktreeAdapter({ workspace, processEnv: { PATH: process.env.PATH ?? "" } });
  const shared = {
    store: buildWorkspaceInstanceStoreOverDatabase(db),
    evidenceStore: createInMemoryEvidenceStore(),
    managedRoot,
    createAdapter: adapter,
    redactString: (value: string): string => value,
    now: (): number => Date.now(),
    newId: (): string => randomUUID(),
  };
  const activePointerStore = buildActiveWorkspacePointerStoreOverDatabase(db);
  const mutex = createWorkspaceMutexRegistry();
  const provisioning = createWorkspaceProvisioningService({ ...shared, mutex });
  const lifecycle = createWorkspaceLifecycleService({
    ...shared,
    activePointerStore,
    provisioning,
    mutex,
  });
  const reconciliation = createWorkspaceReconciliationService({ ...shared, activePointerStore });
  return { provisioning, lifecycle, reconciliation };
}

function verificationRunner(fixtureLabel: string): Pick<VerificationRunnerManager, "runToReport"> {
  const store = createInMemoryUiStore();
  const manager = createVerificationRunnerManager({
    store,
    evidenceStore: createInMemoryEvidenceStore(),
    isWorkspaceTrustedForPackageScripts: () => true,
  });
  const registered = new Set<string>();
  return {
    runToReport: (input, signal): ReturnType<VerificationRunnerManager["runToReport"]> => {
      if (!registered.has(input.projectId)) {
        store.createProject(input.projectId, fixtureLabel);
        registered.add(input.projectId);
      }
      return manager.runToReport(input, signal);
    },
  };
}

function nextScriptedTurn(script: ScriptState, includeQuestion: boolean): NormalizedResponse {
  let response = scriptedResponse(script);
  while (!includeQuestion && response.toolCalls.some((call) => call.name === "question")) {
    response = scriptedResponse(script);
  }
  return response;
}

function scriptedModelDeps(
  deps: UiHandlerDeps,
  script: ScriptState,
  includeQuestion: boolean,
): UiHandlerDeps {
  const chat = (): Promise<NormalizedResponse> =>
    Promise.resolve(nextScriptedTurn(script, includeQuestion));
  return {
    ...deps,
    config: functionalGatewayConfig(),
    configPresent: true,
    gatewayConfig: undefined,
    codingSidecarGatewayChatFactory: () => chat,
    codingSidecarGatewayChatStreamFactory: () =>
      async function* (): AsyncIterable<GatewayStreamChunk> {
        yield { type: "done" as const, response: await chat() };
      },
  };
}

function scriptedComposition(
  config: CodingRuntimeJourneyServerConfig,
  stateDir: string,
  port: number,
  services: JourneyWorkspaceServices,
): JourneyComposition {
  const bffStateRoot = join(stateDir, "bff-state");
  for (const dir of ["state", "ui-db", "evidence"]) {
    mkdirSync(join(bffStateRoot, dir), { recursive: true, mode: 0o700 });
  }
  const scripted = createScriptedOpenCodeHarness();
  const script = journeyScript(config);
  const resolver = createFunctionalRuntimeResolver({
    portable: scriptedFunctionalPortable(stateDir),
    runtimeStateRoot: join(stateDir, "runtime-state"),
    gatewayUrl: `http://${UI_HOST}:${String(port)}/api/coding-sidecar/gateway`,
    workspaceLifecycle: services.lifecycle,
    managedTaskWorkspaceRoot: config.managedRoot(stateDir),
    readWorkspaceHead: readProductionWorkspaceHead,
    verificationRunner: verificationRunner(config.fixtureLabel),
    runtimeEvidence: createCodingRuntimeEvidenceAggregator(createInMemoryEvidenceStore()),
    createSupervisor: scripted.createSupervisor,
  });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    KEIKO_STATE_DIR: join(bffStateRoot, "state"),
    ...(config.launcherSessionSecret === undefined
      ? {}
      : { [SESSION_PAIRING_LAUNCHER_SECRET_ENV]: config.launcherSessionSecret }),
  };
  const deps = buildUiHandlerDeps({
    configPath: undefined,
    evidenceDir: join(bffStateRoot, "evidence"),
    env,
    uiDbPath: join(bffStateRoot, "ui-db", "keiko-ui.db"),
    workspaceProvisioning: services.provisioning,
    workspaceLifecycle: services.lifecycle,
    workspaceReconciliation: services.reconciliation,
    codingRuntimeResolver: resolver,
    codingRuntimeDeploymentCeiling: "autonomous-delivery",
    codingRuntimeServerPrincipal: () => `${config.fixtureId}-operator`,
    autonomousDeliveryDeploymentCeiling: "autonomous-delivery",
  });
  return { deps: scriptedModelDeps(deps, script, config.includeQuestion), scripted };
}

function journeyScript(config: CodingRuntimeJourneyServerConfig): ScriptState {
  return {
    mode: "productive",
    calls: 0,
    old: config.originalContent,
    next: config.editedContent,
  };
}

function registerManagedProject(
  provisioning: WorkspaceProvisioningService,
  store: () => UiHandlerDeps["store"] | undefined,
  fixtureLabel: string,
): WorkspaceProvisioningService {
  return {
    provision: async (request): ReturnType<WorkspaceProvisioningService["provision"]> => {
      const result = await provisioning.provision(request);
      store()?.createProject(result.instance.managedWorktreePath, fixtureLabel);
      return result;
    },
    activate: (request) => provisioning.activate(request),
    getInstance: (workspaceId) => provisioning.getInstance(workspaceId),
  };
}

function gatewayObserver(): ((request: GatewayRequest) => void) | undefined {
  const outputPath = process.env.KEIKO_2483_GATEWAY_OBSERVATION_PATH;
  if (outputPath === undefined || outputPath.length === 0) return undefined;
  let requestCount = 0;
  const outputLimits = new Set<number>();
  return (request): void => {
    requestCount += 1;
    if (request.maxOutputTokens !== undefined) outputLimits.add(request.maxOutputTokens);
    mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      outputPath,
      `${JSON.stringify({
        schemaVersion: 1,
        requestCount,
        outputTokenLimits: [...outputLimits].sort((left, right) => left - right),
        contentFieldsRecorded: false,
      })}\n`,
      { mode: 0o600 },
    );
  };
}

function productionDiscoveryComposition(
  config: CodingRuntimeJourneyServerConfig,
  stateDir: string,
  port: number,
  services: JourneyWorkspaceServices,
): JourneyComposition {
  const projectStore: { current: UiHandlerDeps["store"] | undefined } = { current: undefined };
  const observeGatewayRequest = gatewayObserver();
  const provisioning = registerManagedProject(
    services.provisioning,
    () => projectStore.current,
    config.fixtureLabel,
  );
  const deps = productionDiscoveryBffDeps({
    stateRoot: join(stateDir, "bff-state"),
    workspaceProvisioning: provisioning,
    workspaceLifecycle: services.lifecycle,
    workspaceReconciliation: services.reconciliation,
    script: journeyScript(config),
    uiPort: port,
    ...(config.launcherSessionSecret === undefined
      ? {}
      : { launcherSessionSecret: config.launcherSessionSecret }),
    ...(observeGatewayRequest === undefined ? {} : { observeGatewayRequest }),
  });
  projectStore.current = deps.store;
  return { deps };
}

function collectHtmlDocuments(dir: string): readonly string[] {
  const documents: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) documents.push(...collectHtmlDocuments(full));
    else if (entry.name.endsWith(".html")) documents.push(readFileSync(full, "utf8"));
  }
  return documents;
}

function registerShutdown(server: Server, composition: JourneyComposition): void {
  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    void (async (): Promise<void> => {
      await composition.deps.codingRuntimeOrchestrator?.shutdown();
      await composition.scripted?.closeAll();
      await composition.deps.dispose?.();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      process.exit(0);
    })();
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}

function assertProductionDiscovery(deps: UiHandlerDeps): void {
  if (
    deps.env.KEIKO_OPENCODE_REAL_BINARY !== undefined ||
    deps.env.KEIKO_OPENCODE_REAL_RESOURCE_ROOT !== undefined
  ) {
    throw new Error("real-binary-journey-runtime-seam-present");
  }
  const expectedUnavailable = process.env.KEIKO_2483_EXPECT_UNAVAILABLE_REASON;
  if (expectedUnavailable !== undefined) {
    if (
      deps.codingRuntimeHostQualified !== false ||
      deps.codingRuntimeUnavailableReason !== expectedUnavailable
    ) {
      throw new Error(
        `real-binary-journey-unavailability-mismatch:${String(
          deps.codingRuntimeUnavailableReason,
        )}`,
      );
    }
    process.stdout.write(`KEIKO_2483_UNAVAILABLE ${expectedUnavailable}\n`);
    return;
  }
  if (
    deps.codingRuntimeHostQualified !== true ||
    deps.codingRuntimeUnavailableReason !== undefined
  ) {
    throw new Error(
      `real-binary-journey-unqualified:${String(deps.codingRuntimeUnavailableReason)}`,
    );
  }
}

export async function runCodingRuntimeJourneyServer(
  config: CodingRuntimeJourneyServerConfig,
): Promise<void> {
  const rawStateDir = config.stateDir();
  mkdirSync(rawStateDir, { recursive: true });
  const stateDir = realpathSync(rawStateDir);
  const managedRoot = config.managedRoot(stateDir);
  mkdirSync(managedRoot, { recursive: true, mode: 0o700 });
  createRepositoryFixture(config, stateDir);
  const port = Number(process.env.KEIKO_E2E_UI_PORT ?? String(config.defaultPort));
  const services = createWorkspaceServices(managedRoot);
  const composition =
    config.runtime === "scripted"
      ? scriptedComposition(config, stateDir, port, services)
      : productionDiscoveryComposition(config, stateDir, port, services);
  if (config.runtime === "production-discovery") {
    assertProductionDiscovery(composition.deps);
    if (process.env.KEIKO_2483_EXPECT_UNAVAILABLE_REASON !== undefined) {
      await composition.deps.dispose?.();
      return;
    }
  }
  const staticRoot = join(process.cwd(), "dist", "ui", "static");
  const csp = buildCspHeader(extractInlineScriptHashes(collectHtmlDocuments(staticRoot)));
  const server = createUiServer({ staticRoot, csp, port, handlerDeps: composition.deps });
  registerShutdown(server, composition);
  await new Promise<void>((resolve) => {
    server.listen(port, UI_HOST, resolve);
  });
}
