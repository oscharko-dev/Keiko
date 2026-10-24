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
  CodingWorkbenchActionClass,
  McpServerDefinition,
  VerificationKind,
} from "@oscharko-dev/keiko-contracts";
import {
  encodeSecureWorkspaceNativeResponse,
  encodeSecureWorkspaceNativeDirectory,
} from "./secureWorkspaceTextReadProtocol.js";
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
  type CodingRuntimePauseResult,
  type CodingRuntimeManagerDeps,
  type OpenCodeLifecycleAdapter,
  type OpenCodeLifecycleSettlement,
  type OpenCodeLifecycleHandshakeRequest,
  type OpenCodeLifecyclePrepareRequest,
  type OpenCodeLifecyclePrepareResult,
} from "./codingRuntimeManager.js";
import type { CodingToolApprovalBridge } from "./codingToolApprovalBridge.js";
import {
  CODING_TOOL_MAX_BODY_BYTES,
  CODING_TOOL_MAX_IN_FLIGHT,
  parseCodingToolRequest,
  type CodingToolActionRequest,
  type CodingToolResult,
} from "./codingToolIpc.js";
import type {
  CodingToolFacade,
  CodingAcceptedInitializationFacet,
  CodingAcceptedInitializationReadPort,
  CodingAcceptedInitializationResult,
  CodingToolFacadeInput,
  CodingToolNativeTextReadFacet,
  CodingToolNativeTextSnapshotResult,
  CodingToolNativeReadInvocations,
  CodingToolNativeReadBeginInput,
  CodingToolNativeReadBeginResult,
  CodingToolNativeReadIdentity,
  CodingToolNativeReadContext,
  CodingToolNativeReadFileIO,
  CodingToolNativeReadFilePacket,
  CodingToolNativeInvocationRefusal,
  CodingToolNativeEffectAdmission,
} from "./codingToolFacadePorts.js";
import {
  codingToolEditPresentation,
  humanDecisionFeedback,
  humanDecisionToolResult,
} from "./codingToolFacade.js";
import { isDenied } from "@oscharko-dev/keiko-workspace";
import {
  isSecureWorkspaceNativeRelativePath,
  isSecureWorkspaceNativeRange,
} from "./secureWorkspaceTextRead.js";
import {
  isCodingSafeActivityPresentationPath,
  type CodingSafeActivityToolPresentation,
} from "@oscharko-dev/keiko-contracts/runtime/coding-safe-activity";
import type { OpenCodeQuestionRequest } from "./opencodeHttpClient.js";
import {
  classifyOpenCodeV2PromptFailure,
  createOpenCodeV2HttpClient,
  parseOpenCodeV2ChildEndpoint,
  type OpenCodeV2HttpClient,
} from "./opencodeV2HttpClient.js";
import { createOpenCodeNativeMessageIdMinter } from "./opencodeNativeMessageId.js";
import {
  createOpenCodeV2HistoryProjection,
  OpenCodeV2HistoryError,
  openCodeV2StepChanges,
  type OpenCodeV2StepChange,
} from "./opencodeV2History.js";
import { recordContextPresentation } from "./codingRuntimeHistory.js";
import {
  recordSessionContinuity,
  type CodingSessionContinuity,
} from "./codingSessionContinuity.js";
import {
  bindContinuedSession,
  retainSettledRun,
  seedContinuation,
  withoutBaseline,
  type RunContinuation,
  type SessionContinuationContext,
} from "./opencodeSessionContinuation.js";
import { isAgentAdmitted, openCodeSelectableAgents } from "./opencodeAgents.js";
import {
  acceptPromptInputs,
  createOpenCodePromptInputsRunPort,
  recordPromptInputs,
  releasePromptInputs,
  reservePromptInputs,
  runtimePromptInputs,
  openCodePromptInputs,
  type AdmittedPromptInputs,
  type OpenCodePromptInputsRunPort,
} from "./opencodePromptInputs.js";
import { createOpenCodeInboxRunPort, type OpenCodeInboxRunPort } from "./opencodeInbox.js";
import {
  commandDisplayText,
  createOpenCodeCommandPresentation,
  createOpenCodeCommandsRunPort,
  recordCommandPostRefused,
  type OpenCodeCommandPresentation,
  type OpenCodeCommandsRunPort,
} from "./opencodeCommands.js";
import {
  beginOpenCodeTurnImages,
  createOpenCodeRevertRunPort,
  noteOpenCodeEditTargets,
  openCodeNativeCallKey,
  openCodeRevertBlocksTurn,
  recordOpenCodeEditSettled,
  recordOpenCodeTurnImage,
  recordRevertTurnBlocked,
  type OpenCodeAgentImages,
  type OpenCodeRevertRun,
  type OpenCodeRevertRunPort,
  type OpenCodeStagedRevert,
} from "./opencodeRevert.js";
import {
  DEFAULT_CODING_WORKBENCH_AGENT,
  type CodingWorkbenchAgent,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import {
  createOpenCodeV2ApprovalRequests,
  type OpenCodeV2ApprovalDecision,
  type OpenCodeV2ApprovalOutcome,
  type ToolBridgeApprovalRejection,
} from "./opencodeV2ApprovalRequests.js";
import { openCodeRuntimeVersionPin } from "./opencodeRuntimeVersions.js";
import {
  decideOpenCodeNativePolicy,
  openCodeNativeEditFiles,
  openCodeNativeVerificationKind,
  parseOpenCodeNativePolicyRequest,
  recordOpenCodeNativePolicyDecision,
  type OpenCodeNativeActionClassification,
  type OpenCodeNativeAuthorityEvidence,
  type OpenCodeNativePolicyDecision,
  type OpenCodeNativePolicyOutcome,
  type OpenCodeNativeSessionRelation,
  type OpenCodeNativePolicyRequest,
  type OpenCodeNativeMcpGrants,
} from "./opencodeNativePolicy.js";
import {
  openCodeNativeMcpAdmission,
  type OpenCodeNativeMcpAdmission,
} from "./opencodeNativeMcp.js";
import { OPENCODE_NATIVE_POLICY_ACTION } from "./opencodeNativePolicyPlugin.js";
import { awaitOpenCodeNativePlugins } from "./opencodeNativePluginReadiness.js";
import { createNativeQuestionPort, type NativeQuestionPort } from "./opencodeNativeQuestions.js";
import {
  classifyNativeSession,
  createNativeTreeStatusPort,
  interruptNativeTree,
  type NativeSessionTreeRun,
} from "./opencodeNativeSessionTree.js";
import { openCodeNativeEgress } from "./opencodeNativeEgress.js";
import {
  OPENCODE_NATIVE_FORMATTER_DISPOSITIONS,
  type OpenCodeNativeFormatterDisposition,
} from "./opencodeNativeFormatter.js";
import type { SidecarPermissionEvent } from "./codingSidecarEventParser.js";
import {
  buildOpenCodeLaunchProfile,
  OPENCODE_GATEWAY_PROVIDER_POLICIES,
  OPENCODE_RUNTIME_READINESS_PROMPT,
  openCodeConfigDirectory,
  openCodePlanDirectory,
} from "./opencodeLaunchProfile.js";
import type {
  OpenCodeContextGeometry,
  OpenCodeLaunchProfileResult,
} from "./opencodeLaunchProfile.js";
import type { CodingRuntimeRepositoryItemsPort } from "./codingRuntimeRepositoryItems.js";
import {
  createGeneratedOpenCodeV2Plugins,
  createOpenCodeRuntimeAdapter,
  type OpenCodeGovernedSinkReceipt,
  type OpenCodeRuntimeAdapter,
  type OpenCodeSyncHint,
  type OpenCodeTurnOutcome,
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
import { type OpenCodeToolProfile, openCodeVisibleToolNames } from "./opencodeToolSchemas.js";
import { recordGovernedToolModelContent } from "./governedToolModelContent.js";
import { processServerLogSink } from "../process-log-sink.js";
import {
  openCodeCatalogAliasFor,
  openCodeCatalogSettlementBudgetMs,
} from "../tool-catalog/catalogToolFacadeBridge.js";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

const SIDECAR_SESSION_BOUND_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.sidecar-session.bound",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.opencodeRuntimeComposition.readinessV2Ports.subscribe",
  fields: {
    binding: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["created", "reused"],
    },
    streamCount: { type: "integer", dataClass: "count", required: true },
    sessionId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 256 },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-session-continuity"],
  proofIds: ["coding-runtime.sidecar-session.bound.emitted-line"],
  releaseImpact: "patch",
});

const CODING_WORKBENCH_AGENT_VALUES = ["build", "plan"] as const;

const CODING_WORKBENCH_MODE_VALUES = [
  "governed-assist",
  "supervised-coding",
  "autonomous-delivery",
] as const;

const NATIVE_NARROWING_REFUSED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.native-narrowing.refused",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.opencodeRuntimeComposition.recordNativeNarrowingRefused",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    launchMode: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["autonomous-delivery", "unknown"],
    },
    requestedMode: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: CODING_WORKBENCH_MODE_VALUES,
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-native-policy"],
  proofIds: ["coding-runtime.native-narrowing.refused.emitted-line"],
  releaseImpact: "patch",
});

const NATIVE_FORMATTER_BOUND_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.native-formatter.bound",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.opencodeRuntimeComposition.recordNativeFormatterBound",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    disposition: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: OPENCODE_NATIVE_FORMATTER_DISPOSITIONS,
    },
    launchMode: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [...CODING_WORKBENCH_MODE_VALUES, "unknown"],
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-native-policy"],
  proofIds: ["coding-runtime.native-formatter.bound.emitted-line"],
  releaseImpact: "patch",
});

const PROVIDER_POLICY_BOUND_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.provider-policy.bound",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.opencodeRuntimeComposition.recordProviderPolicyBound",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    providerPolicy: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["gateway-only", "absent"],
    },
    freeModels: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["disabled", "enabled"],
    },
    modelsFetch: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["disabled", "enabled"],
    },
    toolProfile: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["native", "direct", "code-mode"],
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-native-policy"],
  proofIds: ["coding-runtime.provider-policy.bound.emitted-line"],
  releaseImpact: "patch",
});

const AGENT_SELECTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.agent.selected",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.opencodeRuntimeComposition.recordAgentSelected",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    agent: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: CODING_WORKBENCH_AGENT_VALUES,
    },
    previousAgent: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: CODING_WORKBENCH_AGENT_VALUES,
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-agent-selection"],
  proofIds: ["coding-runtime.agent.selected.emitted-line"],
  releaseImpact: "patch",
});

function v2Record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

