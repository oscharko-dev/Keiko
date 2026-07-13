/* eslint-disable @typescript-eslint/explicit-function-return-type -- Integration fixtures are contextually typed. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createNodeGitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";

import { buildCspHeader } from "../../packages/keiko-server/src/csp.js";
import { createUiServer, UI_HOST } from "../../packages/keiko-server/src/server.js";
import { runMigrations } from "../../packages/keiko-server/src/store/schema.js";
import { createInMemoryUiStore } from "../../packages/keiko-server/src/store/index.js";
import { createVerificationRunnerManager } from "../../packages/keiko-server/src/editor/verificationRunner.js";
import { buildActiveWorkspacePointerStoreOverDatabase } from "../../packages/keiko-server/src/task-workspace/active-store.js";
import { createWorkspaceLifecycleService } from "../../packages/keiko-server/src/task-workspace/lifecycle.js";
import { createWorkspaceMutexRegistry } from "../../packages/keiko-server/src/task-workspace/mutex.js";
import { createWorkspaceProvisioningService } from "../../packages/keiko-server/src/task-workspace/provisioning.js";
import { reconcileSingleInstance } from "../../packages/keiko-server/src/task-workspace/reconciliation.js";
import { buildWorkspaceInstanceStoreOverDatabase } from "../../packages/keiko-server/src/task-workspace/store.js";
import { createCodingRuntimeControlPlane } from "../../packages/keiko-server/src/coding-runtime/codingRuntimeControlPlane.js";
import { createCodingRuntimeEvidenceAggregator } from "../../packages/keiko-server/src/coding-runtime/codingRuntimeEvidenceAggregator.js";
import { createCodingRuntimeSnapshotStore } from "../../packages/keiko-server/src/coding-runtime/codingRuntimeSnapshotStore.js";
import {
  createProductionCodingRuntimeHost,
  type QualifiedProductionCodingRuntime,
} from "../../packages/keiko-server/src/coding-runtime/productionCodingRuntimeHost.js";
import type { RuntimeProcessSupervisor } from "../../packages/keiko-server/src/coding-runtime/runtimeProcessSupervisor.js";
import { stagedFunctionalPortable } from "../../packages/keiko-server/src/coding-runtime/opencodeFunctionalHarness/_support.js";
import {
  bffDeps,
  functionalHarness,
  type ScriptState,
} from "../../packages/keiko-server/src/coding-runtime/productionOpenCodeRuntime.functional/_support.js";
import { createProductionOpenCodeRuntimeResolver } from "../../packages/keiko-server/src/coding-runtime/productionOpenCodeRuntimeResolver.js";
import { readProductionWorkspaceHead } from "../../packages/keiko-server/src/coding-runtime/productionWorkspaceHeadReader.js";

const PORT = 32458;
const repoRoot = resolve(import.meta.dirname, "../..");
const roots: string[] = [];
const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("[functional-only] #2258 live managed OpenCode launcher", () => {
  it("resets the script and managed source together between live scenarios", async () => {
    const fixture = await setupWorkspace();
    fixture.script.calls = 3;
    fixture.script.mode = "out-of-scope";
    writeFileSync(join(fixture.workspace, "src", "example.ts"), fixture.script.next, {
      mode: 0o600,
    });

    resetFixture(fixture, "productive");

    expect(fixture.script).toMatchObject({ calls: 0, mode: "productive" });
    expect(readFileSync(join(fixture.workspace, "src", "example.ts"), "utf8")).toBe(
      fixture.script.old,
    );
  });

  it("injects one recovery-required stop while preserving ordinary recovery behavior", async () => {
    const fixture = {
      forceRecoveryOnStop: true,
      recoveryWaitsRemaining: 0,
      recoveryRunId: undefined,
    } as HarnessFixture;
    const delegatedAbort = vi.fn(() => Promise.resolve(true));
    const delegatedRecovery = vi.fn(() => Promise.resolve({ status: "unreaped" as const }));
    const runtime = {
      taskDispatcher: {
        dispatch: () => ({
          ok: true as const,
          completion: Promise.resolve("succeeded" as const),
        }),
        abort: delegatedAbort,
      },
      recovery: { reconcile: delegatedRecovery },
    } as unknown as QualifiedProductionCodingRuntime;
    const wrapped = recoveryInjectingRuntime(runtime, fixture);

    await expect(wrapped.taskDispatcher.abort("run-recovery")).resolves.toBe(false);
    expect(fixture).toMatchObject({
      forceRecoveryOnStop: false,
      recoveryRunId: "run-recovery",
      recoveryWaitsRemaining: 2,
    });
    await expect(wrapped.taskDispatcher.abort("run-normal")).resolves.toBe(true);
    expect(delegatedAbort).toHaveBeenCalledWith("run-normal");
    await expect(wrapped.recovery.reconcile("run-recovery", "a".repeat(32))).resolves.toEqual({
      status: "reaped",
      recoveryHandle: "a".repeat(32),
    });
    expect(fixture).toMatchObject({ recoveryWaitsRemaining: 0, recoveryRunId: undefined });
    await expect(wrapped.recovery.reconcile("run-normal", "b".repeat(32))).resolves.toEqual({
      status: "unreaped",
    });
    expect(delegatedRecovery).toHaveBeenCalledWith("run-normal", "b".repeat(32));
  });

  it.skipIf(process.env.KEIKO_2258_LIVE_HARNESS !== "1")(
    "serves the built Keiko UI and real BFF on its fixed loopback port",
    async () => {
      const staticRoot = join(repoRoot, "dist", "ui", "static");
      if (!existsSync(join(staticRoot, "index.html")))
        throw new Error("functional-ui-build-missing");
      const fixture = await setupWorkspace();
      const portable = stagedFunctionalPortable(fixture.root);
      const verification = createVerification(fixture.workspace);
      const runtimeEvidence = createCodingRuntimeEvidenceAggregator(memoryEvidence());
      const env: NodeJS.ProcessEnv = { KEIKO_UI_PORT: String(PORT) };
      const harness = functionalHarness(portable);
      const resolver = createProductionOpenCodeRuntimeResolver({
        env,
        workspaceLifecycle: fixture.lifecycle,
        managedTaskWorkspaceRoot: fixture.managedRoot,
        verificationRunner: verification.manager,
        runtimeStateRoot: join(fixture.root, "runtime-state"),
        runtimeEvidence,
        readWorkspaceHead: (workspaceRoot, repositoryRoot) =>
          fixture.drifted
            ? "forged-functional-workspace-head"
            : readProductionWorkspaceHead(workspaceRoot, repositoryRoot),
        functionalHarness: {
          ...harness,
          createSupervisor: (runId) =>
            recoveryInjectingSupervisor(harness.createSupervisor(runId), fixture),
        },
      });
      const host = createProductionCodingRuntimeHost({
        resolve: () => {
          const runtime = resolver.resolve();
          return runtime === undefined ? undefined : recoveryInjectingRuntime(runtime, fixture);
        },
      });
      if (host === undefined) throw new Error("functional-runtime-unqualified");
      const control = createCodingRuntimeControlPlane({
        snapshots: createCodingRuntimeSnapshotStore(fixture.db),
        evidence: runtimeEvidence,
        workspaceLifecycle: fixture.lifecycle,
        serverPrincipal: () => "functional-operator",
        runtimeHost: host,
      });
      await control.startupRecovery;
      const runtimeDeps = bffDeps(
        control,
        { runToReport: verification.manager.runToReport, evidence: verification.evidence },
        fixture.script,
      );
      const app = createUiServer({
        staticRoot,
        csp: cspFromBuild(),
        port: PORT,
        handlerDeps: {
          ...runtimeDeps,
          managedTaskWorkspaceRoot: fixture.managedRoot,
          workspaceLifecycle: fixture.lifecycle,
          workspaceProvisioning: fixture.provisioning,
        },
      });
      const server = createHarnessServer(app, fixture);
      servers.push(server);
      await listen(server);
      await assertReady();
      process.stdout.write("KEIKO_2258_READY http://127.0.0.1:32458\n");
      await waitForShutdown();
    },
    0,
  );
});

function cspFromBuild(): string {
  const hashes = JSON.parse(
    readFileSync(join(repoRoot, "dist", "ui", "csp-hashes.json"), "utf8"),
  ) as string[];
  return buildCspHeader(hashes);
}

async function setupWorkspace() {
  const root = resolve(mkdtempSync(join(tmpdir(), "keiko-2258-live-")));
  roots.push(root);
  const { managedRoot, repository } = createFixtureRepository(root);
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  const services = createWorkspaceServices(db, managedRoot);
  const provisioned = await provisionWorkspace(services, repository);
  writeFileSync(join(provisioned.instance.managedWorktreePath, "delivery.txt"), "pending\n", {
    mode: 0o600,
  });
  git(provisioned.instance.managedWorktreePath, ["add", "delivery.txt"]);
  return {
    root,
    db,
    lifecycle: services.lifecycle,
    provisioning: services.provisioning,
    managedRoot,
    workspace: provisioned.instance.managedWorktreePath,
    workspaceHead: gitHead(provisioned.instance.managedWorktreePath),
    script: functionalScript(),
    outsidePath: join(managedRoot, "outside.txt"),
    outsideDigest: digest(readFileSync(join(managedRoot, "outside.txt"), "utf8")),
    drifted: false,
    forceRecoveryOnStop: false,
    recoveryWaitsRemaining: 0,
    recoveryRunId: undefined,
  };
}

function createFixtureRepository(root: string) {
  const repository = join(root, "repository");
  const managedRoot = join(root, "managed");
  mkdirSync(managedRoot, { recursive: true, mode: 0o700 });
  // This file is deliberately outside the managed worktree. The functional model attempts to
  // address it through ../outside.txt; the live status route reports booleans only.
  writeFileSync(join(managedRoot, "outside.txt"), "unchanged\n", { mode: 0o600 });
  mkdirSync(join(repository, "src"), { recursive: true, mode: 0o700 });
  git(repository, ["init", "-q", "-b", "main"]);
  git(repository, ["config", "user.email", "functional@keiko.example"]);
  writeFileSync(join(repository, "src", "example.ts"), "export const value = 1;\n");
  writeFileSync(
    join(repository, "package.json"),
    JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(0)"' } }),
  );
  git(repository, ["add", "."]);
  git(repository, ["commit", "-q", "-m", "synthetic-fixture"]);
  return { repository, managedRoot };
}

function createWorkspaceServices(db: DatabaseSync, managedRoot: string) {
  const evidence = memoryEvidence();
  const mutex = createWorkspaceMutexRegistry();
  const store = buildWorkspaceInstanceStoreOverDatabase(db);
  const activePointerStore = buildActiveWorkspacePointerStoreOverDatabase(db);
  const adapter = (workspace: Parameters<typeof createNodeGitWorktreeAdapter>[0]["workspace"]) =>
    createNodeGitWorktreeAdapter({ workspace, processEnv: { PATH: process.env.PATH ?? "" } });
  const provisioning = createWorkspaceProvisioningService({
    store,
    evidenceStore: evidence,
    managedRoot,
    createAdapter: adapter,
    redactString: () => "[redacted]",
    now: () => 1_700_000_000_000,
    newId: () => "functional-workspace",
    mutex,
  });
  const lifecycle = createWorkspaceLifecycleService({
    store,
    activePointerStore,
    managedRoot,
    provisioning,
    evidenceStore: evidence,
    redactString: () => "[redacted]",
    now: () => 1_700_000_000_000,
    newId: () => "functional-lifecycle",
    mutex,
  });
  return { activePointerStore, adapter, evidence, lifecycle, managedRoot, provisioning, store };
}

async function provisionWorkspace(
  services: ReturnType<typeof createWorkspaceServices>,
  repository: string,
) {
  const provisioned = await services.provisioning.provision({
    repositoryRequestPath: repository,
    taskId: "task-2258",
    baseBranch: "main",
    requestedBy: "functional",
  });
  await services.lifecycle.setActive({
    workspaceId: provisioned.instance.workspaceId,
    requestedBy: "functional",
    acquireLock: false,
  });
  await reconcileSingleInstance(
    {
      store: services.store,
      activePointerStore: services.activePointerStore,
      evidenceStore: services.evidence,
      managedRoot: services.managedRoot,
      createAdapter: services.adapter,
      redactString: () => "[redacted]",
      now: () => 1_700_000_000_000,
      newId: () => "functional-reconcile",
    },
    provisioned.instance,
    1_700_000_000_000,
  );
  return provisioned;
}

function functionalScript(): ScriptState {
  return {
    mode: "productive",
    calls: 0,
    old: "export const value = 1;\n",
    next: "export const value = 2;\n",
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function createVerification(workspace: string) {
  const store = createInMemoryUiStore();
  store.createProject(workspace, "functional");
  const evidence = createInMemoryEvidenceStore();
  const manager = createVerificationRunnerManager({
    store,
    evidenceStore: evidence,
    isWorkspaceTrustedForPackageScripts: () => true,
  });
  return { manager, evidence };
}

function memoryEvidence(): EvidenceStore {
  const entries = new Map<string, string>();
  return {
    put: (id, body) => (entries.set(id, body), id),
    list: () => [...entries.keys()],
    get: (id) => entries.get(id),
    delete: (id) => void entries.delete(id),
  };
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", [...args], { cwd, stdio: "ignore" });
}

function gitHead(cwd: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
}

function listen(server: Server): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(PORT, UI_HOST, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
}

async function assertReady(): Promise<void> {
  const response = await fetch(
    `http://${UI_HOST}:${String(PORT)}/api/coding-workbench/runtime/readiness?requestedMode=governed-assist`,
  );
  if (response.status !== 200) throw new Error("functional-readiness-failed");
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolveShutdown) => {
    process.once("SIGINT", resolveShutdown);
    process.once("SIGTERM", resolveShutdown);
  });
}

interface HarnessFixture {
  readonly script: ScriptState;
  readonly lifecycle: ReturnType<typeof createWorkspaceServices>["lifecycle"];
  readonly workspace: string;
  readonly workspaceHead: string;
  readonly outsidePath: string;
  readonly outsideDigest: string;
  drifted: boolean;
  forceRecoveryOnStop: boolean;
  recoveryWaitsRemaining: number;
  recoveryRunId: string | undefined;
}

function createHarnessServer(app: Server, fixture: HarnessFixture): Server {
  return createServer((request, response) => {
    if (request.method === "POST" && request.url?.startsWith("/_keiko-2258-test/reset") === true) {
      resetScript(request, response, fixture);
      return;
    }
    if (request.method === "POST" && request.url === "/_keiko-2258-test/drift") {
      fixture.drifted = true;
      response.writeHead(204).end();
      return;
    }
    if (request.method === "POST" && request.url === "/_keiko-2258-test/recovery") {
      fixture.forceRecoveryOnStop = true;
      response.writeHead(204).end();
      return;
    }
    if (request.method === "GET" && request.url === "/_keiko-2258-test/status") {
      writeHarnessStatus(response, fixture);
      return;
    }
    app.emit("request", request, response);
  });
}

function resetScript(
  request: IncomingMessage,
  response: ServerResponse,
  fixture: HarnessFixture,
): void {
  const mode = new URL(request.url ?? "/", `http://${UI_HOST}:${String(PORT)}`).searchParams.get(
    "mode",
  );
  if (mode !== null && mode !== "productive" && mode !== "out-of-scope") {
    response.writeHead(400).end();
    return;
  }
  resetFixture(fixture, mode ?? "productive");
  response.writeHead(204).end();
}

function resetFixture(fixture: HarnessFixture, mode: ScriptState["mode"]): void {
  fixture.script.calls = 0;
  fixture.script.mode = mode;
  writeFileSync(join(fixture.workspace, "src", "example.ts"), fixture.script.old, {
    mode: 0o600,
  });
  fixture.drifted = false;
  fixture.forceRecoveryOnStop = false;
  fixture.recoveryWaitsRemaining = 0;
  fixture.recoveryRunId = undefined;
}

function writeHarnessStatus(response: ServerResponse, fixture: HarnessFixture): void {
  const outsideUnchanged =
    digest(readFileSync(fixture.outsidePath, "utf8")) === fixture.outsideDigest;
  const outOfScopeAttemptRecorded =
    fixture.script.mode === "out-of-scope" && fixture.script.calls > 0;
  const fixtureSourceDigestMatches =
    digest(readFileSync(join(fixture.workspace, "src", "example.ts"), "utf8")) ===
    digest(fixture.script.old);
  const workspaceHeadMatchesFixture = gitHead(fixture.workspace) === fixture.workspaceHead;
  const workspaceHealthy = fixture.lifecycle.getActive()?.instance.health === "healthy";
  response
    .writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    })
    .end(
      JSON.stringify({
        outsideUnchanged,
        outOfScopeAttemptRecorded,
        workspaceDriftInjected: fixture.drifted,
        fixtureSourceDigestMatches,
        workspaceHeadMatchesFixture,
        workspaceHealthy,
        scriptCalls: fixture.script.calls,
      }),
    );
}

function recoveryInjectingSupervisor(
  supervisor: RuntimeProcessSupervisor,
  fixture: HarnessFixture,
): RuntimeProcessSupervisor {
  return {
    preflight: (request) => supervisor.preflight(request),
    spawnOwnedTree: (request) => supervisor.spawnOwnedTree(request),
    terminate: (tree, signal): void => {
      supervisor.terminate(tree, signal);
    },
    waitForCompleteTreeExit: async (tree, timeoutMs) => {
      if (fixture.recoveryWaitsRemaining > 0) {
        fixture.recoveryWaitsRemaining -= 1;
        return { status: "recovery-required" };
      }
      return supervisor.waitForCompleteTreeExit(tree, timeoutMs);
    },
    reconcile: (tree) => supervisor.reconcile(tree),
  };
}

function recoveryInjectingRuntime(
  runtime: QualifiedProductionCodingRuntime,
  fixture: HarnessFixture,
): QualifiedProductionCodingRuntime {
  return {
    ...runtime,
    taskDispatcher: {
      ...runtime.taskDispatcher,
      abort: async (runId) => {
        if (!fixture.forceRecoveryOnStop) return runtime.taskDispatcher.abort(runId);
        fixture.forceRecoveryOnStop = false;
        fixture.recoveryRunId = runId;
        fixture.recoveryWaitsRemaining = 2;
        return false;
      },
    },
    recovery: {
      reconcile: async (runId, recoveryHandle) => {
        if (fixture.recoveryRunId !== runId)
          return runtime.recovery.reconcile(runId, recoveryHandle);
        // A matching reaped receipt closes the one-shot fault injection before the fresh retry.
        fixture.recoveryWaitsRemaining = 0;
        fixture.recoveryRunId = undefined;
        return { status: "reaped", recoveryHandle };
      },
    },
  };
}
