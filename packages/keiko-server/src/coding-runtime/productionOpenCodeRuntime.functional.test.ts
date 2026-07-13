import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CodingWorkbenchRuntimeQuestionRequest,
  CodingWorkbenchRuntimeQuestionsResponse,
  CodingWorkbenchRuntimeSseEvent,
  EditorVerificationEvent,
} from "@oscharko-dev/keiko-contracts";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createNodeGitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";

import { createUiServer, UI_HOST } from "../server.js";
import { runMigrations } from "../store/schema.js";
import { createInMemoryUiStore } from "../store/index.js";
import { createVerificationRunnerManager } from "../editor/verificationRunner.js";
import type { VerificationRunnerManager } from "../editor/verificationRunner.js";
import { buildActiveWorkspacePointerStoreOverDatabase } from "../task-workspace/active-store.js";
import { createWorkspaceLifecycleService } from "../task-workspace/lifecycle.js";
import { createWorkspaceMutexRegistry } from "../task-workspace/mutex.js";
import { createWorkspaceProvisioningService } from "../task-workspace/provisioning.js";
import { reconcileSingleInstance } from "../task-workspace/reconciliation.js";
import { buildWorkspaceInstanceStoreOverDatabase } from "../task-workspace/store.js";
import { createCodingRuntimeControlPlane } from "./codingRuntimeControlPlane.js";
import { createCodingRuntimeEvidenceAggregator } from "./codingRuntimeEvidenceAggregator.js";
import { createCodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";
import { createProductionCodingRuntimeHost } from "./productionCodingRuntimeHost.js";
import { resolveProductionRuntimeContext } from "./productionRuntimeWorkspaceAuthority.js";
import { readProductionWorkspaceHead } from "./productionWorkspaceHeadReader.js";
import {
  functionalArtifactAvailable,
  stagedFunctionalPortable,
} from "./opencodeFunctionalHarness/_support.js";
import {
  bffDeps,
  functionalHarness,
  type ScriptState,
} from "./productionOpenCodeRuntime.functional/_support.js";
import { createProductionOpenCodeRuntimeResolver } from "./productionOpenCodeRuntimeResolver.js";

const SECRET = "TASK_SECRET_2258";
const OLD = "export const value = 'ORIGINAL_SECRET_2258';\n";
const NEW = "export const value = 'NEW_SECRET_2258';\n";
const OUTSIDE = "OUTSIDE_SECRET_2258\n";
const roots: string[] = [];
const servers: Server[] = [];

interface FunctionalWorkspaceFixture {
  readonly root: string;
  readonly repository: string;
  readonly db: DatabaseSync;
  readonly lifecycle: ReturnType<typeof createWorkspaceLifecycleService>;
  readonly managedRoot: string;
  readonly workspace: string;
  readonly target: string;
  readonly outside: string;
  readonly script: ScriptState;
  drifted: boolean;
}

interface FunctionalVerificationFixture {
  readonly manager: VerificationRunnerManager;
  readonly evidence: ReturnType<typeof createInMemoryEvidenceStore>;
  readonly events: EditorVerificationEvent[];
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("[functional-only] production OpenCode resolver", () => {
  it.skipIf(!functionalArtifactAvailable())(
    "uses the staged artifact through the BFF, managed workspace, and real verification manager",
    async () => {
      const fixture = await setupWorkspace();
      const portable = stagedFunctionalPortable(fixture.root);
      const verification = createVerification(fixture.workspace);
      const evidenceBodies = new Map<string, string>();
      const runtimeEvidence = createCodingRuntimeEvidenceAggregator({
        put: (id, body) => (evidenceBodies.set(id, body), id),
        get: (id) => evidenceBodies.get(id),
        list: () => [],
        delete: (id) => void evidenceBodies.delete(id),
      });
      const env: NodeJS.ProcessEnv = { KEIKO_UI_PORT: "1" };
      const resolver = createProductionOpenCodeRuntimeResolver({
        env,
        workspaceLifecycle: fixture.lifecycle,
        managedTaskWorkspaceRoot: fixture.managedRoot,
        verificationRunner: verification.manager,
        runtimeStateRoot: join(fixture.root, "runtime-state"),
        runtimeEvidence,
        readWorkspaceHead: (workspaceRoot, repositoryRoot) =>
          fixture.drifted
            ? "forged-live-head"
            : readProductionWorkspaceHead(workspaceRoot, repositoryRoot),
        functionalHarness: functionalHarness(portable),
      });
      const resolved = resolver.resolve();
      const host = createProductionCodingRuntimeHost({ resolve: () => resolved });
      if (host === undefined) throw new Error("functional-resolver-unavailable");
      const snapshots = createCodingRuntimeSnapshotStore(fixture.db);
      const control = createCodingRuntimeControlPlane({
        snapshots,
        evidence: runtimeEvidence,
        workspaceLifecycle: fixture.lifecycle,
        serverPrincipal: () => "functional-operator",
        runtimeHost: host,
      });
      await control.startupRecovery;
      const port = await reserveLoopbackPort();
      const server = createUiServer({
        staticRoot: fixture.root,
        csp: "default-src 'none'",
        port,
        handlerDeps: bffDeps(
          control,
          { runToReport: verification.manager.runToReport, evidence: verification.evidence },
          fixture.script,
        ),
      });
      servers.push(server);
      await listen(server, port);
      env.KEIKO_UI_PORT = String((server.address() as AddressInfo).port);
      const baseUrl = `http://${UI_HOST}:${env.KEIKO_UI_PORT}`;
      const started = await post(
        baseUrl,
        "/api/coding-workbench/runtime/runs",
        startBody("productive"),
      );
      expect(started.status).toBe(200);
      const run = (await started.json()) as {
        runId: string;
        state: string;
        failureCode?: string;
      };
      expect(run).toMatchObject({ state: "running" });
      const timeline: CodingWorkbenchRuntimeSseEvent[] = [];
      const subscribed = control.eventHub.subscribe(run.runId, undefined, {
        write: (event): boolean => {
          timeline.push(event);
          return true;
        },
        close: (): void => undefined,
      });
      expect(subscribed.ok).toBe(true);
      expect(control.questionPort).toBeDefined();
      const question = await waitForQuestion(baseUrl, run.runId);
      expect(question.questions).toHaveLength(1);
      const answered = await post(
        baseUrl,
        `/api/coding-workbench/runtime/runs/${run.runId}/questions/${question.id}/answer`,
        { answers: [["Approve"]] },
      );
      expect(answered.status).toBe(200);
      await expect(answered.json()).resolves.toEqual({ accepted: true });
      await waitForState(baseUrl, run.runId, "succeeded");
      const verificationIndex = timeline.findIndex(
        (event) => event.kind === "runtime-event" && event.eventKind === "verification-summarized",
      );
      const successIndex = timeline.findIndex(
        (event) => event.kind === "status" && event.state === "succeeded",
      );
      expect(verificationIndex).toBeGreaterThanOrEqual(0);
      expect(successIndex).toBeGreaterThan(verificationIndex);
      expect(
        timeline.filter(
          (event) =>
            event.kind === "runtime-event" && event.eventKind === "verification-summarized",
        ),
      ).toHaveLength(1);
      expect(readFile(fixture.target)).toBe(NEW);
      expect(verification.events.some((event) => event.kind === "run-completed")).toBe(true);
      expect(verification.events.find((event) => event.kind === "run-completed")).toMatchObject({
        report: { overallStatus: "passed" },
      });
      await expect(
        post(baseUrl, "/api/coding-workbench/runtime/runs", {
          requestId: "forged-workspace",
          taskIntent: SECRET,
          requestedMode: "supervised-coding",
          workspaceRoot: join(fixture.root, "outside"),
        }),
      ).resolves.toMatchObject({ status: 400 });
      fixture.drifted = true;
      await expect(
        post(baseUrl, "/api/coding-workbench/runtime/runs", startBody("drifted")),
      ).resolves.toMatchObject({ status: 403 });
      fixture.drifted = false;
      expect(fixture.lifecycle.getActive()?.instance.lastVerifiedHead).toBe(
        readProductionWorkspaceHead(fixture.workspace, fixture.repository),
      );
      expect(() =>
        resolveProductionRuntimeContext(
          {
            workspaceLifecycle: fixture.lifecycle,
            managedTaskWorkspaceRoot: fixture.managedRoot,
            readWorkspaceHead: readProductionWorkspaceHead,
          },
          {
            runId: "diagnostic-run",
            requestId: "diagnostic-request",
            taskIntent: SECRET,
            requestedMode: "supervised-coding",
            workspaceId: fixture.lifecycle.getActive()?.instance.workspaceId ?? "",
            workspaceRoot: fixture.workspace,
            serverPrincipal: "functional-operator",
          },
        ),
      ).not.toThrow();

      fixture.script.mode = "productive";
      fixture.script.calls = 0;
      const rejected = await post(
        baseUrl,
        "/api/coding-workbench/runtime/runs",
        startBody("reject-pending-question"),
      );
      expect(rejected.status).toBe(200);
      const rejectedRun = (await rejected.json()) as { runId: string; state: string };
      expect(rejectedRun.state).toBe("running");
      const rejectedQuestion = await waitForQuestion(baseUrl, rejectedRun.runId);
      const rejection = await post(
        baseUrl,
        `/api/coding-workbench/runtime/runs/${rejectedRun.runId}/questions/${rejectedQuestion.id}/reject`,
        {},
      );
      expect(rejection.status).toBe(200);
      await waitForTerminalState(baseUrl, rejectedRun.runId);

      fixture.script.mode = "productive";
      fixture.script.calls = 0;
      const pendingStop = await post(
        baseUrl,
        "/api/coding-workbench/runtime/runs",
        startBody("stop-pending-question"),
      );
      expect(pendingStop.status).toBe(200);
      const pendingStopRun = (await pendingStop.json()) as { runId: string; state: string };
      expect(pendingStopRun.state).toBe("running");
      await waitForQuestion(baseUrl, pendingStopRun.runId);
      const stopped = await post(
        baseUrl,
        `/api/coding-workbench/runtime/runs/${pendingStopRun.runId}/stop`,
        { requestId: pendingStopRun.runId },
      );
      expect(stopped.status).toBe(200);
      await expect(stopped.json()).resolves.toMatchObject({
        runId: pendingStopRun.runId,
        state: "cancelled",
      });
      expect(control.quiescence.isQuiescent()).toBe(true);
      expect(readFile(fixture.target)).toBe(NEW);

      fixture.script.mode = "out-of-scope";
      fixture.script.calls = 0;
      const denied = await post(baseUrl, "/api/coding-workbench/runtime/runs", startBody("escape"));
      expect(denied.status).toBe(200);
      const deniedRun = (await denied.json()) as { runId: string };
      await waitForState(baseUrl, deniedRun.runId, "succeeded");
      expect(readFile(fixture.outside)).toBe(OUTSIDE);
      expect(verification.events.filter((event) => event.kind === "run-completed")).toHaveLength(1);

      const evidence = [
        ...evidenceBodies.values(),
        ...verification.evidence.list().map((id) => verification.evidence.get(id) ?? ""),
      ].join("\n");
      expect(`${evidence}${JSON.stringify(snapshots.listAll())}`).not.toMatch(
        new RegExp(`${SECRET}|${OLD}|${OUTSIDE}`, "u"),
      );
      expect(control.quiescence.isQuiescent()).toBe(true);
    },
    60_000,
  );
});

function setupWorkspace(): Promise<FunctionalWorkspaceFixture> {
  const root = mkdtempSync(join(tmpdir(), "keiko-opencode-resolver-"));
  roots.push(root);
  const repository = join(root, "repository");
  const managedRoot = join(root, "managed");
  mkdirSync(repository, { recursive: true });
  git(repository, ["init", "-q", "-b", "main"]);
  git(repository, ["config", "user.email", "functional@keiko.example"]);
  git(repository, ["config", "user.name", "Keiko Functional"]);
  git(repository, ["config", "commit.gpgsign", "false"]);
  mkdirSync(join(repository, "src"));
  writeFileSync(join(repository, "src", "example.ts"), OLD);
  writeFileSync(
    join(repository, "package.json"),
    JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(0)"' } }),
  );
  git(repository, ["add", "."]);
  git(repository, ["commit", "-q", "-m", "fixture"]);
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  const store = buildWorkspaceInstanceStoreOverDatabase(db);
  const evidence = memoryEvidence();
  const mutex = createWorkspaceMutexRegistry();
  const activePointerStore = buildActiveWorkspacePointerStoreOverDatabase(db);
  const adapter = (
    workspace: Parameters<typeof createNodeGitWorktreeAdapter>[0]["workspace"],
  ): ReturnType<typeof createNodeGitWorktreeAdapter> =>
    createNodeGitWorktreeAdapter({ workspace, processEnv: { PATH: process.env.PATH ?? "" } });
  const provisioning = createWorkspaceProvisioningService({
    store,
    evidenceStore: evidence,
    managedRoot,
    createAdapter: adapter,
    redactString: (value) => value,
    now: () => 1_700_000_000_000,
    newId: () => "functional-id",
    mutex,
  });
  const lifecycle = createWorkspaceLifecycleService({
    store,
    activePointerStore,
    managedRoot,
    provisioning,
    evidenceStore: evidence,
    redactString: (value) => value,
    now: () => 1_700_000_000_000,
    newId: () => "functional-lifecycle-id",
    mutex,
  });
  const script: ScriptState = { mode: "productive", calls: 0, old: OLD, next: NEW };
  return provisioning
    .provision({
      repositoryRequestPath: repository,
      taskId: "task-2258",
      baseBranch: "main",
      requestedBy: "functional",
    })
    .then(async (provisioned) => {
      await lifecycle.setActive({
        workspaceId: provisioned.instance.workspaceId,
        requestedBy: "functional",
        acquireLock: false,
      });
      await reconcileSingleInstance(
        {
          store,
          activePointerStore,
          evidenceStore: evidence,
          managedRoot,
          createAdapter: adapter,
          redactString: (value) => value,
          now: () => 1_700_000_000_000,
          newId: () => "functional-reconcile-id",
        },
        provisioned.instance,
        1_700_000_000_000,
      );
      const workspace = provisioned.instance.managedWorktreePath;
      const target = join(workspace, "src", "example.ts");
      const outside = join(root, "outside.txt");
      writeFileSync(outside, OUTSIDE);
      return {
        root,
        repository,
        db,
        lifecycle,
        managedRoot,
        workspace,
        target,
        outside,
        script,
        drifted: false,
      };
    });
}

function createVerification(workspace: string): FunctionalVerificationFixture {
  const store = createInMemoryUiStore();
  store.createProject(workspace, "functional");
  const evidence = createInMemoryEvidenceStore();
  const events: EditorVerificationEvent[] = [];
  const manager = createVerificationRunnerManager({
    store,
    evidenceStore: evidence,
    isWorkspaceTrustedForPackageScripts: () => true,
  });
  manager.subscribe((event) => events.push(event));
  return { manager, evidence, events };
}

function startBody(requestId: string): {
  readonly requestId: string;
  readonly taskIntent: string;
  readonly requestedMode: "autonomous-delivery";
} {
  return { requestId, taskIntent: SECRET, requestedMode: "autonomous-delivery" };
}
function post(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1", Origin: base },
    body: JSON.stringify(body),
  });
}
async function reserveLoopbackPort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, UI_HOST, resolve));
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => {
      if (error) reject(error);
      else resolve();
    }),
  );
  return port;
}
async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve) => server.listen(port, UI_HOST, resolve));
}
async function waitForQuestion(
  base: string,
  runId: string,
): Promise<CodingWorkbenchRuntimeQuestionRequest> {
  let found: readonly CodingWorkbenchRuntimeQuestionRequest[] = [];
  await vi.waitFor(
    async () => {
      const response = await fetch(`${base}/api/coding-workbench/runtime/runs/${runId}/questions`, {
        headers: { Origin: base },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as CodingWorkbenchRuntimeQuestionsResponse;
      found = body.questions;
      expect(found).toHaveLength(1);
    },
    { timeout: 15_000, interval: 100 },
  );
  const question = found[0];
  if (question === undefined) throw new Error("expected-runtime-question");
  return question;
}
async function waitForState(base: string, runId: string, state: string): Promise<void> {
  await vi.waitFor(async () => {
    expect((await fetch(`${base}/api/coding-workbench/runtime/runs/${runId}`)).status).toBe(200);
  });
  await vi.waitFor(
    async () => {
      const snapshot = (await (
        await fetch(`${base}/api/coding-workbench/runtime/runs/${runId}`)
      ).json()) as { state: string };
      expect(snapshot.state).toBe(state);
    },
    { timeout: 15_000, interval: 100 },
  );
}
async function waitForTerminalState(base: string, runId: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const snapshot = (await (
        await fetch(`${base}/api/coding-workbench/runtime/runs/${runId}`)
      ).json()) as { state: string };
      expect(["succeeded", "failed", "cancelled"]).toContain(snapshot.state);
    },
    { timeout: 15_000, interval: 100 },
  );
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
function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}
function readFile(path: string): string {
  return readFileSync(path, "utf8");
}
