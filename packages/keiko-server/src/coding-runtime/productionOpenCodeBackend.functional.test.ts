import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CodingAppSessionChannelSnapshot,
  CodingWorkbenchRuntimeQuestionRequest,
  CodingWorkbenchRuntimeSseEvent,
  EditorVerificationEvent,
} from "@oscharko-dev/keiko-contracts";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createNodeGitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";

import { createUiServer, UI_HOST } from "../server.js";
import { fakePairingRequestBody } from "../coding-app-session/_support.js";
import type { UiHandlerDeps } from "../deps.js";
import {
  defaultServerDiagnosticSink,
  type ServerDiagnosticRecord,
  type ServerDiagnosticSink,
} from "../diagnostics-log.js";
import { runMigrations } from "../store/schema.js";
import { createInMemoryUiStore } from "../store/index.js";
import { createCodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";
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
import { devLaneEnvEnabled } from "./devLanePortableCodingRuntime.js";
import {
  createFunctionalRuntimeResolver,
  functionalBffDeps,
  productionDiscoveryBffDeps,
  FUNCTIONAL_ACTIVITY_ASSISTANT_PREFIX,
  FUNCTIONAL_ACTIVITY_TRUNCATED_TAIL,
  FUNCTIONAL_PLAN_DROPPED_CANARY,
  FUNCTIONAL_PLAN_STEP_EDIT,
  FUNCTIONAL_PLAN_STEP_READ,
  FUNCTIONAL_PLAN_STEP_VERIFY,
  type ScriptState,
} from "./productionOpenCodeBackend.functional/_support.js";

const SECRET = "TASK_SECRET_2258";
const OLD = "export const value = 'ORIGINAL_SECRET_2258';\n";
const NEW = "export const value = 'NEW_SECRET_2258';\n";
const OUTSIDE = "OUTSIDE_SECRET_2258\n";
const OVERSIZED_CALL_ID = `RAW_TOOL_CALL_ID_2479_${"x".repeat(256)}`;
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
  readonly diagnostics: readonly ServerDiagnosticRecord[];
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
  it("leaves no available feed when backend construction fails", async () => {
    const fixture = await setupWorkspace();
    const portable = scriptedFunctionalPortable(fixture.root);
    const pipeline = await bootPipeline(fixture, portable, () => {
      throw new Error("construction-failure");
    });

    await expect(
      post(
        pipeline.baseUrl,
        "/api/coding-workbench/runtime/runs",
        startBody("construction-failure"),
      ),
    ).resolves.toMatchObject({ status: 403 });
    expect(pipeline.deps.codingSafeActivityProjection?.currentContent()).toBeNull();
  });

  it("rejects an oversized tool correlation identity without retaining raw content", async () => {
    const fixture = await setupWorkspace();
    fixture.script.toolCallId = OVERSIZED_CALL_ID;
    const scripted = createScriptedOpenCodeHarness();
    disposers.push(() => scripted.closeAll());
    const portable = scriptedFunctionalPortable(fixture.root);
    const pipeline = await bootPipeline(fixture, portable, scripted.createSupervisor);
    const cookie = await pipelineSessionCookie(pipeline.baseUrl);
    const started = await post(
      pipeline.baseUrl,
      "/api/coding-workbench/runtime/runs",
      startBody("oversized-tool-correlation"),
    );
    expect(started.status).toBe(200);
    const run = (await started.json()) as { readonly runId: string };
    let snapshot = "";
    await vi.waitFor(
      async () => {
        snapshot = JSON.stringify(await codingAppSessionSnapshot(pipeline.baseUrl, cookie));
        expect(snapshot).toMatch(/"droppedEventCount":[1-9]/u);
      },
      { timeout: 30_000, interval: 100 },
    );
    expect(snapshot).not.toContain(OVERSIZED_CALL_ID);
    await stopRun(pipeline.baseUrl, run.runId);
  }, 120_000);

  it("keeps the coding-runtime control plane when a store is injected with its snapshot companion", async () => {
    // The shared Playwright journey (tests/e2e/servers/coding-runtime-server-shared.mts) injects
    // its own UiStore into this assembly. Injection suppresses the assembly's own persistence
    // composition, and until the snapshot-store companion was wired through, that silently
    // dropped the ENTIRE coding-runtime control plane: the scheduled real-binary lane refused
    // daily as `real-binary-journey-unqualified:undefined` for two weeks after #2835. This pin
    // runs in ordinary CI so that composition class can never again survive only in a
    // scheduled lane.
    const fixture = await setupWorkspace();
    const db = new DatabaseSync(":memory:");
    runMigrations(db);
    const deps = productionDiscoveryBffDeps({
      stateRoot: join(fixture.root, "bff-state-injected"),
      store: createInMemoryUiStore(),
      codingRuntimeSnapshotStore: createCodingRuntimeSnapshotStore(db),
      workspaceLifecycle: fixture.lifecycle,
      script: fixture.script,
      uiPort: await reserveLoopbackPort(),
    });
    disposers.push(async () => {
      await deps.codingRuntimeOrchestrator?.shutdown();
      await deps.dispose?.();
    });
    // The control plane must exist: qualification is answered as a boolean, and an unqualified
    // answer must carry its reason. An absent orchestrator next to an undefined reason is the
    // silent no-control-plane state this pin forbids.
    expect(deps.codingRuntimeOrchestrator).toBeDefined();
    expect(typeof deps.codingRuntimeHostQualified).toBe("boolean");
    if (deps.codingRuntimeHostQualified === false) {
      expect(deps.codingRuntimeUnavailableReason).toBeDefined();
    }
  }, 60_000);

  it("drives the managed OpenCode composition end to end with a scripted child and model gateway", async () => {
    const fixture = await setupWorkspace();
    const scripted = createScriptedOpenCodeHarness();
    disposers.push(() => scripted.closeAll());
    const portable = scriptedFunctionalPortable(fixture.root);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const pipeline = await bootPipeline(fixture, portable, scripted.createSupervisor, {
        mirrorDiagnosticsToDefaultLog: true,
      });
      try {
        await runProductiveScenario(fixture, pipeline);
      } catch (error) {
        throw new Error(
          `functional-scenario-failed:${scripted.children
            .flatMap((child) => child.fixtureFailures())
            .join(",")}`,
          { cause: error },
        );
      }
      await runAuthorityScenarios(fixture, pipeline);
      await runRejectedQuestionScenario(fixture, pipeline, scripted);
      await runStopPendingQuestionScenario(fixture, pipeline);
      await runOutOfScopeScenario(fixture, pipeline, scripted);
      assertRedactedEvidence(fixture, pipeline);
      assertCanariesAbsentFromRequestTargets(scripted);
      assertCanariesAbsentFromOperatorDiagnostics(pipeline.diagnostics, logged.mock.calls);
    } finally {
      logged.mockRestore();
    }
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

  // #2475 anti-false-green acceptance: activation resolves through PRODUCTION discovery and
  // composition — the dev lane's verified staged payload of this repository checkout — with no
  // injected runtime seam. The staged-seam case above remains as the control.
  it.skipIf(!devLaneDiscoveryFunctionalEnabled())(
    "[functional-only] activates the staged dev-lane payload through production discovery with no injected runtime seam",
    async () => {
      // The managed worktree root must be the one the production composition derives from the
      // UI-store path (`<dirname(uiDbPath)>/task-workspaces`); the workspace authority re-proves
      // every run's containment against exactly that root.
      const fixture = await setupWorkspace(["bff-state", "ui-db", "task-workspaces"]);
      fixture.script.mode = "discovery";
      const pipeline = await bootDiscoveryPipeline(fixture);
      expect(pipeline.deps.env.KEIKO_OPENCODE_REAL_BINARY).toBeUndefined();
      expect(pipeline.deps.env.KEIKO_OPENCODE_REAL_RESOURCE_ROOT).toBeUndefined();
      // Asserted first: on activation failure the precise reason is the diagnostic.
      expect(pipeline.deps.codingRuntimeUnavailableReason).toBeUndefined();
      expect(pipeline.deps.codingRuntimeHostQualified).toBe(true);
      await assertLiveReadiness(pipeline.baseUrl);
      await runDiscoveryProductiveScenario(fixture, pipeline);
      assertRedactedEvidence(fixture, pipeline, OLD);
    },
    120_000,
  );
});