const ABORT_SETTLEMENT_TIMEOUT_MS = 30_000;
const INITIAL_TURN_BASELINE_STABILIZATION_MS = 500;
const HISTORY_SYNC_MIN_INTERVAL_MS = 100;

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
  /** Captured server-only observation profile. Absent retains the direct native history contract. */
  readonly toolProfile?: OpenCodeToolProfile | undefined;
  /**
   * The host environment the manager may copy the launch's allowlisted names from (#3897). The
   * mapped profiles allowlist nothing, so they keep launching with an empty inheritance; the native
   * profile inherits the launcher's PATH and locale so the agent's shell finds the project's
   * toolchains the way it does standalone. Absent keeps the empty environment.
   */
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
  /**
   * Admits the workspace's custom agents, commands and skills as sanitized copies in the run's
   * private discovery directory (#3903). Native profile only: the mapped profiles ignore it, and
   * absent leaves the discovery directory exactly as Keiko generated it.
   */
  readonly repositoryItems?: CodingRuntimeRepositoryItemsPort | undefined;
  /**
   * The operator's MCP server registry, read once per native run at launch (#3903,
   * `mcpServerRegistry.ts`); absent admits no MCP server.
   */
  readonly mcpServers?: ((correlationId: string) => readonly McpServerDefinition[]) | undefined;
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
        readonly arm: (sessionId?: string, profile?: OpenCodeToolProfile) => void;
        readonly beginTool?:
          | ((input: {
              readonly actionId: string;
              readonly tool: string;
              readonly occurredAt: string;
            }) => void)
          | undefined;
        readonly clear: () => void;
        readonly ingest: (
          signal: import("./codingSafeActivityProjection.js").CodingSafeActivitySignal,
        ) => boolean;
        readonly recordDrops: (count: number) => void;
        readonly settleTool: (input: {
          readonly actionId: string;
          /** True only when this exact facade request entered its authorized delegate. */
          readonly delegateStarted?: true | undefined;
          readonly state: OpenCodeToolSettlementState;
          readonly occurredAt: string;
          readonly presentation?: CodingSafeActivityToolPresentation;
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
  readonly canSpawnRuntime?: CodingRuntimeManagerDeps["canSpawnRuntime"];
  readonly diagnostics?: ServerDiagnosticSink | undefined;
  readonly activityLog?: ServerLogSink | undefined;
  /**
   * The run's envelope duration (`budget.maxRuntimeMs`), bounding one submitted task's whole agent
   * loop in the adapter (#3873); absent keeps the adapter's default backstop.
   */
  readonly maxTurnWaitMs?: number | undefined;
  /** The run correlation every governed tool result's model-facing rendering is recorded under. */
  readonly toolResultCorrelationId?: string | undefined;
  readonly onRuntimeEvent?: ((event: CodingWorkbenchRuntimeEvent) => void) | undefined;
  readonly onSandboxAttestation?: CodingRuntimeManagerDeps["onSandboxAttestation"];
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
  /**
   * Native session continuity (S02/S03, #3904): the shared service through which the orchestrator
   * asks a run to resume or fork a task's retained session and reads what happened, and the
   * workspace identity a retained entry is bound to. Absent keeps every run on a fresh session.
   */
  readonly sessionContinuity?:
    | {
        readonly service: CodingSessionContinuity;
        readonly workspaceId: string;
      }
    | undefined;
}

type SafeToolSettlement = NonNullable<
  OpenCodeRuntimeCompositionInput["safeActivity"]
>["settleTool"];

export interface OpenCodeToolBridge {
  /** Server-held initial acquisition on the SAME physical-work gate; never a public model tool. */
  readonly acceptedInitialization?: CodingAcceptedInitializationFacet | undefined;
  /** Inactive server-private byte facet; model/HTTP dispatch never selects this surface. */
  readonly nativeTextRead?: CodingToolNativeTextReadFacet | undefined;
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
  readonly nativeBytes?: Uint8Array;
  readonly nativeResult?: true;
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
  /**
   * `agent` selects the primary agent for this and the following turns (`build` or `plan`);
   * absent keeps the run's current agent, `build` until a switch succeeded. A switch is issued
   * once, before the prompt, and only when the agent differs from the run's current one. A refused
   * or failed switch fails the submission: the prompt is never sent under another agent.
   */
  readonly submitTask: (
    runId: string,
    text: string,
    initialContext?: string,
    agent?: CodingWorkbenchAgent,
    inputs?: AdmittedPromptInputs,
  ) => Promise<boolean>;
  /**
   * What a prompt may carry besides its text on this composition's tool profile, and the two
   * operations that honour it (`opencodePromptInputs.ts`): admission before anything is reserved,
   * and the delivery of a `steer` / `queue` message to the turn in flight. Absent means the
   * default: no delivery, no references.
   */
  readonly promptInputs?: OpenCodePromptInputsRunPort["promptInputs"] | undefined;
  readonly admitPromptInputs?: OpenCodePromptInputsRunPort["admitPromptInputs"] | undefined;
  readonly deliverPrompt?: OpenCodePromptInputsRunPort["deliverPrompt"] | undefined;
  /**
   * The run's slash commands (`opencodeCommands.ts`): the listing the Workbench's `/` menu reads, and
   * the confirmation, before a turn is reserved, that the runtime lists the command it names. A
   * turn that runs as a command is submitted through `submitTask` with the command in its inputs.
   */
  readonly listCommands?: OpenCodeCommandsRunPort["listCommands"] | undefined;
  /** The run's subagents and skills for the `@` and `$` menus (S15, #3906). */
  readonly listMentions?: OpenCodeCommandsRunPort["listMentions"] | undefined;
  readonly admitCommand?: OpenCodeCommandsRunPort["admitCommand"] | undefined;
  /**
   * The messages an operator sent into the running turn that the runtime has not handed to the model
   * yet (`opencodeInbox.ts`): the listing, and the withdrawal or promotion of one. Only a profile
   * that takes a delivery offers them; an interrupt withdraws what is still pending.
   */
  readonly listInbox?: OpenCodeInboxRunPort["listInbox"] | undefined;
  readonly actOnInbox?: OpenCodeInboxRunPort["actOnInbox"] | undefined;
  /**
   * The primary agents this composition's tool profile can honour (`openCodeSelectableAgents`):
   * `plan` exists only on the native profile. A request for another agent is refused here.
   */
  readonly selectableAgents?: readonly CodingWorkbenchAgent[] | undefined;
  readonly abortTask: (runId: string) => Promise<boolean>;
  /**
   * Undo and restore of the run's newest turn (B3, S04, `opencodeRevert.ts`): an undo stops the
   * turn in flight, restores the files it changed and keeps the runtime's revert staged; a restore
   * re-applies them. While an undo is staged no new turn is accepted. Only the native profile
   * records snapshots, so only it offers these; absent means the run cannot be undone.
   */
  readonly revertTurn?: OpenCodeRevertRunPort["revertTurn"] | undefined;
  readonly revertState?: OpenCodeRevertRunPort["revertState"] | undefined;
  /**
   * How the armed turn ended (`OpenCodeTurnOutcome`): `true` succeeded, `false` failed or was
   * abandoned, `"interrupted"` the runtime ended it at a human's refusal of a question.
   */
  readonly waitForTerminal: (runId: string, signal: AbortSignal) => Promise<OpenCodeTurnOutcome>;
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
  /**
   * The run's effective autonomy mode: the launch environment's, narrowed when the operator resumes
   * the run with a narrower mode (#3897 audit). Native policy decisions always read this value.
   */
  mode: string | undefined;
  /** The mode the tree was launched with; its kernel egress was bound then and cannot narrow. */
  readonly launchMode: string | undefined;
  /** The MCP tools and servers this run's binding admitted (`opencodeNativeMcp.ts`). */
  mcp?: OpenCodeNativeMcpGrants | undefined;
  readonly password: string;
  readonly configDigest: string;
  readonly verification: PortableSidecarRuntimeVerification;
  readonly observedPermissionIds: Set<string>;
  onPermission?: ((event: SidecarPermissionEvent) => void) | undefined;
  runtimeAdapter?: OpenCodeRuntimeAdapter | undefined;
  client?: OpenCodeV2HttpClient | undefined;
  sessionId?: string | undefined;
  /** Native child sessions (subagents) proven to descend from the run's session (#3897). */
  childSessionIds?: Set<string> | undefined;
  /** What the last question list line counted (`opencodeNativeQuestions.ts`; a line per change). */
  questionList?: { signature?: string | undefined } | undefined;
  /**
   * The primary agent the session runs its next turn under, as of the last successful
   * `session.switchAgent`; absent is the launch profile's default agent, `build` (#3897).
   */
  agent?: CodingWorkbenchAgent | undefined;
  /** What the references of this run's accepted prompts added up to (`opencodePromptInputs.ts`). */
  promptFileBytes?: number | undefined;
  /** How a slash command's turn is shown in the history (`opencodeCommands.ts`). */
  readonly commandPresentation: OpenCodeCommandPresentation;
  /** The retained session this run's database was seeded with (`opencodeSessionContinuation.ts`). */
  continuation?: RunContinuation | undefined;
  /** The undo staged in the runtime, when there is one (`opencodeRevert.ts`). */
  revert?: OpenCodeStagedRevert | undefined;
  /** The newest settled turn's files as it left them (`recordOpenCodeTurnImage`). */
  turnImage?: OpenCodeRevertRun["turnImage"];
  /** What the newest turn's own native edits wrote (`recordOpenCodeEditSettled`). */
  agentImages?: OpenCodeAgentImages | undefined;
  /** Admitted plan-note edits awaiting their settlement (`noteAdmittedEditEvidence`). */
  planNoteEdits?: Set<string> | undefined;
  /** Workspace files each admitted native edit named, by call (`observeNativeStepChanges`). */
  editTargetsByCall?: Map<string, readonly string[]> | undefined;
  /** Calls the policy admitted as project checks (`observeNativeStepChanges`). */
  verificationCalls?: Set<string> | undefined;
  /** Assistant steps whose changed files were already weighed (`observeNativeStepChanges`). */
  seenStepChanges?: Set<string> | undefined;
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
  configured: OpenCodeRuntimeCompositionInput,
): OpenCodeRuntimeComposition {
  const captured = { ...configured };
  const toolProfile = captured.toolProfile ?? "direct";
  openCodeVisibleToolNames(toolProfile);
  const input = { ...captured, toolProfile };
  const runs = new Map<string, PreparedRun>();
  const approvals = createOpenCodeV2ApprovalRequests(input.diagnostics);
  const bridge = createToolBridge(
    {
      capability: input.capabilities.toolFacadeCapability,
      facade: input.toolFacade,
      settleTool: input.safeActivity?.settleTool,
      beginTool: input.safeActivity?.beginTool,
      diagnostics: input.diagnostics,
      renderedResults: renderedResultLog(input),
      resolveWorkspaceRootAccess: input.resolveWorkspaceRootAccess,
      activityLog: input.activityLog ?? processServerLogSink(),
    },
    input.toolBridge,
    input.toolFacadeOrigin,
    { approvals, runs },
  );
  const lifecycle = lifecycleAdapter(input, bridge, runs);
  const manager = withNativeModeNarrowing(
    runs,
    compositionManager(input, lifecycle),
    toolProfile === "native",
    input.activityLog,
  );
  return {
    manager,
    toolBridge: bridge.publicPort,
    runPort: createRunPort(
      runs,
      input.diagnostics,
      input.activityLog,
      approvals,
      openCodeSelectableAgents(toolProfile),
      toolProfile === "native",
      openCodePromptInputs(toolProfile),
    ),
  };
}

function compositionManager(
  input: OpenCodeRuntimeCompositionInput,
  lifecycle: ReturnType<typeof lifecycleAdapter>,
): CodingRuntimeManager {
  return createCodingRuntimeManager({
    supervisor: input.supervisor,
    processEnv: input.processEnv ?? {},
    diagnostics: input.diagnostics,
    openCodeLifecycleAdapter: lifecycle,
    portableRuntimeResolver: () => input.portable,
    canSpawnRuntime: input.canSpawnRuntime,
    ...(input.resolveWorkspaceRootAccess === undefined
      ? {}
      : { resolveWorkspaceRootAccess: input.resolveWorkspaceRootAccess }),
    ...(input.onRuntimeEvent ? { onRuntimeEvent: input.onRuntimeEvent } : {}),
    ...(input.onSandboxAttestation ? { onSandboxAttestation: input.onSandboxAttestation } : {}),
    ...(input.codingToolApprovals === undefined
      ? {}
      : { codingToolApprovals: input.codingToolApprovals }),
    ...input.authorityLifecycle,
  });
}

/**
 * A resume may narrow the run's mode (Supervised workspace to Ask for approval, say); the manager
 * records it, and the native policy must decide with it from the next action on, not with the launch
 * mode. Widening is refused by the manager itself. A native tree launched in Full access keeps the
 * inherited egress the kernel bound at launch, which no later policy can take back (a shell or a
 * Code Mode `fetch` would keep Internet access), so a resume that narrows it below Full access is
 * refused instead of acknowledged with authority the tree still holds (#3897 review).
 */
function withNativeModeNarrowing(
  runs: ReadonlyMap<string, PreparedRun>,
  manager: CodingRuntimeManager,
  native: boolean,
  activityLog: ServerLogSink | undefined,
): CodingRuntimeManager {
  const resume = manager.resume.bind(manager);
  manager.resume = (runId, requestedMode): CodingRuntimePauseResult => {
    const run = runs.get(runId);
    if (native && run !== undefined && narrowsLaunchEgress(run.launchMode, requestedMode)) {
      recordNativeNarrowingRefused(activityLog, runId, run.launchMode, requestedMode);
      return { ok: false, failureCode: "authority-resolution-failed", retryable: false };
    }
    const result = resume(runId, requestedMode);
    if (result.ok && result.effectiveMode !== undefined && run !== undefined)
      run.mode = result.effectiveMode;
    return result;
  };
  return manager;
}

function narrowsLaunchEgress(
  launchMode: string | undefined,
  requestedMode: CodingWorkbenchMode | undefined,
): requestedMode is CodingWorkbenchMode {
  return (
    requestedMode !== undefined &&
    openCodeNativeEgress(launchMode) === "inherited" &&
    openCodeNativeEgress(requestedMode) !== "inherited"
  );
}

function recordNativeNarrowingRefused(
  activityLog: ServerLogSink | undefined,
  runId: string,
  launchMode: string | undefined,
  requestedMode: CodingWorkbenchMode,
): void {
  (activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      NATIVE_NARROWING_REFUSED_OPERATION,
      { level: "warn", correlationId: runId },
      {
        runId,
        launchMode: launchMode === "autonomous-delivery" ? launchMode : "unknown",
        requestedMode,
      },
    ),
  );
}

function createRunPort(
  runs: Map<string, PreparedRun>,
  diagnostics: ServerDiagnosticSink | undefined,
  activityLog: ServerLogSink | undefined,
  approvals: ReturnType<typeof createOpenCodeV2ApprovalRequests>,
  selectableAgents: readonly CodingWorkbenchAgent[],
  snapshots: boolean,
  promptInputs: OpenCodePromptInputsRunPort["promptInputs"],
): OpenCodeRunPort {
  const readyRun = (runId: string): ReadyRun | undefined => {
    const run = runs.get(runId);
    return isReadyRun(run) ? run : undefined;
  };
  const { ports: deliveryPorts, withdrawPendingInbox } = createDeliveryPorts(
    readyRun,
    promptInputs,
    diagnostics,
    activityLog,
  );
  const abortTask = createAbortTask(readyRun, activityLog, withdrawPendingInbox);
  return {
    submitTask: createSubmitTask(readyRun, diagnostics, activityLog, selectableAgents),
    selectableAgents,
    ...createOpenCodeCommandsRunPort({ readyRun, capabilities: promptInputs, activityLog }),
    ...deliveryPorts,
    abortTask,
    ...(snapshots ? createOpenCodeRevertRunPort({ readyRun, abortTask, activityLog }) : {}),
    waitForTerminal: async (runId, signal): Promise<OpenCodeTurnOutcome> => {
      const run = readyRun(runId);
      if (run === undefined) return false;
      const outcome = await run.runtimeAdapter.waitForTerminal(signal);
      if (outcome === false && !signal.aborted)
        recordOpenCodeTurnFailure(diagnostics, run, "terminal");
      // What an undo of this turn must find unchanged, recorded as the turn settled.
      if (snapshots) recordOpenCodeTurnImage(run, activityLog);
      return outcome;
    },
    replyPermission: createReplyPermission(readyRun, diagnostics, approvals),
    ...createQuestionRunPort(readyRun, diagnostics, activityLog),
  };
}

/**
 * The messages an operator sends into a running turn: their admission and delivery
 * (`opencodePromptInputs.ts`) and the list the Workbench shows of the ones the runtime has not taken
 * yet (`opencodeInbox.ts`), both over the one delivery ledger. The interrupt's withdrawal of what is
 * still pending is returned separately: it belongs to the abort, not to the run port's surface.
 */
function createDeliveryPorts(
  readyRun: ReadyRunLookup,
  promptInputs: OpenCodePromptInputsRunPort["promptInputs"],
  diagnostics: ServerDiagnosticSink | undefined,
  activityLog: ServerLogSink | undefined,
): {
  readonly ports: Pick<
    OpenCodeRunPort,
    "promptInputs" | "admitPromptInputs" | "deliverPrompt" | "listInbox" | "actOnInbox"
  >;
  readonly withdrawPendingInbox: OpenCodeInboxRunPort["withdrawPendingInbox"];
} {
  const { nativeInput, withdrawNativeInput, ...prompts } = createOpenCodePromptInputsRunPort({
    readyRun,
    capabilities: promptInputs,
    activityLog,
    recordPostFailure: (runId, error): void => {
      // The message was not accepted; the turn it was meant to join is untouched and keeps running.
      const run = readyRun(runId);
      if (run !== undefined) recordOpenCodeTurnFailure(diagnostics, run, "submit", error);
    },
  });
  const { withdrawPendingInbox, ...inbox } = createOpenCodeInboxRunPort({
    readyRun,
    capabilities: promptInputs,
    activityLog,
    nativeInput,
    withdrawNativeInput,
  });
  return { ports: { ...prompts, ...inbox }, withdrawPendingInbox };
}

function createSubmitTask(
  readyRun: ReadyRunLookup,
  diagnostics: ServerDiagnosticSink | undefined,
  activityLog: ServerLogSink | undefined,
  selectableAgents: readonly CodingWorkbenchAgent[],
): OpenCodeRunPort["submitTask"] {
  return async (runId, text, initialContext, agent, inputs): Promise<boolean> => {
    const run = readyRun(runId);
    // A delivery joins the turn in flight (`deliverPrompt`); it never starts or arms one.
    if (run === undefined || inputs?.delivery !== undefined) return false;
    // A staged undo is finalized by the runtime on the next prompt, which rewrites the history the
    // reconciliation reads append-only; the human restores the undo or stops the run first.
    if (openCodeRevertBlocksTurn(run)) {
      recordRevertTurnBlocked(activityLog, runId);
      return false;
    }
    // Before the baseline is read and the turn armed: a refused agent leaves nothing to undo, and
    // the switch message the runtime records is part of the baseline the turn is measured from.
    if (!(await selectPrimaryAgent(run, agent, selectableAgents, diagnostics, activityLog))) {
      return false;
    }
    if (!(await synchronizeTurnBaseline(run))) return false;
    if (!run.runtimeAdapter.armTurn()) return false;
    // A new turn: what an undo must find unchanged is recorded afresh from here on.
    beginOpenCodeTurnImages(run);
    return postTurnPrompt(run, text, initialContext, inputs, diagnostics, activityLog);
  };
}

/**
 * Runs the turn as one of the runtime's slash commands (`POST /api/session/{sessionID}/command`).
 * The runtime expands its own template around `text` and keeps no caller-supplied message id, and
 * the command body has no field to hide a context in: a command turn is dispatched without an initial
 * context (the orchestrator builds none for it). Its effects pass the run's native policy like any
 * other turn's.
 */
async function postTurnCommand(
  run: ReadyRun,
  name: string,
  text: string,
  inputs: AdmittedPromptInputs,
  diagnostics: ServerDiagnosticSink | undefined,
  activityLog: ServerLogSink | undefined,
): Promise<boolean> {
  if (!reserveTurnInputs(run, inputs, activityLog)) return false;
  run.commandPresentation.arm(commandDisplayText(name, text));
  try {
    await run.client.command(run.sessionId, name, text, undefined, runtimePromptInputs(inputs));
    acceptPromptInputs(activityLog, run, inputs);
    return run.ready;
  } catch (error) {
    releaseUnsentTurnInputs(run, inputs, 1, error);
    run.commandPresentation.disarm();
    recordOpenCodeTurnFailure(diagnostics, run, "submit", error);
    recordCommandPostRefused(activityLog, run.runId, inputs, error);
    run.runtimeAdapter.cancelTurn();
    return false;
  }
}

/**
 * Charges the turn's files to the run before its prompt is sent: once the request has left, the
 * producer may hold them whether or not the acknowledgement arrives (#4064 review). A prompt admitted
 * meanwhile can have left too little of the budget; this turn is then refused, with one body-free
 * line, and cancelled like any other turn whose prompt was not sent.
 */
function reserveTurnInputs(
  run: ReadyRun,
  inputs: AdmittedPromptInputs | undefined,
  activityLog: ServerLogSink | undefined,
): boolean {
  if (inputs === undefined || reservePromptInputs(run, inputs)) return true;
  recordPromptInputs(activityLog, run.runId, inputs, {
    outcome: "refused",
    reason: "references-run-budget",
  });
  run.runtimeAdapter.cancelTurn();
  return false;
}

/**
 * Returns the reservation only when the failure proves the producer holds nothing: its first and
 * only attempt was refused before it was taken. A refusal of a resent attempt may follow one that
 * was stored, so the files stay charged.
 */
function releaseUnsentTurnInputs(
  run: ReadyRun,
  inputs: AdmittedPromptInputs | undefined,
  attempts: number,
  error: unknown,
): void {
  if (inputs === undefined || attempts !== 1) return;
  if (classifyOpenCodeV2PromptFailure(error) === "not-submitted") releasePromptInputs(run, inputs);
}

// What separates a turn's hidden context from the operator's own text in the sent prompt.
const PROMPT_CONTEXT_SEPARATOR = "\n\n";

async function postTurnPrompt(
  run: ReadyRun,
  text: string,
  initialContext: string | undefined,
  inputs: AdmittedPromptInputs | undefined,
  diagnostics: ServerDiagnosticSink | undefined,
  activityLog: ServerLogSink | undefined,
): Promise<boolean> {
  // A turn that is not a command must never take a command's presentation.
  run.commandPresentation.disarm();
  if (inputs?.command !== undefined) {
    return postTurnCommand(run, inputs.command.name, text, inputs, diagnostics, activityLog);
  }
  if (!reserveTurnInputs(run, inputs, activityLog)) return false;
  // One id for the turn's input: a resend after a lost acknowledgement is the same input, never a
  // second one, so a lost reply does not end a turn the runtime already started (#3897 review).
  const id = mintTurnMessageId();
  let attempts = 0;
  const post = (): Promise<void> => {
    attempts += 1;
    return run.client.prompt(
      run.sessionId,
      initialContext === undefined ? text : `${initialContext}${PROMPT_CONTEXT_SEPARATOR}${text}`,
      undefined,
      initialContext === undefined
        ? undefined
        : {
            displayText: text,
            hiddenContextSha256: createHash("sha256").update(initialContext).digest("hex"),
          },
      // A hidden context leads the sent text, so the mentions move by its length and the separator.
      {
        id,
        ...runtimePromptInputs(
          inputs,
          initialContext === undefined
            ? 0
            : initialContext.length + PROMPT_CONTEXT_SEPARATOR.length,
        ),
      },
    );
  };
  try {
    await postOnceMore(post, diagnostics, run);
    if (initialContext !== undefined) recordContextPresentation(activityLog, run.runId);
    if (inputs !== undefined) acceptPromptInputs(activityLog, run, inputs);
    return run.ready;
  } catch (error) {
    releaseUnsentTurnInputs(run, inputs, attempts, error);
    recordOpenCodeTurnFailure(diagnostics, run, "submit", error);
    run.runtimeAdapter.cancelTurn();
    return false;
  }
}

