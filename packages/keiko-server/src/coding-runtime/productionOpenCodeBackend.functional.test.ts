import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
import type { GatewayRequest } from "@oscharko-dev/keiko-model-gateway";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createNodeGitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";

import { resetServerLogger } from "../../../../tests/support/activity-log-test-support.js";
import {
  createBufferedServerLogSink,
  type BufferedServerLogSink,
} from "../../../../tests/support/buffered-server-log.js";
import { createServerLogger, setServerLogger } from "../observability/index.js";
import { createUiServer, UI_HOST } from "../server.js";
import { fakePairingRequestBody } from "../coding-app-session/_support.js";
import { productionOpenCodeToolProfile, type UiHandlerDeps } from "../deps.js";
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
import { createCodingRuntimeEditorMutationLeaseBroker } from "./codingRuntimeEditorMutationLeaseCoordinator.js";
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
import { openCodeSelectableAgents } from "./opencodeAgents.js";
import { openCodePromptInputs } from "./opencodePromptInputs.js";
import {
  createFunctionalRuntimeResolver,
  functionalBffDeps,
  productionDiscoveryBffDeps,
  FUNCTIONAL_ACTIVITY_ASSISTANT_PREFIX,
  FUNCTIONAL_ACTIVITY_TRUNCATED_TAIL,
  FUNCTIONAL_INDEX_AFTER_MARKER,
  FUNCTIONAL_INDEX_PATH,
  FUNCTIONAL_INDEX_STAGED_MARKER,
  FUNCTIONAL_LIFECYCLE_BACKGROUND_COMMAND,
  FUNCTIONAL_LIFECYCLE_DETACHED_COMMAND,
  FUNCTIONAL_LIFECYCLE_FOREGROUND_COMMAND,
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
  readonly provisioning: ReturnType<typeof createWorkspaceProvisioningService>;
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
            .join(",")};diagnostics=${pipeline.diagnostics.map((record) => record.code).join(",")}`,
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
  observeGatewayRequest?: (request: GatewayRequest) => void,
  operatorEnv?: Readonly<Record<string, string>>,
): Promise<FunctionalPipeline> {
  const verification = createVerification(fixture.workspace);
  const port = await reserveLoopbackPort();
  const deps = productionDiscoveryBffDeps({
    stateRoot: join(fixture.root, "bff-state"),
    workspaceLifecycle: fixture.lifecycle,
    // The run's Git preparation re-proves the managed workspace through the same provisioning
    // owner that created it, as the composed server does.
    workspaceProvisioning: fixture.provisioning,
    script: fixture.script,
    uiPort: port,
    ...(observeGatewayRequest === undefined ? {} : { observeGatewayRequest }),
    ...(operatorEnv === undefined ? {} : { operatorEnv }),
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
    // Derived from the production entry points, not restated: the platform picks the profile.
    selectableAgents: openCodeSelectableAgents(productionOpenCodeToolProfile()),
    promptInputs: openCodePromptInputs(productionOpenCodeToolProfile()),
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
  const runtimeMutationLeaseBroker = createCodingRuntimeEditorMutationLeaseBroker();
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
    runtimeMutationLeaseBroker,
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
    runtimeMutationLeaseBroker.dispose();
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
  // V2 exposes progress as assistant text, without V1's native todowrite tool. The paired-only
  // visibility and redaction invariant remains here; structured-plan bounds stay in
  // opencodeSafeActivity.test.ts, at the projection layer that owns them.
  expect(activity).toContain(FUNCTIONAL_PLAN_STEP_READ);
  expect(activity).toContain(FUNCTIONAL_PLAN_STEP_VERIFY);
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
  // #3565 Observation 17: a drifted workspace is refused as `workspace-unqualified` (409) with the
  // refusing check named, no longer as the generic authority failure (403).
  const drifted = await post(
    pipeline.baseUrl,
    "/api/coding-workbench/runtime/runs",
    startBody("drifted"),
  );
  expect(drifted.status).toBe(409);
  expect(await drifted.json()).toMatchObject({
    error: { code: "CODING_RUNTIME_WORKSPACE_UNQUALIFIED" },
  });
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
    FUNCTIONAL_PLAN_STEP_VERIFY,
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
        provisioning,
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
      expect(
        listed.ok,
        `question listing failed for ${tag}: ${listed.ok ? "ok" : listed.failureCode}`,
      ).toBe(true);
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

// #3899 AC2: the original pinned service, started by the production lifecycle owner from the
// dev lane's verified artifact (no runtime seam), observed as the processes and sockets it really
// has. Only the model is scripted; it starts one background and one foreground child through the
// runtime's own shell tool, so every ending has a live process tree to reap.
describe.skipIf(!devLaneDiscoveryFunctionalEnabled())(
  "original OpenCode service lifecycle through the production owner (#3899 AC2)",
  () => {
    it("starts the attested service behind an authenticated loopback transport, bound to the task's workspace", async () => {
      const run = await startLifecycleRun("lifecycle-identity");
      const phases = readinessPhases(run.log, run.runId);
      expect(orderedSubsequence(phases, ATTESTED_SERVICE_PHASES), phases.join(",")).toBe(true);
      const addresses = listeningAddresses(run.service.pid);
      expect(addresses.length).toBeGreaterThan(0);
      for (const address of addresses) {
        expect(address).toMatch(/^127\.0\.0\.1:\d+$/u);
        await expectRefusedWithoutTheRunPassword(`http://${address}`);
      }
      expect(
        realpathSync(processDirectory(onlyProcess(FUNCTIONAL_LIFECYCLE_FOREGROUND_COMMAND).pid)),
      ).toBe(realpathSync(run.fixture.workspace));
      await stopRun(run.pipeline.baseUrl, run.runId);
      await expectServiceTreeReaped(run.service);
    }, 180_000);

    it("cancels a busy turn and reaps the service, its background job and what a command detached", async () => {
      const run = await startLifecycleRun("lifecycle-cancel");
      expect(childCommands(run.service.pid)).toEqual(
        expect.arrayContaining([
          FUNCTIONAL_LIFECYCLE_BACKGROUND_COMMAND,
          FUNCTIONAL_LIFECYCLE_FOREGROUND_COMMAND,
        ]),
      );
      // The detached process belongs to launchd already, in the run's workspace (#3901 AC3).
      const detached = onlyProcess(FUNCTIONAL_LIFECYCLE_DETACHED_COMMAND);
      expect(detached.ppid).toBe(1);
      expect(realpathSync(processDirectory(detached.pid))).toBe(
        realpathSync(run.fixture.workspace),
      );
      // PR #4064 review: a process started in the run's workspace from outside the run, after the
      // service, is the human's; it shares the detached process's parent, directory and start
      // window, and the Stop never touches it.
      const foreign = spawn("/bin/sleep", ["3899.9"], {
        cwd: run.fixture.workspace,
        detached: true,
        stdio: "ignore",
      });
      foreign.unref();
      try {
        await stopRun(run.pipeline.baseUrl, run.runId);
        // Physical execution is settled before Stop answers: nothing is left to wait for (#3901 AC3).
        expectNothingLeft(run.service);
        expect(run.pipeline.orchestrator.getSnapshot(run.runId)?.state).toBe("cancelled");
        await vi.waitFor(() => {
          expect(sweepLines(run.log, run.runId)).toEqual([
            expect.objectContaining({ outcome: "reaped" }),
          ]);
        });
        expect(sweepLines(run.log, run.runId)[0]?.roundCount).toBeGreaterThanOrEqual(1);
        expect(() => process.kill(foreign.pid ?? 0, 0)).not.toThrow();
      } finally {
        foreign.kill("SIGKILL");
      }
    }, 180_000);

    it("ends the children of a crashed service and continues the task in a new service", async () => {
      const transcripts: string[] = [];
      const run = await startLifecycleRun("lifecycle-crash", (request) => {
        transcripts.push(JSON.stringify(request.messages));
      });
      // A crash while the command runs, at once: no sample of the running service is needed, the
      // run's sandbox member answers which processes are the run's (PR #4064 review).
      process.kill(run.service.pid, "SIGKILL");
      await expectServiceTreeReaped(run.service);
      // The line follows the kernel's answer that no process of the run remains.
      await vi.waitFor(() => {
        expect(sweepLines(run.log, run.runId)).toEqual([
          expect.objectContaining({ outcome: "reaped" }),
        ]);
      });
      // The background job, the busy foreground child and the detached process remained.
      expect(sweepLines(run.log, run.runId)[0]?.roundCount).toBeGreaterThanOrEqual(1);
      await vi.waitFor(
        () => {
          expect(run.pipeline.orchestrator.getSnapshot(run.runId)?.state).not.toBe("running");
        },
        { timeout: 30_000, interval: 100 },
      );
      // A runtime ended by a signal nobody in Keiko sent is a human reconciliation (ADR-0137 D5):
      // the Workbench offers "Acknowledge recovery", and the next start takes the slot.
      const crashed = run.pipeline.orchestrator.getSnapshot(run.runId);
      expect(crashed?.state).toBe("recovery-required");
      const acknowledged = await post(
        run.pipeline.baseUrl,
        `/api/coding-workbench/runtime/runs/${run.runId}/recovery-ack`,
        { requestId: run.runId, acknowledged: true },
      );
      expect(acknowledged.status).toBe(200);
      run.fixture.script.mode = "lifecycle-continue";
      transcripts.length = 0;
      const continued = await startRun(run.pipeline, {
        ...startBody("lifecycle-restart"),
        taskIntent: "Continue after the crash",
        conversationId: crashed?.conversationId,
      });
      const restarted = onlyService();
      expect(restarted.pid).not.toBe(run.service.pid);
      await vi.waitFor(() => {
        expect(transcripts.some((transcript) => transcript.includes(SECRET))).toBe(true);
      });
      await stopRun(run.pipeline.baseUrl, continued);
      await expectServiceTreeReaped(restarted);
    }, 240_000);

    it("reaps a service that dies during startup, refuses that start, and starts the next one", async () => {
      const fixture = await setupWorkspace(["bff-state", "ui-db", "task-workspaces"]);
      fixture.script.mode = "lifecycle-continue";
      const pipeline = await bootDiscoveryPipeline(fixture);
      const killed = killServiceOnSpawn();
      const refused = await post(
        pipeline.baseUrl,
        "/api/coding-workbench/runtime/runs",
        startBody("lifecycle-startup-failure"),
      );
      const service = await killed;
      const body = (await refused.json()) as { readonly state?: string };
      expect(refused.status === 200 && body.state === "running").toBe(false);
      await expectServiceTreeReaped(service);
      const runId = await startRun(pipeline, startBody("lifecycle-after-startup-failure"));
      const next = onlyService();
      await stopRun(pipeline.baseUrl, runId);
      await expectServiceTreeReaped(next);
    }, 240_000);

    it("ends an active run and reaps its service tree when the server shuts down", async () => {
      const run = await startLifecycleRun("lifecycle-shutdown");
      await run.pipeline.deps.dispose?.();
      expectNothingLeft(run.service);
      expect(settledStates(run.log, run.runId)).toContain("cancelled");
    }, 180_000);
  },
);

interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
}

interface LifecycleRun {
  readonly fixture: FunctionalWorkspaceFixture;
  readonly pipeline: FunctionalPipeline;
  readonly runId: string;
  readonly service: ProcessRow;
  readonly log: BufferedServerLogSink;
}

// The readiness phases that attest the service before its first turn: the verified artifact, the
// announced loopback endpoint, authenticated health (which refuses any version but the pinned one),
// the refusal of an unauthenticated request, the producer's protocol digest and the session echoed
// at the bound workspace Location (opencodeRuntimeAdapter.ts).
const ATTESTED_SERVICE_PHASES = [
  "target-attestation",
  "endpoint",
  "authenticated-health",
  "unauthenticated-health",
  "openapi-digest",
  "session-echo",
] as const;
const SERVICE_COMMAND = "/opencode-compatible/payload/bin/opencode serve --hostname 127.0.0.1 ";

async function startLifecycleRun(
  tag: string,
  observeGatewayRequest?: (request: GatewayRequest) => void,
): Promise<LifecycleRun> {
  const log = recordActivityLog();
  const fixture = await setupWorkspace(["bff-state", "ui-db", "task-workspaces"]);
  fixture.script.mode = "lifecycle";
  const pipeline = await bootDiscoveryPipeline(fixture, observeGatewayRequest);
  const runId = await startRun(pipeline, startBody(tag));
  await vi.waitFor(
    () => {
      expect(childCommands(onlyService().pid)).toContain(FUNCTIONAL_LIFECYCLE_FOREGROUND_COMMAND);
    },
    { timeout: 60_000, interval: 200 },
  );
  return { fixture, pipeline, runId, service: onlyService(), log };
}

