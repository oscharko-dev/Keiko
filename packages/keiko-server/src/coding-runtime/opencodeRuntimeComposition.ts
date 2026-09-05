import { createHash, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  CodingWorkbenchRuntimeEvent,
  UpdatePortableTarget,
} from "@oscharko-dev/keiko-contracts";
import type { WorkspaceRootAccess } from "../task-workspace/workspace-root-access.js";

import {
  contentFreeErrorClass,
  emitServerDiagnostic,
  type ServerDiagnosticSink,
} from "../diagnostics-log.js";
import { isValidCorrelationId } from "../correlation.js";
import type { PortableSidecarRuntimeVerification } from "../update-portable-sidecar-verification.js";
import {
  createCodingRuntimeManager,
  type CodingRuntimeManager,
  type CodingRuntimeManagerDeps,
  type OpenCodeLifecycleAdapter,
  type OpenCodeLifecycleHandshakeRequest,
  type OpenCodeLifecyclePrepareRequest,
  type OpenCodeLifecyclePrepareResult,
} from "./codingRuntimeManager.js";
import type { CodingToolApprovalBridge } from "./codingToolApprovalBridge.js";
import {
  CODING_TOOL_MAX_BODY_BYTES,
  CODING_TOOL_MAX_IN_FLIGHT,
  parseCodingToolRequest,
  type CodingToolResult,
} from "./codingToolIpc.js";
import type { CodingToolFacade } from "./codingToolFacadePorts.js";
import {
  createOpenCodeHttpClient,
  type OpenCodeHttpClient,
  type OpenCodeQuestionRequest,
  parseOpenCodeChildEndpoint,
} from "./opencodeHttpClient.js";
import { buildOpenCodeLaunchProfile } from "./opencodeLaunchProfile.js";
import {
  createGeneratedOpenCodeBundle,
  createOpenCodeRuntimeAdapter,
  type OpenCodeGovernedSinkReceipt,
  type OpenCodeRuntimeAdapter,
  type OpenCodeSyncHint,
} from "./opencodeRuntimeAdapter.js";
import {
  classifyOpenCodeLiveControl,
  parseOpenCodeHistory,
  projectOpenCodePermissionEvent,
  projectOpenCodePermissionRequestId,
} from "./opencodeProtocol.js";
import { normalizeOpenCodeSafeActivityHistory } from "./opencodeSafeActivity.js";
import {
  OPEN_CODE_PROTOCOL_SURFACE_ALGORITHM,
  projectOpenCodeProtocolSurface,
} from "./opencodeProtocolSurface.js";
import type { OpenCodeReconciliationEvent } from "./opencodeReconciler.js";
import type { RuntimeProcessSupervisor } from "./runtimeProcessSupervisor.js";
import { OPENCODE_PINNED_VERSION } from "./opencodeToolSchemas.js";

const PINNED_RAW_SCHEMA_SHA256 = "7db5cc3bb494b4757655110f2f285b1e70fa586fb5ae2327ffb31d4f0254c7de";
const DIGEST = /^[a-f0-9]{64}$/u;
const ABORT_SETTLEMENT_TIMEOUT_MS = 30_000;
const INITIAL_TURN_BASELINE_STABILIZATION_MS = 500;

interface VerifiedPortableInput {
  readonly verification: PortableSidecarRuntimeVerification;
  readonly resourceRoot: string;
  readonly target: UpdatePortableTarget;
  /** Admission policy that vouched for the record; absent fails closed to release-qualified. */
  readonly admission?:
    "release-qualified" | "functional-dev-lane" | "functional-evaluation-lane" | undefined;
}

/** Terminal states for a tool action's safe-activity settlement (#2386). */
type OpenCodeToolSettlementState = "succeeded" | "failed" | "denied" | "cancelled";

export interface OpenCodeRuntimeCompositionInput {
  readonly portable: VerifiedPortableInput;
  readonly stateBaseRoot: string;
  readonly capabilities: {
    readonly modelGatewayCapability: string;
    readonly toolFacadeCapability: string;
  };
  readonly toolBridge?: {
    readonly requestDeadlineMs: number;
    readonly maxInFlight: number;
  };
  /**
   * ADR-0043 D11-D14: the tool facade rides the SAME single attested loopback destination as the
   * model gateway (`<loopback origin>/api/coding-sidecar/tool`) instead of a second ephemeral
   * listener the Seatbelt egress profile would deny (#3390). Full URL, not a port -- the caller
   * (productionOpenCodeActivation.ts) derives it from the one loopback origin, never a hard-coded
   * port.
   */
  readonly toolFacadeOrigin: string;
  readonly toolFacade: CodingToolFacade;
  readonly codingToolApprovals?: CodingToolApprovalBridge | undefined;
  readonly governedEventSink: {
    readonly execute: (
      identityKey: string,
      event: OpenCodeReconciliationEvent,
    ) => Promise<OpenCodeGovernedSinkReceipt>;
  };
  readonly safeActivity?:
    | {
        readonly arm: () => void;
        readonly clear: () => void;
        readonly ingest: (
          signal: import("./codingSafeActivityProjection.js").CodingSafeActivitySignal,
        ) => boolean;
        readonly recordDrops: (count: number) => void;
        readonly settleTool: (input: {
          readonly actionId: string;
          readonly state: OpenCodeToolSettlementState;
          readonly occurredAt: string;
        }) => void;
      }
    | undefined;
  readonly gatewayReadiness: {
    readonly waitForObservedRequest: (runId: string, signal: AbortSignal) => Promise<boolean>;
    readonly verifyObserved: (runId: string) => void;
    readonly clear: (runId: string, preserveVerification?: boolean) => void;
  };
  readonly fetch: typeof globalThis.fetch;
  readonly supervisor: RuntimeProcessSupervisor;
  readonly resolveWorkspaceRootAccess?: (() => WorkspaceRootAccess | undefined) | undefined;
  readonly diagnostics?: ServerDiagnosticSink | undefined;
  readonly onRuntimeEvent?: ((event: CodingWorkbenchRuntimeEvent) => void) | undefined;
  /**
   * Live question observation for the fixed session (#2386). OpenCode publishes question
   * lifecycle events live-only — they never appear as durable history rows — so the content-free
   * pull-client signal must originate here. The identity is the SSE frame id; no question
   * content leaves the stream.
   */
  readonly onQuestionObserved?: ((identity: string) => void) | undefined;
  readonly authorityLifecycle: Pick<
    CodingRuntimeManagerDeps,
    | "revokeRuntime"
    | "abortInFlightActions"
    | "markRuntimeRecoveryRequired"
    | "releaseRuntimeAfterReap"
  >;
}

type SafeToolSettlement = NonNullable<
  OpenCodeRuntimeCompositionInput["safeActivity"]
>["settleTool"];

export interface OpenCodeToolBridge {
  readonly url: string;
  handle(input: {
    readonly method: "POST";
    readonly headers: Headers;
    readonly body: string;
    /**
     * Caller-owned cancellation (e.g. the BFF route observing its client disconnect). Optional:
     * a caller that has no disconnect signal of its own (the readiness challenge, this file's own
     * tests) simply omits it. Merged with the admission gate's own deadline abort so both sources
     * settle the SAME in-flight facade call through the one existing abort path.
     */
    readonly signal?: AbortSignal;
  }): Promise<{ readonly status: number; readonly body: string }>;
}

export interface OpenCodeRuntimeComposition {
  readonly manager: CodingRuntimeManager;
  readonly toolBridge: OpenCodeToolBridge;
  readonly runPort: OpenCodeRunPort;
}

