// Shared TEST-ONLY server composition for the Code-task browser journeys (#2483). The two
// scripted entries and the real-binary production-discovery entry differ only in fixture identity,
// question behavior, app-session pairing, and runtime source; the workspace, BFF, static UI, CSP,
// shutdown, and deterministic provider-boundary wiring live here once.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
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
import type { ProductionCodingRuntimeResolverInput } from "../../../packages/keiko-server/src/coding-runtime/productionCodingRuntimeResolver.js";
import {
  createFunctionalRuntimeResolver,
  functionalGatewayConfig,
  productionDiscoveryBffDeps,
  scriptedResponse,
  scriptedTranscript,
  type ScriptState,
} from "../../../packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.functional/_support.js";
import { readProductionWorkspaceHead } from "../../../packages/keiko-server/src/coding-runtime/productionWorkspaceHeadReader.js";
import { researchRequestLineText } from "../../../packages/keiko-server/src/coding-runtime/researchEgressPort.js";
import {
  buildCspHeader,
  extractInlineScriptHashes,
} from "../../../packages/keiko-server/src/csp.js";
import {
  buildUiHandlerDeps,
  ensureManagedTaskWorkspaceIdentity,
  type UiHandlerDeps,
} from "../../../packages/keiko-server/src/deps.js";
import {
  createVerificationRunnerManager,
  type VerificationRunnerManager,
} from "../../../packages/keiko-server/src/editor/verificationRunner.js";
import { createUiServer, UI_HOST } from "../../../packages/keiko-server/src/server.js";
import { createInMemoryUiStore } from "../../../packages/keiko-server/src/store/index.js";
import { createCodingRuntimeSnapshotStore } from "../../../packages/keiko-server/src/coding-runtime/codingRuntimeSnapshotStore.js";
import { runMigrations } from "../../../packages/keiko-server/src/store/schema.js";
import { buildActiveWorkspacePointerStoreOverDatabase } from "../../../packages/keiko-server/src/task-workspace/active-store.js";
import { createWorkspaceLifecycleService } from "../../../packages/keiko-server/src/task-workspace/lifecycle.js";
import { createWorkspaceMutexRegistry } from "../../../packages/keiko-server/src/task-workspace/mutex.js";
import { createWorkspaceProvisioningService } from "../../../packages/keiko-server/src/task-workspace/provisioning.js";
import { createWorkspaceReconciliationService } from "../../../packages/keiko-server/src/task-workspace/reconciliation.js";
import { buildWorkspaceInstanceStoreOverDatabase } from "../../../packages/keiko-server/src/task-workspace/store.js";
import { createWorkspaceScriptTrustService } from "../../../packages/keiko-server/src/workspace-script-trust.js";

type WorkspaceAdapterFactory = (
  workspace: Parameters<typeof createNodeGitWorktreeAdapter>[0]["workspace"],
) => ReturnType<typeof createNodeGitWorktreeAdapter>;

interface JourneyWorkspaceServices {
  readonly provisioning: ReturnType<typeof createWorkspaceProvisioningService>;
  readonly lifecycle: ReturnType<typeof createWorkspaceLifecycleService>;
  readonly reconciliation: ReturnType<typeof createWorkspaceReconciliationService>;
  readonly uiStore: ReturnType<typeof createInMemoryUiStore>;
  readonly workspaceScriptTrust: ReturnType<typeof createWorkspaceScriptTrustService>;
  // Injecting `uiStore` into the BFF assembly suppresses its own persistence composition, so the
  // journey must bring the snapshot-store companion or the coding-runtime control plane is never
  // assembled and production discovery refuses as unqualified (the daily lane outage after #2835).
  readonly codingRuntimeSnapshots: ReturnType<typeof createCodingRuntimeSnapshotStore>;
}

