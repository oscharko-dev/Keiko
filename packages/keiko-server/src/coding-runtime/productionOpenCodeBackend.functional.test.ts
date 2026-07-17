import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CodingWorkbenchRuntimeQuestionRequest,
  CodingWorkbenchRuntimeSseEvent,
  EditorVerificationEvent,
} from "@oscharko-dev/keiko-contracts";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createNodeGitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";

import { createUiServer, UI_HOST } from "../server.js";
import type { UiHandlerDeps } from "../deps.js";
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
import { createCodingRuntimeEvidenceAggregator } from "./codingRuntimeEvidenceAggregator.js";
import type { CodingRuntimeOrchestrator } from "./codingRuntimeOrchestrator.js";
import { resolveProductionRuntimeContext } from "./productionRuntimeWorkspaceAuthority.js";
import { readProductionWorkspaceHead } from "./productionWorkspaceHeadReader.js";
import type {
  FunctionalPortableOpenCodeRuntime,
  ProductionOpenCodeBackendInput,
} from "./productionOpenCodeBackend.js";
import {
  createFunctionalSupervisor,
  createScriptedOpenCodeHarness,
  functionalArtifactAvailable,
  scriptedFunctionalPortable,
  stagedFunctionalPortable,
  type ScriptedOpenCodeHarness,
} from "./opencodeFunctionalHarness/_support.js";
import {
  createFunctionalRuntimeResolver,
  functionalBffDeps,
  type ScriptState,
} from "./productionOpenCodeBackend.functional/_support.js";

const SECRET = "TASK_SECRET_2258";
const OLD = "export const value = 'ORIGINAL_SECRET_2258';\n";
const NEW = "export const value = 'NEW_SECRET_2258';\n";
const OUTSIDE = "OUTSIDE_SECRET_2258\n";
const roots: string[] = [];
const servers: Server[] = [];
const disposers: (() => Promise<void> | void)[] = [];

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

interface FunctionalPipeline {
  readonly baseUrl: string;
  readonly deps: UiHandlerDeps;
  readonly orchestrator: CodingRuntimeOrchestrator;
  readonly timeline: CodingWorkbenchRuntimeSseEvent[];
  readonly verification: FunctionalVerificationFixture;
  readonly evidenceBodies: ReadonlyMap<string, string>;
  readonly subscribeTimeline: (runId: string) => void;
}

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("production OpenCode backend functional pipeline", () => {
  it("drives the managed OpenCode composition end to end with a scripted child and model gateway", async () => {
    const fixture = await setupWorkspace();
    const scripted = createScriptedOpenCodeHarness();
    disposers.push(() => scripted.closeAll());
    const portable = scriptedFunctionalPortable(fixture.root);
    const pipeline = await bootPipeline(fixture, portable, scripted.createSupervisor);
    await runProductiveScenario(fixture, pipeline);
    await runAuthorityScenarios(fixture, pipeline);
    await runRejectedQuestionScenario(fixture, pipeline, scripted);
    await runStopPendingQuestionScenario(fixture, pipeline);
    await runOutOfScopeScenario(fixture, pipeline, scripted);
    assertRedactedEvidence(fixture, pipeline);
  }, 120_000);

  it.skipIf(!functionalArtifactAvailable())(
    "[functional-only] drives the staged real OpenCode artifact through the same pipeline",
    async () => {
      const fixture = await setupWorkspace();
      const portable = stagedFunctionalPortable(fixture.root);
      const createSupervisor: NonNullable<
        ProductionOpenCodeBackendInput["createSupervisor"]
      > = () => createFunctionalSupervisor(portable);
      const pipeline = await bootPipeline(fixture, portable, createSupervisor);
      await runProductiveScenario(fixture, pipeline);
      await runAuthorityScenarios(fixture, pipeline);
      assertRedactedEvidence(fixture, pipeline);
    },
    120_000,
  );
});

