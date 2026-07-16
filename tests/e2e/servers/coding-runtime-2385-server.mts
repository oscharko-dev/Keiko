// Test-only server entry for the #2385 Code Task OpenCode tracer (Playwright webServer).
//
// It boots the REAL packages/keiko-server composition — buildUiHandlerDeps + createUiServer over the
// real static UI export — against a hermetic temp state dir, and injects exactly the seams the
// in-process functional pipeline test already proves
// (packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.functional.test.ts):
//
//   1. `codingRuntimeResolver` built by createFunctionalRuntimeResolver over the scripted OpenCode
//      harness (FakeOpenCodeChild — a real loopback HTTP/OpenAPI-3.1+SSE child behind per-run Basic
//      auth) so the governed start → SSE → contained edit → vetted verification loop runs with no
//      OpenCode binary and no Windows payload.
//   2. The gateway config + OpenAI-compatible chat factories swapped to the scripted model
//      (functionalGatewayConfig / scriptedResponse), with the interactive `question` step skipped
//      because the workbench UI intentionally exposes no question surface.
//
// Everything else — routes, control plane, orchestrator, event hub/SSE, evidence, task-workspace
// provisioning/lifecycle/reconciliation — is the production wiring. No production module changes;
// the scripted machinery lives in *_support.ts files that are excluded from the package build, so
// this composition is structurally unreachable in packaged builds.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { GatewayStreamChunk, NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import { createNodeGitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";

import {
  buildCspHeader,
  extractInlineScriptHashes,
} from "../../../packages/keiko-server/src/csp.js";
import { buildUiHandlerDeps, type UiHandlerDeps } from "../../../packages/keiko-server/src/deps.js";
import { createUiServer, UI_HOST } from "../../../packages/keiko-server/src/server.js";
import { createInMemoryUiStore } from "../../../packages/keiko-server/src/store/index.js";
import { runMigrations } from "../../../packages/keiko-server/src/store/schema.js";
import {
  createVerificationRunnerManager,
  type VerificationRunnerManager,
} from "../../../packages/keiko-server/src/editor/verificationRunner.js";
import { buildActiveWorkspacePointerStoreOverDatabase } from "../../../packages/keiko-server/src/task-workspace/active-store.js";
import { createWorkspaceLifecycleService } from "../../../packages/keiko-server/src/task-workspace/lifecycle.js";
import { createWorkspaceMutexRegistry } from "../../../packages/keiko-server/src/task-workspace/mutex.js";
import { createWorkspaceProvisioningService } from "../../../packages/keiko-server/src/task-workspace/provisioning.js";
import { createWorkspaceReconciliationService } from "../../../packages/keiko-server/src/task-workspace/reconciliation.js";
import { buildWorkspaceInstanceStoreOverDatabase } from "../../../packages/keiko-server/src/task-workspace/store.js";
import { createCodingRuntimeEvidenceAggregator } from "../../../packages/keiko-server/src/coding-runtime/codingRuntimeEvidenceAggregator.js";
import { readProductionWorkspaceHead } from "../../../packages/keiko-server/src/coding-runtime/productionWorkspaceHeadReader.js";
import {
  createScriptedOpenCodeHarness,
  scriptedFunctionalPortable,
  type ScriptedOpenCodeHarness,
} from "../../../packages/keiko-server/src/coding-runtime/opencodeFunctionalHarness/_support.js";
import {
  createFunctionalRuntimeResolver,
  functionalGatewayConfig,
  scriptedResponse,
  type ScriptState,
} from "../../../packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.functional/_support.js";
import {
  TRACER_DEFAULT_UI_PORT,
  TRACER_EDITED_CONTENT,
  TRACER_ORIGINAL_CONTENT,
  TRACER_TARGET_RELATIVE_PATH,
  tracerManagedWorkspaceRoot,
  tracerRepositoryRoot,
  tracerStateDir,
} from "../support/coding-runtime-2385-tracer.js";

type WorkspaceAdapterFactory = (
  workspace: Parameters<typeof createNodeGitWorktreeAdapter>[0]["workspace"],
) => ReturnType<typeof createNodeGitWorktreeAdapter>;

interface TracerWorkspaceServices {
  readonly provisioning: ReturnType<typeof createWorkspaceProvisioningService>;
  readonly lifecycle: ReturnType<typeof createWorkspaceLifecycleService>;
  readonly reconciliation: ReturnType<typeof createWorkspaceReconciliationService>;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

// The local git checkout the tracer binds: one commit containing the scripted edit target and a
// deterministic `typecheck` script the vetted verification step executes inside the managed
// worktree. Mirrors the functional pipeline test's workspace fixture.
function createRepositoryFixture(stateDir: string): void {
  const repository = tracerRepositoryRoot(stateDir);
  mkdirSync(join(repository, "src"), { recursive: true });
  git(repository, ["init", "-q", "-b", "main"]);
  git(repository, ["config", "user.email", "tracer@keiko.example"]);
  git(repository, ["config", "user.name", "Keiko Tracer"]);
  git(repository, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repository, TRACER_TARGET_RELATIVE_PATH), TRACER_ORIGINAL_CONTENT);
  writeFileSync(
    join(repository, "package.json"),
    JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(0)"' } }),
  );
  git(repository, ["add", "."]);
  git(repository, ["commit", "-q", "-m", "tracer fixture"]);
}