/** The turn prompts' ascending native ids, shared by every run of this process. */
const mintTurnMessageId = createOpenCodeNativeMessageIdMinter();

/**
 * Posts a turn's prompt; a failure after which the runtime may hold the input is resent once with
 * the same id, which the runtime answers with the receipt it holds. A receipt under another id
 * means the input is held under that one: the turn runs. A definite refusal fails the turn.
 */
async function postOnceMore(
  post: () => Promise<void>,
  diagnostics: ServerDiagnosticSink | undefined,
  run: ReadyRun,
): Promise<void> {
  try {
    await post();
    return;
  } catch (error) {
    const failure = classifyOpenCodeV2PromptFailure(error);
    if (failure === "not-submitted") throw error;
    if (failure === "receipt-mismatch") return;
    recordOpenCodeTurnFailure(diagnostics, run, "submit-resent", error);
  }
  try {
    await post();
  } catch (error) {
    if (classifyOpenCodeV2PromptFailure(error) !== "receipt-mismatch") throw error;
  }
}

/**
 * Makes the session run the requested primary agent (#3897). `true` means the next prompt runs under
 * it, or that none was asked for. An agent this composition cannot honour (`plan` on a mapped
 * profile) or a switch the runtime refuses returns `false` with a body-free diagnostic, never a
 * silent fallback to the default: a read-only request must not run as an editing agent. The agent
 * is remembered only after the runtime confirmed the switch, so a failed one is simply re-sent.
 */
async function selectPrimaryAgent(
  run: ReadyRun,
  requested: CodingWorkbenchAgent | undefined,
  selectableAgents: readonly CodingWorkbenchAgent[],
  diagnostics: ServerDiagnosticSink | undefined,
  activityLog: ServerLogSink | undefined,
): Promise<boolean> {
  if (!isAgentAdmitted(selectableAgents, requested)) {
    recordOpenCodeTurnFailure(diagnostics, run, "agent-unsupported");
    return false;
  }
  const current = run.agent ?? DEFAULT_CODING_WORKBENCH_AGENT;
  if (requested === undefined || requested === current) return true;
  try {
    await run.client.switchAgent(run.sessionId, requested);
  } catch (error) {
    recordOpenCodeTurnFailure(diagnostics, run, "agent", error);
    return false;
  }
  run.agent = requested;
  recordAgentSelected(activityLog, run.runId, requested, current);
  return true;
}

function recordAgentSelected(
  activityLog: ServerLogSink | undefined,
  runId: string,
  agent: CodingWorkbenchAgent,
  previousAgent: CodingWorkbenchAgent,
): void {
  activityLog?.write(
    activityLogEvent(
      AGENT_SELECTED_OPERATION,
      { correlationId: runId },
      { runId, agent, previousAgent },
    ),
  );
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
      // A human's denial rejects this one call with its feedback, so the model goes on without it.
      await run.client.replyPermission(
        run.sessionId,
        permission.id,
        reply,
        reply === "reject" ? humanDecisionFeedback("denied") : undefined,
      );
      return run.ready;
    } catch (error) {
      recordOpenCodeTurnFailure(diagnostics, run, "permission", error);
      return false;
    }
  };
}

type OpenCodeTurnFailureStage =
  | "agent"
  | "agent-unsupported"
  | "permission"
  | "question"
  | "submit"
  | "submit-resent"
  | "terminal";

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

function createAbortTask(
  readyRun: ReadyRunLookup,
  activityLog: ServerLogSink | undefined,
  withdrawPendingInbox: OpenCodeInboxRunPort["withdrawPendingInbox"],
): OpenCodeRunPort["abortTask"] {
  return async (runId): Promise<boolean> => {
    const run = readyRun(runId);
    if (run === undefined) return false;
    try {
      // The whole native session tree: a background child keeps running when only the parent is
      // interrupted, and its end would start another turn of the parent (`interruptNativeTree`).
      const stopped = await interruptNativeTree(run.client, nativeSessionTree(run, run.sessionId), {
        signal: AbortSignal.timeout(ABORT_SETTLEMENT_TIMEOUT_MS),
        pause: readinessPollDelay,
        runId: run.runId,
        activityLog,
      });
      if (stopped.settled) {
        await run.runtimeAdapter.waitForTerminal(AbortSignal.timeout(ABORT_SETTLEMENT_TIMEOUT_MS));
        // The runtime keeps the messages it had not taken through an interrupt and would hand them
        // to the model with the next prompt, a turn the operator never meant them for.
        await withdrawPendingInbox(
          runId,
          undefined,
          AbortSignal.timeout(ABORT_SETTLEMENT_TIMEOUT_MS),
        );
      } else {
        run.runtimeAdapter.cancelTurn();
      }
      return stopped.settled && run.ready;
    } catch {
      run.runtimeAdapter.cancelTurn();
      return false;
    }
  };
}

function createQuestionRunPort(
  readyRun: ReadyRunLookup,
  diagnostics: ServerDiagnosticSink | undefined,
  activityLog: ServerLogSink | undefined,
): QuestionRunPort {
  // The run's questions are its own session's and its owned children's (`opencodeNativeQuestions.ts`).
  const portOf = (run: ReadyRun): NativeQuestionPort => {
    run.questionList ??= {};
    return createNativeQuestionPort({
      runId: run.runId,
      client: run.client,
      tree: nativeSessionTree(run, run.sessionId),
      open: () => run.ready,
      activityLog,
      onFailure: (error) => {
        recordOpenCodeTurnFailure(diagnostics, run, "question", error);
      },
      listed: run.questionList,
    });
  };
  return {
    listQuestions: async (runId): Promise<readonly OpenCodeQuestionRequest[]> => {
      const run = readyRun(runId);
      return run === undefined ? [] : portOf(run).list();
    },
    answerQuestion: async (runId, requestId, answers): Promise<boolean> => {
      const run = readyRun(runId);
      return run === undefined ? false : portOf(run).answer(requestId, answers);
    },
    rejectQuestion: async (runId, requestId): Promise<boolean> => {
      const run = readyRun(runId);
      return run === undefined ? false : portOf(run).reject(requestId);
    },
  };
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
    dispose: (runId, signal, settlement): Promise<boolean> =>
      disposeRun(input, bridge, runs, runId, signal, settlement),
  };
}

async function disposeRun(
  input: OpenCodeRuntimeCompositionInput,
  bridge: ToolBridgeController,
  runs: Map<string, PreparedRun>,
  runId: string,
  signal?: AbortSignal,
  settlement?: OpenCodeLifecycleSettlement,
): Promise<boolean> {
  const run = runs.get(runId);
  if (run !== undefined) run.ready = false;
  try {
    const drained = bridge.close(signal);
    input.safeActivity?.clear();
    input.gatewayReadiness.clear(runId);
    if (!(await drained)) return false;
    if (run === undefined) return true;
    if (!currentDisposal(runs, run, signal)) return false;
    await run.runtimeAdapter?.close();
    if (!currentDisposal(runs, run, signal)) return false;
    retainOnDispose(input, run, settlement);
    rmSync(run.runRoot, { recursive: true, force: true });
    runs.delete(runId);
    return true;
  } catch (error) {
    recordCompositionDisposalFailure(input.diagnostics, runId, "run-dispose", error);
    return false;
  }
}

/**
 * The runtime is reaped, so its database is quiescent. A run that settled normally leaves it as its
 * task's retained entry before the private state is removed (`retainSettledRun`); any other run
 * removes the task's now-stale entry. Never throws.
 */
function retainOnDispose(
  input: OpenCodeRuntimeCompositionInput,
  run: PreparedRun,
  settlement: OpenCodeLifecycleSettlement | undefined,
): void {
  const context = continuationContext(input);
  if (context === undefined) return;
  retainSettledRun(
    context,
    {
      runId: run.runId,
      runRoot: run.runRoot,
      workspaceRoot: run.workspaceRoot,
      sessionId: run.sessionId,
    },
    settlement?.terminalStatus,
  );
}

function disposalCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function currentDisposal(
  runs: ReadonlyMap<string, PreparedRun>,
  run: PreparedRun,
  signal: AbortSignal | undefined,
): boolean {
  return !disposalCancelled(signal) && runs.get(run.runId) === run;
}

// KEIKO-0320: the prepare cleanup calls (bridge.close, rmSync) can each throw on their own — a
// permission-denied unlink, a socket teardown failure. Without an inner guard, a throw here
// escapes as an uncaught rejection and the outer manager relabels the resulting timeout as a
// generic retryable failure, discarding the real cause. Guard each cleanup step and emit a
// redacted operator diagnostic when the disposal itself fails (#3099 P2 follow-up: previously
// the failure was silently swallowed, so a permission-error leak left the private run root on
// disk with no diagnostic and no retry hook).
function recordCompositionDisposalFailure(
  diagnostics: ServerDiagnosticSink | undefined,
  runId: string,
  operation: "prepare-bridge-close" | "prepare-run-root-remove" | "run-dispose",
  error: unknown,
): void {
  const detail = describeError(error);
  emitServerDiagnostic(diagnostics, {
    correlationId: runId,
    timestamp: new Date().toISOString(),
    operation: "coding-runtime.opencode-composition",
    source: `opencode-runtime-composition.${operation}`,
    errorClass: contentFreeErrorClass(error),
    message: operation === "run-dispose" ? "server-operation-failed" : operation,
    code: operation,
    ...(detail.frames === undefined ? {} : { frames: detail.frames }),
    ...(detail.causeChain === undefined ? {} : { causeChain: detail.causeChain }),
  });
}

async function disposeFailedPrepare(
  bridge: ToolBridgeController,
  runRoot: string,
  runId: string,
  diagnostics: ServerDiagnosticSink | undefined,
  signal: AbortSignal,
): Promise<void> {
  try {
    if (!(await bridge.close(signal))) {
      recordCompositionDisposalFailure(diagnostics, runId, "prepare-bridge-close", signal.reason);
      return;
    }
  } catch (error) {
    recordCompositionDisposalFailure(diagnostics, runId, "prepare-bridge-close", error);
    return;
  }
  try {
    rmSync(runRoot, { recursive: true, force: true });
  } catch (error) {
    // The private run root may persist on disk; the operator record makes the leak diagnosable.
    recordCompositionDisposalFailure(diagnostics, runId, "prepare-run-root-remove", error);
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
  const continuation = seedRun(input, request, runRoot);
  await bridge.start();
  const { profile, mcp } = runLaunchProfile(input, request, runRoot);
  const config = profile.config;
  materialize(runRoot, config, createGeneratedOpenCodeV2Plugins(input.toolProfile));
  await admitRepositoryItems(input, request, runRoot);
  const password = profile.env.OPENCODE_SERVER_PASSWORD;
  if (password === undefined) throw new Error("password-missing");
  const configDigest = createHash("sha256").update(config, "utf8").digest("hex");
  const result = preparedLaunch(input, bridge, profile.env);
  persistPreparedRun(runs, request, runRoot, password, configDigest, { continuation, mcp });
  recordNativeFormatterBound(input.activityLog, request, profile.formatter);
  recordProviderPolicyBound(input.activityLog, request, profile, input.toolProfile ?? "direct");
  return result;
}

/** The run's launch profile, with the MCP servers the operator's registry admits for it. */
function runLaunchProfile(
  input: OpenCodeRuntimeCompositionInput,
  request: OpenCodeLifecyclePrepareRequest,
  runRoot: string,
): {
  readonly profile: Extract<OpenCodeLaunchProfileResult, { readonly ok: true }>;
  readonly mcp: OpenCodeNativeMcpGrants | undefined;
} {
  const mcp = nativeMcpAdmission(input, request, runRoot);
  const profile = buildOpenCodeLaunchProfile({
    executable: request.executablePath,
    stateRoot: runRoot,
    contextGeometry: input.contextGeometry,
    toolProfile: input.toolProfile,
    mode: request.env.KEIKO_CODING_MODE,
    ...(mcp === undefined ? {} : { mcp: mcp.config }),
  });
  if (!profile.ok) throw new Error("profile-invalid");
  return { profile, mcp: mcp?.grants };
}

/** A native run's MCP servers from the operator's registry; none for a mapped profile. */
function nativeMcpAdmission(
  input: OpenCodeRuntimeCompositionInput,
  request: OpenCodeLifecyclePrepareRequest,
  runRoot: string,
): OpenCodeNativeMcpAdmission | undefined {
  if (input.toolProfile !== "native" || input.mcpServers === undefined) return undefined;
  return openCodeNativeMcpAdmission({
    servers: input.mcpServers(request.runId),
    mode: request.env.KEIKO_CODING_MODE,
    home: join(runRoot, "home"),
  });
}

/** The prepared launch: the profile's environment plus the run's two capabilities. */
function preparedLaunch(
  input: OpenCodeRuntimeCompositionInput,
  bridge: ToolBridgeController,
  env: Readonly<Record<string, string>>,
): {
  readonly ok: true;
  readonly parentLifetime: "stdin-eof";
  readonly env: Readonly<Record<string, string>>;
} {
  return {
    ok: true,
    parentLifetime: "stdin-eof",
    env: {
      ...env,
      KEIKO_MODEL_GATEWAY_CAPABILITY: input.capabilities.modelGatewayCapability,
      KEIKO_TOOL_FACADE_URL: bridge.publicPort.url,
      KEIKO_TOOL_FACADE_CAPABILITY: input.capabilities.toolFacadeCapability,
    },
  };
}

// The copies join the discovery directory before the first launch, so the config digest stays the
// digest of Keiko's own generated document; the admission line carries the copies' own. The port
// never rejects: a run starts without the repository's items rather than failing because of them.
async function admitRepositoryItems(
  input: OpenCodeRuntimeCompositionInput,
  request: OpenCodeLifecyclePrepareRequest,
  runRoot: string,
): Promise<void> {
  if (input.toolProfile !== "native") return;
  await input.repositoryItems?.admitForRun({
    runId: request.runId,
    discoveryRoot: openCodeConfigDirectory(runRoot),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
}

function continuationContext(
  input: OpenCodeRuntimeCompositionInput,
): SessionContinuationContext | undefined {
  const continuity = input.sessionContinuity;
  if (continuity === undefined) return undefined;
  return {
    service: continuity.service,
    workspaceId: continuity.workspaceId,
    native: input.toolProfile === "native",
    runtimeVersion: input.portable.verification.summary.upstreamVersion,
    maxInputTokens: input.contextGeometry.maxInputTokens,
    activityLog: input.activityLog,
  };
}

/** Seeds the run's private runtime database when the run asked to continue a task's session. */
function seedRun(
  input: OpenCodeRuntimeCompositionInput,
  request: OpenCodeLifecyclePrepareRequest,
  runRoot: string,
): RunContinuation | undefined {
  const context = continuationContext(input);
  if (context === undefined) return undefined;
  return seedContinuation(context, {
    runId: request.runId,
    runRoot,
    workspaceRoot: request.env.KEIKO_CODING_WORKSPACE_ROOT ?? "",
  });
}

/** A native run's built-in formatter decision, once per prepared run (parity row C07). */
function recordNativeFormatterBound(
  activityLog: ServerLogSink | undefined,
  request: OpenCodeLifecyclePrepareRequest,
  disposition: OpenCodeNativeFormatterDisposition | undefined,
): void {
  if (disposition === undefined) return;
  const mode = CODING_WORKBENCH_MODE_VALUES.find(
    (value) => value === request.env.KEIKO_CODING_MODE,
  );
  (activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      NATIVE_FORMATTER_BOUND_OPERATION,
      { correlationId: request.runId },
      { runId: request.runId, disposition, launchMode: mode ?? "unknown" },
    ),
  );
}

/**
 * Whether the prepared run admits only the gateway-bound provider, keeps OpenCode's hosted free
 * models off and never fetches the models.dev catalog (parity row S11), read from the launch
 * configuration and environment it was given.
 */
function recordProviderPolicyBound(
  activityLog: ServerLogSink | undefined,
  request: OpenCodeLifecyclePrepareRequest,
  profile: Extract<OpenCodeLaunchProfileResult, { readonly ok: true }>,
  toolProfile: OpenCodeToolProfile,
): void {
  const gatewayOnly =
    JSON.stringify(profile.configValue.policies) ===
    JSON.stringify(OPENCODE_GATEWAY_PROVIDER_POLICIES);
  (activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      PROVIDER_POLICY_BOUND_OPERATION,
      { correlationId: request.runId },
      {
        runId: request.runId,
        providerPolicy: gatewayOnly ? "gateway-only" : "absent",
        freeModels: profile.env.OPENCODE_DISABLE_FREE_MODELS === "1" ? "disabled" : "enabled",
        modelsFetch: profile.env.OPENCODE_DISABLE_MODELS_FETCH === "1" ? "disabled" : "enabled",
        toolProfile,
      },
    ),
  );
}

function persistPreparedRun(
  runs: Map<string, PreparedRun>,
  request: OpenCodeLifecyclePrepareRequest,
  runRoot: string,
  password: string,
  configDigest: string,
  extras: {
    readonly continuation?: RunContinuation | undefined;
    readonly mcp?: OpenCodeNativeMcpGrants | undefined;
  } = {},
): void {
  const { continuation, mcp } = extras;
  const run = preparedRun(
    request.runId,
    runRoot,
    request.env.KEIKO_CODING_WORKSPACE_ROOT ?? "",
    password,
    configDigest,
    request.verification,
    request.env.KEIKO_CODING_MODE,
  );
  if (continuation !== undefined) run.continuation = continuation;
  if (mcp !== undefined) run.mcp = mcp;
  runs.set(request.runId, run);
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
    await disposeFailedPrepare(
      bridge,
      runRoot,
      request.runId,
      input.diagnostics,
      request.signal === undefined
        ? AbortSignal.timeout(request.timeoutMs)
        : AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)]),
    );
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
  mode?: string,
): PreparedRun {
  return {
    runId,
    runRoot,
    workspaceRoot,
    password,
    configDigest,
    verification,
    mode,
    launchMode: mode,
    observedPermissionIds: new Set(),
    commandPresentation: createOpenCodeCommandPresentation(),
    initialTurnBaselineStable: false,
    ready: false,
  };
}

