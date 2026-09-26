import { createHash, timingSafeEqual } from "node:crypto";
import {
  DEFAULT_SANDBOX_POLICY,
  GOVERNED_TOOL_SETTLEMENT_GRACE_MS,
} from "@oscharko-dev/keiko-contracts/runtime/tools";
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
  describeError,
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
import type { CodingToolEditBaseRead, CodingToolFacade } from "./codingToolFacadePorts.js";
import { staleEditBaseToolResult } from "./codingToolFacade.js";
import type { OpenCodeQuestionRequest } from "./opencodeHttpClient.js";
import {
  createOpenCodeV2HttpClient,
  parseOpenCodeV2ChildEndpoint,
  type OpenCodeV2HttpClient,
} from "./opencodeV2HttpClient.js";
import { createOpenCodeV2HistoryProjection, OpenCodeV2HistoryError } from "./opencodeV2History.js";
import { recordContextPresentation } from "./codingRuntimeHistory.js";
import {
  createOpenCodeV2ApprovalRequests,
  type OpenCodeV2ApprovalDecision,
  type OpenCodeV2ApprovalOutcome,
  type ToolBridgeApprovalRejection,
} from "./opencodeV2ApprovalRequests.js";
import type { SidecarPermissionEvent } from "./codingSidecarEventParser.js";
import { answerOpenCodeV2Form, projectOpenCodeV2Form, v2FormId } from "./opencodeV2Questions.js";
import {
  buildOpenCodeLaunchProfile,
  OPENCODE_RUNTIME_READINESS_PROMPT,
} from "./opencodeLaunchProfile.js";
import type { OpenCodeContextGeometry } from "./opencodeLaunchProfile.js";
import {
  createGeneratedOpenCodeV2Plugins,
  createOpenCodeRuntimeAdapter,
  type OpenCodeGovernedSinkReceipt,
  type OpenCodeRuntimeAdapter,
  type OpenCodeSyncHint,
} from "./opencodeRuntimeAdapter.js";
import {
  OPENCODE_HISTORY_RESPONSE_MAX_BYTES,
  projectOpenCodePermissionRequestId,
} from "./opencodeProtocol.js";
import {
  OPEN_CODE_V2_PROTOCOL_SURFACE_ALGORITHM,
  projectOpenCodeV2ProtocolSurface,
} from "./opencodeProtocolSurface.js";
import type { OpenCodeReconciliationEvent } from "./opencodeReconciler.js";
import type { RuntimeProcessSupervisor } from "./runtimeProcessSupervisor.js";
import { OPENCODE_PINNED_VERSION } from "./opencodeToolSchemas.js";
import { CodingRuntimeQuestionAnswerRejectedError } from "./codingRuntimeQuestionPort.js";
import { openCodeCatalogSettlementBudgetMs } from "../tool-catalog/catalogToolFacadeBridge.js";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";

function v2Record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

const PINNED_RAW_SCHEMA_SHA256 = "1362671d8cfdcb925b3a9fd61eaa20152e4c587746445a0b03504674b25c88ec";
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
  readonly contextGeometry: OpenCodeContextGeometry;
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
        readonly captureMessages?:
          | ((
              messages: readonly import("./codingRuntimeHistory.js").CodingHistoryMessage[],
            ) => boolean)
          | undefined;
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
  readonly activityLog?: ServerLogSink | undefined;
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
  /**
   * The SAME per-run deadline (ms) the admission gate applies to an in-flight facade call
   * (`createToolBridgeAdmissionGate`'s `limits.requestDeadlineMs`), exposed so the BFF route can
   * bound body-ingestion time with the identical number instead of a second, restated constant —
   * closing the gap where a slow/partial POST could otherwise buffer for as long as Node's generic
   * socket defaults allow before the gate's own timer ever starts (#3390 follow-up).
   */
  readonly requestDeadlineMs: number;
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
  }): Promise<OpenCodeToolBridgeResponse>;
}

/**
 * `rejection` is set only on a refused governed ask (#3610): the outcome of the human decision,
 * carried beside the status so the route never reads that 403 as an origin refusal.
 */
export interface OpenCodeToolBridgeResponse {
  readonly status: number;
  readonly body: string;
  readonly rejection?: ToolBridgeApprovalRejection;
  /** The run and permission request a refused governed ask belongs to (PR #3617 review). */
  readonly approval?: { readonly runId: string; readonly requestId: string } | undefined;
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
  readonly workspaceRoot: string;
  readonly password: string;
  readonly configDigest: string;
  readonly verification: PortableSidecarRuntimeVerification;
  readonly observedPermissionIds: Set<string>;
  onPermission?: ((event: SidecarPermissionEvent) => void) | undefined;
  runtimeAdapter?: OpenCodeRuntimeAdapter | undefined;
  client?: OpenCodeV2HttpClient | undefined;
  sessionId?: string | undefined;
  initialTurnBaselineStable: boolean;
  ready: boolean;
}