// One sqlite-backed store shared by provisioning, active-binding lifecycle, AND reconciliation, so
// the /api/task-workspaces routes, the #447 reconciliation route, and the injected runtime
// resolver's workspace authority all observe the same instances (as production composes them).
function createTracerWorkspaceServices(managedRoot: string): TracerWorkspaceServices {
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

// The managed tool facade calls runToReport with the ACTIVE managed worktree as projectId; the
// worktree only exists after the browser binds it, so the backing project is registered lazily.
function tracerVerificationRunner(): Pick<VerificationRunnerManager, "runToReport"> {
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
        store.createProject(input.projectId, "tracer-2385");
        registered.add(input.projectId);
      }
      return manager.runToReport(input, signal);
    },
  };
}

// The scripted model turn, minus the interactive `question` step: the Coding Workbench exposes no
// runtime-question surface (questions are answered through the orchestrator API only), so a pending
// question would stall the browser journey instead of exercising it. Skipping keeps the proven
// read -> contained edit -> vetted verification sequence intact.
function nextScriptedTurn(script: ScriptState): NormalizedResponse {
  let response = scriptedResponse(script);
  while (response.toolCalls.some((call) => call.name === "question")) {
    response = scriptedResponse(script);
  }
  return response;
}

// Exactly the two gateway seams functionalBffDeps replaces: fixture gateway config + scripted
// OpenAI-compatible chat factories. Every route and control-plane surface stays production wiring.
function tracerHandlerDeps(deps: UiHandlerDeps, script: ScriptState): UiHandlerDeps {
  const chat = (): Promise<NormalizedResponse> => Promise.resolve(nextScriptedTurn(script));
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

function collectHtmlDocuments(dir: string): readonly string[] {
  const documents: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) documents.push(...collectHtmlDocuments(full));
    else if (entry.name.endsWith(".html")) documents.push(readFileSync(full, "utf8"));
  }
  return documents;
}

function registerShutdown(
  server: Server,
  deps: UiHandlerDeps,
  scripted: ScriptedOpenCodeHarness,
): void {
  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    void (async (): Promise<void> => {
      await deps.codingRuntimeOrchestrator?.shutdown();
      await scripted.closeAll();
      await deps.dispose?.();
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

interface TracerComposition {
  readonly handlerDeps: UiHandlerDeps;
  readonly scripted: ScriptedOpenCodeHarness;
}

function buildTracerComposition(stateDir: string, port: number): TracerComposition {
  const bffStateRoot = join(stateDir, "bff-state");
  for (const dir of ["state", "ui-db", "evidence"]) {
    mkdirSync(join(bffStateRoot, dir), { recursive: true, mode: 0o700 });
  }
  const managedRoot = tracerManagedWorkspaceRoot(stateDir);
  mkdirSync(managedRoot, { recursive: true, mode: 0o700 });
  const services = createTracerWorkspaceServices(managedRoot);
  const scripted = createScriptedOpenCodeHarness();
  const script: ScriptState = {
    mode: "productive",
    calls: 0,
    old: TRACER_ORIGINAL_CONTENT,
    next: TRACER_EDITED_CONTENT,
  };
  const resolver = createFunctionalRuntimeResolver({
    portable: scriptedFunctionalPortable(stateDir),
    runtimeStateRoot: join(stateDir, "runtime-state"),
    gatewayUrl: `http://${UI_HOST}:${String(port)}/api/coding-sidecar/gateway`,
    workspaceLifecycle: services.lifecycle,
    managedTaskWorkspaceRoot: managedRoot,
    readWorkspaceHead: readProductionWorkspaceHead,
    verificationRunner: tracerVerificationRunner(),
    runtimeEvidence: createCodingRuntimeEvidenceAggregator(createInMemoryEvidenceStore()),
    createSupervisor: scripted.createSupervisor,
  });
  const deps = buildUiHandlerDeps({
    configPath: undefined,
    evidenceDir: join(bffStateRoot, "evidence"),
    env: { PATH: process.env.PATH ?? "", KEIKO_STATE_DIR: join(bffStateRoot, "state") },
    uiDbPath: join(bffStateRoot, "ui-db", "keiko-ui.db"),
    workspaceProvisioning: services.provisioning,
    workspaceLifecycle: services.lifecycle,
    workspaceReconciliation: services.reconciliation,
    codingRuntimeResolver: resolver,
    codingRuntimeDeploymentCeiling: "autonomous-delivery",
    codingRuntimeServerPrincipal: () => "tracer-operator",
    autonomousDeliveryDeploymentCeiling: "autonomous-delivery",
  });
  return { handlerDeps: tracerHandlerDeps(deps, script), scripted };
}

async function main(): Promise<void> {
  const rawStateDir = tracerStateDir();
  mkdirSync(rawStateDir, { recursive: true });
  const stateDir = realpathSync(rawStateDir);
  const port = Number(process.env.KEIKO_E2E_UI_PORT ?? String(TRACER_DEFAULT_UI_PORT));
  createRepositoryFixture(stateDir);
  const { handlerDeps, scripted } = buildTracerComposition(stateDir, port);
  const staticRoot = join(process.cwd(), "dist", "ui", "static");
  const csp = buildCspHeader(extractInlineScriptHashes(collectHtmlDocuments(staticRoot)));
  const server = createUiServer({ staticRoot, csp, port, handlerDeps });
  registerShutdown(server, handlerDeps, scripted);
  await new Promise<void>((resolve) => {
    server.listen(port, UI_HOST, resolve);
  });
}

await main();