async function startRun(pipeline: FunctionalPipeline, body: unknown): Promise<string> {
  const started = await post(pipeline.baseUrl, "/api/coding-workbench/runtime/runs", body);
  const text = await started.clone().text();
  expect(started.status, text).toBe(200);
  const run = (await started.json()) as { readonly runId: string; readonly state: string };
  expect(run.state, text).toBe("running");
  return run.runId;
}

function recordActivityLog(): BufferedServerLogSink {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
  disposers.push(() => {
    resetServerLogger();
  });
  return sink;
}

function readinessPhases(log: BufferedServerLogSink, runId: string): readonly string[] {
  return log.events.flatMap((event) => {
    const phase = event.extra?.phase;
    return event.op === "coding-runtime.readiness.phase" &&
      event.correlationId === runId &&
      typeof phase === "string"
      ? [phase]
      : [];
  });
}

function sweepLines(
  log: BufferedServerLogSink,
  runId: string,
): readonly Readonly<Record<string, unknown>>[] {
  return log.events.flatMap((event) =>
    event.op === "coding-runtime.descendants.swept" && event.correlationId === runId
      ? [
          {
            outcome: event.extra?.outcome,
            roundCount: event.extra?.roundCount,
            checkCount: event.extra?.checkCount,
          },
        ]
      : [],
  );
}