export interface OpenCodeRunPort {
  readonly submitTask: (runId: string, text: string, initialContext?: string) => Promise<boolean>;
  readonly abortTask: (runId: string) => Promise<boolean>;
  readonly waitForTerminal: (runId: string, signal: AbortSignal) => Promise<boolean>;
  readonly listQuestions: (runId: string) => Promise<readonly OpenCodeQuestionRequest[]>;
  readonly answerQuestion: (
    runId: string,
    requestId: string,
    answers: readonly (readonly string[])[],
  ) => Promise<boolean>;
  readonly rejectQuestion: (runId: string, requestId: string) => Promise<boolean>;
  readonly replyPermission: (
    runId: string,
    requestId: string,
    reply: "once" | "reject",
  ) => Promise<boolean>;
}

interface PreparedRun {
  readonly runId: string;
  readonly runRoot: string;
  readonly password: string;
  readonly configDigest: string;
  readonly verification: PortableSidecarRuntimeVerification;
  readonly observedPermissionIds: Set<string>;
  runtimeAdapter?: OpenCodeRuntimeAdapter | undefined;
  client?: OpenCodeHttpClient | undefined;
  sessionId?: string | undefined;
  initialTurnBaselineStable: boolean;
  ready: boolean;
}

interface ReadyRun extends PreparedRun {
  runtimeAdapter: OpenCodeRuntimeAdapter;
  client: OpenCodeHttpClient;
  sessionId: string;
  ready: true;
}
type ReadyRunLookup = (runId: string) => ReadyRun | undefined;
type QuestionRunPort = Pick<OpenCodeRunPort, "listQuestions" | "answerQuestion" | "rejectQuestion">;

export function createOpenCodeRuntimeComposition(
  input: OpenCodeRuntimeCompositionInput,
): OpenCodeRuntimeComposition {
  const bridge = createToolBridge(
    input.capabilities.toolFacadeCapability,
    input.toolFacade,
    input.toolBridge,
    input.safeActivity?.settleTool,
    input.diagnostics,
    input.toolFacadeOrigin,
  );
  const runs = new Map<string, PreparedRun>();
  const lifecycle = lifecycleAdapter(input, bridge, runs);
  const manager = createCodingRuntimeManager({
    supervisor: input.supervisor,
    processEnv: {},
    openCodeLifecycleAdapter: lifecycle,
    portableRuntimeResolver: () => input.portable,
    ...(input.resolveWorkspaceRootAccess === undefined
      ? {}
      : { resolveWorkspaceRootAccess: input.resolveWorkspaceRootAccess }),
    ...(input.onRuntimeEvent ? { onRuntimeEvent: input.onRuntimeEvent } : {}),
    ...(input.codingToolApprovals === undefined
      ? {}
      : { codingToolApprovals: input.codingToolApprovals }),
    ...input.authorityLifecycle,
  });
  return {
    manager,
    toolBridge: bridge.publicPort,
    runPort: createRunPort(runs, input.diagnostics),
  };
}

function createRunPort(
  runs: Map<string, PreparedRun>,
  diagnostics: ServerDiagnosticSink | undefined,
): OpenCodeRunPort {
  const readyRun = (runId: string): ReadyRun | undefined => {
    const run = runs.get(runId);
    return isReadyRun(run) ? run : undefined;
  };
  return {
    submitTask: createSubmitTask(readyRun, diagnostics),
    abortTask: createAbortTask(readyRun),
    waitForTerminal: async (runId, signal): Promise<boolean> => {
      const run = readyRun(runId);
      if (run === undefined) return false;
      const outcome = await run.runtimeAdapter.waitForTerminal(signal);
      if (!outcome && !signal.aborted) recordOpenCodeTurnFailure(diagnostics, run, "terminal");
      return outcome;
    },
    replyPermission: createReplyPermission(readyRun, diagnostics),
    ...createQuestionRunPort(readyRun),
  };
}

function createSubmitTask(
  readyRun: ReadyRunLookup,
  diagnostics: ServerDiagnosticSink | undefined,
): OpenCodeRunPort["submitTask"] {
  return async (runId, text, initialContext): Promise<boolean> => {
    const run = readyRun(runId);
    if (run === undefined) return false;
    if (!(await synchronizeTurnBaseline(run))) return false;
    if (!run.runtimeAdapter.armTurn()) return false;
    try {
      await run.client.promptAsync(run.sessionId, text, { initialContext });
      return run.ready;
    } catch (error) {
      recordOpenCodeTurnFailure(diagnostics, run, "submit", error);
      run.runtimeAdapter.cancelTurn();
      return false;
    }
  };
}

function createReplyPermission(
  readyRun: ReadyRunLookup,
  diagnostics: ServerDiagnosticSink | undefined,
): OpenCodeRunPort["replyPermission"] {
  return async (runId, requestId, reply): Promise<boolean> => {
    const run = readyRun(runId);
    if (run === undefined) return false;
    try {
      const owned = (await run.client.listPermissions()).filter(
        (request) =>
          request.sessionID === run.sessionId &&
          projectOpenCodePermissionRequestId(request.id) === requestId,
      );
      const permission = owned[0];
      return (
        owned.length === 1 &&
        permission !== undefined &&
        (await run.client.replyPermission(permission.id, reply)) &&
        run.ready
      );
    } catch (error) {
      recordOpenCodeTurnFailure(diagnostics, run, "permission", error);
      return false;
    }
  };
}

type OpenCodeTurnFailureStage = "permission" | "submit" | "terminal";

function recordOpenCodeTurnFailure(
  diagnostics: ServerDiagnosticSink | undefined,
  run: ReadyRun,
  stage: OpenCodeTurnFailureStage,
  error?: unknown,
): void {
  emitServerDiagnostic(diagnostics, {
    correlationId: run.runId,
    timestamp: new Date().toISOString(),
    operation: "coding-runtime.opencode-composition",
    source: "opencode.turn",
    errorClass: error === undefined ? "OpenCodeTurnFailure" : contentFreeErrorClass(error),
    message: "runtime-turn-failed",
    code: openCodeTurnFailureCode(run.runRoot, stage),
  });
}

function openCodeTurnFailureCode(runRoot: string, stage: OpenCodeTurnFailureStage): string {
  const database = projectOpenCodeRuntimeDatabase(join(runRoot, "state", "opencode.db"));
  return `stage=${stage}:${database}`;
}

function projectOpenCodeRuntimeDatabase(databasePath: string): string {
  if (!existsSync(databasePath)) return "db=missing";
  try {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return openCodeRuntimeDatabaseSummary(database);
    } finally {
      database.close();
    }
  } catch {
    return "db=unavailable";
  }
}

function openCodeRuntimeDatabaseSummary(database: DatabaseSync): string {
  const messages = database.prepare(OPEN_CODE_MESSAGE_SUMMARY_SQL).get() as CountRow;
  const parts = database.prepare(OPEN_CODE_PART_SUMMARY_SQL).get() as CountRow;
  return [
    "db=ok",
    `m=${String(boundedCount(messages.total))}`,
    `a=${String(boundedCount(messages.assistant))}`,
    `stop=${String(boundedCount(messages.stop))}`,
    `tool=${String(boundedCount(messages.toolCalls))}`,
    `error=${String(boundedCount(messages.error))}`,
    `length=${String(boundedCount(messages.length))}`,
    `err=${String(boundedCount(messages.errorName))}`,
    `p=${String(boundedCount(parts.total))}`,
    `ptool=${String(boundedCount(parts.tool))}`,
    `ptext=${String(boundedCount(parts.text))}`,
    `pfail=${String(boundedCount(parts.failed))}`,
    `pdone=${String(boundedCount(parts.completed))}`,
  ].join(":");
}

interface CountRow {
  readonly total?: unknown;
  readonly assistant?: unknown;
  readonly stop?: unknown;
  readonly toolCalls?: unknown;
  readonly error?: unknown;
  readonly length?: unknown;
  readonly errorName?: unknown;
  readonly tool?: unknown;
  readonly text?: unknown;
  readonly failed?: unknown;
  readonly completed?: unknown;
}

function boundedCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

const OPEN_CODE_MESSAGE_SUMMARY_SQL = `
SELECT
  COUNT(*) AS total,
  COALESCE(SUM(CASE WHEN json_extract(data, '$.role') = 'assistant' THEN 1 ELSE 0 END), 0) AS assistant,
  COALESCE(SUM(CASE WHEN json_extract(data, '$.finish') = 'stop' THEN 1 ELSE 0 END), 0) AS stop,
  COALESCE(SUM(CASE WHEN json_extract(data, '$.finish') = 'tool-calls' THEN 1 ELSE 0 END), 0) AS toolCalls,
  COALESCE(SUM(CASE WHEN json_extract(data, '$.finish') = 'error' THEN 1 ELSE 0 END), 0) AS error,
  COALESCE(SUM(CASE WHEN json_extract(data, '$.finish') = 'length' THEN 1 ELSE 0 END), 0) AS length,
  COALESCE(SUM(CASE WHEN json_extract(data, '$.error.name') IS NOT NULL THEN 1 ELSE 0 END), 0) AS errorName
FROM message
`;

const OPEN_CODE_PART_SUMMARY_SQL = `
SELECT
  COUNT(*) AS total,
  COALESCE(SUM(CASE WHEN json_extract(data, '$.type') = 'tool' THEN 1 ELSE 0 END), 0) AS tool,
  COALESCE(SUM(CASE WHEN json_extract(data, '$.type') = 'text' THEN 1 ELSE 0 END), 0) AS text,
  COALESCE(SUM(CASE WHEN json_extract(data, '$.state.status') = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
  COALESCE(SUM(CASE WHEN json_extract(data, '$.state.status') = 'completed' THEN 1 ELSE 0 END), 0) AS completed
FROM part
`;

async function synchronizeTurnBaseline(run: ReadyRun): Promise<boolean> {
  if (!run.initialTurnBaselineStable) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, INITIAL_TURN_BASELINE_STABILIZATION_MS);
    });
  }
  const synchronized = await run.runtimeAdapter.reconcile();
  if (!synchronized.ok) return false;
  run.initialTurnBaselineStable = true;
  return true;
}

function createAbortTask(readyRun: ReadyRunLookup): OpenCodeRunPort["abortTask"] {
  return async (runId): Promise<boolean> => {
    const run = readyRun(runId);
    if (run === undefined) return false;
    try {
      if (!(await run.client.abortSession(run.sessionId))) {
        run.runtimeAdapter.cancelTurn();
        return false;
      }
      const settled = await run.runtimeAdapter.waitForTerminal(
        AbortSignal.timeout(ABORT_SETTLEMENT_TIMEOUT_MS),
      );
      if (!settled) run.runtimeAdapter.cancelTurn();
      return settled && run.ready;
    } catch {
      run.runtimeAdapter.cancelTurn();
      return false;
    }
  };
}

function createQuestionRunPort(readyRun: ReadyRunLookup): QuestionRunPort {
  return {
    listQuestions: async (runId): Promise<readonly OpenCodeQuestionRequest[]> => {
      const run = readyRun(runId);
      if (run === undefined) return [];
      try {
        return (await run.client.listQuestions()).filter(
          (request) => request.sessionID === run.sessionId,
        );
      } catch {
        return [];
      }
    },
    answerQuestion: async (runId, requestId, answers): Promise<boolean> => {
      const run = readyRun(runId);
      if (run === undefined) return false;
      try {
        const pending = (await run.client.listQuestions()).find(
          (request) => request.id === requestId && request.sessionID === run.sessionId,
        );
        if (pending === undefined || !answersMatchQuestions(pending, answers)) return false;
        return (await run.client.answerQuestion(requestId, answers)) && run.ready;
      } catch {
        return false;
      }
    },
    rejectQuestion: async (runId, requestId): Promise<boolean> => {
      const run = readyRun(runId);
      if (run === undefined) return false;
      try {
        const owned = (await run.client.listQuestions()).some(
          (request) => request.id === requestId && request.sessionID === run.sessionId,
        );
        return owned && (await run.client.rejectQuestion(requestId)) && run.ready;
      } catch {
        return false;
      }
    },
  };
}

function answersMatchQuestions(
  request: OpenCodeQuestionRequest,
  answers: readonly (readonly string[])[],
): boolean {
  if (answers.length !== request.questions.length) return false;
  return answers.every((answer, index) => {
    const question = request.questions[index];
    if (question === undefined || (question.multiple !== true && answer.length > 1)) return false;
    const labels = new Set(question.options.map((option) => option.label));
    return answer.every((selection) => question.custom === true || labels.has(selection));
  });
}

function isReadyRun(run: PreparedRun | undefined): run is ReadyRun {
  return (
    run?.ready === true &&
    run.client !== undefined &&
    run.runtimeAdapter !== undefined &&
    run.sessionId !== undefined
  );
}

function lifecycleAdapter(
  input: OpenCodeRuntimeCompositionInput,
  bridge: ToolBridgeController,
  runs: Map<string, PreparedRun>,
): OpenCodeLifecycleAdapter {
  return {
    prepare: (request) => prepare(input, bridge, runs, request),
    handshake: (request) => handshake(input, bridge, runs, request),
    monitor: ({ runId, onFailure }): (() => void) | undefined => {
      const run = runs.get(runId);
      const dispose = run?.runtimeAdapter?.monitor(onFailure);
      return dispose === undefined
        ? undefined
        : (): void => {
            if (run !== undefined) run.ready = false;
            dispose();
          };
    },
    dispose: async (runId): Promise<boolean> => {
      input.safeActivity?.clear();
      const run = runs.get(runId);
      if (run === undefined) return true;
      run.ready = false;
      input.gatewayReadiness.clear(runId);
      try {
        await run.runtimeAdapter?.close();
        await bridge.close();
        rmSync(run.runRoot, { recursive: true, force: true });
      } catch {
        // Surface disposal failure on the port's boolean channel; the manager routes a false
        // result into the same reap-failure handling it applies to a thrown disposal today.
        return false;
      }
      runs.delete(runId);
      return true;
    },
  };
}

// KEIKO-0320: the prepare cleanup calls (bridge.close, rmSync) can each throw on their own — a
// permission-denied unlink, a socket teardown failure. Without an inner guard, a throw here
// escapes as an uncaught rejection and the outer manager relabels the resulting timeout as a
// generic retryable failure, discarding the real cause. Guard each cleanup step and emit a
// redacted operator diagnostic when the disposal itself fails (#3099 P2 follow-up: previously
// the failure was silently swallowed, so a permission-error leak left the private run root on
// disk with no diagnostic and no retry hook).
function recordPrepareDisposalFailure(
  diagnostics: ServerDiagnosticSink | undefined,
  runId: string,
  operation: "prepare-bridge-close" | "prepare-run-root-remove",
  error: unknown,
): void {
  emitServerDiagnostic(diagnostics, {
    correlationId: runId,
    timestamp: new Date().toISOString(),
    operation: "coding-runtime.opencode-composition",
    source: `opencode-runtime-composition.${operation}`,
    errorClass: contentFreeErrorClass(error),
    message: operation,
  });
}

async function disposeFailedPrepare(
  bridge: ToolBridgeController,
  runRoot: string,
  runId: string,
  diagnostics: ServerDiagnosticSink | undefined,
): Promise<void> {
  try {
    await bridge.close();
  } catch (error) {
    recordPrepareDisposalFailure(diagnostics, runId, "prepare-bridge-close", error);
  }
  try {
    rmSync(runRoot, { recursive: true, force: true });
  } catch (error) {
    // The private run root may persist on disk; the operator record makes the leak diagnosable.
    recordPrepareDisposalFailure(diagnostics, runId, "prepare-run-root-remove", error);
  }
}

