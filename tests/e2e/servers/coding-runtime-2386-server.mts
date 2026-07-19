// Test-only server entry for the #2386 real-authority Coding Workbench journey (Playwright
// webServer). Copied from tests/e2e/servers/coding-runtime-2385-server.mts and adapted for #2386.
//
// It boots the REAL packages/keiko-server composition — buildUiHandlerDeps + createUiServer over the
// real static UI export — against a hermetic temp state dir, and injects exactly the same two
// gateway seams the in-process functional pipeline test already proves
// (packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.functional.test.ts): the
// fixture gateway config and the scripted OpenAI-compatible chat factories. Every route and
// control-plane surface — including the #2386 question / pause / resume / follow-up routes now
// mounted behind loopback + CSRF + serverPrincipal — is the production wiring.
//
// Difference from the #2385 tracer entry: the scripted `question` turn is NOT skipped. #2386 mounts
// the runtime-question surface, so the required question must reach the browser for real. The
// deployment ceiling stays autonomous-delivery so every mode (including the default
// supervised-coding) and every grant is exercisable; the browser selects the mode.

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
import { SESSION_PAIRING_LAUNCHER_SECRET_ENV } from "../../../packages/keiko-server/src/coding-app-session/launcherSessionPairingPort.js";
import {
  AUTHORITY_APP_SESSION_LAUNCHER_SECRET,
  AUTHORITY_DEFAULT_UI_PORT,
  AUTHORITY_EDITED_CONTENT,
  AUTHORITY_ORIGINAL_CONTENT,
  AUTHORITY_TARGET_RELATIVE_PATH,
  authorityManagedWorkspaceRoot,
  authorityRepositoryRoot,
  authorityStateDir,
} from "../support/coding-runtime-2386-authority.js";

type WorkspaceAdapterFactory = (
  workspace: Parameters<typeof createNodeGitWorktreeAdapter>[0]["workspace"],
) => ReturnType<typeof createNodeGitWorktreeAdapter>;

interface AuthorityWorkspaceServices {
  readonly provisioning: ReturnType<typeof createWorkspaceProvisioningService>;
  readonly lifecycle: ReturnType<typeof createWorkspaceLifecycleService>;
  readonly reconciliation: ReturnType<typeof createWorkspaceReconciliationService>;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

// The local git checkout the journey binds: one commit containing the scripted edit target and a
// deterministic `typecheck` script the vetted verification step executes inside the managed
// worktree. Mirrors the functional pipeline test's workspace fixture.
function createRepositoryFixture(stateDir: string): void {
  const repository = authorityRepositoryRoot(stateDir);
  mkdirSync(join(repository, "src"), { recursive: true });
  git(repository, ["init", "-q", "-b", "main"]);
  git(repository, ["config", "user.email", "authority@keiko.example"]);
  git(repository, ["config", "user.name", "Keiko Authority"]);
  git(repository, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repository, AUTHORITY_TARGET_RELATIVE_PATH), AUTHORITY_ORIGINAL_CONTENT);
  writeFileSync(
    join(repository, "package.json"),
    JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(0)"' } }),
  );
  git(repository, ["add", "."]);
  git(repository, ["commit", "-q", "-m", "authority fixture"]);
}

// One sqlite-backed store shared by provisioning, active-binding lifecycle, AND reconciliation, so
// the /api/task-workspaces routes, the #447 reconciliation route, and the injected runtime
// resolver's workspace authority all observe the same instances (as production composes them).
function createAuthorityWorkspaceServices(managedRoot: string): AuthorityWorkspaceServices {
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
function authorityVerificationRunner(): Pick<VerificationRunnerManager, "runToReport"> {
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
        store.createProject(input.projectId, "authority-2386");
        registered.add(input.projectId);
      }
      return manager.runToReport(input, signal);
    },
  };
}

// The scripted model turn INCLUDING the interactive `question` step: #2386 mounts the runtime
// question surface, so the required question must reach the browser and halt the agent loop until
// answered/rejected. The proven read -> question -> contained edit -> vetted verification sequence
// runs end to end.
function nextScriptedTurn(script: ScriptState): NormalizedResponse {
  return scriptedResponse(script);
}

