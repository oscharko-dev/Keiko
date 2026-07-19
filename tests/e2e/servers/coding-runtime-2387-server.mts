// Test-only server entry for the #2387 governed-research Coding Workbench journey (Playwright
// webServer). Copied from tests/e2e/servers/coding-runtime-2386-server.mts and adapted for #2387.
//
// It boots the REAL packages/keiko-server composition — buildUiHandlerDeps + createUiServer over
// the real static UI export — against a hermetic temp state dir, and injects bounded test seams:
// the fixture gateway config, the scripted OpenAI-compatible chat factories (script mode
// "research": the model asks for one exact public URL, retries after approval, retries after
// revoke), the hermetic research transport (`researchFetchImpl`), and a deterministic child model.
// No test seam touches the real network. Every route and control-plane surface — approvals, the research
// grant snapshot projection, and POST /runs/:runId/research/revoke — is the production wiring.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { GatewayStreamChunk, NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import { createNodeGitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";

import { SESSION_PAIRING_LAUNCHER_SECRET_ENV } from "../../../packages/keiko-server/src/coding-app-session/launcherSessionPairingPort.js";

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
  RESEARCH_JOURNEY_URL,
  type ScriptState,
} from "../../../packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.functional/_support.js";
import {
  RESEARCH_DEFAULT_UI_PORT,
  RESEARCH_APP_SESSION_LAUNCHER_SECRET,
  RESEARCH_JOURNEY_HOST,
  researchManagedWorkspaceRoot,
  researchRepositoryRoot,
  researchStateDir,
} from "../support/coding-runtime-2387-research.js";

type WorkspaceAdapterFactory = (
  workspace: Parameters<typeof createNodeGitWorktreeAdapter>[0]["workspace"],
) => ReturnType<typeof createNodeGitWorktreeAdapter>;

interface ResearchWorkspaceServices {
  readonly provisioning: ReturnType<typeof createWorkspaceProvisioningService>;
  readonly lifecycle: ReturnType<typeof createWorkspaceLifecycleService>;
  readonly reconciliation: ReturnType<typeof createWorkspaceReconciliationService>;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

// The local git checkout the journey binds. The research journey never edits it, but binding a real
// repository is required before a run can start.
function createRepositoryFixture(stateDir: string): void {
  const repository = researchRepositoryRoot(stateDir);
  mkdirSync(join(repository, "src"), { recursive: true });
  git(repository, ["init", "-q", "-b", "main"]);
  git(repository, ["config", "user.email", "research@keiko.example"]);
  git(repository, ["config", "user.name", "Keiko Research"]);
  git(repository, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repository, "src", "example.ts"), "export const value = 'RESEARCH_2387';\n");
  writeFileSync(
    join(repository, "package.json"),
    JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(0)"' } }),
  );
  git(repository, ["add", "."]);
  git(repository, ["commit", "-q", "-m", "research fixture"]);
}

// One sqlite-backed store shared by provisioning, active-binding lifecycle, AND reconciliation, so
// the /api/task-workspaces routes and the injected runtime resolver's workspace authority all
// observe the same instances (as production composes them).
function createResearchWorkspaceServices(managedRoot: string): ResearchWorkspaceServices {
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

function researchVerificationRunner(): Pick<VerificationRunnerManager, "runToReport"> {
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
        store.createProject(input.projectId, "research-2387");
        registered.add(input.projectId);
      }
      return manager.runToReport(input, signal);
    },
  };
}

// The hermetic research transport: answers ONLY for the journey URL's host with a deterministic
// page body; anything else fails closed exactly like a blocked network. No socket is ever opened.
function hermeticResearchFetch(): (url: string) => Promise<Response> {
  return (url: string): Promise<Response> => {
    if (new URL(url).hostname !== RESEARCH_JOURNEY_HOST) {
      return Promise.reject(new Error("blocked-by-hermetic-transport"));
    }
    return Promise.resolve(
      new Response("<html><body>Backpressure guide</body></html>", { status: 200 }),
    );
  };
}

function childResponse(): NormalizedResponse {
  return {
    modelId: "functional-model",
    content: "Read-only repository inspection complete",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "child-2387",
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      costClass: "low",
    },
  };
}