async function materializePrepare(
  input: OpenCodeRuntimeCompositionInput,
  bridge: ToolBridgeController,
  runs: Map<string, PreparedRun>,
  request: OpenCodeLifecyclePrepareRequest,
  runRoot: string,
): Promise<OpenCodeLifecyclePrepareResult> {
  createPrivateState(runRoot);
  await bridge.start();
  const profile = buildOpenCodeLaunchProfile({
    executable: request.executablePath,
    stateRoot: runRoot,
  });
  if (!profile.ok) throw new Error("profile-invalid");
  const bundle = createGeneratedOpenCodeBundle();
  const config = JSON.stringify(bundle.config);
  materialize(runRoot, config, bundle.toolSources);
  const password = profile.env.OPENCODE_SERVER_PASSWORD;
  if (password === undefined) throw new Error("password-missing");
  const configDigest = createHash("sha256").update(config, "utf8").digest("hex");
  runs.set(
    request.runId,
    preparedRun(request.runId, runRoot, password, configDigest, request.verification),
  );
  return {
    ok: true,
    env: {
      ...profile.env,
      KEIKO_MODEL_GATEWAY_CAPABILITY: input.capabilities.modelGatewayCapability,
      KEIKO_TOOL_FACADE_URL: bridge.publicPort.url,
      KEIKO_TOOL_FACADE_CAPABILITY: input.capabilities.toolFacadeCapability,
    },
  };
}

async function prepare(
  input: OpenCodeRuntimeCompositionInput,
  bridge: ToolBridgeController,
  runs: Map<string, PreparedRun>,
  request: OpenCodeLifecyclePrepareRequest,
): Promise<OpenCodeLifecyclePrepareResult> {
  if (!verifiedProtocol(request.verification, input.portable.verification)) {
    return { ok: false, reason: "target-attestation-failed" };
  }
  if (!distinctCapabilities(input.capabilities)) {
    return { ok: false, reason: "capability-binding-failed" };
  }
  const runRoot = join(input.stateBaseRoot, request.runId);
  try {
    return await materializePrepare(input, bridge, runs, request, runRoot);
  } catch {
    await disposeFailedPrepare(bridge, runRoot, request.runId, input.diagnostics);
    return { ok: false, reason: "config-materialization-failed" };
  }
}

function preparedRun(
  runId: string,
  runRoot: string,
  password: string,
  configDigest: string,
  verification: PortableSidecarRuntimeVerification,
): PreparedRun {
  return {
    runId,
    runRoot,
    password,
    configDigest,
    verification,
    observedPermissionIds: new Set(),
    initialTurnBaselineStable: false,
    ready: false,
  };
}

// eslint-disable-next-line max-lines-per-function -- handshake keeps attested client/adapter binding atomic.
async function handshake(
  input: OpenCodeRuntimeCompositionInput,
  bridge: ToolBridgeController,
  runs: Map<string, PreparedRun>,
  request: OpenCodeLifecycleHandshakeRequest,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const run = runs.get(request.runId);
  if (run === undefined) return { ok: false, reason: "preparation-missing" };
  try {
    const parsed = parseOpenCodeChildEndpoint(await request.startupOutput.nextLine(request.signal));
    if (!parsed.ok) return { ok: false, reason: "endpoint-invalid" };
    const client = createOpenCodeHttpClient({
      endpoint: parsed.endpoint,
      password: run.password,
      fetch: input.fetch,
      requestTimeoutMs: request.timeoutMs,
      eventIdleTimeoutMs: request.timeoutMs,
    });
    const adapter = createOpenCodeRuntimeAdapter({
      correlationId: request.runId,
      readiness: readinessPorts(input, bridge, run, client, parsed.endpoint, request),
      governedSink: input.governedEventSink,
      ...(input.safeActivity
        ? {
            safeActivitySink: {
              ingest: input.safeActivity.ingest,
              recordDrops: input.safeActivity.recordDrops,
            },
          }
        : {}),
      control: {
        status: async (sessionId, signal) => {
          const status = (await client.sessionStatuses({ signal }))[sessionId];
          return status === undefined || status.type === "idle" ? "terminal" : "activity";
        },
      },
      safety: {
        revokeAudiences: (): void => undefined,
        abortGovernedActions: (): void => undefined,
        wipeEphemeralState: (): void => undefined,
        requireManagerReap: (): void => undefined,
      },
    });
    const result = await adapter.start();
    if (!result.ok) {
      await adapter.close();
      return { ok: false, reason: result.phase };
    }
    input.safeActivity?.arm();
    if (runs.get(request.runId) !== run) {
      await adapter.close();
      return { ok: false, reason: "preparation-missing" };
    }
    run.runtimeAdapter = adapter;
    run.client = client;
    run.sessionId = result.sessionId;
    run.ready = true;
    return { ok: true };
  } catch {
    return { ok: false, reason: "readiness-failed" };
  }
}

// eslint-disable-next-line max-lines-per-function -- readiness port wiring keeps trust bindings visible together.
function readinessPorts(
  input: OpenCodeRuntimeCompositionInput,
  bridge: ToolBridgeController,
  run: PreparedRun,
  client: ReturnType<typeof createOpenCodeHttpClient>,
  endpoint: string,
  request: OpenCodeLifecycleHandshakeRequest,
): Parameters<typeof createOpenCodeRuntimeAdapter>[0]["readiness"] {
  let startupRead = false;
  let fixedSessionId: string | undefined;
  const safeActivity = new Map<
    string,
    import("./codingSafeActivityProjection.js").CodingSafeActivitySignal
  >();
  return {
    verifiedTarget: {
      executable: join(input.portable.resourceRoot, run.verification.executablePath),
      attestationDigest: run.verification.protocolHandshakeDigest,
    },
    configDigest: run.configDigest,
    verifyTargetAttestation: (): Promise<boolean> => Promise.resolve(true),
    materialize: (): Promise<boolean> => Promise.resolve(configMaterialized(run.runRoot)),
    startupLine: (): Promise<string> => {
      startupRead = true;
      return Promise.resolve(`opencode server listening on ${endpoint}\n`);
    },
    health: (authorization) =>
      authorization === "basic"
        ? authenticatedHealth(client)
        : unauthenticatedHealth(input.fetch, endpoint, request.signal),
    openApiDigest: () => openApiDigest(client),
    gatewayChallenge: () =>
      challengeGateway(
        input,
        run,
        client,
        fixedSessionId,
        request.signal,
        request.timeoutMs,
        startupRead,
      ),
    toolFacadeChallenge: () => challengeToolFacade(input, bridge),
    subscribe: async function* (signal): AsyncIterable<OpenCodeSyncHint> {
      fixedSessionId = await createAndEchoFixedSession(client, request.signal);
      const combinedSignal =
        request.signal === undefined ? signal : AbortSignal.any([signal, request.signal]);
      for await (const event of client.events({ signal: combinedSignal })) {
        const eventType = event.data.type;
        if (eventType !== "sync") {
          observeLiveQuestion(input, event.data, fixedSessionId);
          observeLivePermission(run, request, event.data, fixedSessionId);
          const control = classifyOpenCodeLiveControl(event.data);
          const fixedControl = control?.sessionId === fixedSessionId ? control : undefined;
          yield {
            requiresHistoryIdentity: false,
            ...(fixedControl === undefined ? {} : { control: fixedControl }),
          };
          continue;
        }
        const eventId = event.data.id;
        if (typeof eventId !== "string") throw new Error("opencode-event-identity-invalid");
        yield { id: eventId, requiresHistoryIdentity: true };
      }
    },
    history: async (checkpoints, signal): Promise<readonly OpenCodeReconciliationEvent[]> => {
      const combinedSignal =
        request.signal === undefined ? signal : AbortSignal.any([signal, request.signal]);
      const rows = await client.history(checkpoints, { signal: combinedSignal });
      const normalized = normalizeOpenCodeSafeActivityHistory(rows);
      stageSafeActivity(normalized, safeActivity, input.safeActivity);
      const parsed = parseOpenCodeHistory(rows);
      if (!parsed.ok) {
        recordHistoryParseFailure(input.diagnostics, run.runId, parsed.reason, rows);
        throw new Error("opencode-history-invalid");
      }
      return parsed.value;
    },
    takeSafeActivity: (
      identityKey,
    ): import("./codingSafeActivityProjection.js").CodingSafeActivitySignal | undefined => {
      const signal = safeActivity.get(identityKey);
      safeActivity.delete(identityKey);
      return signal;
    },
    clearSafeActivity: (): void => {
      safeActivity.clear();
    },
    sessionEcho: (): Promise<string> => Promise.resolve(fixedSessionId ?? ""),
  };
}