// Exactly the two gateway seams functionalBffDeps replaces: fixture gateway config + scripted
// OpenAI-compatible chat factories. Every route and control-plane surface stays production wiring.
function authorityHandlerDeps(deps: UiHandlerDeps, script: ScriptState): UiHandlerDeps {
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

interface AuthorityComposition {
  readonly handlerDeps: UiHandlerDeps;
  readonly scripted: ScriptedOpenCodeHarness;
}

function buildAuthorityComposition(stateDir: string, port: number): AuthorityComposition {
  const bffStateRoot = join(stateDir, "bff-state");
  for (const dir of ["state", "ui-db", "evidence"]) {
    mkdirSync(join(bffStateRoot, dir), { recursive: true, mode: 0o700 });
  }
  const managedRoot = authorityManagedWorkspaceRoot(stateDir);
  mkdirSync(managedRoot, { recursive: true, mode: 0o700 });
  const services = createAuthorityWorkspaceServices(managedRoot);
  const scripted = createScriptedOpenCodeHarness();
  const script: ScriptState = {
    mode: "productive",
    calls: 0,
    old: AUTHORITY_ORIGINAL_CONTENT,
    next: AUTHORITY_EDITED_CONTENT,
  };
  const resolver = createFunctionalRuntimeResolver({
    portable: scriptedFunctionalPortable(stateDir),
    runtimeStateRoot: join(stateDir, "runtime-state"),
    gatewayUrl: `http://${UI_HOST}:${String(port)}/api/coding-sidecar/gateway`,
    workspaceLifecycle: services.lifecycle,
    managedTaskWorkspaceRoot: managedRoot,
    readWorkspaceHead: readProductionWorkspaceHead,
    verificationRunner: authorityVerificationRunner(),
    runtimeEvidence: createCodingRuntimeEvidenceAggregator(createInMemoryEvidenceStore()),
    createSupervisor: scripted.createSupervisor,
  });
  const deps = buildUiHandlerDeps({
    configPath: undefined,
    evidenceDir: join(bffStateRoot, "evidence"),
    env: {
      PATH: process.env.PATH ?? "",
      KEIKO_STATE_DIR: join(bffStateRoot, "state"),
      // #2478: provision the launcher secret so the journey pairs through the REAL production
      // pairing port (`resolveLauncherSessionPairingPort`) — no fake port on this journey.
      [SESSION_PAIRING_LAUNCHER_SECRET_ENV]: AUTHORITY_APP_SESSION_LAUNCHER_SECRET,
    },
    uiDbPath: join(bffStateRoot, "ui-db", "keiko-ui.db"),
    workspaceProvisioning: services.provisioning,
    workspaceLifecycle: services.lifecycle,
    workspaceReconciliation: services.reconciliation,
    codingRuntimeResolver: resolver,
    codingRuntimeDeploymentCeiling: "autonomous-delivery",
    codingRuntimeServerPrincipal: () => "authority-operator",
    autonomousDeliveryDeploymentCeiling: "autonomous-delivery",
  });
  return { handlerDeps: authorityHandlerDeps(deps, script), scripted };
}

async function main(): Promise<void> {
  const rawStateDir = authorityStateDir();
  mkdirSync(rawStateDir, { recursive: true });
  const stateDir = realpathSync(rawStateDir);
  const port = Number(process.env.KEIKO_E2E_UI_PORT ?? String(AUTHORITY_DEFAULT_UI_PORT));
  createRepositoryFixture(stateDir);
  const { handlerDeps, scripted } = buildAuthorityComposition(stateDir, port);
  const staticRoot = join(process.cwd(), "dist", "ui", "static");
  const csp = buildCspHeader(extractInlineScriptHashes(collectHtmlDocuments(staticRoot)));
  const server = createUiServer({ staticRoot, csp, port, handlerDeps });
  registerShutdown(server, handlerDeps, scripted);
  await new Promise<void>((resolve) => {
    server.listen(port, UI_HOST, resolve);
  });
}

await main();