function settledStates(log: BufferedServerLogSink, runId: string): readonly unknown[] {
  return log.events.flatMap((event) =>
    event.op === "coding-runtime.run.settled" && event.extra?.runId === runId
      ? [event.extra.state]
      : [],
  );
}

function orderedSubsequence(values: readonly string[], expected: readonly string[]): boolean {
  let next = 0;
  for (const value of values) if (value === expected[next]) next += 1;
  return next === expected.length;
}

function processTable(): readonly ProcessRow[] {
  return execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
      return match === null
        ? []
        : [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" }];
    });
}

/** The original services this server process owns right now. */
function services(): readonly ProcessRow[] {
  return processTable().filter(
    (row) => row.ppid === process.pid && row.command.includes(SERVICE_COMMAND),
  );
}

function onlyService(): ProcessRow {
  const owned = services();
  expect(owned).toHaveLength(1);
  const [service] = owned;
  if (service === undefined) throw new Error("expected-one-original-service");
  return service;
}

function onlyProcess(command: string): ProcessRow {
  const matching = processTable().filter((row) => row.command === command);
  expect(matching).toHaveLength(1);
  const [row] = matching;
  if (row === undefined) throw new Error("expected-one-process");
  return row;
}

function childCommands(pid: number): readonly string[] {
  return processTable()
    .filter((row) => row.ppid === pid)
    .map((row) => row.command);
}

function lsofNames(args: readonly string[]): readonly string[] {
  return execFileSync("/usr/sbin/lsof", [...args, "-Fn"], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1));
}