function recordHistoryParseFailure(
  diagnostics: ServerDiagnosticSink | undefined,
  runId: string,
  reason: "schema-invalid" | "event-unknown" | "frame-invalid" | "frame-oversized",
  rows: readonly unknown[],
): void {
  const eventTypeDigest = firstUnknownHistoryEventTypeDigest(rows);
  const eventShape = firstUnknownMessageShape(rows);
  const eventDigestCode = eventTypeDigest === undefined ? "" : `:eventSha256=${eventTypeDigest}`;
  const eventShapeCode = eventShape === undefined ? "" : `:${eventShape}`;
  emitServerDiagnostic(diagnostics, {
    correlationId: runId,
    timestamp: new Date().toISOString(),
    operation: "coding-runtime.handshake",
    source: "opencode.history",
    errorClass: "OpenCodeHistoryFailure",
    message: "runtime-handshake-failed",
    code: `stage=sse-history-reconciliation:reason=${reason}${eventDigestCode}${eventShapeCode}`,
  });
}

function structuralNameDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function firstUnknownHistoryEventTypeDigest(rows: readonly unknown[]): string | undefined {
  for (const row of rows) {
    const parsed = parseOpenCodeHistory([row]);
    if (parsed.ok || parsed.reason !== "event-unknown") continue;
    if (typeof row !== "object" || row === null || Array.isArray(row)) return undefined;
    const type = (row as Record<string, unknown>).type;
    return typeof type === "string" ? structuralNameDigest(type) : undefined;
  }
  return undefined;
}

function firstUnknownMessageShape(rows: readonly unknown[]): string | undefined {
  for (const row of rows) {
    if (parseOpenCodeHistory([row]).ok) continue;
    const message = historyMessageInfo(row);
    if (message !== undefined) return unknownMessageShape(message);
  }
  return undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function historyMessageInfo(row: unknown): Record<string, unknown> | undefined {
  const event = recordValue(row);
  if (event?.type !== "message.updated.1") return undefined;
  return recordValue(recordValue(event.data)?.info);
}

type HistoryMessageRole = "assistant" | "unknown" | "user";

function historyMessageRole(message: Readonly<Record<string, unknown>>): HistoryMessageRole {
  if (message.role === "assistant") return "assistant";
  return message.role === "user" ? "user" : "unknown";
}

function unknownMessageShape(message: Readonly<Record<string, unknown>>): string {
  const role = historyMessageRole(message);
  const assistant = role === "assistant";
  const allowed = assistant ? ASSISTANT_MESSAGE_KEYS : USER_MESSAGE_KEYS;
  const required = assistant ? ASSISTANT_MESSAGE_REQUIRED_KEYS : USER_MESSAGE_KEYS;
  const extraKeys = Object.keys(message)
    .filter((key) => !allowed.has(key))
    .sort((left, right) => left.localeCompare(right));
  const firstExtraKey = extraKeys.at(0);
  const missing = [...required].find((key) => !Object.hasOwn(message, key));
  const extraKeyDigest = firstExtraKey === undefined ? "none" : structuralNameDigest(firstExtraKey);
  return `role=${role}:extraCount=${String(extraKeys.length)}:extraKeySha256=${extraKeyDigest}:missing=${missing ?? "none"}`;
}

const USER_MESSAGE_KEYS = new Set(["id", "sessionID", "role", "time", "agent", "model"]);
const ASSISTANT_MESSAGE_REQUIRED_KEYS = new Set([
  "id",
  "sessionID",
  "role",
  "time",
  "parentID",
  "modelID",
  "providerID",
  "mode",
  "agent",
  "path",
  "cost",
  "tokens",
]);
const ASSISTANT_MESSAGE_KEYS = new Set([
  ...ASSISTANT_MESSAGE_REQUIRED_KEYS,
  "finish",
  "summary",
  "error",
  "structured",
  "variant",
]);

const MAX_STAGED_SAFE_ACTIVITY_ITEMS = 2_048;
const MAX_STAGED_SAFE_ACTIVITY_BYTES = 128 * 1_024;
const MAX_OBSERVED_PERMISSION_IDS = 256;

function observeLivePermission(
  run: PreparedRun,
  request: OpenCodeLifecycleHandshakeRequest,
  data: unknown,
  fixedSessionId: string,
): void {
  if (!isPermissionAskedForSession(data, fixedSessionId)) return;
  const projected = projectOpenCodePermissionEvent(data, fixedSessionId);
  if (projected === undefined) throw new Error("opencode-permission-invalid");
  if (run.observedPermissionIds.has(projected.requestId)) return;
  if (run.observedPermissionIds.size >= MAX_OBSERVED_PERMISSION_IDS) {
    throw new Error("opencode-permission-limit");
  }
  run.observedPermissionIds.add(projected.requestId);
  request.onPermission(projected);
}

function isPermissionAskedForSession(value: unknown, fixedSessionId: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (event.type !== "permission.asked") return false;
  const properties = event.properties;
  return (
    typeof properties === "object" &&
    properties !== null &&
    !Array.isArray(properties) &&
    (properties as Record<string, unknown>).sessionID === fixedSessionId
  );
}

function stageSafeActivity(
  normalized: ReturnType<typeof normalizeOpenCodeSafeActivityHistory>,
  staged: Map<string, import("./codingSafeActivityProjection.js").CodingSafeActivitySignal>,
  sink: OpenCodeRuntimeCompositionInput["safeActivity"],
): void {
  staged.clear();
  let stagedBytes = 0;
  let dropped = normalized.dropped;
  for (const item of normalized.signals) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    if (
      staged.size >= MAX_STAGED_SAFE_ACTIVITY_ITEMS ||
      stagedBytes + itemBytes > MAX_STAGED_SAFE_ACTIVITY_BYTES
    ) {
      dropped += 1;
      continue;
    }
    staged.set(item.identity, item.signal);
    stagedBytes += itemBytes;
  }
  if (dropped > 0) sink?.recordDrops(dropped);
}

const LIVE_QUESTION_EVENT_TYPES = new Set([
  "question.asked",
  "question.replied",
  "question.rejected",
]);

/**
 * Surfaces the fixed session's live question lifecycle as a content-free identity (#2386).
 * Fails closed: no session binding, foreign sessions, and malformed frames observe nothing.
 */