interface ReadyRun extends PreparedRun {
  runtimeAdapter: OpenCodeRuntimeAdapter;
  client: OpenCodeV2HttpClient;
  sessionId: string;
  // Deliberately NOT narrowed to the literal `true`: `isReadyRun` below only asserts `ready`
  // was `true` at lookup time. The same mutable object stays reachable through `runs` and can
  // flip `ready` to `false` (dispose/monitor cleanup) while an async run port call is still
  // in flight on this reference -- a literal-`true` type would make TS (and, on top of it,
  // ESLint's no-unnecessary-condition) treat every later `run.ready` check as dead code and
  // invite deleting the very guard that catches that race.
  ready: boolean;
}
type ReadyRunLookup = (runId: string) => ReadyRun | undefined;
type QuestionRunPort = Pick<OpenCodeRunPort, "listQuestions" | "answerQuestion" | "rejectQuestion">;

export function createOpenCodeRuntimeComposition(
  input: OpenCodeRuntimeCompositionInput,
): OpenCodeRuntimeComposition {
  const runs = new Map<string, PreparedRun>();
  const approvals = createOpenCodeV2ApprovalRequests(input.diagnostics, input.activityLog);
  const bridge = createToolBridge(
    input.capabilities.toolFacadeCapability,
    input.toolFacade,
    input.toolBridge,
    input.safeActivity?.settleTool,
    input.diagnostics,
    input.toolFacadeOrigin,
    { approvals, runs },
  );
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
    runPort: createRunPort(runs, input.diagnostics, input.activityLog, approvals),
  };
}

function createRunPort(
  runs: Map<string, PreparedRun>,
  diagnostics: ServerDiagnosticSink | undefined,
  activityLog: ServerLogSink | undefined,
  approvals: ReturnType<typeof createOpenCodeV2ApprovalRequests>,
): OpenCodeRunPort {
  const readyRun = (runId: string): ReadyRun | undefined => {
    const run = runs.get(runId);
    return isReadyRun(run) ? run : undefined;
  };
  return {
    submitTask: createSubmitTask(readyRun, diagnostics, activityLog),
    abortTask: createAbortTask(readyRun),
    waitForTerminal: async (runId, signal): Promise<boolean> => {
      const run = readyRun(runId);
      if (run === undefined) return false;
      const outcome = await run.runtimeAdapter.waitForTerminal(signal);
      if (!outcome && !signal.aborted) recordOpenCodeTurnFailure(diagnostics, run, "terminal");
      return outcome;
    },
    replyPermission: createReplyPermission(readyRun, diagnostics, approvals),
    ...createQuestionRunPort(readyRun, diagnostics),
  };
}