function devLaneDiscoveryFunctionalEnabled(): boolean {
  return (
    process.platform === "darwin" &&
    devLaneEnvEnabled(process.env.KEIKO_OPENCODE_DEV_LANE_FUNCTIONAL)
  );
}

/**
 * Boots the BFF with production composition only: activation must discover the dev-lane payload
 * staged for this repository checkout (`npm run dev:coding-runtime:stage`). The absence of the
 * resolver, ports, and supervisor seams is structural — `productionDiscoveryBffDeps` has no such
 * inputs — and the seam environment values are asserted absent above.
 */
async function bootDiscoveryPipeline(
  fixture: FunctionalWorkspaceFixture,
): Promise<FunctionalPipeline> {
  const verification = createVerification(fixture.workspace);
  const port = await reserveLoopbackPort();
  const deps = productionDiscoveryBffDeps({
    stateRoot: join(fixture.root, "bff-state"),
    workspaceLifecycle: fixture.lifecycle,
    script: fixture.script,
    uiPort: port,
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
    evidenceBodies: new Map<string, string>(),
    diagnostics: [],
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

async function assertLiveReadiness(baseUrl: string): Promise<void> {
  const response = await fetch(
    `${baseUrl}/api/coding-workbench/runtime/readiness?requestedMode=autonomous-delivery`,
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    schemaVersion: "1",
    requestedMode: "autonomous-delivery",
    // The explicitly configured ceiling (KEIKO_CODING_DEPLOYMENT_CEILING) is reported honestly.
    deploymentCeiling: "autonomous-delivery",
    effectiveMode: "autonomous-delivery",
    runtimeAvailable: true,
    runtimeEvidenceClass: "functional-not-platform-qualified",
  });
}

/** The productive journey against the discovery-activated runtime (no verification fixture). */
async function runDiscoveryProductiveScenario(
  fixture: FunctionalWorkspaceFixture,
  pipeline: FunctionalPipeline,
): Promise<void> {
  const started = await post(
    pipeline.baseUrl,
    "/api/coding-workbench/runtime/runs",
    startBody("discovery-productive"),
  );
  const startedBody = await started.clone().text();
  expect(
    started.status,
    `${startedBody}; diagnostics: ${JSON.stringify(pipeline.diagnostics)}`,
  ).toBe(200);
  const run = (await started.json()) as { runId: string; state: string; failureCode?: string };
  pipeline.subscribeTimeline(run.runId);
  // Snapshot and timeline are content-free by contract; on failure they are the diagnostic.
  expect(
    run,
    `start snapshot: ${JSON.stringify(run)}; timeline: ${JSON.stringify(pipeline.timeline)}`,
  ).toMatchObject({ state: "running" });
  const question = await waitForQuestion(pipeline.orchestrator, run.runId, "discovery-question");
  expect(question.questions[0]?.question).toBe("Approve?");
  await expect(
    answerQuestion(pipeline.orchestrator, run.runId, question.id, [["Approve"]]),
  ).resolves.toBe(true);
  // The question's arrival above already proves the full governed round-trip against the real
  // child: gateway canary → task turn → tool bridge → dev-lane secure-read helper → scripted
  // model → runtime question → answer. The edit and verification legs are deliberately out of
  // this headless journey's scope (applyChangeset requires a live browser bridge — the browser
  // owns editor state — and the verification runner requires a product-registered project); the
  // staged-seam control and the W1.10 real-binary UI journey own them. The workspace file must
  // remain untouched, and the run must stop under governance.
  expect(readFile(fixture.target)).toBe(OLD);
  const status = pipeline.orchestrator.getSnapshot(run.runId);
  expect(status?.state).toBe("running");
  await stopRun(pipeline.baseUrl, run.runId);
}

async function bootPipeline(
  fixture: FunctionalWorkspaceFixture,
  portable: FunctionalPortableOpenCodeRuntime,
  createSupervisor: NonNullable<ProductionOpenCodeBackendInput["createSupervisor"]>,
  options: { readonly mirrorDiagnosticsToDefaultLog?: boolean } = {},
): Promise<FunctionalPipeline> {
  const verification = createVerification(fixture.workspace);
  const evidenceBodies = new Map<string, string>();
  const runtimeEvidence = createCodingRuntimeEvidenceAggregator(memoryEvidence(evidenceBodies));
  const diagnosticRecords: ServerDiagnosticRecord[] = [];
  const diagnostics: ServerDiagnosticSink = {
    record: (record): void => {
      diagnosticRecords.push(record);
      if (options.mirrorDiagnosticsToDefaultLog === true) {
        defaultServerDiagnosticSink.record(record);
      }
    },
  };
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
    diagnostics,
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
    diagnostics: diagnosticRecords,
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
  const sessionCookie = await pipelineSessionCookie(pipeline.baseUrl);
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
  const preAnswerActivity = JSON.stringify(
    await codingAppSessionSnapshot(pipeline.baseUrl, sessionCookie),
  );
  expect(preAnswerActivity).toContain(SECRET);
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
  const activity = await waitForSafeActivity(pipeline.baseUrl, sessionCookie);
  expect(activity).toContain(SECRET);
  expect(activity).toContain(FUNCTIONAL_ACTIVITY_ASSISTANT_PREFIX);
  expect(activity).not.toContain(FUNCTIONAL_ACTIVITY_TRUNCATED_TAIL);
  expect(activity).not.toContain(OLD);
  expect(activity).not.toContain(NEW);
  expect(activity).toContain('"state":"succeeded"');
  expect(activity).toContain('"truncated":true');
  // #2480: the plan snapshot updated live — revision 2 carries the added verify step and the
  // state flips, while unprojected todo fields and the plan tool never surface as tool activity.
  expect(activity).toContain('"revision":2');
  expect(activity).toContain(FUNCTIONAL_PLAN_STEP_READ);
  expect(activity).toContain(FUNCTIONAL_PLAN_STEP_VERIFY);
  expect(activity).toContain('"state":"active"');
  expect(activity).not.toContain(FUNCTIONAL_PLAN_DROPPED_CANARY);
  expect(activity).not.toContain('"todowrite"');
  const unpaired = await codingAppSessionSnapshot(pipeline.baseUrl);
  expect(unpaired).toEqual({ schemaVersion: "1", content: null });
  const unauthenticatedTimeline = JSON.stringify(pipeline.timeline);
  for (const canary of rawActivityCanaries()) {
    expect(unauthenticatedTimeline).not.toContain(canary);
    expect(JSON.stringify(unpaired)).not.toContain(canary);
  }
  expect(
    pipeline.timeline.filter(
      (event) => event.kind === "runtime-event" && event.eventKind === "verification-summarized",
    ),
  ).toHaveLength(1);
  expect(
    pipeline.verification.events.find((event) => event.kind === "run-completed"),
  ).toMatchObject({ report: { overallStatus: "passed" } });
  pipeline.deps.codingSafeActivityProjection?.recordDrop(run.runId, "validation-rejected");
  await stopRun(pipeline.baseUrl, run.runId);
  await expect(codingAppSessionSnapshot(pipeline.baseUrl, sessionCookie)).resolves.toEqual({
    schemaVersion: "1",
    content: null,
  });
}

async function pairAppSession(baseUrl: string): Promise<string> {
  const response = await post(baseUrl, PAIR_PATH, fakePairingRequestBody());
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined) throw new Error("functional-app-session-pairing-failed");
  return cookie;
}

async function codingAppSessionSnapshot(
  baseUrl: string,
  cookie?: string,
): Promise<CodingAppSessionChannelSnapshot> {
  const response = await fetch(`${baseUrl}/api/coding-workbench/app-session/channel`, {
    headers: cookie === undefined ? {} : { Cookie: cookie },
  });
  assertResponseMetadata(response);
  expect(response.status).toBe(200);
  return (await response.json()) as CodingAppSessionChannelSnapshot;
}

async function waitForSafeActivity(baseUrl: string, cookie: string): Promise<string> {
  let body = "";
  await vi.waitFor(
    async () => {
      body = JSON.stringify(await codingAppSessionSnapshot(baseUrl, cookie));
      expect(body).toContain(FUNCTIONAL_ACTIVITY_ASSISTANT_PREFIX);
      expect(body).toContain('"state":"succeeded"');
    },
    { timeout: 30_000, interval: 100 },
  );
  return body;
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
  expectedTarget: string = NEW,
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
  for (const canary of rawActivityCanaries()) {
    expect(`${evidence}${snapshots}`).not.toContain(canary);
  }
  expect(readFile(fixture.target)).toBe(expectedTarget);
}

function rawActivityCanaries(): readonly string[] {
  return [
    SECRET,
    OLD,
    NEW,
    OUTSIDE,
    FUNCTIONAL_ACTIVITY_ASSISTANT_PREFIX,
    FUNCTIONAL_ACTIVITY_TRUNCATED_TAIL,
    OVERSIZED_CALL_ID,
    FUNCTIONAL_PLAN_STEP_READ,
    FUNCTIONAL_PLAN_STEP_EDIT,
    FUNCTIONAL_PLAN_STEP_VERIFY,
    FUNCTIONAL_PLAN_DROPPED_CANARY,
  ];
}

function assertCanariesAbsentFromRequestTargets(scripted: ScriptedOpenCodeHarness): void {
  const targets = JSON.stringify(scripted.children.flatMap((child) => child.requestedTargets()));
  for (const canary of rawActivityCanaries()) expect(targets).not.toContain(canary);
}

function assertCanariesAbsentFromOperatorDiagnostics(
  diagnostics: readonly ServerDiagnosticRecord[],
  defaultLogCalls: readonly unknown[],
): void {
  expect(diagnostics.length).toBeGreaterThan(0);
  expect(defaultLogCalls.length).toBeGreaterThan(0);
  const operatorOutput = JSON.stringify({ diagnostics, defaultLogCalls });
  for (const canary of rawActivityCanaries()) expect(operatorOutput).not.toContain(canary);
}

function assertResponseMetadata(response: Response): void {
  expect(response.redirected).toBe(false);
  for (const canary of rawActivityCanaries()) expect(response.url).not.toContain(canary);
}

function setupWorkspace(
  managedRootSegments: readonly string[] = ["managed"],
): Promise<FunctionalWorkspaceFixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-opencode-functional-")));
  roots.push(root);
  const repository = join(root, "repository");
  const managedRoot = join(root, ...managedRootSegments);
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
          mutex,
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

// Every state-changing coding-runtime route binds to the launcher-attested app session
// (ADR-0141 D1/D2), so the functional transport behaves like the paired browser: one session per
// booted pipeline, redeemed lazily and presented on every subsequent POST. The pair endpoint itself
// is the one path that must not present a cookie — it is what mints one.
const PAIR_PATH = "/api/coding-workbench/app-session/pair";
const pipelineSessions = new Map<string, Promise<string>>();

function pipelineSessionCookie(base: string): Promise<string> {
  const existing = pipelineSessions.get(base);
  if (existing !== undefined) return existing;
  const minted = pairAppSession(base);
  pipelineSessions.set(base, minted);
  return minted;
}

async function post(base: string, path: string, body: unknown): Promise<Response> {
  const cookie = path === PAIR_PATH ? undefined : await pipelineSessionCookie(base);
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Keiko-CSRF": "1",
      Origin: base,
      ...(cookie === undefined ? {} : { Cookie: cookie }),
    },
    body: JSON.stringify(body),
  });
  assertResponseMetadata(response);
  return response;
}

async function stopRun(base: string, runId: string): Promise<void> {
  const stopped = await post(base, `/api/coding-workbench/runtime/runs/${runId}/stop`, {
    requestId: runId,
  });
  expect(stopped.status).toBe(200);
  // Under the causal-terminal contract the child's own stop completion may settle the run
  // succeeded before the operator's stop lands. Both terminal outcomes are legitimate here;
  // anything else (failed, still running, missing snapshot) stays a hard failure.
  const body = (await stopped.json()) as { readonly runId?: string; readonly state?: string };
  if (body.state === "cancelled") {
    expect(body).toMatchObject({ runId, state: "cancelled" });
    return;
  }
  const settled = await fetch(`${base}/api/coding-workbench/runtime/runs/${runId}`);
  assertResponseMetadata(settled);
  expect(settled.status).toBe(200);
  await expect(settled.json()).resolves.toMatchObject({ runId, state: "succeeded" });
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