function observeLiveQuestion(
  input: OpenCodeRuntimeCompositionInput,
  data: { readonly id?: unknown; readonly type?: unknown; readonly properties?: unknown },
  fixedSessionId: string,
): void {
  if (input.onQuestionObserved === undefined || fixedSessionId.length === 0) return;
  if (typeof data.type !== "string" || !LIVE_QUESTION_EVENT_TYPES.has(data.type)) return;
  if (liveQuestionSession(data.properties) !== fixedSessionId) return;
  if (typeof data.id !== "string" || data.id.length === 0) return;
  input.onQuestionObserved(`${data.type}\u0000${data.id}`);
}

function liveQuestionSession(properties: unknown): string | undefined {
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    return undefined;
  }
  const sessionId = (properties as Record<string, unknown>).sessionID;
  return typeof sessionId === "string" ? sessionId : undefined;
}

async function createAndEchoFixedSession(
  client: ReturnType<typeof createOpenCodeHttpClient>,
  signal: AbortSignal | undefined,
): Promise<string> {
  const created = await client.createSession({ signal });
  const createdId = typeof created.id === "string" ? created.id : undefined;
  if (createdId === undefined || !/^ses_[A-Za-z0-9_-]{1,251}$/u.test(createdId)) return "";
  const sessions = await client.sessions({ signal });
  return sessions.length === 1 && sessions[0]?.id === createdId ? createdId : "";
}

async function challengeGateway(
  input: OpenCodeRuntimeCompositionInput,
  run: PreparedRun,
  client: ReturnType<typeof createOpenCodeHttpClient>,
  sessionId: string | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  startupRead: boolean,
): Promise<boolean> {
  const reason = gatewayChallengePrecondition(input, sessionId, startupRead);
  if (reason !== undefined) {
    recordGatewayChallengeFailure(input.diagnostics, run.runId, reason);
    return false;
  }
  if (sessionId === undefined) return false;
  const challengeSignal = signal ?? AbortSignal.timeout(timeoutMs);
  const observed = input.gatewayReadiness.waitForObservedRequest(run.runId, challengeSignal);
  let verified = false;
  try {
    await client.promptAsync(sessionId, "Keiko runtime readiness handshake.", {
      signal: challengeSignal,
    });
    const accepted = await observed;
    await client.abortSession(sessionId, { signal: challengeSignal });
    const terminal = await fixedSessionIsTerminal(client, sessionId, challengeSignal);
    verified = accepted && terminal;
    if (!verified) {
      recordGatewayChallengeFailure(input.diagnostics, run.runId, "live-verification-failed");
    }
    return verified;
  } catch {
    recordGatewayChallengeFailure(input.diagnostics, run.runId, "live-verification-failed");
    return false;
  } finally {
    input.gatewayReadiness.clear(run.runId, verified);
  }
}

type GatewayChallengePreconditionFailure =
  "startup-unread" | "session-missing" | "capability-invalid" | "live-verification-failed";

function gatewayChallengePrecondition(
  input: OpenCodeRuntimeCompositionInput,
  sessionId: string | undefined,
  startupRead: boolean,
): GatewayChallengePreconditionFailure | undefined {
  if (!startupRead) return "startup-unread";
  if (sessionId === undefined) return "session-missing";
  return input.capabilities.modelGatewayCapability.length < 32 ? "capability-invalid" : undefined;
}

function recordGatewayChallengeFailure(
  diagnostics: ServerDiagnosticSink | undefined,
  runId: string,
  reason: GatewayChallengePreconditionFailure,
): void {
  emitServerDiagnostic(diagnostics, {
    correlationId: runId,
    timestamp: new Date().toISOString(),
    operation: "coding-runtime.handshake",
    source: "opencode.gateway-challenge",
    errorClass: "OpenCodeGatewayChallengeFailure",
    message: "runtime-handshake-failed",
    code: `stage=gateway-challenge:reason=${reason}`,
  });
}

async function fixedSessionIsTerminal(
  client: ReturnType<typeof createOpenCodeHttpClient>,
  sessionId: string,
  signal: AbortSignal,
): Promise<boolean> {
  while (!signal.aborted) {
    const status = (await client.sessionStatuses({ signal }))[sessionId];
    if (status === undefined || status.type === "idle") return true;
    if (!(await readinessPollDelay(signal))) return false;
  }
  return false;
}