function listeningAddresses(pid: number): readonly string[] {
  return lsofNames(["-a", "-nP", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"]);
}

function processDirectory(pid: number): string {
  const [directory] = lsofNames(["-a", "-p", String(pid), "-d", "cwd"]);
  if (directory === undefined) throw new Error("expected-process-directory");
  return directory;
}

// Only Keiko holds the run's password: the service answers nothing without it, with a wrong one,
// or for a state-changing request.
async function expectRefusedWithoutTheRunPassword(origin: string): Promise<void> {
  const wrong = `Basic ${Buffer.from("opencode:not-the-run-password").toString("base64")}`;
  const statuses = [
    (await fetch(`${origin}/api/info`)).status,
    (await fetch(`${origin}/api/info`, { headers: { Authorization: wrong } })).status,
    (await fetch(`${origin}/api/session`, { method: "POST", body: "{}" })).status,
  ];
  expect(statuses).toEqual([401, 401, 401]);
}

const LIFECYCLE_COMMANDS: ReadonlySet<string> = new Set([
  FUNCTIONAL_LIFECYCLE_BACKGROUND_COMMAND,
  FUNCTIONAL_LIFECYCLE_DETACHED_COMMAND,
  FUNCTIONAL_LIFECYCLE_FOREGROUND_COMMAND,
]);

/** The service, its children and every lifecycle command are gone right now. */
function expectNothingLeft(service: ProcessRow): void {
  const live = processTable();
  expect(live.filter((row) => row.pid === service.pid || row.ppid === service.pid)).toEqual([]);
  expect(live.filter((row) => LIFECYCLE_COMMANDS.has(row.command))).toEqual([]);
}

async function expectServiceTreeReaped(service: ProcessRow): Promise<void> {
  await vi.waitFor(
    () => {
      expectNothingLeft(service);
    },
    { timeout: 20_000, interval: 200 },
  );
}

/** Kills the first original service this process starts, the moment it appears. */
async function killServiceOnSpawn(): Promise<ProcessRow> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const [service] = services();
    if (service !== undefined) {
      process.kill(service.pid, "SIGKILL");
      return service;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("original-service-never-started");
}

// #3901 AC4: the execution boundary as the run's own shell sees it, on the production path with
// the original 2.1.4 in Full access. One probe reports what a command of the run can reach.
const PROBE_SCRIPT = `#!/bin/sh
foreign="$1"; state="$2"
if ps -p "$foreign" -o pid= >/dev/null 2>&1; then echo probe.introspect=visible; else echo probe.introspect=hidden; fi
if kill -0 "$foreign" 2>/dev/null; then echo probe.signal=allowed; else echo probe.signal=denied; fi
if cat .env >/dev/null 2>&1; then echo probe.dotenv=readable; else echo probe.dotenv=denied; fi
if cat "$state" >/dev/null 2>&1; then echo probe.state=readable; else echo probe.state=denied; fi
echo "probe.secrets=$(env | grep -c -E '^(OPENCODE_SERVER_PASSWORD|KEIKO_MODEL_GATEWAY_CAPABILITY|KEIKO_TOOL_FACADE_CAPABILITY|OPENCODE_CONFIG_CONTENT)=')"
echo "probe.openssl_conf=\${OPENSSL_CONF:-unset}"
if [ -n "\${OPENSSL_CONF:-}" ] && cat "$OPENSSL_CONF" >/dev/null 2>&1; then echo probe.openssl_read=ok; else echo probe.openssl_read=denied; fi
echo "probe.node_options=\${NODE_OPTIONS:-unset}"
echo "probe.node_options_sha=$(node -p 'require("node:crypto").createHash("sha256").update(process.env.NODE_OPTIONS ?? "").digest("hex")' 2>/dev/null || echo failed)"
if node -e 'require("node:crypto").createHash("sha256")' >/dev/null 2>&1; then echo probe.node=ok; else echo probe.node=failed; fi
echo probe.done=1
`;

describe.skipIf(!devLaneDiscoveryFunctionalEnabled())(
  "original OpenCode execution boundary on macOS (#3901 AC4)",
  () => {
    it("hides foreign processes, sensitive files and run secrets, and keeps the operator's OpenSSL configuration", async () => {
      const probe = await probeBoundary((opensslConf) => ({
        OPENSSL_CONF: opensslConf,
        NODE_OPTIONS: "--openssl-shared-config",
      }));
      expect(probe.facts).toEqual({
        introspect: "hidden",
        signal: "denied",
        dotenv: "denied",
        state: "denied",
        secrets: "0",
        openssl_conf: probe.opensslConf,
        openssl_read: "ok",
        node_options: "--openssl-shared-config",
        node_options_sha: sha256("--openssl-shared-config"),
        node: "ok",
      });
      expect(probe.transcript).not.toContain("DOTENV_CANARY_3901");
    }, 180_000);

    // PR #4064 review: Node reads NODE_OPTIONS with its own quoting, so an operator's configuration
    // under a directory with spaces is one option; a whitespace split dropped it from the run. Node
    // refuses to start on a configuration file it cannot read, so `node=ok` proves the read.
    it("keeps a quoted OpenSSL configuration path with spaces, as Node reads it", async () => {
      let nodeOptions = "";
      const probe = await probeBoundary((opensslConf) => {
        nodeOptions = `--openssl-config="${opensslConf}" --openssl-shared-config`;
        return { NODE_OPTIONS: nodeOptions };
      }, "operator openssl");
      expect(probe.opensslConf).toContain(" ");
      expect(probe.facts).toMatchObject({
        node_options_sha: sha256(nodeOptions),
        openssl_conf: "unset",
        node: "ok",
      });
    }, 180_000);

    // PR #4064 review: a negated OpenSSL switch is one of Node's own OpenSSL-only forms.
    it("keeps a quoted configuration together with a negated OpenSSL switch", async () => {
      let nodeOptions = "";
      const probe = await probeBoundary((opensslConf) => {
        nodeOptions = `--openssl-config="${opensslConf}" --openssl-shared-config --no-openssl-legacy-provider`;
        return { NODE_OPTIONS: nodeOptions };
      }, "operator openssl");
      expect(probe.facts).toMatchObject({ node_options_sha: sha256(nodeOptions), node: "ok" });
    }, 180_000);

    it("keeps NODE_OPTIONS that carry anything besides OpenSSL and FIPS switches out of the run", async () => {
      const probe = await probeBoundary(() => ({
        NODE_OPTIONS: "--openssl-shared-config --max-old-space-size=64",
      }));
      expect(probe.facts).toMatchObject({
        node_options: "unset",
        openssl_conf: "unset",
        node: "ok",
      });
    }, 180_000);
  },
);

interface BoundaryProbe {
  readonly facts: Readonly<Record<string, string>>;
  readonly transcript: string;
  readonly opensslConf: string;
}

async function probeBoundary(
  operatorEnv: (opensslConf: string) => Readonly<Record<string, string>>,
  opensslDirectory = "openssl",
): Promise<BoundaryProbe> {
  const fixture = await setupWorkspace(["bff-state", "ui-db", "task-workspaces"]);
  writeFileSync(join(fixture.workspace, ".env"), "API_KEY=DOTENV_CANARY_3901\n");
  writeFileSync(join(fixture.workspace, "probe.sh"), PROBE_SCRIPT, { mode: 0o755 });
  const openssl = join(fixture.root, opensslDirectory);
  mkdirSync(openssl, { recursive: true });
  const opensslConf = join(openssl, "openssl.cnf");
  writeFileSync(opensslConf, "openssl_conf = openssl_init\n[openssl_init]\n");
  const state = join(fixture.root, "bff-state", "ui-db", "keiko.config.json");
  fixture.script.mode = "probe";
  fixture.script.probeCommand = `sh ./probe.sh ${String(process.pid)} '${state}'`;
  const transcripts: string[] = [];
  const pipeline = await bootDiscoveryPipeline(
    fixture,
    (request) => {
      transcripts.push(JSON.stringify(request.messages));
    },
    operatorEnv(opensslConf),
  );
  const runId = await startRun(pipeline, startBody("boundary-probe"));
  await vi.waitFor(
    () => {
      expect(transcripts.join("\n")).toContain("probe.done=1");
    },
    { timeout: 60_000, interval: 200 },
  );
  await stopRun(pipeline.baseUrl, runId);
  return { facts: probeFacts(transcripts), transcript: transcripts.join("\n"), opensslConf };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function probeFacts(transcripts: readonly string[]): Readonly<Record<string, string>> {
  const facts: Record<string, string> = {};
  for (const match of transcripts.join("\n").matchAll(/probe\.([a-z_]+)=([^\s"\\]+)/gu)) {
    const [, key, value] = match;
    if (key !== undefined && value !== undefined && key !== "done") facts[key] = value;
  }
  return facts;
}

// #3902 AC2: Git as the original runtime uses it in the managed task worktree. It reads with its
// own Git; the worktree's Git directory is read-only to it, so the index changes only through
// Keiko's proposals and their redemption, unstaging included.
const GIT_READ_PROBE_SCRIPT = `#!/bin/sh
run() { name="$1"; shift; if "$@" >/dev/null 2>&1; then echo "git.$name=ok"; else echo "git.$name=refused"; fi; }
printf 'changed\\n' >> src/example.ts
run status git status --porcelain
git diff --quiet -- src/example.ts >/dev/null 2>&1
case $? in 0) echo git.diff=unchanged ;; 1) echo git.diff=changed ;; *) echo git.diff=refused ;; esac
run log git log -1 --format=%H
run show git show --stat HEAD
run blame git blame -- src/example.ts
run add git add -- src/example.ts
run restore_staged git restore --staged -- src/example.ts
echo git.done=1
`;

describe.skipIf(!devLaneDiscoveryFunctionalEnabled())(
  "original OpenCode Git in the managed worktree (#3902 AC2)",
  () => {
    async function journey(
      mode: "probe" | "index",
      done: string,
      probeCommand?: string,
    ): Promise<{ readonly transcript: string; readonly workspace: string }> {
      const fixture = await setupWorkspace(["bff-state", "ui-db", "task-workspaces"]);
      writeFileSync(join(fixture.workspace, "gitprobe.sh"), GIT_READ_PROBE_SCRIPT, { mode: 0o755 });
      fixture.script.mode = mode;
      if (probeCommand !== undefined) fixture.script.probeCommand = probeCommand;
      const transcripts: string[] = [];
      const pipeline = await bootDiscoveryPipeline(fixture, (request) => {
        transcripts.push(JSON.stringify(request.messages));
      });
      const runId = await startRun(pipeline, startBody(`git-${mode}`));
      await vi.waitFor(
        () => {
          expect(transcripts.join("\n")).toContain(done);
        },
        { timeout: 120_000, interval: 200 },
      );
      await stopRun(pipeline.baseUrl, runId);
      return { transcript: transcripts.join("\n"), workspace: fixture.workspace };
    }

    it("reads status, diff, log, show and blame with its own Git and cannot write the index", async () => {
      const { transcript } = await journey("probe", "git.done=1", "sh ./gitprobe.sh 2>&1");
      const facts = Object.fromEntries(
        [...transcript.matchAll(/git\.([a-z_]+)=([a-z0-9]+)/gu)].map(
          (match) => [match[1] ?? "", match[2] ?? ""] as const,
        ),
      );
      expect(facts).toEqual({
        status: "ok",
        diff: "changed",
        log: "ok",
        show: "ok",
        blame: "ok",
        add: "refused",
        restore_staged: "refused",
        done: "1",
      });
    }, 240_000);

    it("stages a change and gives it back to the worktree only through Keiko", async () => {
      const { transcript, workspace } = await journey("index", FUNCTIONAL_INDEX_AFTER_MARKER);
      // The agent's own Git saw the change staged after the stage redemption, and not after the
      // unstage redemption; both redemptions succeeded.
      expect(transcript).toContain(`${FUNCTIONAL_INDEX_STAGED_MARKER}${FUNCTIONAL_INDEX_PATH},`);
      expect(transcript).toMatch(new RegExp(`${FUNCTIONAL_INDEX_AFTER_MARKER}(?:\\\\)+n`, "u"));
      expect(transcript).toMatch(/(?<![a-z])stage-\d+\\*",\\*"status\\*":\\*"succeeded/u);
      expect(transcript).toMatch(/unstage-\d+\\*",\\*"status\\*":\\*"succeeded/u);
      // The worktree keeps the bytes; only the index gave them back.
      expect(git(workspace, ["diff", "--cached", "--name-only"])).toBe("");
      expect(git(workspace, ["diff", "--name-only"])).toBe(FUNCTIONAL_INDEX_PATH);
      expect(readFile(join(workspace, FUNCTIONAL_INDEX_PATH))).toContain("staged by the agent");
    }, 240_000);
  },
);