// Exactly the gateway seams the functional harness replaces: fixture gateway config + scripted
// OpenAI-compatible chat factories. Every route and control-plane surface stays production wiring.
function researchHandlerDeps(deps: UiHandlerDeps, script: ScriptState): UiHandlerDeps {
  const chat = (): Promise<NormalizedResponse> => Promise.resolve(scriptedResponse(script));
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

interface ResearchComposition {
  readonly handlerDeps: UiHandlerDeps;
  readonly scripted: ScriptedOpenCodeHarness;
}

function buildResearchComposition(stateDir: string, port: number): ResearchComposition {
  const bffStateRoot = join(stateDir, "bff-state");
  for (const dir of ["state", "ui-db", "evidence"]) {
    mkdirSync(join(bffStateRoot, dir), { recursive: true, mode: 0o700 });
  }
  const managedRoot = researchManagedWorkspaceRoot(stateDir);
  mkdirSync(managedRoot, { recursive: true, mode: 0o700 });
  const services = createResearchWorkspaceServices(managedRoot);
  const scripted = createScriptedOpenCodeHarness();
  const script: ScriptState = { mode: "research", calls: 0, old: "", next: "" };
  const resolver = createFunctionalRuntimeResolver({
    portable: scriptedFunctionalPortable(stateDir),
    runtimeStateRoot: join(stateDir, "runtime-state"),
    gatewayUrl: `http://${UI_HOST}:${String(port)}/api/coding-sidecar/gateway`,
    workspaceLifecycle: services.lifecycle,
    managedTaskWorkspaceRoot: managedRoot,
    readWorkspaceHead: readProductionWorkspaceHead,
    verificationRunner: researchVerificationRunner(),
    runtimeEvidence: createCodingRuntimeEvidenceAggregator(createInMemoryEvidenceStore()),
    createSupervisor: scripted.createSupervisor,
    researchEgressEnabled: true,
    researchFetchImpl: hermeticResearchFetch(),
    childModelPortFactory: () => ({ call: () => Promise.resolve(childResponse()) }),
  });
  const deps = buildUiHandlerDeps({
    configPath: undefined,
    evidenceDir: join(bffStateRoot, "evidence"),
    env: {
      PATH: process.env.PATH ?? "",
      KEIKO_STATE_DIR: join(bffStateRoot, "state"),
      [SESSION_PAIRING_LAUNCHER_SECRET_ENV]: RESEARCH_APP_SESSION_LAUNCHER_SECRET,
    },
    uiDbPath: join(bffStateRoot, "ui-db", "keiko-ui.db"),
    workspaceProvisioning: services.provisioning,
    workspaceLifecycle: services.lifecycle,
    workspaceReconciliation: services.reconciliation,
    codingRuntimeResolver: resolver,
    codingRuntimeDeploymentCeiling: "autonomous-delivery",
    codingRuntimeServerPrincipal: () => "research-operator",
    autonomousDeliveryDeploymentCeiling: "autonomous-delivery",
  });
  return { handlerDeps: researchHandlerDeps(deps, script), scripted };
}

async function main(): Promise<void> {
  const rawStateDir = researchStateDir();
  mkdirSync(rawStateDir, { recursive: true });
  const stateDir = realpathSync(rawStateDir);
  const port = Number(process.env.KEIKO_E2E_UI_PORT ?? String(RESEARCH_DEFAULT_UI_PORT));
  createRepositoryFixture(stateDir);
  const { handlerDeps, scripted } = buildResearchComposition(stateDir, port);
  const staticRoot = join(process.cwd(), "dist", "ui", "static");
  const csp = buildCspHeader(extractInlineScriptHashes(collectHtmlDocuments(staticRoot)));
  const server = createUiServer({ staticRoot, csp, port, handlerDeps });
  registerShutdown(server, handlerDeps, scripted);
  // The journey URL constant and the hermetic transport must agree on the host, or every fetch
  // would fail closed for the wrong reason and the journey would time out confusingly.
  if (new URL(RESEARCH_JOURNEY_URL).hostname !== RESEARCH_JOURNEY_HOST) {
    throw new Error("research journey host mismatch");
  }
  await new Promise<void>((resolve) => {
    server.listen(port, UI_HOST, resolve);
  });
}

await main();