function readinessPollDelay(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const settle = (result: boolean): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = (): void => {
      settle(false);
    };
    const timer = setTimeout(() => {
      settle(true);
    }, 10);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function challengeToolFacade(
  input: OpenCodeRuntimeCompositionInput,
  bridge: ToolBridgeController,
): Promise<boolean> {
  const result = await bridge.publicPort.handle({
    method: "POST",
    headers: new Headers({
      authorization: `Bearer ${input.capabilities.toolFacadeCapability}`,
    }),
    body: JSON.stringify({ action: "permission-event", requestId: "keiko-readiness" }),
  });
  if (result.status !== 200) return false;
  try {
    const parsed: unknown = JSON.parse(result.body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const record = parsed as Record<string, unknown>;
    return (
      Object.keys(record).length === 2 &&
      record.status === "observed" &&
      Array.isArray(record.evidence) &&
      record.evidence.length === 0
    );
  } catch {
    return false;
  }
}

async function openApiDigest(client: ReturnType<typeof createOpenCodeHttpClient>): Promise<string> {
  return projectOpenCodeProtocolSurface(await client.document()).digest;
}

async function authenticatedHealth(
  client: ReturnType<typeof createOpenCodeHttpClient>,
): Promise<{ readonly status: number; readonly version?: string }> {
  const result = await client.health();
  if (!result.ok || result.value.healthy !== true || typeof result.value.version !== "string") {
    return { status: 500 };
  }
  return { status: 200, version: result.value.version };
}

async function unauthenticatedHealth(
  fetch: typeof globalThis.fetch,
  endpoint: string,
  signal: AbortSignal | undefined,
): Promise<{ readonly status: number }> {
  const response = await fetch(new URL("/global/health", endpoint), {
    method: "GET",
    redirect: "manual",
    ...(signal === undefined ? {} : { signal }),
  });
  return { status: response.status };
}

function verifiedProtocol(
  candidate: PortableSidecarRuntimeVerification,
  trusted: PortableSidecarRuntimeVerification,
): boolean {
  return (
    candidate === trusted &&
    candidate.summary.status === "verified" &&
    candidate.summary.upstreamVersion === OPENCODE_PINNED_VERSION &&
    candidate.availability.protocolSchemaVerified &&
    candidate.protocolSchemaRawSha256 === PINNED_RAW_SCHEMA_SHA256 &&
    runtimeField(candidate, "protocolHandshakeAlgorithm") ===
      OPEN_CODE_PROTOCOL_SURFACE_ALGORITHM &&
    DIGEST.test(candidate.protocolHandshakeDigest)
  );
}

function runtimeField(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function distinctCapabilities(
  capabilities: OpenCodeRuntimeCompositionInput["capabilities"],
): boolean {
  return (
    capabilities.modelGatewayCapability.length >= 32 &&
    capabilities.toolFacadeCapability.length >= 32 &&
    capabilities.modelGatewayCapability !== capabilities.toolFacadeCapability
  );
}

function createPrivateState(runRoot: string): void {
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  chmodSync(runRoot, 0o700);
  for (const name of ["config", "state", "home", "tmp"]) {
    const path = join(runRoot, name);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
  for (const path of [
    join(runRoot, "config", "opencode"),
    join(runRoot, "config", "opencode", "tools"),
  ]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
}

function materialize(
  runRoot: string,
  config: string,
  toolSources: Readonly<Record<string, string>>,
): void {
  const discoveryRoot = join(runRoot, "config", "opencode");
  writePrivateFile(join(discoveryRoot, "opencode.json"), config);
  for (const [name, source] of Object.entries(toolSources)) {
    writePrivateFile(join(discoveryRoot, "tools", `${name}.ts`), source);
  }
}

function writePrivateFile(path: string, value: string): void {
  writeFileSync(path, value, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

function configMaterialized(runRoot: string): boolean {
  try {
    return (
      statSync(join(runRoot, "config", "opencode", "opencode.json")).isFile() &&
      readFileSync(join(runRoot, "config", "opencode", "opencode.json"), "utf8").length > 0
    );
  } catch {
    return false;
  }
}

interface ToolBridgeController {
  readonly publicPort: OpenCodeToolBridge;
  start(): Promise<void>;
  close(): Promise<void>;
  active(): boolean;
}

interface ToolBridgeLimits {
  readonly requestDeadlineMs: number;
  readonly maxInFlight: number;
}

interface AdmittedToolRequest {
  readonly controller: AbortController;
  release(): void;
}

interface ToolBridgeAdmissionGate {
  readonly admit: () => AdmittedToolRequest | undefined;
  readonly abortAll: () => void;
}

const DEFAULT_TOOL_BRIDGE_DEADLINE_MS = 30_000;
const MAX_TOOL_BRIDGE_DEADLINE_MS = 60_000;
const MAX_TOOL_BRIDGE_IN_FLIGHT = 64;
const DEADLINE_ABORT = "tool-bridge-deadline";
const DISCONNECT_ABORT = "tool-bridge-disconnect";
const CLOSE_ABORT = "tool-bridge-close";

// The execution collaborators travel the whole bridge chain (listener → handler → executor) as
// one unit; bundling them keeps every signature within the parameter budget (typescript:S107).
interface ToolBridgeExecutionDeps {
  readonly capability: string;
  readonly facade: CodingToolFacade;
  readonly settleTool: SafeToolSettlement | undefined;
  readonly diagnostics: ServerDiagnosticSink | undefined;
}

// #3390 (ADR-0043 D11-D14): the tool facade no longer opens its own loopback listener -- a second
// attested destination is exactly the defect the Seatbelt egress profile exists to deny. `handle`
// is the ONLY dispatch surface; the BFF route (coding-sidecar-tool-facade.ts) calls it directly
// over the already-attested `/api/coding-sidecar/gateway` loopback port. `active`/`start`/`close`
// stay so the composition's existing prepare/dispose lifecycle (which gates the readiness
// challenge and rejects post-close calls with 503) is unchanged; only the transport underneath
// them changes. A caller that still needs a real HTTP endpoint (the scripted functional harness's
// fake sidecar) owns its OWN tiny listener wrapping this SAME `handle` -- never a second
// production path (see opencodeFunctionalHarness/_support.ts).
function createToolBridge(
  capability: string,
  facade: CodingToolFacade,
  configuredLimits: OpenCodeRuntimeCompositionInput["toolBridge"],
  settleTool: SafeToolSettlement | undefined,
  diagnostics: ServerDiagnosticSink | undefined,
  toolFacadeOrigin: string,
): ToolBridgeController {
  const limits = normalizeToolBridgeLimits(configuredLimits);
  let listening = false;
  const gate = createToolBridgeAdmissionGate(limits);
  const deps: ToolBridgeExecutionDeps = { capability, facade, settleTool, diagnostics };
  const handle: OpenCodeToolBridge["handle"] = (request) =>
    handleDirectToolRequest(listening, deps, gate, request);
  const publicPort: OpenCodeToolBridge = {
    get url(): string {
      return toolFacadeOrigin;
    },
    handle,
  };
  return {
    publicPort,
    active: () => listening,
    start: (): Promise<void> => {
      listening = true;
      return Promise.resolve();
    },
    close: (): Promise<void> => {
      listening = false;
      gate.abortAll();
      return Promise.resolve();
    },
  };
}

function handleDirectToolRequest(
  active: boolean,
  deps: ToolBridgeExecutionDeps,
  gate: ToolBridgeAdmissionGate,
  input: Parameters<OpenCodeToolBridge["handle"]>[0],
): Promise<{ readonly status: number; readonly body: string }> {
  const rejection = preflightToolRequest(active, deps.capability, input.headers, input.body);
  if (rejection !== undefined) return Promise.resolve(rejection);
  const admission = gate.admit();
  if (admission === undefined) return Promise.resolve({ status: 429, body: "" });
  const detachExternalAbort = bindExternalAbort(input.signal, admission);
  return executeToolRequest(deps, input.headers, input.body, admission).finally(
    detachExternalAbort,
  );
}

// The route's own disconnect signal (its client going away mid-execution) and the admission
// gate's deadline timer settle the SAME in-flight facade call through the one existing abort
// path (`executeToolRequest`'s `raceAbort`) -- this is the only place an external signal joins it,
// so "abort-on-close" never grows a second cancellation mechanism.
function bindExternalAbort(
  signal: AbortSignal | undefined,
  admission: AdmittedToolRequest,
): () => void {
  if (signal === undefined) return () => undefined;
  if (signal.aborted) {
    admission.controller.abort(new Error(DISCONNECT_ABORT));
    return () => undefined;
  }
  const onAbort = (): void => {
    admission.controller.abort(new Error(DISCONNECT_ABORT));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return (): void => {
    signal.removeEventListener("abort", onAbort);
  };
}

function createToolBridgeAdmissionGate(limits: ToolBridgeLimits): ToolBridgeAdmissionGate {
  let admitted = 0;
  const controllers = new Set<AbortController>();
  return {
    admit: (): AdmittedToolRequest | undefined => {
      if (admitted >= limits.maxInFlight) return undefined;
      admitted += 1;
      const controller = new AbortController();
      controllers.add(controller);
      const timer = setTimeout(() => {
        controller.abort(new Error(DEADLINE_ABORT));
      }, limits.requestDeadlineMs);
      timer.unref();
      let released = false;
      return {
        controller,
        release: (): void => {
          if (released) return;
          released = true;
          clearTimeout(timer);
          controllers.delete(controller);
          admitted -= 1;
        },
      };
    },
    abortAll: (): void => {
      for (const controller of controllers) controller.abort(new Error(CLOSE_ABORT));
    },
  };
}

function normalizeToolBridgeLimits(
  input: OpenCodeRuntimeCompositionInput["toolBridge"],
): ToolBridgeLimits {
  return {
    requestDeadlineMs: boundedInteger(
      input?.requestDeadlineMs,
      DEFAULT_TOOL_BRIDGE_DEADLINE_MS,
      MAX_TOOL_BRIDGE_DEADLINE_MS,
    ),
    maxInFlight: boundedInteger(
      input?.maxInFlight,
      CODING_TOOL_MAX_IN_FLIGHT,
      MAX_TOOL_BRIDGE_IN_FLIGHT,
    ),
  };
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  return value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.min(maximum, Math.max(1, Math.trunc(value)));
}

function preflightToolRequest(
  active: boolean,
  capability: string,
  headers: Headers,
  body?: string,
): { readonly status: number; readonly body: string } | undefined {
  if (!active) return { status: 503, body: "" };
  if (headers.has("origin")) return { status: 403, body: "" };
  const bearer = headers.get("authorization");
  if (bearer === null || !safeEqual(bearer, `Bearer ${capability}`)) {
    return { status: 401, body: "" };
  }
  const declaredLength = declaredBodyLength(headers.get("content-length"));
  if (declaredLength === "invalid" || declaredLength > CODING_TOOL_MAX_BODY_BYTES) {
    return { status: 413, body: "" };
  }
  if (body !== undefined && Buffer.byteLength(body, "utf8") > CODING_TOOL_MAX_BODY_BYTES) {
    return { status: 413, body: "" };
  }
  return undefined;
}

function declaredBodyLength(value: string | null): number | "invalid" {
  if (value === null) return 0;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) return "invalid";
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : "invalid";
}

async function executeToolRequest(
  deps: ToolBridgeExecutionDeps,
  headers: Headers,
  body: string,
  admission: AdmittedToolRequest,
): Promise<{ readonly status: number; readonly body: string }> {
  const { facade, capability, settleTool, diagnostics } = deps;
  if (!validJson(body)) {
    admission.release();
    return { status: 400, body: "" };
  }
  const actionId = parseCodingToolRequest(body, CODING_TOOL_MAX_BODY_BYTES)?.actionId;
  const work = startFacadeExecution(facade, capability, headers, body, admission);
  releaseAdmissionWhenSettled(work, admission);
  try {
    const result = await raceAbort(work, admission.controller.signal);
    const reason = abortReason(admission.controller.signal);
    if (reason !== undefined) {
      settleSafeTool(settleTool, actionId, "cancelled");
      return reason === DEADLINE_ABORT ? { status: 408, body: "" } : { status: 502, body: "" };
    }
    return responseForToolResult(result, settleTool, actionId);
  } catch (error) {
    const reason = abortReason(admission.controller.signal);
    // A cancellation is an expected outcome, not a facade fault, so only a genuine failure is
    // surfaced to the operator.
    if (reason === undefined) emitFacadeFailureDiagnostic(diagnostics, actionId, error);
    settleSafeTool(settleTool, actionId, reason === undefined ? "failed" : "cancelled");
    return reason === DEADLINE_ABORT ? { status: 408, body: "" } : { status: 502, body: "" };
  }
}

function responseForToolResult(
  result: CodingToolResult,
  settleTool: SafeToolSettlement | undefined,
  actionId: string | undefined,
): { readonly status: number; readonly body: string } {
  if (result.status === "busy") {
    settleSafeTool(settleTool, actionId, "failed");
    return { status: 429, body: "" };
  }
  settleSafeTool(settleTool, actionId, safeToolState(result));
  const responseBody = JSON.stringify(result);
  return Buffer.byteLength(responseBody, "utf8") <= CODING_TOOL_MAX_BODY_BYTES
    ? { status: 200, body: responseBody }
    : { status: 502, body: "" };
}

// Invoking inside `.then` defers the call, so a facade that dies SYNCHRONOUSLY (before returning a
// promise) surfaces as a rejection on the very same path as one whose promise rejects. That gives
// the awaiting request path a single failure mode to own — it emits the operator diagnostic,
// settles the tool, and maps the request to 502/408 — and it keeps the call out of a `try`, which
// typescript:S4822 rejects around a promise-returning call in either direction (with a `.catch` it
// asks for the `try` to go, without one it asks for the `.catch`).
function startFacadeExecution(
  facade: CodingToolFacade,
  capability: string,
  headers: Headers,
  body: string,
  admission: AdmittedToolRequest,
): Promise<CodingToolResult> {
  return Promise.resolve().then(() =>
    facade.execute({ body, capability, headers, signal: admission.controller.signal }),
  );
}

// Content-free by design (the tool bridge never logs request or error bodies): the record carries
// the error class and a fixed machine message only, keyed to the action id for correlation. The
// class label comes from the shared `contentFreeErrorClass` hardening in diagnostics-log, so the
// mutable-`Error.name` defense lives in exactly one place.
// `actionId` is request content (parseCodingToolRequest bounds it to a non-empty string ≤512
// bytes only), so it rides on the redaction-safe diagnostic solely as a bounded machine token that
// satisfies the one canonical correlation-id shape (`isValidCorrelationId`, the shape
// `defaultServerDiagnosticSink` sanitizes against — a wider local shape would be replaced by the
// sink's content-free marker and lose the correlation). The `tool:<callId>` production shape is not
// valid as-is (the canonical shape admits no `:`), so it is mapped onto `tool-<callId>` — a fixed,
// documented prefix swap an analyzer joins back to the evidence's `actionId`. Prose, whitespace,
// overlength and too-short values degrade to the marker.
const TOOL_ACTION_ID_PREFIX = "tool:";
const TOOL_ACTION_CORRELATION_PREFIX = "tool-";
const UNPARSED_ACTION_CORRELATION_ID = "tool-bridge-unparsed-action";

function actionCorrelationId(actionId: string | undefined): string {
  if (actionId === undefined) return UNPARSED_ACTION_CORRELATION_ID;
  const candidate = actionId.startsWith(TOOL_ACTION_ID_PREFIX)
    ? `${TOOL_ACTION_CORRELATION_PREFIX}${actionId.slice(TOOL_ACTION_ID_PREFIX.length)}`
    : actionId;
  return isValidCorrelationId(candidate) ? candidate : UNPARSED_ACTION_CORRELATION_ID;
}

function emitFacadeFailureDiagnostic(
  diagnostics: ServerDiagnosticSink | undefined,
  actionId: string | undefined,
  error: unknown,
): void {
  emitServerDiagnostic(diagnostics, {
    correlationId: actionCorrelationId(actionId),
    timestamp: new Date().toISOString(),
    operation: "coding-runtime.tool-bridge",
    source: "opencode-runtime-composition.facade-execute",
    errorClass: contentFreeErrorClass(error),
    message: "tool-facade-failed",
  });
}

function releaseAdmissionWhenSettled(
  work: Promise<CodingToolResult>,
  admission: AdmittedToolRequest,
): void {
  void work.then(
    () => {
      admission.release();
    },
    () => {
      admission.release();
    },
  );
}

function settleSafeTool(
  settleTool: SafeToolSettlement | undefined,
  actionId: string | undefined,
  state: OpenCodeToolSettlementState,
): void {
  if (actionId === undefined) return;
  settleTool?.({ actionId, state, occurredAt: new Date().toISOString() });
}

function safeToolState(result: CodingToolResult): OpenCodeToolSettlementState {
  if (result.status === "completed") return "succeeded";
  if (result.status === "denied") return "denied";
  if (result.status === "cancelled") return "cancelled";
  return "failed";
}

function validJson(body: string): boolean {
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          reject(abortError(signal));
        },
        { once: true },
      );
    }),
  ]);
}

function abortReason(signal: AbortSignal): string | undefined {
  return signal.reason instanceof Error ? signal.reason.message : undefined;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("tool-bridge-aborted");
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

// Retired production HTTP listener for this bridge (#3390 / ADR-0043 D11-D14): NOTHING in this
// module calls `.listen()` any more -- `handle()` above is the one dispatch surface, reached over
// the already-attested `/api/coding-sidecar/gateway` loopback port via
// coding-sidecar-tool-facade.ts. The two small helpers below (Node headers -> `Headers`, and a
// byte-budget-bounded body read) are kept, exported, for the ONE caller still allowed to own a
// real HTTP endpoint around this same `handle`: the scripted functional harness's fake sidecar
// (opencodeFunctionalHarness/_support.ts) -- never a second production path.

/** Node's multi-valued header shape flattened onto the Fetch `Headers` `preflightToolRequest` and
 * the BFF route both read. */
export function incomingHeaders(values: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === "string") headers.set(name, value);
    else if (value !== undefined) headers.set(name, value.join(", "));
  }
  return headers;
}

/** Same byte budget (`CODING_TOOL_MAX_BODY_BYTES`) as `preflightToolRequest`'s declared-length
 * check, enforced against the ACTUAL stream as it arrives rather than a (possibly absent or
 * understated) `content-length` header. */
export function readBoundedBody(request: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = (): void => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (reason: unknown): void => {
      request.pause();
      cleanup();
      reject(reason instanceof Error ? reason : new Error("tool-bridge-read-aborted"));
    };
    const onData = (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > CODING_TOOL_MAX_BODY_BYTES) fail(new Error("body-too-large"));
      else chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks, bytes));
    };
    const onError = (error: Error): void => {
      fail(error);
    };
    const onAbort = (): void => {
      fail(signal.reason);
    };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