function createSubmitTask(
  readyRun: ReadyRunLookup,
  diagnostics: ServerDiagnosticSink | undefined,
  activityLog: ServerLogSink | undefined,
): OpenCodeRunPort["submitTask"] {
  return async (runId, text, initialContext): Promise<boolean> => {
    const run = readyRun(runId);
    if (run === undefined) return false;
    if (!(await synchronizeTurnBaseline(run))) return false;
    if (!run.runtimeAdapter.armTurn()) return false;
    try {
      await run.client.prompt(
        run.sessionId,
        initialContext === undefined ? text : `${initialContext}\n\n${text}`,
        undefined,
        initialContext === undefined
          ? undefined
          : {
              displayText: text,
              hiddenContextSha256: createHash("sha256").update(initialContext).digest("hex"),
            },
      );
      if (initialContext !== undefined) recordContextPresentation(activityLog, runId);
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
  approvals: ReturnType<typeof createOpenCodeV2ApprovalRequests>,
): OpenCodeRunPort["replyPermission"] {
  return async (runId, requestId, reply): Promise<boolean> => {
    const run = readyRun(runId);
    if (run === undefined) return false;
    if (approvals.resolve(runId, requestId, reply === "once")) return run.ready;
    try {
      const owned = (await run.client.permissions()).filter(
        (request) =>
          request.sessionID === run.sessionId &&
          typeof request.id === "string" &&
          projectOpenCodePermissionRequestId(request.id) === requestId,
      );
      const permission = owned[0];
      if (owned.length !== 1 || typeof permission?.id !== "string") return false;
      await run.client.replyPermission(run.sessionId, permission.id, reply);
      return run.ready;
    } catch (error) {
      recordOpenCodeTurnFailure(diagnostics, run, "permission", error);
      return false;
    }
  };
}

type OpenCodeTurnFailureStage = "permission" | "question" | "submit" | "terminal";

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
  COALESCE(SUM(CASE WHEN type = 'assistant' THEN 1 ELSE 0 END), 0) AS assistant,
  COALESCE(SUM(CASE WHEN json_extract(data, '$.finish') = 'stop' THEN 1 ELSE 0 END), 0) AS stop,
  COALESCE(SUM(CASE WHEN json_extract(data, '$.finish') = 'tool-calls' THEN 1 ELSE 0 END), 0) AS toolCalls,
  COALESCE(SUM(CASE WHEN json_extract(data, '$.finish') = 'error' THEN 1 ELSE 0 END), 0) AS error,
  COALESCE(SUM(CASE WHEN json_extract(data, '$.finish') = 'length' THEN 1 ELSE 0 END), 0) AS length,
  COALESCE(SUM(CASE WHEN json_extract(data, '$.error.name') IS NOT NULL THEN 1 ELSE 0 END), 0) AS errorName
FROM session_message
`;

const OPEN_CODE_PART_SUMMARY_SQL = `
SELECT
  COUNT(*) AS total,
  COALESCE(SUM(CASE WHEN json_extract(part.value, '$.type') = 'tool' THEN 1 ELSE 0 END), 0) AS tool,
  COALESCE(SUM(CASE WHEN json_extract(part.value, '$.type') = 'text' THEN 1 ELSE 0 END), 0) AS text,
  COALESCE(SUM(CASE WHEN json_extract(part.value, '$.state.status') = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
  COALESCE(SUM(CASE WHEN json_extract(part.value, '$.state.status') = 'completed' THEN 1 ELSE 0 END), 0) AS completed
FROM session_message AS message, json_each(json_extract(message.data, '$.content')) AS part
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
      await run.client.interrupt(run.sessionId);
      const settled = await fixedV2SessionIsTerminal(
        run.client,
        run.sessionId,
        AbortSignal.timeout(ABORT_SETTLEMENT_TIMEOUT_MS),
      );
      if (settled) {
        await run.runtimeAdapter.waitForTerminal(AbortSignal.timeout(ABORT_SETTLEMENT_TIMEOUT_MS));
      } else {
        run.runtimeAdapter.cancelTurn();
      }
      return settled && run.ready;
    } catch {
      run.runtimeAdapter.cancelTurn();
      return false;
    }
  };
}

function createQuestionRunPort(
  readyRun: ReadyRunLookup,
  diagnostics: ServerDiagnosticSink | undefined,
): QuestionRunPort {
  return {
    listQuestions: async (runId): Promise<readonly OpenCodeQuestionRequest[]> => {
      const run = readyRun(runId);
      if (run === undefined) return [];
      try {
        return (await run.client.forms())
          .filter((form) => form.sessionID === run.sessionId)
          .map(projectOpenCodeV2Form);
      } catch (error) {
        recordOpenCodeTurnFailure(diagnostics, run, "question", error);
        throw error;
      }
    },
    answerQuestion: async (runId, requestId, answers): Promise<boolean> => {
      const run = readyRun(runId);
      if (run === undefined) return false;
      try {
        const formId = v2FormId(requestId);
        const pending = (await run.client.forms()).find(
          (form) => form.id === formId && form.sessionID === run.sessionId,
        );
        if (pending === undefined || !run.ready) return false;
        const question = projectOpenCodeV2Form(pending);
        if (!answersMatchQuestions(question, answers))
          throw new CodingRuntimeQuestionAnswerRejectedError();
        await run.client.replyForm(
          run.sessionId,
          String(pending.id),
          answerOpenCodeV2Form(pending, answers),
        );
        return run.ready;
      } catch (error) {
        if (error instanceof CodingRuntimeQuestionAnswerRejectedError) throw error;
        recordOpenCodeTurnFailure(diagnostics, run, "question", error);
        throw error;
      }
    },
    rejectQuestion: createRejectQuestion(readyRun, diagnostics),
  };
}

function createRejectQuestion(
  readyRun: ReadyRunLookup,
  diagnostics: ServerDiagnosticSink | undefined,
): QuestionRunPort["rejectQuestion"] {
  return async (runId, requestId): Promise<boolean> => {
    const run = readyRun(runId);
    if (run === undefined) return false;
    try {
      const formId = v2FormId(requestId);
      const owned = (await run.client.forms()).some(
        (form) => form.id === formId && form.sessionID === run.sessionId,
      );
      if (!owned || formId === undefined) return false;
      await run.client.cancelForm(run.sessionId, formId);
      return run.ready;
    } catch (error) {
      recordOpenCodeTurnFailure(diagnostics, run, "question", error);
      throw error;
    }
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
      bridge.approvals.close();
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
    contextGeometry: input.contextGeometry,
  });
  if (!profile.ok) throw new Error("profile-invalid");
  const config = profile.config;
  materialize(runRoot, config, createGeneratedOpenCodeV2Plugins());
  const password = profile.env.OPENCODE_SERVER_PASSWORD;
  if (password === undefined) throw new Error("password-missing");
  const configDigest = createHash("sha256").update(config, "utf8").digest("hex");
  runs.set(
    request.runId,
    preparedRun(
      request.runId,
      runRoot,
      request.env.KEIKO_CODING_WORKSPACE_ROOT ?? "",
      password,
      configDigest,
      request.verification,
    ),
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
  workspaceRoot: string,
  password: string,
  configDigest: string,
  verification: PortableSidecarRuntimeVerification,
): PreparedRun {
  return {
    runId,
    runRoot,
    workspaceRoot,
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
  run.onPermission = request.onPermission;
  try {
    const endpoint = parseOpenCodeV2ChildEndpoint(
      await request.startupOutput.nextLine(request.signal),
    );
    if (endpoint === undefined) return { ok: false, reason: "endpoint-invalid" };
    const client = createOpenCodeV2HttpClient({
      endpoint,
      password: run.password,
      fetch: input.fetch,
      timeoutMs: request.timeoutMs,
    });
    const adapter = createOpenCodeRuntimeAdapter({
      correlationId: request.runId,
      contextGeometry: input.contextGeometry,
      ...(input.activityLog === undefined ? {} : { activityLog: input.activityLog }),
      readiness: readinessV2Ports(input, bridge, run, client, endpoint, request),
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
          return (await v2SessionIsTerminal(client, sessionId, signal)) ? "terminal" : "activity";
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

// eslint-disable-next-line max-lines-per-function -- ordered V2 readiness ports bind one attested child.
function readinessV2Ports(
  input: OpenCodeRuntimeCompositionInput,
  bridge: ToolBridgeController,
  run: PreparedRun,
  client: OpenCodeV2HttpClient,
  endpoint: string,
  request: OpenCodeLifecycleHandshakeRequest,
): Parameters<typeof createOpenCodeRuntimeAdapter>[0]["readiness"] {
  let fixedSessionId: string | undefined;
  let startupRead = false;
  const history = createOpenCodeV2HistoryProjection({
    runId: run.runId,
    activityLog: input.activityLog,
    captureMessages: input.safeActivity?.captureMessages,
  });
  const staged = new Map<
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
      return Promise.resolve(`server listening on ${endpoint}\n`);
    },
    health: async (
      authorization,
    ): Promise<{ readonly status: number; readonly version?: string }> =>
      authorization === "basic"
        ? authenticatedV2Health(client)
        : unauthenticatedV2Health(input.fetch, endpoint, request.signal),
    openApiDigest: async (): Promise<string> =>
      projectOpenCodeV2ProtocolSurface(await client.document()).digest,
    gatewayChallenge: () =>
      challengeV2Gateway(input, run, client, fixedSessionId, request, startupRead),
    toolFacadeChallenge: () => challengeToolFacade(input, bridge),
    subscribe: async function* (signal): AsyncIterable<OpenCodeSyncHint> {
      fixedSessionId = await createAndEchoV2Session(client, run.workspaceRoot, request.signal);
      const combined =
        request.signal === undefined ? signal : AbortSignal.any([signal, request.signal]);
      for await (const event of client.events(combined)) {
        yield v2SyncHint(event, fixedSessionId, input.onQuestionObserved);
      }
    },
    history: async (checkpoints, signal): Promise<readonly OpenCodeReconciliationEvent[]> => {
      if (fixedSessionId === undefined) throw new Error("opencode-v2-session-missing");
      let messages: readonly Readonly<Record<string, unknown>>[] = [];
      try {
        messages = await client.messages(fixedSessionId, signal);
        const events = history.project(fixedSessionId, messages, checkpoints[fixedSessionId]);
        staged.clear();
        for (const event of events) {
          const safe = history.takeSignal(event);
          if (safe !== undefined)
            staged.set(`${event.aggregateId}\u0000${String(event.sequence)}`, safe);
        }
        return events;
      } catch (error) {
        if (messages.length > 0) input.safeActivity?.recordDrops(messages.length);
        recordOpenCodeV2HistoryFailure(input.diagnostics, run.runId, error);
        throw error;
      }
    },
    takeSafeActivity: (
      identityKey,
    ): import("./codingSafeActivityProjection.js").CodingSafeActivitySignal | undefined => {
      const safe = staged.get(identityKey);
      staged.delete(identityKey);
      return safe;
    },
    clearSafeActivity: (): void => {
      staged.clear();
      history.clearSignals();
    },
    sessionEcho: (): Promise<string> => Promise.resolve(fixedSessionId ?? ""),
  };
}

function v2ExecutionState(type: unknown): "activity" | "terminal" | undefined {
  if (type === "session.execution.started") return "activity";
  if (
    type === "session.execution.succeeded" ||
    type === "session.execution.failed" ||
    type === "session.execution.cancelled"
  )
    return "terminal";
  return undefined;
}

function v2SyncHint(
  event: Readonly<Record<string, unknown>>,
  fixedSessionId: string,
  onQuestionObserved: ((identity: string) => void) | undefined,
): OpenCodeSyncHint {
  const data = v2Record(event.data);
  if (
    event.type === "form.created" &&
    typeof event.id === "string" &&
    v2Record(data?.form)?.sessionID === fixedSessionId
  )
    onQuestionObserved?.(event.id);
  const state = v2ExecutionState(event.type);
  return {
    requiresHistoryIdentity: false,
    ...(data?.sessionID === fixedSessionId && state !== undefined
      ? { control: { sessionId: fixedSessionId, state } }
      : {}),
  };
}

const KNOWN_V2_HISTORY_FAILURES = new Set([
  "opencode-v2-response-invalid",
  "opencode-v2-envelope-invalid",
  "opencode-v2-history-oversized",
  "opencode-v2-cursor-invalid",
  "opencode-v2-message-time-invalid",
  "opencode-v2-message-id-invalid",
  "opencode-v2-content-invalid",
  "opencode-v2-parent-message-missing",
  "opencode-v2-tool-invalid",
  "opencode-v2-tool-time-invalid",
  "opencode-v2-tool-state-invalid",
  "opencode-v2-plan-invalid",
  "opencode-v2-text-oversized",
]);

function v2HistoryFailureReason(error: unknown): string {
  if (error instanceof OpenCodeV2HistoryError) return error.safeCode;
  if (error instanceof Error && error.message === "opencode-v2-response-oversized")
    return `reason=transport-oversized:responseBudgetBytes=${String(OPENCODE_HISTORY_RESPONSE_MAX_BYTES)}`;
  if (error instanceof Error && KNOWN_V2_HISTORY_FAILURES.has(error.message))
    return `reason=${error.message}`;
  return "reason=transport-invalid";
}

function recordOpenCodeV2HistoryFailure(
  diagnostics: ServerDiagnosticSink | undefined,
  runId: string,
  error: unknown,
): void {
  const reason = v2HistoryFailureReason(error);
  const detail = describeError(error);
  emitServerDiagnostic(diagnostics, {
    correlationId: runId,
    timestamp: new Date().toISOString(),
    operation: "coding-runtime.history",
    source: "opencode.history",
    errorClass: "OpenCodeHistoryFailure",
    message: "runtime-history-failed",
    code: `stage=history:${reason}`,
    ...(detail.frames === undefined ? {} : { frames: detail.frames }),
    ...(detail.causeChain === undefined ? {} : { causeChain: detail.causeChain }),
  });
}

async function createAndEchoV2Session(
  client: OpenCodeV2HttpClient,
  directory: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const created = await client.createSession(directory, signal);
  const id = created.id;
  if (typeof id !== "string" || !/^ses_[A-Za-z0-9_-]{1,251}$/u.test(id)) return "";
  const sessions = await client.sessions(signal);
  return sessions.length === 1 && sessions[0]?.id === id ? id : "";
}

async function authenticatedV2Health(
  client: OpenCodeV2HttpClient,
): Promise<{ readonly status: number; readonly version?: string }> {
  const info = await client.info();
  return typeof info.version === "string"
    ? { status: 200, version: info.version }
    : { status: 500 };
}

async function unauthenticatedV2Health(
  fetchFn: typeof globalThis.fetch,
  endpoint: string,
  signal: AbortSignal | undefined,
): Promise<{ readonly status: number }> {
  const response = await fetchFn(new URL("/api/info", endpoint), {
    method: "GET",
    redirect: "manual",
    ...(signal === undefined ? {} : { signal }),
  });
  return { status: response.status };
}

async function v2SessionIsTerminal(
  client: OpenCodeV2HttpClient,
  sessionId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const active = await client.active(signal);
  return !Object.hasOwn(active, sessionId);
}

async function fixedV2SessionIsTerminal(
  client: OpenCodeV2HttpClient,
  sessionId: string,
  signal: AbortSignal,
): Promise<boolean> {
  while (!signal.aborted) {
    if (await v2SessionIsTerminal(client, sessionId, signal)) return true;
    if (!(await readinessPollDelay(signal))) return false;
  }
  return false;
}

async function challengeV2Gateway(
  input: OpenCodeRuntimeCompositionInput,
  run: PreparedRun,
  client: OpenCodeV2HttpClient,
  sessionId: string | undefined,
  request: OpenCodeLifecycleHandshakeRequest,
  startupRead: boolean,
): Promise<boolean> {
  const reason = gatewayChallengePrecondition(input, sessionId, startupRead);
  if (reason !== undefined || sessionId === undefined) {
    recordGatewayChallengeFailure(input.diagnostics, run.runId, reason ?? "session-missing");
    return false;
  }
  const signal = request.signal ?? AbortSignal.timeout(request.timeoutMs);
  const observed = input.gatewayReadiness.waitForObservedRequest(run.runId, signal);
  let verified = false;
  try {
    // One constant for the prompt and for every reader that must recognise it: the sidecar's fixed
    // readiness answer and the Coding History capture, which never stores this turn (#3610).
    await client.prompt(sessionId, OPENCODE_RUNTIME_READINESS_PROMPT, signal);
    const accepted = await observed;
    await client.interrupt(sessionId, signal);
    verified = accepted && (await fixedV2SessionIsTerminal(client, sessionId, signal));
    // An unaccepted wait the start signal did not end is the gateway route refusing the challenge
    // request (#3603): named apart from a request that never arrived or a turn that did not end.
    if (!verified)
      recordGatewayChallengeFailure(
        input.diagnostics,
        run.runId,
        accepted || signal.aborted ? "live-verification-failed" : "gateway-refused",
      );
    return verified;
  } catch {
    recordGatewayChallengeFailure(input.diagnostics, run.runId, "live-verification-failed");
    return false;
  } finally {
    input.gatewayReadiness.clear(run.runId, verified);
  }
}

type GatewayChallengePreconditionFailure =
  | "startup-unread"
  | "session-missing"
  | "capability-invalid"
  | "live-verification-failed"
  | "gateway-refused";

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
      OPEN_CODE_V2_PROTOCOL_SURFACE_ALGORITHM &&
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
    join(runRoot, "config", "opencode", "plugins"),
  ]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
}

function materialize(
  runRoot: string,
  config: string,
  pluginSources: Readonly<Record<string, string>>,
): void {
  const discoveryRoot = join(runRoot, "config", "opencode");
  writePrivateFile(join(discoveryRoot, "opencode.json"), config);
  for (const [name, source] of Object.entries(pluginSources)) {
    writePrivateFile(join(discoveryRoot, "plugins", `${name}.ts`), source);
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
  readonly approvals: ReturnType<typeof createOpenCodeV2ApprovalRequests>;
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
  // The deadline this request was admitted under, named by the diagnostic its expiry leaves.
  readonly deadlineMs: number;
  release(): void;
}

interface ToolBridgeAdmissionGate {
  readonly limits: ToolBridgeLimits;
  readonly admit: (requestDeadlineMs: number) => AdmittedToolRequest | undefined;
  readonly abortAll: () => void;
}

const DEFAULT_TOOL_BRIDGE_DEADLINE_MS = 30_000;
const MAX_TOOL_BRIDGE_DEADLINE_MS = 60_000;
/**
 * The deadline the tool bridge admits a request under. A tool the catalog settles beyond the
 * sandbox default (the verification tool at its derived work budget, the four proposal tools at the
 * wait for the operator's approval on top of their own work) is admitted one settlement grace past
 * that budget, read from the catalog descriptor of the tool the request dispatches to, so the
 * facade's answer (the result, or the catalog's own timeout) always reaches the sidecar instead of a
 * bridge-side abort racing it. Every other request, and a body the facade's parser refuses, gets the
 * configured default; the facade refuses the latter afterwards as before. A deadline read from the
 * verification action alone cut every waiting approval off at 30 s (PR #3452, F44).
 */
export function toolBridgeRequestDeadlineMs(
  configuredDeadlineMs: number,
  body: string | undefined,
): number {
  const request =
    body === undefined ? undefined : parseCodingToolRequest(body, CODING_TOOL_MAX_BODY_BYTES);
  const budgetMs = request === undefined ? undefined : openCodeCatalogSettlementBudgetMs(request);
  return budgetMs !== undefined && budgetMs > DEFAULT_SANDBOX_POLICY.defaultTimeoutMs
    ? budgetMs + GOVERNED_TOOL_SETTLEMENT_GRACE_MS
    : configuredDeadlineMs;
}

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
  v2: {
    readonly approvals: ReturnType<typeof createOpenCodeV2ApprovalRequests>;
    readonly runs: ReadonlyMap<string, PreparedRun>;
  },
): ToolBridgeController {
  const { approvals, runs } = v2;
  const limits = normalizeToolBridgeLimits(configuredLimits);
  let listening = false;
  const gate = createToolBridgeAdmissionGate(limits);
  const deps: ToolBridgeExecutionDeps = { capability, facade, settleTool, diagnostics };
  const handle: OpenCodeToolBridge["handle"] = (request) =>
    handleDirectToolRequest(listening, deps, gate, request, approvals, runs);
  const publicPort: OpenCodeToolBridge = {
    get url(): string {
      return toolFacadeOrigin;
    },
    requestDeadlineMs: limits.requestDeadlineMs,
    handle,
  };
  return {
    publicPort,
    approvals,
    active: () => listening,
    start: (): Promise<void> => {
      listening = true;
      return Promise.resolve();
    },
    close: (): Promise<void> => {
      listening = false;
      approvals.close();
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
  approvals: ReturnType<typeof createOpenCodeV2ApprovalRequests>,
  runs: ReadonlyMap<string, PreparedRun>,
): Promise<OpenCodeToolBridgeResponse> {
  const preflight = preflightToolRequest(active, deps.capability, input.headers, input.body);
  if (preflight.outcome === "rejected") {
    return Promise.resolve({ status: preflight.status, body: preflight.body });
  }
  const permission = parseV2PermissionRequest(input.body);
  if (permission !== undefined) {
    return handleV2PermissionRequest(permission, input.signal, deps, approvals, runs);
  }
  const admission = gate.admit(
    toolBridgeRequestDeadlineMs(gate.limits.requestDeadlineMs, input.body),
  );
  if (admission === undefined) return Promise.resolve({ status: 429, body: "" });
  const detachExternalAbort = bindExternalAbort(input.signal, admission);
  return executeToolRequest(deps, input.headers, input.body, admission).finally(
    detachExternalAbort,
  );
}

function parseV2PermissionRequest(body: string): Readonly<Record<string, unknown>> | undefined {
  if (!validJson(body)) return undefined;
  const parsed: unknown = JSON.parse(body);
  const value = v2Record(parsed);
  return value?.action === "permission-request" ? value : undefined;
}

async function handleV2PermissionRequest(
  value: Readonly<Record<string, unknown>>,
  signal: AbortSignal | undefined,
  deps: ToolBridgeExecutionDeps,
  approvals: ReturnType<typeof createOpenCodeV2ApprovalRequests>,
  runs: ReadonlyMap<string, PreparedRun>,
): Promise<OpenCodeToolBridgeResponse> {
  const run = typeof value.runId === "string" ? runs.get(value.runId) : undefined;
  if (signal?.aborted === true) return refusedApproval("cancelled");
  if (run?.ready !== true || run.sessionId === undefined || run.onPermission === undefined)
    return refusedApproval("unavailable");
  const { editBaseDigest } = deps.facade;
  const decision = await approvals.request({
    value,
    runId: run.runId,
    sessionId: run.sessionId,
    onPermission: run.onPermission,
    signal: signal ?? new AbortController().signal,
    ...(editBaseDigest === undefined
      ? {}
      : {
          editBaseDigest: (
            file: string,
            readSignal: AbortSignal,
          ): Promise<CodingToolEditBaseRead> => editBaseDigest(deps.capability, file, readSignal),
        }),
  });
  settleDecidedTool(deps.settleTool, decision);
  return withApprovalIds(approvalResponse(decision), run.runId, decision);
}

// A refused ask names its run and permission request, so the route's line joins the run's own
// approval lines (PR #3617 review).
function withApprovalIds(
  response: OpenCodeToolBridgeResponse,
  runId: string,
  decision: OpenCodeV2ApprovalDecision,
): OpenCodeToolBridgeResponse {
  return decision.requestId === undefined || response.rejection === undefined
    ? response
    : { ...response, approval: { runId, requestId: decision.requestId } };
}

// The tool call a refused ask ends is settled with Keiko's own verdict (#3612): OpenCode reports
// any refused call as a generic failure, which read "Failed" for a human's denial. A stale base is
// a failed edit, reached without asking anyone.
const DECIDED_TOOL_STATES: Readonly<
  Partial<Record<OpenCodeV2ApprovalOutcome, OpenCodeToolSettlementState>>
> = {
  denied: "denied",
  expired: "cancelled",
  cancelled: "cancelled",
  stale: "failed",
  // PR #3617 review: an edit the run's authority no longer admits is denied, not a generic failure.
  "authority-denied": "denied",
};

function settleDecidedTool(
  settleTool: SafeToolSettlement | undefined,
  decision: OpenCodeV2ApprovalDecision,
): void {
  const state = DECIDED_TOOL_STATES[decision.outcome];
  if (state !== undefined) settleSafeTool(settleTool, decision.actionId, state);
}

// A stale base answers with the edit's own refusal result, which the plugin hands to the model in
// place of the tool call, so the model reads the same re-read guidance as after an approval.
function approvalResponse(decision: OpenCodeV2ApprovalDecision): OpenCodeToolBridgeResponse {
  if (decision.outcome === "approved") return { status: 200, body: '{"status":"approved"}' };
  if (decision.outcome === "stale") {
    return {
      status: 409,
      body: JSON.stringify(staleEditBaseToolResult(decision.staleFile)),
      rejection: "approval-stale",
    };
  }
  return refusedApproval(decision.outcome);
}

const APPROVAL_REJECTIONS: Readonly<
  Record<Exclude<OpenCodeV2ApprovalOutcome, "approved">, ToolBridgeApprovalRejection>
> = {
  denied: "approval-denied",
  expired: "approval-expired",
  cancelled: "approval-cancelled",
  unavailable: "approval-unavailable",
  stale: "approval-stale",
  "authority-denied": "approval-authority-denied",
};

// The plugin only reads `response.ok`, so the status stays 403; the outcome rides beside it.
function refusedApproval(
  outcome: Exclude<OpenCodeV2ApprovalOutcome, "approved">,
): OpenCodeToolBridgeResponse {
  return { status: 403, body: "", rejection: APPROVAL_REJECTIONS[outcome] };
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
    limits,
    admit: (requestDeadlineMs: number): AdmittedToolRequest | undefined => {
      if (admitted >= limits.maxInFlight) return undefined;
      admitted += 1;
      const controller = new AbortController();
      controllers.add(controller);
      const timer = setTimeout(() => {
        controller.abort(new Error(DEADLINE_ABORT));
      }, requestDeadlineMs);
      timer.unref();
      let released = false;
      return {
        controller,
        deadlineMs: requestDeadlineMs,
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

type ToolPreflightResult =
  | { readonly outcome: "rejected"; readonly status: number; readonly body: string }
  | { readonly outcome: "admitted" };

function preflightToolRequest(
  active: boolean,
  capability: string,
  headers: Headers,
  body?: string,
): ToolPreflightResult {
  if (!active) return { outcome: "rejected", status: 503, body: "" };
  if (headers.has("origin")) return { outcome: "rejected", status: 403, body: "" };
  const bearer = headers.get("authorization");
  if (bearer === null || !safeEqual(bearer, `Bearer ${capability}`)) {
    return { outcome: "rejected", status: 401, body: "" };
  }
  const declaredLength = declaredBodyLength(headers.get("content-length"));
  if (declaredLength === "invalid" || declaredLength > CODING_TOOL_MAX_BODY_BYTES) {
    return { outcome: "rejected", status: 413, body: "" };
  }
  if (body !== undefined && Buffer.byteLength(body, "utf8") > CODING_TOOL_MAX_BODY_BYTES) {
    return { outcome: "rejected", status: 413, body: "" };
  }
  return { outcome: "admitted" };
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
    if (reason !== undefined) return abortedToolResponse(deps, actionId, admission, reason);
    return responseForToolResult(result, settleTool, actionId);
  } catch (error) {
    const reason = abortReason(admission.controller.signal);
    // A cancellation is an expected outcome, not a facade fault, so only a genuine failure is
    // surfaced to the operator.
    if (reason !== undefined) return abortedToolResponse(deps, actionId, admission, reason);
    emitFacadeFailureDiagnostic(diagnostics, actionId, error);
    settleSafeTool(settleTool, actionId, "failed");
    return { status: 502, body: "" };
  }
}

// A request the bridge itself stopped. Its own deadline leaves a diagnostic naming the deadline the
// request was admitted under, so a call cut off here is told apart in the log from one its caller
// dropped or the catalog timed out; a 30 s bridge deadline once cut waiting approvals off without a
// line of its own (PR #3452, F44).
function abortedToolResponse(
  deps: ToolBridgeExecutionDeps,
  actionId: string | undefined,
  admission: AdmittedToolRequest,
  reason: string,
): { readonly status: number; readonly body: string } {
  settleSafeTool(deps.settleTool, actionId, "cancelled");
  if (reason !== DEADLINE_ABORT) return { status: 502, body: "" };
  emitServerDiagnostic(deps.diagnostics, {
    correlationId: actionCorrelationId(actionId),
    timestamp: new Date().toISOString(),
    operation: "coding-runtime.tool-bridge",
    source: "opencode-runtime-composition.request-deadline",
    errorClass: "TimeoutError",
    message: "tool-bridge-deadline",
    httpStatus: 408,
    deadlineMs: admission.deadlineMs,
  });
  return { status: 408, body: "" };
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