async function bootPipeline(
  fixture: FunctionalWorkspaceFixture,
  portable: FunctionalPortableOpenCodeRuntime,
  createSupervisor: NonNullable<ProductionOpenCodeBackendInput["createSupervisor"]>,
): Promise<FunctionalPipeline> {
  const verification = createVerification(fixture.workspace);
  const evidenceBodies = new Map<string, string>();
  const runtimeEvidence = createCodingRuntimeEvidenceAggregator(memoryEvidence(evidenceBodies));
  const port = await reserveLoopbackPort();
  const resolver = createFunctionalRuntimeResolver({
    portable,
    runtimeStateRoot: join(fixture.root, "runtime-state"),
    gatewayUrl: `http://${UI_HOST}:${String(port)}/api/coding-sidecar/gateway`,
    workspaceLifecycle: fixture.lifecycle,
    managedTaskWorkspaceRoot: fixture.managedRoot,
    readWorkspaceHead: (workspaceRoot, repositoryRoot) =>
      fixture.drifted
        ? "forged-live-head"
        : readProductionWorkspaceHead(workspaceRoot, repositoryRoot),
    verificationRunner: verification.manager,
    runtimeEvidence,
    createSupervisor,
  });
  const deps = functionalBffDeps({
    stateRoot: join(fixture.root, "bff-state"),
    workspaceLifecycle: fixture.lifecycle,
    codingRuntimeResolver: resolver,
    script: fixture.script,
  });
  disposers.push(async () => {
    await deps.codingRuntimeOrchestrator?.shutdown();
    await deps.dispose?.();
  });
  const server = createUiServer({
    staticRoot: fixture.root,
    csp: "default-src 'none'",
    port,
    handlerDeps: deps,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(port, UI_HOST, resolve));
  const orchestrator = deps.codingRuntimeOrchestrator;
  const eventHub = deps.codingRuntimeEventHub;
  if (orchestrator === undefined || eventHub === undefined) {
    throw new Error("functional-control-plane-missing");
  }
  const timeline: CodingWorkbenchRuntimeSseEvent[] = [];
  return {
    baseUrl: `http://${UI_HOST}:${String(port)}`,
    deps,
    orchestrator,
    timeline,
    verification,
    evidenceBodies,
    subscribeTimeline: (runId): void => {
      const subscribed = eventHub.subscribe(runId, undefined, {
        write: (event): boolean => {
          timeline.push(event);
          return true;
        },
        close: (): void => undefined,
      });
      expect(subscribed.ok).toBe(true);
    },
  };
}

async function runProductiveScenario(
  fixture: FunctionalWorkspaceFixture,
  pipeline: FunctionalPipeline,
): Promise<void> {
  const started = await post(
    pipeline.baseUrl,
    "/api/coding-workbench/runtime/runs",
    startBody("productive"),
  );
  expect(started.status).toBe(200);
  const run = (await started.json()) as { runId: string; state: string };
  expect(run.state).toBe("running");
  pipeline.subscribeTimeline(run.runId);
  const question = await waitForQuestion(pipeline.orchestrator, run.runId, "productive-question");
  expect(question.questions).toHaveLength(1);
  expect(question.questions[0]?.question).toBe("Approve?");
  // #2386: the question's arrival must surface on the workbench event stream as a content-free
  // observation signal — pull-based clients re-list on it instead of hanging on a stale empty list.
  await vi.waitFor(
    () => {
      expect(
        pipeline.timeline.some(
          (event) => event.kind === "runtime-event" && event.eventKind === "observation-streamed",
        ),
      ).toBe(true);
    },
    { timeout: 30_000, interval: 100 },
  );
  const answered = await answerQuestion(pipeline.orchestrator, run.runId, question.id, [
    ["Approve"],
  ]);
  expect(answered).toBe(true);
  await vi.waitFor(
    () => {
      expect(readFile(fixture.target)).toBe(NEW);
      expect(
        pipeline.timeline.some(
          (event) =>
            event.kind === "runtime-event" && event.eventKind === "verification-summarized",
        ),
      ).toBe(true);
      expect(pipeline.verification.events.some((event) => event.kind === "run-completed")).toBe(
        true,
      );
    },
    { timeout: 30_000, interval: 100 },
  );
  expect(
    pipeline.timeline.filter(
      (event) => event.kind === "runtime-event" && event.eventKind === "verification-summarized",
    ),
  ).toHaveLength(1);
  expect(
    pipeline.verification.events.find((event) => event.kind === "run-completed"),
  ).toMatchObject({ report: { overallStatus: "passed" } });
  await stopRun(pipeline.baseUrl, run.runId);
}

async function runAuthorityScenarios(
  fixture: FunctionalWorkspaceFixture,
  pipeline: FunctionalPipeline,
): Promise<void> {
  await expect(
    post(pipeline.baseUrl, "/api/coding-workbench/runtime/runs", {
      requestId: "forged-workspace",
      taskIntent: SECRET,
      requestedMode: "supervised-coding",
      workspaceRoot: join(fixture.root, "outside"),
    }),
  ).resolves.toMatchObject({ status: 400 });
  fixture.drifted = true;
  await expect(
    post(pipeline.baseUrl, "/api/coding-workbench/runtime/runs", startBody("drifted")),
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
        deploymentCeiling: "autonomous-delivery",
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
}

async function runRejectedQuestionScenario(
  fixture: FunctionalWorkspaceFixture,
  pipeline: FunctionalPipeline,
  scripted: ScriptedOpenCodeHarness,
): Promise<void> {
  fixture.script.mode = "productive";
  fixture.script.calls = 0;
  const started = await post(
    pipeline.baseUrl,
    "/api/coding-workbench/runtime/runs",
    startBody("reject-pending-question"),
  );
  expect(started.status).toBe(200);
  const run = (await started.json()) as { runId: string; state: string };
  expect(run.state).toBe("running");
  const question = await waitForQuestion(pipeline.orchestrator, run.runId, "reject-question");
  const rejected = await rejectQuestion(pipeline.orchestrator, run.runId, question.id);
  expect(rejected).toBe(true);
  await waitForChildTurns(scripted, 2);
  expect(readFile(fixture.target)).toBe(NEW);
  await stopRun(pipeline.baseUrl, run.runId);
}

async function runStopPendingQuestionScenario(
  fixture: FunctionalWorkspaceFixture,
  pipeline: FunctionalPipeline,
): Promise<void> {
  fixture.script.mode = "productive";
  fixture.script.calls = 0;
  const started = await post(
    pipeline.baseUrl,
    "/api/coding-workbench/runtime/runs",
    startBody("stop-pending-question"),
  );
  expect(started.status).toBe(200);
  const run = (await started.json()) as { runId: string; state: string };
  expect(run.state).toBe("running");
  await waitForQuestion(pipeline.orchestrator, run.runId, "stop-question");
  await stopRun(pipeline.baseUrl, run.runId);
  expect(readFile(fixture.target)).toBe(NEW);
}

async function runOutOfScopeScenario(
  fixture: FunctionalWorkspaceFixture,
  pipeline: FunctionalPipeline,
  scripted: ScriptedOpenCodeHarness,
): Promise<void> {
  fixture.script.mode = "out-of-scope";
  fixture.script.calls = 0;
  const started = await post(
    pipeline.baseUrl,
    "/api/coding-workbench/runtime/runs",
    startBody("escape"),
  );
  expect(started.status).toBe(200);
  const run = (await started.json()) as { runId: string };
  await waitForChildTurns(scripted, 2);
  expect(readFile(fixture.outside)).toBe(OUTSIDE);
  expect(
    pipeline.verification.events.filter((event) => event.kind === "run-completed"),
  ).toHaveLength(1);
  await stopRun(pipeline.baseUrl, run.runId);
}

function assertRedactedEvidence(
  fixture: FunctionalWorkspaceFixture,
  pipeline: FunctionalPipeline,
): void {
  const workbenchStore = pipeline.deps.codingWorkbenchEvidenceStore;
  const evidence = [
    ...pipeline.evidenceBodies.values(),
    ...pipeline.verification.evidence
      .list()
      .map((id) => pipeline.verification.evidence.get(id) ?? ""),
    ...(workbenchStore?.list() ?? []).map((id) => workbenchStore?.get(id) ?? ""),
  ].join("\n");
  const snapshots = JSON.stringify(pipeline.deps.codingRuntimeSnapshotStore?.listAll() ?? []);
  expect(`${evidence}${snapshots}`).not.toMatch(new RegExp(`${SECRET}|${OLD}|${OUTSIDE}`, "u"));
  expect(readFile(fixture.target)).toBe(NEW);
}

function setupWorkspace(): Promise<FunctionalWorkspaceFixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-opencode-functional-")));
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
  const evidence = memoryEvidence(new Map());
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

async function stopRun(base: string, runId: string): Promise<void> {
  const stopped = await post(base, `/api/coding-workbench/runtime/runs/${runId}/stop`, {
    requestId: runId,
  });
  expect(stopped.status).toBe(200);
  await expect(stopped.json()).resolves.toMatchObject({ runId, state: "cancelled" });
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

let questionPollSequence = 0;

async function waitForQuestion(
  orchestrator: CodingRuntimeOrchestrator,
  runId: string,
  tag: string,
): Promise<CodingWorkbenchRuntimeQuestionRequest> {
  let found: readonly CodingWorkbenchRuntimeQuestionRequest[] = [];
  await vi.waitFor(
    async () => {
      questionPollSequence += 1;
      const snapshot = orchestrator.getSnapshot(runId);
      expect(snapshot?.state).toBe("running");
      const listed = await orchestrator.listQuestions(runId, {
        requestId: `${tag}-${String(questionPollSequence)}`,
        expectedRevision: snapshot?.revision ?? -1,
      });
      expect(listed.ok, `question listing failed for ${tag}`).toBe(true);
      if (listed.ok) found = listed.questions.questions;
      expect(found).toHaveLength(1);
    },
    { timeout: 30_000, interval: 100 },
  );
  const question = found[0];
  if (question === undefined) throw new Error("expected-runtime-question");
  return question;
}

async function answerQuestion(
  orchestrator: CodingRuntimeOrchestrator,
  runId: string,
  questionId: string,
  answers: readonly (readonly string[])[],
): Promise<boolean> {
  questionPollSequence += 1;
  const snapshot = orchestrator.getSnapshot(runId);
  const result = await orchestrator.answerQuestion(runId, {
    requestId: `answer-${String(questionPollSequence)}`,
    expectedRevision: snapshot?.revision ?? -1,
    questionId,
    answers,
  });
  return result.ok;
}

async function rejectQuestion(
  orchestrator: CodingRuntimeOrchestrator,
  runId: string,
  questionId: string,
): Promise<boolean> {
  questionPollSequence += 1;
  const snapshot = orchestrator.getSnapshot(runId);
  const result = await orchestrator.rejectQuestion(runId, {
    requestId: `reject-${String(questionPollSequence)}`,
    expectedRevision: snapshot?.revision ?? -1,
    questionId,
  });
  return result.ok;
}

async function waitForChildTurns(scripted: ScriptedOpenCodeHarness, turns: number): Promise<void> {
  await vi.waitFor(
    () => {
      const child = scripted.children.at(-1);
      expect(child).toBeDefined();
      expect(child?.completedTurns()).toBeGreaterThanOrEqual(turns);
    },
    { timeout: 30_000, interval: 50 },
  );
}

function memoryEvidence(entries: Map<string, string>): EvidenceStore {
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