/**
 * #2642: the research seams the #2387 journey needs on top of the scripted composition. When
 * present, the shared server opens the network-egress class, injects the hermetic transport, wires
 * the read-only child model, projects the injection directive into the script state, records every
 * scripted tool name to the journey-owned log, and asserts the URL/host/request-line invariants
 * before it accepts a connection — so the entry file can stay declarative.
 */
export interface CodingRuntimeResearchJourneyConfig {
  /** The public URL the scripted model asks to research. */
  readonly journeyUrl: string;
  /** The host the hermetic transport must answer for; all other hosts fail closed. */
  readonly journeyHost: string;
  /** The sanitized request line the approval panel must show for `journeyUrl`. */
  readonly expectedRequestLine: string;
  /** The visible directive the granted page carries; projected into the script state. */
  readonly injectionDirective: string;
  /**
   * Builds the hermetic research transport. Called once per boot; the returned fetch is the ONLY
   * network seam the resolver sees.
   */
  readonly hermeticFetch: () => (url: string) => Promise<Response>;
  /**
   * The scripted response the read-only child model returns. Production resolves the same model
   * through the gateway; the journey holds this stub so the child never touches the network.
   */
  readonly childModelResponse: () => NormalizedResponse;
  /** Provider model id served by `childModelResponse`; keeps the mounted port and profile aligned. */
  readonly childModelId: string;
  /** Path (derived from stateDir) the shared server appends every scripted tool name to. */
  readonly toolCallLogPath: (stateDir: string) => string;
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
  /** #2642: opt-in research runtime seams. Only meaningful when `runtime === "scripted"`. */
  readonly research?: CodingRuntimeResearchJourneyConfig | undefined;
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
  const uiStore = createInMemoryUiStore();
  const workspaceScriptTrust = createWorkspaceScriptTrustService({ store: uiStore });
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
  const provisioning = createWorkspaceProvisioningService({
    ...shared,
    ensureManagedWorkspaceIdentity: (instance, initializeTrust): void => {
      ensureManagedTaskWorkspaceIdentity({
        uiStore,
        workspaceScriptTrust,
        instance,
        initializeTrust,
      });
    },
    mutex,
  });
  const lifecycle = createWorkspaceLifecycleService({
    ...shared,
    activePointerStore,
    provisioning,
    mutex,
  });
  const reconciliation = createWorkspaceReconciliationService({ ...shared, activePointerStore });
  return {
    provisioning,
    lifecycle,
    reconciliation,
    uiStore,
    workspaceScriptTrust,
    codingRuntimeSnapshots: createCodingRuntimeSnapshotStore(db),
  };
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

function nextScriptedTurn(
  script: ScriptState,
  includeQuestion: boolean,
  transcript: string,
): NormalizedResponse {
  let response = scriptedResponse(script, transcript);
  while (!includeQuestion && response.toolCalls.some((call) => call.name === "question")) {
    response = scriptedResponse(script, transcript);
  }
  return response;
}

function scriptedModelDeps(
  deps: UiHandlerDeps,
  script: ScriptState,
  includeQuestion: boolean,
): UiHandlerDeps {
  // #2642: research mode reads the fenced-untrusted transcript to prove the granted page's directive
  // reaches the model without being complied with; productive/discovery/out-of-scope modes ignore
  // the transcript, so passing it always is behaviour-preserving.
  const chat = (request?: GatewayRequest): Promise<NormalizedResponse> =>
    Promise.resolve(nextScriptedTurn(script, includeQuestion, scriptedTranscript(request)));
  return {
    ...deps,
    config: functionalGatewayConfig(),
    configPresent: true,
    gatewayConfig: undefined,
    codingSidecarGatewayChatFactory: () => chat,
    codingSidecarGatewayChatStreamFactory: () =>
      async function* (request: GatewayRequest): AsyncIterable<GatewayStreamChunk> {
        yield { type: "done" as const, response: await chat(request) };
      },
  };
}

function researchResolverSeams(research: CodingRuntimeResearchJourneyConfig): {
  readonly researchEgressEnabled: true;
  readonly researchFetchImpl: NonNullable<
    ProductionCodingRuntimeResolverInput["researchFetchImpl"]
  >;
  readonly childModelPortFactory: NonNullable<
    ProductionCodingRuntimeResolverInput["childModelPortFactory"]
  >;
  readonly childModelId: string;
} {
  const fetchImpl = research.hermeticFetch();
  return {
    researchEgressEnabled: true,
    researchFetchImpl: fetchImpl,
    childModelPortFactory: () => ({
      call: (): Promise<NormalizedResponse> => {
        const response = research.childModelResponse();
        return response.modelId === research.childModelId
          ? Promise.resolve(response)
          : Promise.reject(new Error("research-child-model-id-mismatch"));
      },
    }),
    childModelId: research.childModelId,
  };
}

function scriptedResolver(
  config: CodingRuntimeJourneyServerConfig,
  stateDir: string,
  port: number,
  services: JourneyWorkspaceServices,
  scripted: ScriptedOpenCodeHarness,
): ReturnType<typeof createFunctionalRuntimeResolver> {
  const input = {
    portable: scriptedFunctionalPortable(stateDir),
    runtimeStateRoot: join(stateDir, "runtime-state"),
    gatewayUrl: `http://${UI_HOST}:${String(port)}/api/coding-sidecar/gateway`,
    workspaceLifecycle: services.lifecycle,
    managedTaskWorkspaceRoot: config.managedRoot(stateDir),
    readWorkspaceHead: readProductionWorkspaceHead,
    verificationRunner: verificationRunner(config.fixtureLabel),
    runtimeEvidence: createCodingRuntimeEvidenceAggregator(createInMemoryEvidenceStore()),
    createSupervisor: scripted.createSupervisor,
  };
  return config.research === undefined
    ? createFunctionalRuntimeResolver(input)
    : createFunctionalRuntimeResolver({
        ...input,
        ...researchResolverSeams(config.research),
      });
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
  const script = journeyScript(config, stateDir);
  const resolver = scriptedResolver(config, stateDir, port, services, scripted);
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
    store: services.uiStore,
    codingRuntimeSnapshotStore: services.codingRuntimeSnapshots,
    workspaceScriptTrust: services.workspaceScriptTrust,
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

function journeyScript(config: CodingRuntimeJourneyServerConfig, stateDir: string): ScriptState {
  if (config.research === undefined) {
    return {
      mode: "productive",
      calls: 0,
      old: config.originalContent,
      next: config.editedContent,
    };
  }
  const logPath = config.research.toolCallLogPath(stateDir);
  const injectionDirective = config.research.injectionDirective;
  // Truncate the log up front so a reused stateDir (a server restarted without the Playwright
  // config's prepare step running first) cannot bleed a prior run's tool names into
  // `expectNoMutationWasAttempted()` and falsely flip a clean current run to failed.
  writeFileSync(logPath, "", { mode: 0o600 });
  return {
    mode: "research",
    calls: 0,
    old: config.originalContent,
    next: config.editedContent,
    injectionDirective,
    observeToolCall: (name: string): void => {
      appendFileSync(logPath, `${name}\n`, { mode: 0o600 });
    },
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
  const observeGatewayRequest = gatewayObserver();
  const deps = productionDiscoveryBffDeps({
    stateRoot: join(stateDir, "bff-state"),
    store: services.uiStore,
    codingRuntimeSnapshotStore: services.codingRuntimeSnapshots,
    workspaceScriptTrust: services.workspaceScriptTrust,
    workspaceProvisioning: services.provisioning,
    workspaceLifecycle: services.lifecycle,
    workspaceReconciliation: services.reconciliation,
    script: journeyScript(config, stateDir),
    uiPort: port,
    ...(config.launcherSessionSecret === undefined
      ? {}
      : { launcherSessionSecret: config.launcherSessionSecret }),
    ...(observeGatewayRequest === undefined ? {} : { observeGatewayRequest }),
  });
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

// A lingering SSE connection keeps `server.close()`'s callback from ever firing. Bounding the wait
// turns "the harness eventually kills us" into a deterministic exit we control.
const SERVER_CLOSE_TIMEOUT_MS = 5_000;

function registerShutdown(server: Server, composition: JourneyComposition): void {
  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    void (async (): Promise<void> => {
      // KEIKO-0429: this is the shared shutdown path for every Code-task journey server
      // (#2385, #2386, #2387, #2483). Unhandled, a rejecting stage surfaced as a bare
      // unhandled-rejection trace with nothing naming WHICH resource failed to dispose, and a
      // never-resolving server.close() surfaced as a hang — both read as flake, and each costs a
      // full CI cycle to re-diagnose. Naming the stage is the whole point: the exit code alone
      // cannot distinguish an orchestrator that refused to stop from a socket that stayed open.
      let stage = "codingRuntimeOrchestrator.shutdown";
      try {
        await composition.deps.codingRuntimeOrchestrator?.shutdown();
        stage = "scripted.closeAll";
        await composition.scripted?.closeAll();
        stage = "deps.dispose";
        await composition.deps.dispose?.();
        stage = "server.close";
        // The timeout REJECTS rather than resolves. Resolving would have let a socket that never
        // closed fall through to the exit(0) below — turning the hang this bound exists to surface
        // back into a silent clean shutdown, which is the defect KEIKO-0429 is about, one layer
        // further down (review finding on #3159).
        await Promise.race([
          new Promise<void>((resolve) => {
            server.close(() => {
              resolve();
            });
          }),
          new Promise<void>((_resolve, reject) => {
            setTimeout(() => {
              reject(
                new Error(
                  `server.close did not complete within ${String(SERVER_CLOSE_TIMEOUT_MS)}ms ` +
                    "(a connection is still open)",
                ),
              );
            }, SERVER_CLOSE_TIMEOUT_MS).unref();
          }),
        ]);
      } catch (error) {
        // The STAGE is the diagnostic; the error text can carry a path or payload the disposing
        // resource was holding. Stage plus error type answers "which resource failed to dispose"
        // without reproducing what it held (review finding on #3159).
        process.stderr.write(
          `[coding-runtime-server] shutdown failed during ${stage}: ${
            error instanceof Error ? error.constructor.name : typeof error
          }\n`,
        );
        process.exit(1);
      }
      process.exit(0);
    })();
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}

function assertResearchInvariants(research: CodingRuntimeResearchJourneyConfig): void {
  // The journey URL constant and the hermetic transport must agree on the host, or every fetch
  // would fail closed for the wrong reason and the journey would time out confusingly.
  if (new URL(research.journeyUrl).hostname !== research.journeyHost) {
    throw new Error("research journey host mismatch");
  }
  // The spec asserts the approval panel shows this exact request line; deriving it from the
  // production sanitizer makes a silent drift between the fixture and the server impossible.
  if (researchRequestLineText(new URL(research.journeyUrl)) !== research.expectedRequestLine) {
    throw new Error("research journey request-line mismatch");
  }
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
    // Name the actual composition state instead of losing it: an absent control plane carries NO
    // unavailable reason (the assembly skipped it entirely — for months this rendered as the
    // useless "unqualified:undefined"), while a present-but-unqualified host names its reason.
    const reason =
      deps.codingRuntimeUnavailableReason ??
      (deps.codingRuntimeOrchestrator === undefined
        ? "control-plane-absent (injected store without a codingRuntimeSnapshotStore companion?)"
        : "unqualified-without-reason");
    throw new Error(`real-binary-journey-unqualified:${reason}`);
  }
}

export async function runCodingRuntimeJourneyServer(
  config: CodingRuntimeJourneyServerConfig,
): Promise<void> {
  if (config.research !== undefined) assertResearchInvariants(config.research);
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