type CompositionSafeActivitySignal =
  import("./codingSafeActivityProjection.js").CodingSafeActivitySignal;

/**
 * The adapter ingests each fresh, committed history signal once. The native profile's tools execute
 * in the original runtime, outside the facade, so its terminal tool signals are also the run's tool
 * evidence (#3873, #3897 review): they reach the facade's native settlement owner, which counts each
 * call once by its identity. Counted whether or not the safe-activity projection accepts the
 * signal; approval never reaches here, only the runtime's own completed or failed call.
 */
function adapterSafeActivitySink(
  input: OpenCodeRuntimeCompositionInput,
  run: PreparedRun,
): Pick<Parameters<typeof createOpenCodeRuntimeAdapter>[0], "safeActivitySink"> {
  const settle = nativeToolSettlementObserver(input, run);
  const activity = input.safeActivity;
  if (activity === undefined && settle === undefined) return {};
  return {
    safeActivitySink: {
      ingest: (signal): boolean => {
        settle?.(signal);
        return activity?.ingest(signal) ?? true;
      },
      recordDrops: (count): void => {
        activity?.recordDrops(count);
      },
    },
  };
}

/** The native tools whose completed call wrote the files its edit check named. */
const NATIVE_FILE_WRITE_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "patch"]);

function nativeToolSettlementObserver(
  input: OpenCodeRuntimeCompositionInput,
  run: PreparedRun,
): ((signal: CompositionSafeActivitySignal) => void) | undefined {
  const settlement = input.toolProfile === "native" ? input.toolFacade.nativeSettlement : undefined;
  if (settlement === undefined) return undefined;
  return (signal): void => {
    if (signal.kind !== "tool" || signal.messageId === undefined) return;
    if (signal.state !== "succeeded" && signal.state !== "failed") return;
    if (signal.state === "succeeded" && NATIVE_FILE_WRITE_TOOLS.has(signal.tool ?? "")) {
      const key = openCodeNativeCallKey(signal.messageId, signal.callId);
      recordOpenCodeEditSettled(run, key, input.activityLog);
    }
    settlement.settled({
      messageId: signal.messageId,
      callId: signal.callId,
      tool: signal.tool,
      state: signal.state,
      ...planNoteSettlement(run, signal.messageId, signal.callId),
      ...(signal.exitCode === undefined ? {} : { exitCode: signal.exitCode }),
      ...(signal.exitStatusCheck === undefined ? {} : { exitStatusCheck: signal.exitStatusCheck }),
    });
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
      maxTurnWaitMs: input.maxTurnWaitMs,
      contextGeometry: input.contextGeometry,
      ...(input.activityLog === undefined ? {} : { activityLog: input.activityLog }),
      readiness: readinessV2Ports(input, bridge, run, client, endpoint, request),
      governedSink: input.governedEventSink,
      ...adapterSafeActivitySink(input, run),
      control: {
        status: createNativeTreeStatusPort({
          runId: run.runId,
          client,
          tree: (sessionId) => nativeSessionTree(run, sessionId),
          activityLog: input.activityLog,
        }),
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
    input.safeActivity?.arm(result.sessionId, input.toolProfile);
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
  let sessionCreation: Promise<string> | undefined;
  let streamCount = 0;
  let startupRead = false;
  // The events the coalescing pump absorbed since the history projection last wrote its line.
  let mergedEvents = 0;
  const history = createOpenCodeV2HistoryProjection({
    toolProfile: input.toolProfile,
    runId: run.runId,
    activityLog: input.activityLog,
    captureMessages: input.safeActivity?.captureMessages,
    userMessageDisplay: run.commandPresentation.displayFor,
    takeMergedEventCount: (): number => {
      const merged = mergedEvents;
      mergedEvents = 0;
      return merged;
    },
  });
  const staged = new Map<
    string,
    import("./codingSafeActivityProjection.js").CodingSafeActivitySignal
  >();
  return {
    verifiedTarget: {
      executable: join(input.portable.resourceRoot, run.verification.executablePath),
      attestationDigest: run.verification.protocolHandshakeDigest,
      version: run.verification.summary.upstreamVersion,
    },
    configDigest: run.configDigest,
    nativeContextProfile: input.toolProfile === "native" ? "native" : "mapped",
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
    ...(input.toolProfile === "native"
      ? {
          policyPluginActive: (): Promise<boolean> =>
            awaitOpenCodeNativePlugins(
              (signal) => client.plugins(signal),
              join(openCodeConfigDirectory(run.runRoot), "plugins"),
              request.signal,
            ),
        }
      : {}),
    gatewayChallenge: () =>
      challengeV2Gateway(input, run, client, fixedSessionId, request, startupRead),
    toolFacadeChallenge: () => challengeToolFacade(input, bridge),
    subscribe: async function* (signal): AsyncIterable<OpenCodeSyncHint> {
      // A reconnect opens another event stream for the same run, not another sidecar session.
      // Keep the creation promise so concurrent subscriptions cannot create competing sessions.
      sessionCreation ??= bindRunSession(input, run, client, request.signal);
      fixedSessionId = await sessionCreation;
      streamCount += 1;
      if (fixedSessionId !== "")
        input.activityLog?.write(
          activityLogEvent(
            SIDECAR_SESSION_BOUND_OPERATION,
            { correlationId: run.runId },
            {
              binding: streamCount === 1 ? "created" : "reused",
              streamCount,
              sessionId: fixedSessionId,
            },
          ),
        );
      // The stream this one replaces missed events while nobody listened. A text or reasoning part it
      // was feeding is not extended by this stream: a gap in the middle of a text would show words
      // the model never wrote in that order. Each such part shows what it has until the history
      // shows it complete (#3873 review, PR #3876).
      if (streamCount > 1) history.freezeLiveText();
      const combined =
        request.signal === undefined ? signal : AbortSignal.any([signal, request.signal]);
      const sessionId = fixedSessionId;
      yield* coalescedSyncHints(
        client.events(combined),
        (event) => {
          // Every event reaches the live text overlay as it arrives, before coalescing can fold it
          // into a hint: the deltas are the content, and only the reads are coalesced.
          history.observeLiveEvent(sessionId, event);
          return v2SyncHint(event, sessionId, input.onQuestionObserved);
        },
        (merged) => {
          mergedEvents += merged;
        },
        HISTORY_SYNC_MIN_INTERVAL_MS,
      );
    },
    history: async (checkpoints, signal): Promise<readonly OpenCodeReconciliationEvent[]> => {
      if (fixedSessionId === undefined) throw new Error("opencode-v2-session-missing");
      let messages: readonly Readonly<Record<string, unknown>>[] = [];
      try {
        messages = await client.messages(fixedSessionId, signal);
        // A continued session already holds the messages of earlier runs, which Coding History has
        // and the timeline must not show again: the projection starts after them.
        const ownMessages = withoutBaseline(messages, run.continuation?.baselineIds);
        const events = history.project(fixedSessionId, ownMessages, checkpoints[fixedSessionId]);
        observeNativeStepChanges(input, run, ownMessages);
        staged.clear();
        for (const event of events) {
          const safe = history.takeSignal(event);
          if (safe !== undefined)
            staged.set(`${event.aggregateId}\u0000${String(event.sequence)}`, safe);
        }
        return events;
      } catch (error) {
        // Stopping the monitor aborts its in-flight read after the final history was captured.
        // The adapter owns that cancellation; it is not a sidecar history failure.
        if (signal.aborted) throw error;
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

function v2ExecutionState(type: unknown): "activity" | "interrupted" | "terminal" | undefined {
  if (type === "session.execution.started") return "activity";
  // The runtime ends a turn this way when a human refuses a question: no idle message follows.
  if (type === "session.execution.interrupted") return "interrupted";
  if (
    type === "session.execution.succeeded" ||
    type === "session.execution.failed" ||
    type === "session.execution.cancelled"
  )
    return "terminal";
  return undefined;
}

function plainSyncHint(hint: OpenCodeSyncHint | undefined): boolean {
  return hint !== undefined && !("id" in hint) && hint.control === undefined;
}

// A plain hint asks for one history read. One already queued covers the new one, and a control
// hint's own read covers every plain hint queued before it; control hints keep their order. Returns
// how many hints the call absorbed, each one a history read it saved: the new hint itself when a
// queued plain hint covered it, or the queued plain hints a control hint's read replaced. Every
// hint is yielded once or absorbed once, so a stream read to its end has as many events as hints
// yielded plus hints absorbed.
function enqueueSyncHint(pending: OpenCodeSyncHint[], hint: OpenCodeSyncHint): number {
  if (plainSyncHint(hint)) {
    if (plainSyncHint(pending.at(-1))) return 1;
    pending.push(hint);
    return 0;
  }
  let absorbed = 0;
  while (plainSyncHint(pending.at(-1))) {
    pending.pop();
    absorbed += 1;
  }
  pending.push(hint);
  return absorbed;
}

/**
 * Lab ledger F2 (#3873): a live turn can emit a runtime event for every streamed token, and every
 * hint costs one full history read, so a burst of events used to queue one read each and the live
 * timeline fell further behind the model the longer it answered. Events are read as they arrive and
 * the hints that pile up while a read runs collapse into one, since the next read sees the whole
 * history anyway; control hints are never dropped and keep their order. A stream failure surfaces
 * on the next pull, after the hints read before it.
 *
 * `onMerged` receives, each time events were absorbed, how many (#3873 review, PR #3876): the
 * evidence that a read stood for more than one event, which the history projection's line carries
 * as `mergedEventCount`. It sees the count only, never an event.
 * Production also spaces plain reads by 100 ms: a fast history response must not turn every
 * streamed delta into another full read. Control hints, source failure and end flush immediately;
 * live text still observes every source event before the hint is coalesced.
 */
export async function* coalescedSyncHints(
  events: AsyncIterable<Readonly<Record<string, unknown>>>,
  toHint: (event: Readonly<Record<string, unknown>>) => OpenCodeSyncHint,
  onMerged?: (mergedEvents: number) => void,
  minimumIntervalMs = 0,
): AsyncGenerator<OpenCodeSyncHint> {
  const pump: SyncHintPump = {
    source: events[Symbol.asyncIterator](),
    toHint,
    onMerged,
    pending: [],
    ended: false,
    stopped: false,
    minimumIntervalMs,
    nextPlainReadAtMs: 0,
    wake: undefined,
  };
  pullSyncHint(pump);
  try {
    // One pull per hint: the wait for the next one is the iterator's own, so no loop body awaits.
    for await (const hint of queuedSyncHints(pump)) yield hint;
  } finally {
    // The read still in flight ends with the caller's abort signal, or closes the source once it
    // resolves; nothing here waits on it.
    pump.stopped = true;
  }
}

// The hints the pump has queued, read one pull at a time. The iterator has no `return`: leaving it
// early closes nothing, because the pump's own source is closed through `stopped` above.
function queuedSyncHints(pump: SyncHintPump): AsyncIterable<OpenCodeSyncHint> {
  return { [Symbol.asyncIterator]: () => ({ next: () => nextQueuedSyncHint(pump) }) };
}

// A queued hint at once; otherwise the failure of the source, which surfaces after every hint read
// before it, or its end; otherwise the next wake, after which the pull starts over. A wake follows
// every hint the pump queues and the end of its source, so a pull waits once, not repeatedly.
async function nextQueuedSyncHint(pump: SyncHintPump): Promise<IteratorResult<OpenCodeSyncHint>> {
  const hint = pump.pending[0];
  const delayMs =
    plainSyncHint(hint) && !pump.ended
      ? Math.max(0, pump.nextPlainReadAtMs - performance.now())
      : 0;
  if (hint !== undefined && delayMs === 0) {
    pump.pending.shift();
    pump.nextPlainReadAtMs = performance.now() + pump.minimumIntervalMs;
    return { done: false, value: hint };
  }
  if (pump.failure !== undefined) throw pump.failure.error;
  if (pump.ended && hint === undefined) return { done: true, value: undefined };
  await waitForSyncHint(pump, delayMs);
  return nextQueuedSyncHint(pump);
}

async function waitForSyncHint(pump: SyncHintPump, delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    pump.wake = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      pump.wake = undefined;
      resolve();
    };
    if (delayMs > 0) timer = setTimeout(() => pump.wake?.(), delayMs);
  });
}

interface SyncHintPump {
  readonly source: AsyncIterator<Readonly<Record<string, unknown>>>;
  readonly toHint: (event: Readonly<Record<string, unknown>>) => OpenCodeSyncHint;
  readonly onMerged: ((mergedEvents: number) => void) | undefined;
  readonly pending: OpenCodeSyncHint[];
  readonly minimumIntervalMs: number;
  nextPlainReadAtMs: number;
  ended: boolean;
  stopped: boolean;
  failure?: { readonly error: unknown };
  wake: (() => void) | undefined;
}

// Reads the next event without waiting for the consumer. A failure is kept for the consumer, who
// receives it on its next pull, after every hint read before it.
function pullSyncHint(pump: SyncHintPump): void {
  const settle = (error?: unknown): void => {
    if (error !== undefined) pump.failure ??= { error };
    pump.ended = true;
    pump.wake?.();
  };
  const onNext = (next: IteratorResult<Readonly<Record<string, unknown>>>): void => {
    if (next.done === true) {
      settle();
      return;
    }
    if (pump.stopped) {
      settle();
      void pump.source.return?.(undefined).then(undefined, settle);
      return;
    }
    const hint = pump.toHint(next.value);
    const absorbed = enqueueSyncHint(pump.pending, hint);
    if (absorbed > 0) pump.onMerged?.(absorbed);
    if (absorbed === 0 || !plainSyncHint(hint)) pump.wake?.();
    pullSyncHint(pump);
  };
  void pump.source.next().then(onNext).then(undefined, settle);
}

export function v2SyncHint(
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

/**
 * The session a run works in: its own new one, or, when its database was seeded from a task's
 * retained entry, the retained session resumed or forked (`bindContinuedSession`). A continued
 * session that cannot be bound to this run's workspace fails the run's readiness: it is never
 * replaced by a fresh one inside a database that still holds the other.
 */
async function bindRunSession(
  input: OpenCodeRuntimeCompositionInput,
  run: PreparedRun,
  client: OpenCodeV2HttpClient,
  signal: AbortSignal | undefined,
): Promise<string> {
  const continuation = run.continuation;
  const context = continuationContext(input);
  if (continuation === undefined || context === undefined) {
    return createAndEchoV2Session(client, run.workspaceRoot, signal);
  }
  const line = continuedSessionLine(context, run, continuation);
  let bound: Awaited<ReturnType<typeof bindContinuedSession>>;
  try {
    bound = await bindContinuedSession(client, continuation, run.workspaceRoot, signal);
  } catch (error) {
    // Not a refusal (the runtime could not be asked, or the run was cancelled): the readiness fails
    // with the error itself, and the continuity line says the session was never bound.
    recordSessionContinuity(input.activityLog, {
      ...line,
      outcome: "failed",
      reason: "session-mismatch",
      error,
    });
    throw error;
  }
  const forked = continuation.intent.kind === "fork";
  if (!bound.ok) {
    // An entry the runtime does not see the way its manifest says can never be used again.
    if (bound.reason === "session-mismatch") context.service.store?.remove(continuation.taskId);
    recordSessionContinuity(input.activityLog, {
      ...line,
      outcome: "failed",
      reason: bound.reason,
      ...(bound.error === undefined ? {} : { error: bound.error }),
    });
    return "";
  }
  continuation.baselineIds = bound.baselineIds;
  context.service.settle(run.runId, { kind: forked ? "forked" : "resumed" });
  recordSessionContinuity(input.activityLog, {
    ...line,
    outcome: forked ? "forked" : "resumed",
    databaseBytes: continuation.databaseBytes,
    messageCount: bound.baselineIds.size,
    ageMs: continuation.ageMs,
  });
  return bound.sessionId;
}

function continuedSessionLine(
  context: SessionContinuationContext,
  run: PreparedRun,
  continuation: RunContinuation,
): Pick<
  Parameters<typeof recordSessionContinuity>[1],
  "runId" | "action" | "taskId" | "sourceTaskId" | "boundary"
> {
  const intent = continuation.intent;
  const taskId = intent.kind === "resume" ? intent.taskId : context.service.taskOfRun(run.runId);
  return {
    runId: run.runId,
    action: intent.kind,
    ...(taskId === undefined ? {} : { taskId }),
    ...(intent.kind === "fork"
      ? { sourceTaskId: intent.sourceTaskId, boundary: intent.boundary.kind }
      : {}),
  };
}

async function createAndEchoV2Session(
  client: OpenCodeV2HttpClient,
  directory: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const created = await client.createSession(directory, signal);
  const id = created.id;
  if (!validCreatedSession(id, created.location, directory) || disposalCancelled(signal)) return "";
  const sessions = await client.sessions(signal);
  const echoed = sessions[0];
  return sessions.length === 1 &&
    echoed?.id === id &&
    v2Record(echoed.location)?.directory === directory &&
    !disposalCancelled(signal)
    ? id
    : "";
}

function validCreatedSession(id: unknown, location: unknown, directory: string): id is string {
  return (
    typeof id === "string" &&
    /^ses_[A-Za-z0-9_-]{1,251}$/u.test(id) &&
    v2Record(location)?.directory === directory
  );
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
  if (run.continuation === undefined) {
    return runGatewayChallenge(input, run, client, sessionId, signal);
  }
  return challengeInScratchSession(input, run, client, signal);
}

/**
 * The gateway recognises its readiness probe only as a request that holds nothing but the probe, so
 * a continued run, whose session holds a conversation, proves the route in a scratch session of its
 * own database and removes it again: the continued session never carries a handshake turn, and the
 * run's database ends up with exactly the one session the run works in.
 */
async function challengeInScratchSession(
  input: OpenCodeRuntimeCompositionInput,
  run: PreparedRun,
  client: OpenCodeV2HttpClient,
  signal: AbortSignal,
): Promise<boolean> {
  let scratchId: string;
  try {
    const created = await client.createSession(run.workspaceRoot, signal);
    if (!validCreatedSession(created.id, created.location, run.workspaceRoot)) {
      throw new Error("opencode-v2-session-invalid");
    }
    scratchId = created.id;
  } catch {
    recordGatewayChallengeFailure(input.diagnostics, run.runId, "scratch-session-failed");
    return false;
  }
  const verified = await runGatewayChallenge(input, run, client, scratchId, signal);
  try {
    await client.removeSession(scratchId, signal);
    return verified;
  } catch {
    recordGatewayChallengeFailure(input.diagnostics, run.runId, "scratch-session-failed");
    return false;
  }
}

async function runGatewayChallenge(
  input: OpenCodeRuntimeCompositionInput,
  run: PreparedRun,
  client: OpenCodeV2HttpClient,
  sessionId: string,
  signal: AbortSignal,
): Promise<boolean> {
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
  | "gateway-refused"
  | "scratch-session-failed";

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
  // The discovered runtime's approved version selects its own producer-derived digests (#3908).
  const pin = openCodeRuntimeVersionPin(candidate.summary.upstreamVersion);
  return (
    candidate === trusted &&
    candidate.summary.status === "verified" &&
    pin !== undefined &&
    candidate.availability.protocolSchemaVerified &&
    candidate.protocolSchemaRawSha256 === pin.rawSchemaSha256 &&
    runtimeField(candidate, "protocolHandshakeAlgorithm") ===
      OPEN_CODE_V2_PROTOCOL_SURFACE_ALGORITHM &&
    candidate.protocolHandshakeDigest === pin.protocolSurfaceSha256
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
  // The plan directory exists before launch: its kernel rule keeps the directories above it
  // from being created or replaced while the run is alive.
  for (const path of [
    openCodeConfigDirectory(runRoot),
    join(openCodeConfigDirectory(runRoot), "plugins"),
    openCodePlanDirectory(runRoot),
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
  const discoveryRoot = openCodeConfigDirectory(runRoot);
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
      statSync(join(openCodeConfigDirectory(runRoot), "opencode.json")).isFile() &&
      readFileSync(join(openCodeConfigDirectory(runRoot), "opencode.json"), "utf8").length > 0
    );
  } catch {
    return false;
  }
}

interface ToolBridgeController {
  readonly publicPort: OpenCodeToolBridge;
  readonly approvals: ReturnType<typeof createOpenCodeV2ApprovalRequests>;
  start(): Promise<void>;
  close(signal?: AbortSignal): Promise<boolean>;
  active(): boolean;
}

interface ToolBridgeLimits {
  readonly requestDeadlineMs: number;
  readonly maxInFlight: number;
}

interface AdmittedToolRequest {
  readonly controller: AbortController;
  nativeReadIdentity?: CodingToolNativeReadIdentity;
  // The deadline this request was admitted under, named by the diagnostic its expiry leaves.
  readonly deadlineMs: number;
  release(): void;
}

interface ToolBridgeAdmissionGate {
  readonly limits: ToolBridgeLimits;
  readonly admit: (requestDeadlineMs: number) => AdmittedToolRequest | undefined;
  readonly abortNativeRead: (identity: CodingToolNativeReadIdentity) => void;
  readonly abortAll: () => void;
  readonly drained: () => boolean;
  readonly drain: (signal: AbortSignal) => Promise<boolean>;
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
  readonly activityLog: ServerLogSink;
  readonly resolveWorkspaceRootAccess: OpenCodeRuntimeCompositionInput["resolveWorkspaceRootAccess"];
  readonly capability: string;
  readonly facade: CodingToolFacade;
  readonly settleTool: SafeToolSettlement | undefined;
  readonly beginTool?: NonNullable<OpenCodeRuntimeCompositionInput["safeActivity"]>["beginTool"];
  readonly diagnostics: ServerDiagnosticSink | undefined;
  readonly renderedResults?: RenderedResultLog | undefined;
}

/** Where a delivered tool result's model-facing rendering is recorded (#3873). */
interface RenderedResultLog {
  readonly sink: ServerLogSink;
  readonly correlationId: string;
}

function renderedResultLog(input: OpenCodeRuntimeCompositionInput): RenderedResultLog | undefined {
  return input.toolResultCorrelationId === undefined
    ? undefined
    : {
        sink: input.activityLog ?? processServerLogSink(),
        correlationId: input.toolResultCorrelationId,
      };
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
  deps: ToolBridgeExecutionDeps,
  configuredLimits: OpenCodeRuntimeCompositionInput["toolBridge"],
  toolFacadeOrigin: string,
  v2: {
    readonly approvals: ReturnType<typeof createOpenCodeV2ApprovalRequests>;
    readonly runs: ReadonlyMap<string, PreparedRun>;
  },
): ToolBridgeController {
  const limits = normalizeToolBridgeLimits(configuredLimits);
  let listening = false;
  let closing: Promise<boolean> | undefined;
  const gate = createToolBridgeAdmissionGate(limits);
  const nativeTextRead = nativeToolBridgeFacet(deps, gate, () => listening);
  const requestContext = { ...v2, nativeRead: nativeTextRead?.invocations };
  const handle: OpenCodeToolBridge["handle"] = (request) =>
    handleDirectToolRequest(listening, deps, gate, request, requestContext);
  const acceptedInitialization = initializationBridgeFacet(deps, gate, () => listening);
  const publicPort: OpenCodeToolBridge = {
    ...(acceptedInitialization === undefined ? {} : { acceptedInitialization }),
    ...(nativeTextRead === undefined ? {} : { nativeTextRead }),
    get url(): string {
      return toolFacadeOrigin;
    },
    requestDeadlineMs: limits.requestDeadlineMs,
    handle,
  };
  return {
    publicPort,
    approvals: v2.approvals,
    active: () => listening,
    start: (): Promise<void> => {
      if (closing !== undefined || !gate.drained()) return Promise.reject(new Error(CLOSE_ABORT));
      listening = true;
      return Promise.resolve();
    },
    close: (signal): Promise<boolean> => {
      listening = false;
      v2.approvals.close();
      gate.abortAll();
      closing ??= gate
        .drain(signal ?? AbortSignal.timeout(limits.requestDeadlineMs))
        .then((drained): boolean => {
          closing = undefined;
          return drained;
        });
      return closing;
    },
  };
}

function nativeToolBridgeFacet(
  deps: ToolBridgeExecutionDeps,
  gate: ToolBridgeAdmissionGate,
  active: () => boolean,
): CodingToolNativeTextReadFacet | undefined {
  const facet = deps.facade.nativeTextRead;
  const producer = facet?.readTextSnapshot.bind(facet);
  if (producer === undefined) return undefined;
  const invocations = nativeInvocationBridgeFacet(deps, gate, active, facet?.invocations);
  return Object.freeze({
    ...(invocations === undefined ? {} : { invocations }),
    readTextSnapshot: (
      input: CodingToolFacadeInput,
    ): Promise<CodingToolNativeTextSnapshotResult> => {
      if (!active()) return Promise.resolve({ ok: false, reason: "dispatch-refused" });
      const { body, capability, headers, signal } = input;
      const ownedBody = nativeToolRequestBody(body, capability, headers, deps.capability);
      if (ownedBody === undefined) return Promise.resolve({ ok: false, reason: "invalid-request" });
      if (signal?.aborted === true) return Promise.resolve({ ok: false, reason: "cancelled" });
      const admission = gate.admit(gate.limits.requestDeadlineMs);
      if (admission === undefined) return Promise.resolve({ ok: false, reason: "busy" });
      const detach = bindExternalAbort(signal, admission);
      return executeNativeToolRequest(deps, producer, ownedBody, admission).finally(detach);
    },
  });
}

function nativeInvocationBridgeFacet(
  deps: ToolBridgeExecutionDeps,
  gate: ToolBridgeAdmissionGate,
  active: () => boolean,
  supplied: CodingToolNativeReadInvocations | undefined,
): CodingToolNativeReadInvocations | undefined {
  if (supplied === undefined) return undefined;
  const fileIO = captureBridgeNativeFileIO(supplied.fileIO);
  const producer = Object.freeze({
    begin: supplied.begin.bind(supplied),
    readTextSnapshot: supplied.readTextSnapshot.bind(supplied),
    signalFor: supplied.signalFor.bind(supplied),
    close: supplied.close.bind(supplied),
  });
  return Object.freeze({
    ...(fileIO === undefined ? {} : { fileIO: bridgeNativeFileIO(deps, active, producer, fileIO) }),
    begin: (input): Promise<CodingToolNativeReadBeginResult> =>
      beginNativeBridgeInvocation(deps, gate, active, producer, input),
    signalFor: producer.signalFor,
    readTextSnapshot: (identity, input): Promise<CodingToolNativeTextSnapshotResult> =>
      boundedNativeInvocationCall(deps, active, producer, identity, () =>
        producer.readTextSnapshot(identity, input),
      ),
    close: (identity, outcome): Promise<boolean> =>
      closeNativeBridgeInvocation(deps, gate, active, producer, identity, outcome),
  } satisfies CodingToolNativeReadInvocations);
}

function captureBridgeNativeFileIO(
  selected: CodingToolNativeReadFileIO | undefined,
): CodingToolNativeReadFileIO | undefined {
  return selected === undefined
    ? undefined
    : Object.freeze({
        readBytes: selected.readBytes.bind(selected),
        stat: selected.stat.bind(selected),
        list: selected.list.bind(selected),
      });
}

function bridgeNativeFileIO(
  deps: ToolBridgeExecutionDeps,
  active: () => boolean,
  producer: CodingToolNativeReadInvocations,
  io: CodingToolNativeReadFileIO,
): CodingToolNativeReadFileIO {
  return Object.freeze({
    readBytes: (identity, input) =>
      boundedNativeInvocationCall(deps, active, producer, identity, () =>
        io.readBytes(identity, input),
      ),
    stat: (identity, input) =>
      boundedNativeInvocationCall(deps, active, producer, identity, () => io.stat(identity, input)),
    list: (identity, input) =>
      boundedNativeInvocationCall(deps, active, producer, identity, () => io.list(identity, input)),
  } satisfies CodingToolNativeReadFileIO);
}

async function closeNativeBridgeInvocation(
  deps: ToolBridgeExecutionDeps,
  gate: ToolBridgeAdmissionGate,
  active: () => boolean,
  producer: CodingToolNativeReadInvocations,
  identity: CodingToolNativeReadIdentity,
  outcome: "completed" | "failed" | "cancelled",
): Promise<boolean> {
  try {
    if (!active() || producer.signalFor(identity) === undefined) return false;
    if (outcome !== "completed") gate.abortNativeRead(identity);
    // The canonical terminal promise is already deadline/cancellation bounded. Its successful
    // settlement aborts the registry's signal too; racing that signal would fabricate failure.
    return await producer.close(identity, outcome);
  } catch (error) {
    emitFacadeFailureDiagnostic(deps.diagnostics, identity.actionId, error);
    return false;
  }
}

async function boundedNativeInvocationCall<Result>(
  deps: ToolBridgeExecutionDeps,
  active: () => boolean,
  producer: CodingToolNativeReadInvocations,
  identity: CodingToolNativeReadIdentity,
  execute: () => Promise<Result>,
): Promise<Result | CodingToolNativeInvocationRefusal> {
  const refused = { ok: false as const, reason: "dispatch-refused" as const };
  let signal: AbortSignal | undefined;
  try {
    if (!active()) return refused;
    signal = producer.signalFor(identity);
    if (signal === undefined || signal.aborted) return refused;
    const work = execute();
    return await raceAbort(work, signal);
  } catch (error) {
    if (signal?.aborted === true) return { ok: false, reason: "cancelled" };
    emitFacadeFailureDiagnostic(deps.diagnostics, identity.actionId, error);
    return refused;
  }
}

async function beginNativeBridgeInvocation(
  deps: ToolBridgeExecutionDeps,
  gate: ToolBridgeAdmissionGate,
  active: () => boolean,
  producer: CodingToolNativeReadInvocations,
  input: CodingToolNativeReadBeginInput,
): Promise<CodingToolNativeReadBeginResult> {
  if (!active()) return { ok: false, reason: "dispatch-refused" };
  const ownedInput = prepareNativeBridgeBeginInput(deps, input);
  if (ownedInput === undefined) return { ok: false, reason: "invalid-request" };
  const { signal } = ownedInput;
  const ownedBody = ownedInput.body;
  if (signal?.aborted === true) return { ok: false, reason: "cancelled" };
  const admission = gate.admit(gate.limits.requestDeadlineMs);
  if (admission === undefined) return { ok: false, reason: "busy" };
  const detach = bindExternalAbort(signal, admission);
  const work = callNativeReadBegin(producer, {
    ...ownedInput,
    body: ownedBody,
    capability: deps.capability,
    signal: admission.controller.signal,
  });
  const physicalWork = work.then(async (result): Promise<void> => {
    if (result.ok) await result.settled;
  });
  releaseAdmissionWhenSettled(physicalWork, admission);
  void physicalWork.then(detach, detach);
  try {
    const result = await raceAbort(work, admission.controller.signal);
    if (!result.ok) return result;
    admission.nativeReadIdentity = Object.freeze({ ...result.identity });
    return {
      ...result,
      settled: physicalWork.then((): void => {
        admission.release();
      }),
    };
  } catch (error) {
    const actionId = parseCodingToolRequest(ownedBody, CODING_TOOL_MAX_BODY_BYTES)?.actionId;
    if (!admission.controller.signal.aborted)
      emitFacadeFailureDiagnostic(deps.diagnostics, actionId, error);
    return {
      ...nativeToolAbortResult(deps, actionId, admission),
      ok: false,
    } as CodingToolNativeReadBeginResult;
  }
}

function prepareNativeBridgeBeginInput(
  deps: ToolBridgeExecutionDeps,
  input: CodingToolNativeReadBeginInput,
): (CodingToolNativeReadBeginInput & { readonly body: string }) | undefined {
  try {
    const owned = ownNativeBridgeBeginInput(input);
    if (owned === undefined) return undefined;
    const body = privateNativeToolBody(
      owned.body,
      owned.capability,
      owned.headers,
      deps.capability,
    );
    return body === undefined ? undefined : { ...owned, body };
  } catch (error) {
    emitFacadeFailureDiagnostic(deps.diagnostics, undefined, error);
    return undefined;
  }
}

function ownNativeBridgeBeginInput(
  input: CodingToolNativeReadBeginInput,
): CodingToolNativeReadBeginInput | undefined {
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const allowed = new Set([
    "body",
    "capability",
    "headers",
    "signal",
    "context",
    "offset",
    "limit",
  ]);
  const owned: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowed.has(key)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    owned[key] = descriptor.value;
  }
  if (!nativeBridgeBeginValues(owned.body, owned.capability, owned.signal)) return undefined;
  return owned as unknown as CodingToolNativeReadBeginInput;
}

function nativeBridgeBeginValues(body: unknown, capability: unknown, signal: unknown): boolean {
  return (
    (typeof body === "string" || Buffer.isBuffer(body)) &&
    (capability === undefined || typeof capability === "string") &&
    (signal === undefined || signal instanceof AbortSignal)
  );
}

async function callNativeReadBegin(
  producer: CodingToolNativeReadInvocations,
  input: CodingToolNativeReadBeginInput,
): Promise<CodingToolNativeReadBeginResult> {
  return producer.begin(input);
}

function nativeToolRequestBody(
  body: CodingToolFacadeInput["body"],
  capability: string | undefined,
  headers: CodingToolFacadeInput["headers"],
  ownedCapability: string,
): string | undefined {
  const ownedBody = privateNativeToolBody(body, capability, headers, ownedCapability);
  if (ownedBody === undefined) return undefined;
  const request = parseCodingToolRequest(ownedBody, CODING_TOOL_MAX_BODY_BYTES);
  return request?.action === "read" &&
    request.startLine === undefined &&
    request.maxLines === undefined
    ? ownedBody
    : undefined;
}

function privateNativeToolBody(
  body: CodingToolFacadeInput["body"],
  capability: string | undefined,
  headers: CodingToolFacadeInput["headers"],
  ownedCapability: string,
): string | undefined {
  if (
    headers !== undefined ||
    (capability !== undefined && !safeEqual(capability, ownedCapability))
  )
    return undefined;
  if (Buffer.byteLength(body) > CODING_TOOL_MAX_BODY_BYTES) return undefined;
  return typeof body === "string" ? body : body.toString("utf8");
}

async function executeNativeToolRequest(
  deps: ToolBridgeExecutionDeps,
  producer: CodingToolNativeTextReadFacet["readTextSnapshot"],
  body: string,
  admission: AdmittedToolRequest,
): Promise<CodingToolNativeTextSnapshotResult> {
  const signal = admission.controller.signal;
  const work = Promise.resolve().then(() =>
    signal.aborted
      ? { ok: false as const, reason: "cancelled" as const }
      : producer({ body, capability: deps.capability, signal }),
  );
  releaseAdmissionWhenSettled(work, admission);
  const actionId = parseCodingToolRequest(body, CODING_TOOL_MAX_BODY_BYTES)?.actionId;
  try {
    const result = await raceAbort(work, signal);
    return signal.aborted ? nativeToolAbortResult(deps, actionId, admission) : result;
  } catch (error) {
    if (signal.aborted) return nativeToolAbortResult(deps, actionId, admission);
    emitFacadeFailureDiagnostic(deps.diagnostics, actionId, error);
    return { ok: false, reason: "dispatch-refused" };
  }
}

function nativeToolAbortResult(
  deps: ToolBridgeExecutionDeps,
  actionId: string | undefined,
  admission: AdmittedToolRequest,
): CodingToolNativeTextSnapshotResult {
  if (abortReason(admission.controller.signal) !== DEADLINE_ABORT)
    return { ok: false, reason: "cancelled" };
  emitToolBridgeDeadlineDiagnostic(deps.diagnostics, actionId, admission);
  return { ok: false, reason: "timeout" };
}

function handleDirectToolRequest(
  active: boolean,
  deps: ToolBridgeExecutionDeps,
  gate: ToolBridgeAdmissionGate,
  input: Parameters<OpenCodeToolBridge["handle"]>[0],
  context: {
    readonly approvals: ReturnType<typeof createOpenCodeV2ApprovalRequests>;
    readonly runs: ReadonlyMap<string, PreparedRun>;
    readonly nativeRead: CodingToolNativeReadInvocations | undefined;
  },
): Promise<OpenCodeToolBridgeResponse> {
  const { approvals, runs, nativeRead } = context;
  const preflight = preflightToolRequest(active, deps.capability, input.headers, input.body);
  if (preflight.outcome === "rejected") {
    return Promise.resolve({ status: preflight.status, body: preflight.body });
  }
  const read = nativeReadTransportValue(input.body);
  if (read !== undefined)
    return handleNativeReadTransport(read, input.signal, deps, runs, nativeRead);
  const permission = parseV2PermissionRequest(input.body);
  if (permission !== undefined) {
    return handleV2PermissionRequest(permission, input.signal, deps, approvals, runs);
  }
  const nativePolicy = parseNativePolicyBody(input.body);
  if (nativePolicy !== undefined) {
    return handleNativePolicyRequest(nativePolicy, input.signal, deps, approvals, runs);
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

function parseNativePolicyBody(body: string): OpenCodeNativePolicyRequest | undefined {
  if (!validJson(body)) return undefined;
  const parsed: unknown = JSON.parse(body);
  return v2Record(parsed)?.action === OPENCODE_NATIVE_POLICY_ACTION
    ? parseOpenCodeNativePolicyRequest(parsed)
    : undefined;
}

/**
 * The native permission hook's question (#3897): what is the final effect of this evaluated
 * OpenCode action for this run? The server-owned policy answers allow or deny at once, or puts the
 * action to the human through the run's approval lane and answers with the decision. Every answer
 * leaves a body-free line; an unready run, a foreign session or a malformed ask is refused.
 */
async function handleNativePolicyRequest(
  request: OpenCodeNativePolicyRequest,
  signal: AbortSignal | undefined,
  deps: ToolBridgeExecutionDeps,
  approvals: ReturnType<typeof createOpenCodeV2ApprovalRequests>,
  runs: ReadonlyMap<string, PreparedRun>,
): Promise<OpenCodeToolBridgeResponse> {
  const run = runs.get(request.runId);
  const sessionRelation =
    run?.ready === true
      ? await nativeSessionRelation(run, request.sessionID, signal, deps.diagnostics)
      : undefined;
  if (run?.ready !== true || sessionRelation === undefined) {
    return { status: 403, body: "", rejection: "approval-unavailable" };
  }
  const decision = decideOpenCodeNativePolicy({
    mode: run.mode,
    workspaceRoot: run.workspaceRoot,
    planRoot: openCodePlanDirectory(run.runRoot),
    request,
    nowMs: Date.now(),
    ...(run.mcp === undefined ? {} : { mcp: run.mcp }),
  });
  const settled = await settleNativePolicyOutcome(run, decision, request, signal, deps, {
    approvals,
    sessionRelation,
  });
  const { outcome } = settled;
  if (outcome !== "allowed" && outcome !== "approved") noteNativeCallRefused(deps, request);
  recordOpenCodeNativePolicyDecision(deps.activityLog, run.runId, {
    mode: run.mode,
    request,
    decision,
    outcome,
    sessionRelation,
    ...(settled.authority === undefined ? {} : { authority: settled.authority }),
  });
  return nativePolicyResult(outcome, decision);
}

// A refused call ends as a failed tool in the runtime's history; the run's effort evidence reads it
// as a refusal rather than a failure of the tool itself.
function noteNativeCallRefused(
  deps: ToolBridgeExecutionDeps,
  request: OpenCodeNativePolicyRequest,
): void {
  if (request.source === undefined) return;
  deps.facade.nativeSettlement?.refused({
    messageId: request.source.messageID,
    callId: request.source.id,
  });
}

function nativePolicyResult(
  outcome: OpenCodeNativePolicyOutcome,
  decision: OpenCodeNativePolicyDecision,
): OpenCodeToolBridgeResponse {
  if (outcome === "allowed" || outcome === "approved") return nativePolicyResponse("allow");
  if (outcome === "authority-refused" || outcome === "cancelled")
    return nativePolicyResponse("deny", NATIVE_AUTHORITY_REFUSED_MESSAGE);
  if (decision.effect === "deny") return nativePolicyResponse("deny", decision.message);
  return nativePolicyResponse(
    "deny",
    humanDecisionFeedback(outcome === "denied" ? "denied" : "expired"),
  );
}

const NATIVE_AUTHORITY_REFUSED_MESSAGE =
  "Keiko refused this action: the run's authority is no longer valid or its budget is exhausted.";

/**
 * The policy's answer, revalidated against live authority before an effect is released (#3897
 * review): an already-aborted ask is cancelled, and an allowed or human-approved action is
 * admitted through the facade's native-effect owner, which authenticates the capability, requires
 * the run to be running on its tree binding, checks the envelope's action classes and charges the
 * run's tool-call budget once per original tool invocation, reads included. A wiring without that
 * owner refuses every effect.
 */
async function settleNativePolicyOutcome(
  run: PreparedRun,
  decision: OpenCodeNativePolicyDecision,
  request: OpenCodeNativePolicyRequest,
  signal: AbortSignal | undefined,
  deps: ToolBridgeExecutionDeps,
  context: {
    readonly approvals: ReturnType<typeof createOpenCodeV2ApprovalRequests>;
    readonly sessionRelation: OpenCodeNativeSessionRelation;
  },
): Promise<NativePolicySettlement> {
  const { approvals, sessionRelation } = context;
  if (signal?.aborted === true) return { outcome: "cancelled" };
  if (decision.effect === "deny") return { outcome: decision.reason };
  const outcome: OpenCodeNativePolicyOutcome =
    decision.effect === "ask"
      ? await nativePolicyHumanDecision(run, decision, signal, deps, approvals)
      : "allowed";
  noteDeniedVerification(deps, request, outcome);
  if (outcome !== "allowed" && outcome !== "approved") return { outcome };
  const admission = nativeEffectAdmission(
    deps,
    decision.classification.actionClass,
    request,
    signal,
  );
  if (!admission.ok)
    return { outcome: "authority-refused", authority: { reason: admission.reason } };
  noteAdmittedEditTargets(run, request);
  noteAdmittedEditEvidence(run, request, decision.classification, { deps, sessionRelation });
  noteAdmittedVerification(run, deps, request);
  return { outcome, authority: { charge: admission.charge } };
}

/** A human refused a project check: the run's verification is blocked, as for the governed one. */
function noteDeniedVerification(
  deps: ToolBridgeExecutionDeps,
  request: OpenCodeNativePolicyRequest,
  outcome: OpenCodeNativePolicyOutcome,
): void {
  if (outcome === "denied" && nativeVerificationKind(request) !== undefined)
    deps.facade.nativeSettlement?.verificationDenied?.();
}

/** The project check an admitted native shell call runs, if it is one (#3901). */
function nativeVerificationKind(
  request: OpenCodeNativePolicyRequest,
): VerificationKind | undefined {
  return request.permission === "shell"
    ? openCodeNativeVerificationKind(request.resources)
    : undefined;
}

/** An admitted verification command, so its exit status can become the run's evidence (#3901). */
function noteAdmittedVerification(
  run: PreparedRun,
  deps: ToolBridgeExecutionDeps,
  request: OpenCodeNativePolicyRequest,
): void {
  const kind = nativeVerificationKind(request);
  if (kind === undefined || request.source === undefined) return;
  run.verificationCalls ??= new Set();
  rememberKey(
    run.verificationCalls,
    openCodeNativeCallKey(request.source.messageID, request.source.id),
  );
  deps.facade.nativeSettlement?.verificationAdmitted?.(
    { messageId: request.source.messageID, callId: request.source.id },
    kind,
  );
}

/** The most admitted plan-note edits a run remembers until the runtime reports them settled. */
const PLAN_NOTE_EDITS_MAX = 256;

/**
 * What an admitted native edit means for the run's verification evidence (#3901). The plan agent's
 * notes in the run's private plan directory are planning: the policy classifies that edit as a
 * read, and its settlement does not count as a workspace edit. A workspace edit of a child session
 * is settled on the child, whose history the run does not read, so it counts from its admission.
 */
function noteAdmittedEditEvidence(
  run: PreparedRun,
  request: OpenCodeNativePolicyRequest,
  classification: OpenCodeNativeActionClassification,
  context: {
    readonly deps: ToolBridgeExecutionDeps;
    readonly sessionRelation: OpenCodeNativeSessionRelation;
  },
): void {
  if (request.permission !== "edit" || request.source === undefined) return;
  if (classification.actionClass === "workspace-read") {
    rememberPlanNoteEdit(run, openCodeNativeCallKey(request.source.messageID, request.source.id));
    return;
  }
  if (context.sessionRelation === "child") context.deps.facade.nativeSettlement?.unsettledEdit?.();
}

function rememberPlanNoteEdit(run: PreparedRun, key: string): void {
  run.planNoteEdits ??= new Set();
  const notes = run.planNoteEdits;
  notes.add(key);
  if (notes.size > PLAN_NOTE_EDITS_MAX) notes.delete(notes.values().next().value ?? "");
}

/** A settled plan-note edit is no workspace edit; every other call keeps its tool's meaning. */
function planNoteSettlement(
  run: PreparedRun,
  messageId: string,
  callId: string,
): { readonly workspaceEdit?: false } {
  return run.planNoteEdits?.delete(openCodeNativeCallKey(messageId, callId)) === true
    ? { workspaceEdit: false }
    : {};
}

/** An admitted native edit's targets, so its settlement can record what the turn itself wrote. */
function noteAdmittedEditTargets(run: PreparedRun, request: OpenCodeNativePolicyRequest): void {
  if (request.source === undefined) return;
  const key = openCodeNativeCallKey(request.source.messageID, request.source.id);
  const files = openCodeNativeEditFiles(request, run.workspaceRoot);
  noteOpenCodeEditTargets(run, key, files);
  if (files.length === 0) return;
  run.editTargetsByCall ??= new Map();
  const targets = run.editTargetsByCall;
  targets.delete(key);
  targets.set(key, files);
  if (targets.size > STEP_EVIDENCE_MAX) targets.delete(targets.keys().next().value ?? "");
}

/** The most call and step facts a run remembers for its verification evidence. */
const STEP_EVIDENCE_MAX = 1024;

function rememberKey(keys: Set<string>, key: string): void {
  keys.delete(key);
  keys.add(key);
  if (keys.size > STEP_EVIDENCE_MAX) keys.delete(keys.values().next().value ?? "");
}

type NativeStepOutcome = "counted" | "covered" | "verification-only";

/**
 * The workspace files a finished native step changed, weighed against the run's verification
 * evidence once per step (#3901). A file a native edit of the same step named is that edit's, which
 * its own settlement already counted; anything else (a shell command's or a child session's writes)
 * is a change no settlement reported, so it is the run's edit and a check must follow it. A step of
 * project checks alone changed only what the checks themselves write. The step is weighed when the
 * history shows it finished, before that read's tool settlements reach the ledger, so a check in a
 * later step still proves it.
 */
function observeNativeStepChanges(
  input: OpenCodeRuntimeCompositionInput,
  run: PreparedRun,
  messages: readonly Readonly<Record<string, unknown>>[],
): void {
  const settlement = input.toolProfile === "native" ? input.toolFacade.nativeSettlement : undefined;
  if (settlement?.unsettledEdit === undefined) return;
  run.seenStepChanges ??= new Set();
  const seen = run.seenStepChanges;
  for (const change of openCodeV2StepChanges(messages)) {
    if (seen.has(change.messageId)) continue;
    rememberKey(seen, change.messageId);
    const weighed = weighStepChange(run, change);
    if (weighed.outcome === "counted") settlement.unsettledEdit();
    recordNativeStepChanged(input.activityLog, run.runId, change, weighed);
  }
}

function weighStepChange(
  run: PreparedRun,
  change: OpenCodeV2StepChange,
): { readonly outcome: NativeStepOutcome; readonly uncoveredCount: number } {
  const keys = change.callIds.map((callId) => openCodeNativeCallKey(change.messageId, callId));
  if (keys.length > 0 && keys.every((key) => run.verificationCalls?.has(key) === true))
    return { outcome: "verification-only", uncoveredCount: 0 };
  const covered = new Set(keys.flatMap((key) => run.editTargetsByCall?.get(key) ?? []));
  const uncoveredCount =
    change.files.filter((file) => !covered.has(file)).length + (change.truncated ? 1 : 0);
  return { outcome: uncoveredCount > 0 ? "counted" : "covered", uncoveredCount };
}

const NATIVE_STEP_CHANGED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.native-step.changed",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.opencodeRuntimeComposition.recordNativeStepChanged",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["counted", "covered", "verification-only"],
    },
    fileCount: { type: "integer", dataClass: "count", required: true },
    uncoveredCount: { type: "integer", dataClass: "count", required: true },
    callCount: { type: "integer", dataClass: "count", required: true },
    fileList: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["complete", "truncated"],
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-native-policy"],
  proofIds: ["coding-runtime.native-step.changed.emitted-line"],
  releaseImpact: "patch",
});

/** One body-free line per weighed step: what it changed and whether it counts as the run's edit. */
function recordNativeStepChanged(
  activityLog: ServerLogSink | undefined,
  runId: string,
  change: OpenCodeV2StepChange,
  weighed: { readonly outcome: NativeStepOutcome; readonly uncoveredCount: number },
): void {
  (activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      NATIVE_STEP_CHANGED_OPERATION,
      { correlationId: runId },
      {
        runId,
        outcome: weighed.outcome,
        fileCount: change.files.length,
        uncoveredCount: weighed.uncoveredCount,
        callCount: change.callIds.length,
        fileList: change.truncated ? "truncated" : "complete",
      },
    ),
  );
}

interface NativePolicySettlement {
  readonly outcome: OpenCodeNativePolicyOutcome;
  readonly authority?: OpenCodeNativeAuthorityEvidence;
}

function nativeEffectAdmission(
  deps: ToolBridgeExecutionDeps,
  actionClass: CodingWorkbenchActionClass,
  request: OpenCodeNativePolicyRequest,
  signal: AbortSignal | undefined,
): CodingToolNativeEffectAdmission {
  if (signal?.aborted === true) return { ok: false, reason: "unavailable" };
  const { source, patchBytes } = request;
  return (
    deps.facade.nativeEffect?.admit({
      capability: deps.capability,
      actionClass,
      ...(patchBytes === undefined ? {} : { patchBytes }),
      ...(source === undefined
        ? {}
        : {
            invocation: {
              sessionId: request.sessionID,
              messageId: source.messageID,
              callId: source.id,
            },
          }),
    }) ?? { ok: false, reason: "unavailable" }
  );
}

/**
 * Which native session asked: the run's own session, or a child session the original runtime
 * created under it (a subagent, #3897 review). The run's session tree decides
 * (`opencodeNativeSessionTree.ts`): a child is admitted once its `parentID` chain reaches the run's
 * session within a bounded depth and every session on the chain is located in the run's workspace;
 * the proof is read from the runtime's own session list and cached. Any other session, a failed
 * read or a full cache refuses the ask.
 */
async function nativeSessionRelation(
  run: PreparedRun,
  sessionID: string,
  signal: AbortSignal | undefined,
  diagnostics: ServerDiagnosticSink | undefined,
): Promise<OpenCodeNativeSessionRelation | undefined> {
  if (run.sessionId === undefined || run.client === undefined) return undefined;
  try {
    return await classifyNativeSession(
      run.client,
      nativeSessionTree(run, run.sessionId),
      sessionID,
      signal,
    );
  } catch (error) {
    // A failed read proves no ancestry, so the ask is refused; the failure itself is recorded
    // body-free under the run's correlation.
    emitServerDiagnostic(diagnostics, {
      correlationId: run.runId,
      timestamp: new Date().toISOString(),
      operation: "coding-runtime.tool-bridge",
      source: "opencode-runtime-composition.native-session-ancestry",
      errorClass: contentFreeErrorClass(error),
      message: "native-session-ancestry-failed",
    });
    return undefined;
  }
}

/** The run's session tree, sharing the run's admission cache of proven children. */
function nativeSessionTree(
  run: Pick<PreparedRun, "workspaceRoot" | "childSessionIds">,
  sessionId: string,
): NativeSessionTreeRun {
  run.childSessionIds ??= new Set();
  return { sessionId, workspaceRoot: run.workspaceRoot, children: run.childSessionIds };
}

export { nativeSessionDescendsFromRun } from "./opencodeNativeSessionTree.js";

// The ask goes to the human through the run's existing approval lane; the tool call it ends is
// settled with the human's verdict like a governed ask (#3612).
async function nativePolicyHumanDecision(
  run: Pick<PreparedRun, "runId" | "onPermission">,
  decision: Extract<OpenCodeNativePolicyDecision, { readonly effect: "ask" }>,
  signal: AbortSignal | undefined,
  deps: ToolBridgeExecutionDeps,
  approvals: ReturnType<typeof createOpenCodeV2ApprovalRequests>,
): Promise<OpenCodeNativePolicyOutcome> {
  if (run.onPermission === undefined || signal?.aborted === true) return "unavailable";
  const human = await approvals.requestNative({
    runId: run.runId,
    event: decision.event,
    actionId: decision.actionId,
    onPermission: run.onPermission,
    signal: signal ?? new AbortController().signal,
  });
  settleDecidedTool(deps.settleTool, human);
  return human.outcome;
}

function nativePolicyResponse(
  effect: "allow" | "deny",
  message?: string,
): OpenCodeToolBridgeResponse {
  return {
    status: 200,
    body: JSON.stringify(message === undefined ? { effect } : { effect, message }),
  };
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
  const decision = await approvals.request({
    value,
    runId: run.runId,
    sessionId: run.sessionId,
    onPermission: run.onPermission,
    signal: signal ?? new AbortController().signal,
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
// any refused call as a generic failure, which read "Failed" for a human's denial.
const DECIDED_TOOL_STATES: Readonly<
  Partial<Record<OpenCodeV2ApprovalOutcome, OpenCodeToolSettlementState>>
> = {
  denied: "denied",
  expired: "cancelled",
  cancelled: "cancelled",
};

function settleDecidedTool(
  settleTool: SafeToolSettlement | undefined,
  decision: OpenCodeV2ApprovalDecision,
): void {
  const state = DECIDED_TOOL_STATES[decision.outcome];
  if (state !== undefined) settleSafeTool(settleTool, decision.actionId, state);
}

// A step the human declined, or nobody decided in time, answers 409 with the call's own result,
// which the plugin hands to the model in place of the call, so the run goes on without it (owner
// decision 2026-09-26, ADR-0124 D6). A cancelled or unavailable ask stays a bare refusal.
function approvalResponse(decision: OpenCodeV2ApprovalDecision): OpenCodeToolBridgeResponse {
  const { outcome } = decision;
  if (outcome === "approved") return { status: 200, body: '{"status":"approved"}' };
  if (outcome === "denied" || outcome === "expired") {
    return {
      status: 409,
      body: JSON.stringify(humanDecisionToolResult(outcome)),
      rejection: APPROVAL_REJECTIONS[outcome],
    };
  }
  return refusedApproval(outcome);
}

const APPROVAL_REJECTIONS: Readonly<
  Record<Exclude<OpenCodeV2ApprovalOutcome, "approved">, ToolBridgeApprovalRejection>
> = {
  denied: "approval-denied",
  expired: "approval-expired",
  cancelled: "approval-cancelled",
  unavailable: "approval-unavailable",
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

interface ToolBridgeDrainWait {
  readonly completion: Promise<boolean>;
  finish(drained: boolean): void;
}

function toolBridgeDrainWait(signal: AbortSignal, clear: () => void): ToolBridgeDrainWait {
  let resolve!: (drained: boolean) => void;
  const completion = new Promise<boolean>((done) => {
    resolve = done;
  });
  const finish = (drained: boolean): void => {
    signal.removeEventListener("abort", onAbort);
    clear();
    resolve(drained);
  };
  const onAbort = (): void => {
    finish(false);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return { completion, finish };
}

function createToolBridgeAdmissionGate(limits: ToolBridgeLimits): ToolBridgeAdmissionGate {
  let pendingDrain: ToolBridgeDrainWait | undefined;
  const requests = new Set<AdmittedToolRequest>();
  const release = (controller: AbortController): void => {
    for (const request of requests) {
      if (request.controller === controller) requests.delete(request);
    }
    if (requests.size === 0) pendingDrain?.finish(true);
  };
  return {
    limits,
    admit: (requestDeadlineMs): AdmittedToolRequest | undefined => {
      if (requests.size >= limits.maxInFlight) return undefined;
      const request = admittedToolRequest(new AbortController(), requestDeadlineMs, release);
      requests.add(request);
      return request;
    },
    abortNativeRead: (identity): void => {
      for (const request of requests) {
        if (sameNativeReadIdentity(request.nativeReadIdentity, identity))
          request.controller.abort(new Error(DISCONNECT_ABORT));
      }
    },
    abortAll: (): void => {
      for (const request of requests) request.controller.abort(new Error(CLOSE_ABORT));
    },
    drained: (): boolean => requests.size === 0,
    drain: (signal): Promise<boolean> => {
      if (requests.size === 0) return Promise.resolve(true);
      if (signal.aborted) return Promise.resolve(false);
      pendingDrain ??= toolBridgeDrainWait(signal, (): void => {
        pendingDrain = undefined;
      });
      return pendingDrain.completion;
    },
  };
}

function sameNativeReadIdentity(
  selected: CodingToolNativeReadIdentity | undefined,
  supplied: CodingToolNativeReadIdentity,
): boolean {
  return (
    selected?.actionId === supplied.actionId &&
    selected.idempotencyKey === supplied.idempotencyKey &&
    selected.invocationId === supplied.invocationId
  );
}

function admittedToolRequest(
  controller: AbortController,
  deadlineMs: number,
  release: (controller: AbortController) => void,
): AdmittedToolRequest {
  const timer = setTimeout(() => {
    controller.abort(new Error(DEADLINE_ABORT));
  }, deadlineMs);
  timer.unref();
  let released = false;
  return {
    controller,
    deadlineMs,
    release: (): void => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      release(controller);
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
  if (declaredLength === undefined || declaredLength > CODING_TOOL_MAX_BODY_BYTES) {
    return { outcome: "rejected", status: 413, body: "" };
  }
  if (body !== undefined && Buffer.byteLength(body, "utf8") > CODING_TOOL_MAX_BODY_BYTES) {
    return { outcome: "rejected", status: 413, body: "" };
  }
  return { outcome: "admitted" };
}

// The declared Content-Length, or `undefined` for a malformed declaration.
function declaredBodyLength(value: string | null): number | undefined {
  if (value === null) return 0;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
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
  const service: ToolService = {
    request: parseCodingToolRequest(body, CODING_TOOL_MAX_BODY_BYTES),
    startedAtMs: Date.now(),
  };
  const actionId = service.request?.actionId;
  const work = startFacadeExecution(facade, capability, headers, body, admission, () => {
    beginSafeTool(deps.beginTool, service.request);
    service.delegateStarted = true;
  });
  releaseAdmissionWhenSettled(work, admission);
  try {
    const result = await raceAbort(work, admission.controller.signal);
    const reason = abortReason(admission.controller.signal);
    if (reason !== undefined) return abortedToolResponse(deps, service, admission, reason);
    return responseForToolResult(result, deps, service);
  } catch (error) {
    const reason = abortReason(admission.controller.signal);
    // A cancellation is an expected outcome, not a facade fault, so only a genuine failure is
    // surfaced to the operator.
    if (reason !== undefined) return abortedToolResponse(deps, service, admission, reason);
    emitFacadeFailureDiagnostic(diagnostics, actionId, error);
    settleSafeTool(
      settleTool,
      actionId,
      "failed",
      bridgeServicePresentation(service),
      service.delegateStarted,
    );
    return { status: 502, body: "" };
  }
}

// A request the bridge itself stopped. Its own deadline leaves a diagnostic naming the deadline the
// request was admitted under, so a call cut off here is told apart in the log from one its caller
// dropped or the catalog timed out; a 30 s bridge deadline once cut waiting approvals off without a
// line of its own (PR #3452, F44).
function abortedToolResponse(
  deps: ToolBridgeExecutionDeps,
  service: ToolService,
  admission: AdmittedToolRequest,
  reason: string,
): { readonly status: number; readonly body: string } {
  const actionId = service.request?.actionId;
  settleSafeTool(
    deps.settleTool,
    actionId,
    "cancelled",
    bridgeServicePresentation(service),
    service.delegateStarted,
  );
  if (reason !== DEADLINE_ABORT) return { status: 502, body: "" };
  emitToolBridgeDeadlineDiagnostic(deps.diagnostics, actionId, admission);
  return { status: 408, body: "" };
}

function emitToolBridgeDeadlineDiagnostic(
  diagnostics: ServerDiagnosticSink | undefined,
  actionId: string | undefined,
  admission: AdmittedToolRequest,
): void {
  emitServerDiagnostic(diagnostics, {
    correlationId: actionCorrelationId(actionId),
    timestamp: new Date().toISOString(),
    operation: "coding-runtime.tool-bridge",
    source: "opencode-runtime-composition.request-deadline",
    errorClass: "TimeoutError",
    message: "tool-bridge-deadline",
    httpStatus: 408,
    deadlineMs: admission.deadlineMs,
  });
}

function responseForToolResult(
  result: CodingToolResult,
  deps: ToolBridgeExecutionDeps,
  service: ToolService,
): { readonly status: number; readonly body: string } {
  const actionId = service.request?.actionId;
  const presentation = bridgeServicePresentation(service, result);
  if (result.status === "busy") {
    settleSafeTool(deps.settleTool, actionId, "failed", presentation, service.delegateStarted);
    return { status: 429, body: "" };
  }
  settleSafeTool(
    deps.settleTool,
    actionId,
    safeToolState(result),
    presentation,
    service.delegateStarted,
  );
  const responseBody = JSON.stringify(result);
  if (Buffer.byteLength(responseBody, "utf8") > CODING_TOOL_MAX_BODY_BYTES) {
    return { status: 502, body: "" };
  }
  if (deps.renderedResults !== undefined) {
    recordRenderedToolResult(
      deps.renderedResults,
      deps.diagnostics,
      actionId,
      result,
      presentation.bridgeDurationMs,
    );
  }
  return { status: 200, body: responseBody };
}

// The rendering record is evidence about an answer the facade has already produced, and the facade
// has by then executed the tool — an applied edit among them. A sink that cannot take the line (or a
// line that fails its own validation) must therefore never reach `executeToolRequest`'s catch, which
// answers 502 and settles the same action a second time as failed: the model would read a failure
// for a completed action and could repeat it (PR #3876 review). The failure goes to the operator
// diagnostic instead, content-free and correlated to the call, and the answer stands.
function recordRenderedToolResult(
  rendered: RenderedResultLog,
  diagnostics: ServerDiagnosticSink | undefined,
  actionId: string | undefined,
  result: CodingToolResult,
  bridgeDurationMs: number | undefined,
): void {
  try {
    recordGovernedToolModelContent(rendered.sink, rendered.correlationId, result, bridgeDurationMs);
  } catch (error) {
    emitServerDiagnostic(diagnostics, {
      correlationId: actionCorrelationId(actionId),
      timestamp: new Date().toISOString(),
      operation: "coding-runtime.tool-bridge",
      source: "opencode-runtime-composition.tool-result-render-log",
      errorClass: contentFreeErrorClass(error),
      message: "tool-result-render-log-failed",
    });
  }
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
  onDelegateStarted: () => void,
): Promise<CodingToolResult> {
  return Promise.resolve().then(() =>
    facade.execute({
      body,
      capability,
      headers,
      signal: admission.controller.signal,
      onDelegateStarted,
    }),
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

function releaseAdmissionWhenSettled<T>(work: Promise<T>, admission: AdmittedToolRequest): void {
  void work.then(
    () => {
      admission.release();
    },
    () => {
      admission.release();
    },
  );
}

function beginSafeTool(
  beginTool: NonNullable<OpenCodeRuntimeCompositionInput["safeActivity"]>["beginTool"],
  request: CodingToolActionRequest | undefined,
): void {
  if (beginTool === undefined || request === undefined) return;
  const tool = openCodeCatalogAliasFor(request);
  if (tool !== undefined)
    beginTool({ actionId: request.actionId, tool, occurredAt: new Date().toISOString() });
}

function settleSafeTool(
  settleTool: SafeToolSettlement | undefined,
  actionId: string | undefined,
  state: OpenCodeToolSettlementState,
  presentation?: CodingSafeActivityToolPresentation,
  delegateStarted?: true,
): void {
  if (actionId === undefined) return;
  settleTool?.({
    actionId,
    state,
    ...(delegateStarted === undefined ? {} : { delegateStarted }),
    occurredAt: new Date().toISOString(),
    ...(presentation === undefined ? {} : { presentation }),
  });
}

interface ToolService {
  delegateStarted?: true;
  readonly request: CodingToolActionRequest | undefined;
  readonly startedAtMs: number;
}

function bridgeServicePresentation(
  service: ToolService,
  result?: CodingToolResult,
): CodingSafeActivityToolPresentation {
  const facts =
    result === undefined || service.request === undefined
      ? {}
      : governedToolPresentation(service.request, result);
  return Object.freeze({
    ...facts,
    bridgeDurationMs: Math.max(0, Date.now() - service.startedAtMs),
  });
}

function governedToolPresentation(
  request: CodingToolActionRequest,
  result: CodingToolResult,
): CodingSafeActivityToolPresentation {
  if (request.action === "edit") return codingToolEditPresentation(result);
  if (result.status !== "completed" || !("read" in result)) return {};
  if (request.action === "discover") {
    return "returnedPathCount" in result.read && typeof result.read.returnedPathCount === "number"
      ? { returnedPathCount: result.read.returnedPathCount }
      : {};
  }
  return request.action === "read" ? governedReadPresentation(request, result.read) : {};
}

function governedReadPresentation(
  request: Extract<CodingToolActionRequest, { action: "read" }>,
  read:
    | import("./codingToolIpc.js").CodingToolReadResult
    | import("./codingToolIpc.js").CodingToolEgressReadResult,
): CodingSafeActivityToolPresentation {
  if (!isCodingSafeActivityPresentationPath(request.relativePath) || isDenied(request.relativePath))
    return {};
  return {
    relativePath: request.relativePath,
    readByteCount: read.byteCount,
    ...("totalLines" in read ? { totalFileLines: read.totalLines } : {}),
  };
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

function initializationBridgeFacet(
  deps: ToolBridgeExecutionDeps,
  gate: ToolBridgeAdmissionGate,
  active: () => boolean,
): CodingAcceptedInitializationFacet | undefined {
  const facet = deps.facade.acceptedInitialization;
  const producer = facet?.run.bind(facet);
  if (producer === undefined) return undefined;
  return Object.freeze({
    run: <T>(
      initialize: (io: CodingAcceptedInitializationReadPort) => Promise<T>,
      signal?: AbortSignal,
    ): Promise<CodingAcceptedInitializationResult<T>> => {
      if (!active()) return Promise.resolve({ ok: false, reason: "initialization-closed" });
      if (signal?.aborted === true) return Promise.resolve({ ok: false, reason: "cancelled" });
      const admission = gate.admit(gate.limits.requestDeadlineMs);
      if (admission === undefined) return Promise.resolve({ ok: false, reason: "busy" });
      const detach = bindExternalAbort(signal, admission);
      return executeBridgeInitialization(deps, producer, initialize, admission).finally(detach);
    },
  });
}

async function executeBridgeInitialization<T>(
  deps: ToolBridgeExecutionDeps,
  producer: CodingAcceptedInitializationFacet["run"],
  initialize: (io: CodingAcceptedInitializationReadPort) => Promise<T>,
  admission: AdmittedToolRequest,
): Promise<CodingAcceptedInitializationResult<T>> {
  const signal = admission.controller.signal;
  const work = Promise.resolve().then(() => producer(initialize, signal));
  releaseAdmissionWhenSettled(work, admission);
  try {
    return await raceAbort(work, signal);
  } catch (error) {
    if (signal.aborted) {
      if (abortReason(signal) !== DEADLINE_ABORT) return { ok: false, reason: "cancelled" };
      emitToolBridgeDeadlineDiagnostic(deps.diagnostics, undefined, admission);
      return { ok: false, reason: "timeout" };
    }
    emitFacadeFailureDiagnostic(deps.diagnostics, undefined, error);
    return { ok: false, reason: "initialization-failed" };
  }
}

type NativeReadTransportPacket = Readonly<{
  action: "native-read-invocation";
  runId: string;
}> &
  (
    | Readonly<{
        phase: "begin";
        actionId: string;
        idempotencyKey: string;
        relativePath: string;
        context: CodingToolNativeReadContext;
        offset?: number;
        limit?: number;
      }>
    | Readonly<{
        phase: "readBytes" | "stat" | "list";
        identity: CodingToolNativeReadIdentity;
        input: CodingToolNativeReadFilePacket;
      }>
    | Readonly<{
        phase: "close";
        identity: CodingToolNativeReadIdentity;
        outcome: "completed" | "failed" | "cancelled";
      }>
  );

function nativeReadTransportValue(body: string): unknown {
  if (!validJson(body)) return undefined;
  const value: unknown = JSON.parse(body);
  return v2Record(value)?.action === "native-read-invocation" ? value : undefined;
}

/** Capture transport data only; the existing parent owns authority, replay and physical work. */
export function copyNativeReadTransportPacket(
  value: unknown,
): NativeReadTransportPacket | undefined {
  const record = initializationData(value);
  if (record?.action !== "native-read-invocation" || typeof record.runId !== "string")
    return undefined;
  if (!/^[A-Za-z0-9_-]{1,256}$/u.test(record.runId)) return undefined;
  const common = { action: "native-read-invocation", runId: record.runId } as const;
  if (record.phase === "begin") return copyNativeReadBegin(record, common);
  const identity = copyNativeReadStrings(record.identity, [
    "actionId",
    "idempotencyKey",
    "invocationId",
  ]);
  if (identity === undefined) return undefined;
  if (record.phase === "close") return copyNativeReadClose(record, common, identity);
  return copyNativeReadIO(record, common, identity);
}

function copyNativeReadStrings<const K extends string>(
  value: unknown,
  keys: readonly K[],
): Readonly<Record<K, string>> | undefined {
  const record = initializationData(value);
  if (record === undefined || !initialFields(record, keys)) return undefined;
  if (!keys.every((key) => nativeReadTransportString(record[key]))) return undefined;
  return record as Readonly<Record<K, string>>;
}

function nativeReadTransportString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 512;
}

function copyNativeReadBegin(
  record: Readonly<Record<string, unknown>>,
  common: Readonly<{ action: "native-read-invocation"; runId: string }>,
): NativeReadTransportPacket | undefined {
  if (
    !nativeReadBeginFields(record) ||
    !nativeReadTransportString(record.actionId) ||
    !nativeReadTransportString(record.idempotencyKey) ||
    !nativeReadTransportPath(record.relativePath)
  )
    return undefined;
  const context = copyNativeReadStrings(record.context, ["sessionID", "messageID", "id", "agent"]);
  if (context === undefined || !nativeReadWindow(record.offset) || !nativeReadWindow(record.limit))
    return undefined;
  return Object.freeze({
    ...common,
    phase: "begin",
    actionId: record.actionId,
    idempotencyKey: record.idempotencyKey,
    relativePath: record.relativePath,
    context,
    ...(record.offset === undefined ? {} : { offset: record.offset }),
    ...(record.limit === undefined ? {} : { limit: record.limit }),
  });
}

function nativeReadBeginFields(record: Readonly<Record<string, unknown>>): boolean {
  const keys = [
    "action",
    "phase",
    "runId",
    "actionId",
    "idempotencyKey",
    "relativePath",
    "context",
  ];
  for (const key of ["offset", "limit"]) if (Object.hasOwn(record, key)) keys.push(key);
  return initialFields(record, keys);
}

function nativeReadTransportPath(value: unknown): value is string {
  return typeof value === "string" && isSecureWorkspaceNativeRelativePath(value);
}

function nativeReadWindow(value: unknown): value is number | undefined {
  return (
    value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
}

function copyNativeReadClose(
  record: Readonly<Record<string, unknown>>,
  common: Readonly<{ action: "native-read-invocation"; runId: string }>,
  identity: CodingToolNativeReadIdentity,
): NativeReadTransportPacket | undefined {
  if (!initialFields(record, ["action", "phase", "runId", "identity", "outcome"])) return undefined;
  const outcome = record.outcome;
  return outcome === "completed" || outcome === "failed" || outcome === "cancelled"
    ? Object.freeze({ ...common, phase: "close", identity, outcome })
    : undefined;
}

function copyNativeReadIO(
  record: Readonly<Record<string, unknown>>,
  common: Readonly<{ action: "native-read-invocation"; runId: string }>,
  identity: CodingToolNativeReadIdentity,
): NativeReadTransportPacket | undefined {
  const phase = record.phase;
  if (phase !== "readBytes" && phase !== "stat" && phase !== "list") return undefined;
  if (!nativeReadTransportPath(record.relativePath) || !nativeReadOrdinal(record.ordinal))
    return undefined;
  const purpose = record.purpose;
  if (purpose !== "native-tool-io" && purpose !== "native-instructions") return undefined;
  const keys = ["action", "phase", "runId", "identity", "ordinal", "relativePath", "purpose"];
  const range = copyInitializationRange(record, keys);
  if (!nativeReadRangeForPhase(phase, range)) return undefined;
  const input: CodingToolNativeReadFilePacket = Object.freeze({
    ordinal: record.ordinal,
    relativePath: record.relativePath,
    purpose,
    ...(range === undefined ? {} : { range }),
  });
  return Object.freeze({ ...common, phase, identity, input });
}

function nativeReadOrdinal(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function nativeReadRangeForPhase(
  phase: string,
  range: ReturnType<typeof copyInitializationRange>,
): range is Exclude<ReturnType<typeof copyInitializationRange>, false> {
  return (
    range !== false &&
    (range === undefined || (phase === "readBytes" && isSecureWorkspaceNativeRange(range)))
  );
}

async function handleNativeReadTransport(
  value: unknown,
  signal: AbortSignal | undefined,
  deps: ToolBridgeExecutionDeps,
  runs: ReadonlyMap<string, PreparedRun>,
  producer: CodingToolNativeReadInvocations | undefined,
): Promise<OpenCodeToolBridgeResponse> {
  const packet = copyNativeReadTransportPacket(value);
  if (packet === undefined) return nativeTransportRefusal("invalid-request", 400);
  const run = runs.get(packet.runId);
  try {
    if (producer?.fileIO === undefined || !nativeReadRunCurrent(deps, run))
      return nativeTransportRefusal("dispatch-refused");
    if (signal?.aborted === true) return nativeTransportRefusal("cancelled");
    return await dispatchNativeReadTransport(packet, run, producer, signal, deps);
  } catch (error) {
    if (producer !== undefined && packet.phase !== "begin")
      void producer.close(packet.identity, "cancelled");
    emitFacadeFailureDiagnostic(deps.diagnostics, nativeReadPacketActionId(packet), error);
    return nativeTransportRefusal("dispatch-refused", 502);
  }
}

function nativeReadPacketActionId(packet: NativeReadTransportPacket): string {
  return packet.phase === "begin" ? packet.actionId : packet.identity.actionId;
}

function dispatchNativeReadTransport(
  packet: NativeReadTransportPacket,
  run: PreparedRun & { sessionId: string },
  producer: CodingToolNativeReadInvocations,
  signal: AbortSignal | undefined,
  deps: ToolBridgeExecutionDeps,
): Promise<OpenCodeToolBridgeResponse> {
  if (packet.phase === "begin")
    return beginNativeReadTransport(packet, run, producer, signal, deps);
  if (packet.phase === "close")
    return closeNativeReadTransport(packet, run, producer, signal, deps);
  return nativeReadTransportIO(packet, run, producer, signal, deps);
}

function nativeReadRunCurrent(
  deps: ToolBridgeExecutionDeps,
  run: PreparedRun | undefined,
): run is PreparedRun & { sessionId: string } {
  return run?.ready === true && run.sessionId !== undefined && initializationRootCurrent(deps, run);
}

async function beginNativeReadTransport(
  packet: Extract<NativeReadTransportPacket, { phase: "begin" }>,
  run: PreparedRun & { sessionId: string },
  producer: CodingToolNativeReadInvocations,
  signal: AbortSignal | undefined,
  deps: ToolBridgeExecutionDeps,
): Promise<OpenCodeToolBridgeResponse> {
  if (packet.context.sessionID !== run.sessionId) return nativeTransportRefusal("dispatch-refused");
  const body = JSON.stringify({
    action: "read",
    relativePath: packet.relativePath,
    actionId: packet.actionId,
    idempotencyKey: packet.idempotencyKey,
  });
  const result = await producer.begin({
    body,
    context: packet.context,
    capability: deps.capability,
    signal,
    ...(packet.offset === undefined ? {} : { offset: packet.offset }),
    ...(packet.limit === undefined ? {} : { limit: packet.limit }),
  });
  if (!result.ok) return nativeTransportRefusal(result.reason);
  let delivered = false;
  try {
    if (!nativeReadBeginCurrent(packet, run, producer, result.identity, signal, deps))
      return nativeTransportRefusal("dispatch-refused");
    delivered = true;
    return {
      status: 200,
      body: JSON.stringify({ ok: true, identity: result.identity }),
      nativeResult: true,
    };
  } finally {
    if (!delivered) void producer.close(result.identity, "cancelled");
  }
}

function nativeReadBeginCurrent(
  packet: Extract<NativeReadTransportPacket, { phase: "begin" }>,
  run: PreparedRun,
  producer: CodingToolNativeReadInvocations,
  identity: CodingToolNativeReadIdentity,
  signal: AbortSignal | undefined,
  deps: ToolBridgeExecutionDeps,
): boolean {
  return (
    signal?.aborted !== true &&
    nativeReadRunCurrent(deps, run) &&
    packet.context.sessionID === run.sessionId &&
    producer.signalFor(identity)?.aborted === false
  );
}

async function closeNativeReadTransport(
  packet: Extract<NativeReadTransportPacket, { phase: "close" }>,
  run: PreparedRun,
  producer: CodingToolNativeReadInvocations,
  signal: AbortSignal | undefined,
  deps: ToolBridgeExecutionDeps,
): Promise<OpenCodeToolBridgeResponse> {
  const detach = bindNativeReadDisconnect(signal, producer, packet.identity);
  try {
    const ok = await producer.close(packet.identity, packet.outcome);
    return nativeReadRunCurrent(deps, run) && signal?.aborted !== true
      ? { status: 200, body: JSON.stringify({ ok }), nativeResult: true }
      : nativeTransportRefusal("dispatch-refused");
  } finally {
    detach();
  }
}

function bindNativeReadDisconnect(
  signal: AbortSignal | undefined,
  producer: CodingToolNativeReadInvocations,
  identity: CodingToolNativeReadIdentity,
): () => void {
  const abort = (): void => {
    void producer.close(identity, "cancelled");
  };
  if (signal?.aborted === true) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  return (): void => {
    signal?.removeEventListener("abort", abort);
  };
}

async function nativeReadTransportIO(
  packet: Extract<NativeReadTransportPacket, { phase: "readBytes" | "stat" | "list" }>,
  run: PreparedRun,
  producer: CodingToolNativeReadInvocations,
  signal: AbortSignal | undefined,
  deps: ToolBridgeExecutionDeps,
): Promise<OpenCodeToolBridgeResponse> {
  const io = producer.fileIO;
  if (io === undefined) return nativeTransportRefusal("dispatch-refused");
  const detach = bindNativeReadDisconnect(signal, producer, packet.identity);
  const work = io[packet.phase](packet.identity, packet.input);
  void work.then((late) => {
    if (signal?.aborted === true) wipeNativeIOBytes(late);
  });
  try {
    const result = signal === undefined ? await work : await raceAbort(work, signal);
    if (signal?.aborted === true || !nativeReadIOCurrent(deps, run, result)) {
      wipeNativeIOBytes(result);
      void producer.close(packet.identity, "cancelled");
      return nativeTransportRefusal("dispatch-refused");
    }
    return nativeFileIOResponse(result);
  } catch (error) {
    if (signal?.aborted !== true) throw error;
    return nativeTransportRefusal("cancelled");
  } finally {
    detach();
  }
}

function nativeReadIOCurrent(
  deps: ToolBridgeExecutionDeps,
  run: PreparedRun,
  result: NativeFileIOResult,
): boolean {
  let current = false;
  try {
    current = nativeReadRunCurrent(deps, run);
    return current;
  } finally {
    if (!current) wipeNativeIOBytes(result);
  }
}

function wipeNativeIOBytes(result: NativeFileIOResult): void {
  if (result.ok && "bytes" in result) result.bytes.fill(0);
}

function initializationData(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    return undefined;
  const fields: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    fields[key] = descriptor.value as unknown;
  }
  return Object.freeze(fields);
}

function initialFields(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key))
  );
}

function copyInitializationRange(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): { readonly offset: number; readonly length: number } | false | undefined {
  if (!Object.hasOwn(record, "range")) return initialFields(record, keys) ? undefined : false;
  const range = initializationData(record.range);
  if (
    range === undefined ||
    !initialFields(record, [...keys, "range"]) ||
    !initialFields(range, ["offset", "length"])
  )
    return false;
  if (typeof range.offset !== "number" || typeof range.length !== "number") return false;
  return Object.freeze({ offset: range.offset, length: range.length });
}

function initializationRootCurrent(deps: ToolBridgeExecutionDeps, run: PreparedRun): boolean {
  const root = deps.resolveWorkspaceRootAccess?.();
  return root?.canonicalRoot === run.workspaceRoot;
}

function nativeTransportRefusal(reason: string, status = 409): OpenCodeToolBridgeResponse {
  return { status, body: JSON.stringify({ ok: false, reason }), nativeResult: true };
}

type NativeFileIOResult =
  | Awaited<ReturnType<CodingToolNativeReadFileIO["readBytes"]>>
  | Awaited<ReturnType<CodingToolNativeReadFileIO["stat"]>>
  | Awaited<ReturnType<CodingToolNativeReadFileIO["list"]>>;

function nativeFileIOResponse(result: NativeFileIOResult): OpenCodeToolBridgeResponse {
  if (!result.ok) {
    if (result.reason === "wrong-kind")
      return {
        status: 200,
        body: "",
        nativeBytes: encodeSecureWorkspaceNativeResponse({
          status: "wrong-kind",
          info: result.info,
        }),
      };
    return nativeTransportRefusal(result.reason);
  }
  const bytes = nativeFileIOResultBytes(result);
  try {
    return {
      status: 200,
      body: "",
      nativeBytes: encodeSecureWorkspaceNativeResponse({ status: "ok", info: result.info, bytes }),
    };
  } finally {
    bytes.fill(0);
  }
}

function nativeFileIOResultBytes(
  result: Extract<NativeFileIOResult, { readonly ok: true }>,
): Uint8Array {
  if ("bytes" in result) return result.bytes;
  if ("entries" in result) return encodeSecureWorkspaceNativeDirectory(result.entries);
  return new Uint8Array();
}
