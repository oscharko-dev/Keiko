import { KNOWLEDGE_DOCUMENTS_TOOL_ID } from "@oscharko-dev/keiko-contracts/runtime/knowledge-turn-coverage";
import { chatToolSelectionFits, offeredDefinitions } from "./chat-tool-schema-selection.js";
import { JIRA_MUTATION_OPERATIONS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { jiraOperationForTool } from "./atlassian/jiraManagedProvider.js";
import { gatewayToolDefinitions } from "@oscharko-dev/keiko-tool-catalog";
import { deriveContextProfileFromCapability } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { chatKnowledgeScopes } from "./requirement-inventory.js";
import { randomUUID } from "node:crypto";
import { createCatalogToolBinder } from "./tool-catalog/catalogToolDispatch.js";
import { createCodingToolInvocationRegistry } from "./coding-runtime/codingToolInvocationRegistry.js";
import type { CodingToolInvocationRegistry } from "./coding-runtime/codingToolInvocationRegistry.js";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import { processServerLogSink } from "./process-log-sink.js";
import { recordJiraCatalogSelection } from "./atlassian/jiraCatalogSelectionActivity.js";
import {
  defaultServerDiagnosticSink,
  emitServerDiagnostic,
  serverDiagnosticFromError,
} from "./diagnostics-log.js";
import {
  batchDraftDecision,
  JIRA_DRAFT_BATCH_TOOL_ID,
  JIRA_DRAFT_TOOL_ID,
  type BatchDraftSkipReason,
} from "./chat-tool-batch-draft.js";
import {
  acceptChatToolReadGrant,
  waitForChatToolWriteConsent,
  refreshChatToolWriteApproval,
  type ChatToolApprovalContext,
} from "./chat-tool-approvals.js";
import type {
  ChatToolReadGrantView,
  ChatToolWriteApprovalView,
  ChatMessage as GatewayMessage,
  RunCounters,
  ToolDefinition,
} from "@oscharko-dev/keiko-contracts";
import type {
  CatalogConsumerPort,
  CatalogToolBinderInput,
  CatalogToolBudgetPort,
  CatalogConsumer,
  CatalogToolBinder,
} from "./tool-catalog/catalogToolPorts.js";
import { gatewayMessagesForToolExchange } from "./conversation-gateway.js";
import { jiraDraftCondensedRows } from "./atlassian/jiraDraftModelData.js";
import { parseJiraDraft } from "@oscharko-dev/keiko-connectors";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import { ProviderEmptyAnswerError } from "@oscharko-dev/keiko-security/errors/gateway";
import { createHarnessCatalogBudget, type ModelPort } from "@oscharko-dev/keiko-harness";
import type { HarnessLimits } from "@oscharko-dev/keiko-contracts/runtime/harness";
import type { ChatToolAuthorityEnvelope } from "@oscharko-dev/keiko-contracts/runtime/chat-tool-authority";
import { chatToolTurnLimits } from "./chat-tool-turn-budget.js";
import {
  chatToolTurnEndReason,
  chatToolTurnHoldsWrite,
  chatToolTurnPartialAnswer,
  recordChatToolTurnContextFitted,
  recordChatToolTurnResultCondensed,
  recordChatToolTurnCorrected,
  recordChatToolBatchDraftOffer,
  recordChatToolTurnEnded,
  type ChatToolTurnEndReason,
} from "./chat-tool-turn-ending.js";
import {
  CHAT_TURN_JIRA_AUTHENTICATION_FAILED,
  onChatScopeInterruption,
  type ChatGenerationInterruption,
} from "./chat-turn-serializer.js";
import {
  groundedToolAttemptConfirmation,
  groundedNestedToolCallRelease,
} from "./grounded-answer.js";
import { withNestedCallerAdmission } from "./chat-tool-nested-admission.js";
import { fitToolContinuation, fitToolRoundOutput } from "./chat-tool-continuation-fit.js";
import {
  announcedCreateCorrection,
  announcedCreateCount,
  claimNotice,
  correctionRoundOffersTools,
  toolCallAsTextCorrection,
  toolCallsWrittenAsText,
} from "./chat-tool-announced-create.js";
import {
  omittedReportFindingKeys,
  rawReportKeyCorrection,
  rawReportKeys,
  reportCoverageCorrection,
  reportCoverageMismatches,
  reportEvidenceLines,
  reportFindingCorrection,
  unsupportedIssueKeyCorrection,
  unsupportedIssueKeys,
} from "./chat-tool-report-coverage.js";
import {
  findConfiguredCapability,
  ContextOverflowError,
  CallerAttemptAdmissionError,
  GatewayError,
  GatewayToolCatalogError,
  toolCallingConfigurationFingerprint,
  type ModelProviderConfig,
  type GatewayCallRequest,
  type NormalizedResponse,
  type GatewayStreamChunk,
} from "@oscharko-dev/keiko-model-gateway";
import {
  isToolCallingVerificationFresh,
  type ToolCallingVerification,
} from "@oscharko-dev/keiko-contracts/runtime/gateway";
import {
  isChatToolBatchProgress,
  type ChatToolBatchProgress,
  type ChatToolExchange,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ToolConsumerContext } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import type {
  CatalogJsonObject,
  ToolResultEnvelope,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ChatMessage } from "./store/index.js";
import {
  CHAT_TOOL_TRANSCRIPT_BASE_BYTES,
  CHAT_TOOL_TRANSCRIPT_MAX_BYTES,
  chatToolExchangeReservation,
} from "./store/chatToolTranscript.js";
import type { UiHandlerDeps } from "./deps.js";
import type { ManagedProviderCatalog } from "./tool-catalog/managedProviderCatalog.js";
import { requireNoJiraPodRefusal } from "./chat-jira-pod-refusal.js";
import { CatalogDispatchFault, requireDispatch } from "./tool-catalog/catalogToolErrors.js";
import { isGatewayAdmissionRefusal } from "./grounded-gateway-error-status.js";
import {
  knowledgeTurnCoverage,
  knowledgeCoverageCorrection,
  logKnowledgeCoverage,
} from "./chat-tool-knowledge-coverage.js";
import {
  ConversationModelNotReadyError,
  type ToolCallingReadinessReason,
} from "./conversation-readiness-error.js";
import { logConversationAdmission } from "./conversation-readiness-log.js";
import type { AcceptedJiraChatTurn } from "./atlassian/jiraChatAuthority.js";
import { jiraMutationToolId } from "./atlassian/jiraMutationToolId.js";
import {
  isJiraTextWrite,
  latestCitationLabels,
  recordJiraCitationMarkers,
  resolveJiraCitationMarkers,
  unambiguousCitationLabels,
} from "./atlassian/jiraCitationMarkers.js";

const TOOL_TURN_RULES =
  "When the user requests an operation supported by an offered tool, invoke the matching tool. If the Chat's mode requires an action approval, Keiko presents the approval control and waits for the decision before the effect; asking for permission in prose does not replace it. Invoke modifying tools only when the user has actually requested that change. Server authority, mode, approval and budget checks remain binding.";
const TOOL_TURN_INSTRUCTION: GatewayMessage = {
  role: "system",
  content: TOOL_TURN_RULES,
};

type AnswerCorrectionLog =
  | {
      readonly correctionKind: "knowledge-coverage";
      readonly pendingKnowledgePageCount: number;
    }
  | {
      readonly correctionKind: "report-omission";
      readonly omittedFindingCount: number;
    }
  | {
      readonly correctionKind: "report-coverage";
      readonly mismatchedRequirementCount: number;
    }
  | {
      readonly correctionKind: "unsupported-issue-key";
      readonly unsupportedKeyCount: number;
    }
  | {
      readonly correctionKind: "raw-report-key";
      readonly rawReportKeyCount: number;
    }
  | {
      readonly correctionKind: "announced-create" | "tool-call-as-text";
      readonly announcementCount: number;
    };

// Local estimates are not provider counts; the margin keeps the gateway's exact admission and its
// one context-window retry as the authority.
const CONTINUATION_WINDOW_SHARE = 0.8;

/**
 * A runtime observation as this turn's prompt carries it: its call id by position instead of the
 * stored random id, so the runtime prefix sent this turn is byte-identical to the previous turn's
 * and the provider can reuse it. Stored ids, call identity and replayed history are unchanged.
 */
function promptStableRuntimeMessages(
  messages: readonly GatewayMessage[],
  position: number,
): GatewayMessage[] {
  const id = `runtime-${String(position)}`;
  return messages.map((entry) => ({
    ...entry,
    ...(entry.toolCalls === undefined
      ? {}
      : { toolCalls: entry.toolCalls.map((call) => ({ ...call, id })) }),
    ...(entry.toolCallId === undefined ? {} : { toolCallId: id }),
  }));
}

/** Catalogs must be resolved before minting so a failed preparation retains no authority. */
export function mintAndBoundChatTurn<
  Authority extends { readonly ok: true; readonly envelope: ChatToolAuthorityEnvelope },
>(
  deps: Pick<UiHandlerDeps, "gatewayConfig">,
  modelId: string,
  message: ChatMessage,
  correlationId: string,
  mint: (turn: AcceptedJiraChatTurn) => Authority | { readonly ok: false },
  signals: readonly AbortSignal[],
): { readonly authority: Authority; readonly signal: AbortSignal } {
  const readinessFailure = chatModelToolReadiness(deps, modelId);
  if (readinessFailure !== undefined) {
    const generation = deps.gatewayConfig?.generation();
    logConversationAdmission(
      "observation-unavailable",
      correlationId,
      generation,
      generation,
      readinessFailure,
    );
    throw new ConversationModelNotReadyError("tool-calling", readinessFailure);
  }
  requireDispatch(
    signals.every((signal) => !signal.aborted),
    "denied",
    "authority-invalid",
  );
  const authority = mint({
    chatId: message.chatId,
    userMessageId: message.id,
    startedAtMs: message.timestamp,
    nowMs: Date.now(),
    correlationId,
  });
  // A Jira Pod that cannot serve this Chat says so; every other refusal stays the generic one.
  requireNoJiraPodRefusal(authority);
  requireDispatch(authority.ok, "denied", "authority-invalid");
  const remaining = Date.parse(authority.envelope.expiresAt) - Date.now();
  requireDispatch(remaining > 0, "denied", "authority-expired");
  return { authority, signal: AbortSignal.any([...signals, AbortSignal.timeout(remaining)]) };
}
/**
 * Whether a turn's answer reports a change tool's outcome (#4292). A change Keiko did not send
 * counts too: a re-run whose 370 issues all already existed in Jira dispatched nothing, and the
 * citation repair that followed regenerated its two-sentence report for 150 seconds.
 */
export function transcriptReportsToolAction(exchanges: readonly ChatToolExchange[]): boolean {
  return exchanges.some((exchange) => exchange.mutationOutcome !== undefined);
}
type ModelAttempt = NonNullable<GatewayCallRequest["attemptAdmission"]>;
type ChatRoundCatalog = Pick<ManagedProviderCatalog<CatalogConsumer>, "catalog" | "projection">;
type ChatCatalogBind<Context extends ToolConsumerContext> = (
  context: Context,
  budget: ReturnType<typeof createHarnessCatalogBudget>["port"],
  invocationRegistry: CodingToolInvocationRegistry,
) => CatalogToolBinder;
export interface ChatToolCatalogSelection<Context extends ToolConsumerContext> {
  readonly managed: ChatRoundCatalog;
  readonly bind: ChatCatalogBind<Context>;
  readonly close: () => Promise<void>;
}
export interface ChatToolInvocationPreparationPorts {
  readonly publishHumanInput: (
    view: import("@oscharko-dev/keiko-contracts/runtime/atlassian-connectors").JiraHumanInputView,
  ) => Promise<void>;
  readonly requestReadConsent: (grant: ChatToolReadGrantView) => Promise<void>;
}
export interface ChatToolTurnOptions<Context extends ToolConsumerContext> {
  readonly deps: Pick<
    UiHandlerDeps,
    "store" | "gatewayConfig" | "atlassianActionApprovalRegistry" | "activityLog" | "diagnostics"
  > &
    Partial<Pick<UiHandlerDeps, "redactor">>;
  readonly message: ChatMessage;
  readonly context: Context;
  readonly managed: ChatRoundCatalog;
  readonly correlationId: string;
  /** The accepted Authority Envelope budget; it is the turn's only duration and call bound. */
  readonly budget: ChatToolAuthorityEnvelope["budget"];
  /** Rules shared by every offered tool of a source, said once instead of in each description. */
  readonly guidance?: string;
  readonly bind: ChatCatalogBind<Context>;
  /** Source adapters commit derived write data before approval or dispatch, inside this turn. */
  readonly prepareInvocation?: (
    call: ChatToolExchange["call"],
    actionId: string,
    ports: ChatToolInvocationPreparationPorts,
  ) => Promise<{ readonly sourceDigest?: string } | undefined>;
  /** Release private per-call material after outcome retention, including pre-dispatch refusal. */
  readonly finalizeInvocation?: (actionId: string) => void;
  /** Await private lifetime cleanup when this turn ends, retaining it across adopted retries. */
  readonly finalizeTurn?: () => Promise<void>;
  readonly selectTools?: (
    identities: readonly string[],
  ) => Promise<ChatToolCatalogSelection<Context>>;
}
export function chatModelSupportsTools(
  deps: Pick<UiHandlerDeps, "gatewayConfig">,
  modelId: string,
): boolean {
  return chatModelToolReadiness(deps, modelId) === undefined;
}

/** One reason owner for both source-turn admission and the legacy boolean capability view. */
export function chatModelToolReadiness(
  deps: Pick<UiHandlerDeps, "gatewayConfig">,
  modelId: string,
): ToolCallingReadinessReason | undefined {
  const config = deps.gatewayConfig?.current();
  if (config === undefined) return "unverified";
  const provider = config.providers.find((candidate) => candidate.modelId === modelId);
  const capability = findConfiguredCapability(config, modelId);
  if (provider === undefined || capability === undefined) return "unverified";
  if (capability.kind !== "chat") return "unsupported";
  const proofFailure = toolCallingProofFailure(capability.toolCallingVerification, provider);
  if (proofFailure !== undefined) return proofFailure;
  // Parsing withdraws the effective flag when proof expires; it must not hide that proof's cause.
  return capability.toolCalling ? undefined : "unsupported";
}

function toolCallingProofFailure(
  verification: ToolCallingVerification | undefined,
  provider: ModelProviderConfig,
): ToolCallingReadinessReason | undefined {
  if (verification?.status === "unsupported") return "unsupported";
  if (verification?.status !== "verified") return "unverified";
  if (verification.configurationFingerprint !== toolCallingConfigurationFingerprint(provider))
    return "configuration-changed";
  const checkedAt = Date.parse(verification.checkedAt);
  const nowMs = Date.now();
  if (!Number.isFinite(checkedAt) || checkedAt > nowMs) return "unverified";
  return isToolCallingVerificationFresh(verification, { nowMs }) ? undefined : "stale";
}

function boundArguments(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function publicToolCall(call: NormalizedResponse["toolCalls"][number]): ChatToolExchange["call"] {
  return {
    id: call.id,
    name: call.name,
    arguments: call.arguments,
  };
}

function usableModelObservation(
  exchange: ChatToolExchange,
  origin: "runtime" | undefined,
): boolean {
  return (
    origin !== "runtime" &&
    exchange.result?.status === "completed" &&
    exchange.result.data !== null &&
    (exchange.mutationOutcome === undefined || exchange.mutationOutcome === "succeeded")
  );
}

/** Shared bounded tool loop; provider adapters own authority, consent and mutation settlement. */
interface ActiveDraftProgress {
  readonly actionId: string;
  invocationId?: string;
  snapshot?: () => CatalogJsonObject;
}
function interruptedDraftProgress(
  progress: ActiveDraftProgress,
  result: ToolResultEnvelope,
  mutationOutcome: ChatToolExchange["mutationOutcome"],
): CatalogJsonObject | undefined {
  return result.data === null &&
    progress.snapshot !== undefined &&
    progress.invocationId === result.invocationId &&
    mutationOutcome !== undefined &&
    mutationOutcome !== "not-dispatched"
    ? progress.snapshot()
    : undefined;
}
function startedOperationBinding(
  invocation: NonNullable<NormalizedResponse["toolCalls"][number]["invocation"]>,
): NonNullable<ReturnType<typeof jiraOperationForTool>>["binding"] | undefined {
  const operation = JIRA_MUTATION_OPERATIONS.find(
    (name) => invocation.toolRef.canonicalId === jiraMutationToolId(name),
  );
  if (operation === undefined) return undefined;
  const contract = jiraOperationForTool(operation);
  requireDispatch(
    contract?.declaration.descriptor.toolRef.contractVersion === invocation.toolRef.contractVersion,
    "invalid",
    "invalid-arguments",
  );
  return contract.binding;
}
/** Model calls a nested batch leaves to the turn's final answer and citation repair rounds. */
const ANSWER_ROUND_MODEL_CALL_RESERVE = 3;
/** The one running draft batch call; its throttle key is the last progress it published. */
interface ActiveBatchProgress {
  readonly callId: string;
  publishedKey?: string;
}
/** Turn-owned progress or cleanup failure: the existing body-free server diagnostic boundary. */
function reportTurnFailure(
  options: Pick<ChatToolTurnOptions<ToolConsumerContext>, "deps" | "correlationId">,
  error: unknown,
  operation:
    | "chat.tool-turn.batch-progress"
    | "chat.tool-turn.selection-release"
    | "chat.tool-turn.finalize" = "chat.tool-turn.batch-progress",
): void {
  const { deps, correlationId } = options;
  emitServerDiagnostic(
    deps.diagnostics,
    serverDiagnosticFromError({
      correlationId,
      operation,
      source: "chat-tool-turn",
      error,
      redact: (text): string => {
        const redacted = deps.redactor?.(text);
        return typeof redacted === "string" ? redacted : text;
      },
    }),
  );
}

export abstract class ChatToolTurn<Context extends ToolConsumerContext = ToolConsumerContext> {
  private readonly counters: RunCounters = {
    iterations: 0,
    modelCalls: 0,
    toolCalls: 0,
    commandExecutions: 0,
    failureAttempts: 0,
    browserNavigations: 0,
  };
  protected readonly context: Context;
  private readonly budget: ReturnType<typeof createHarnessCatalogBudget>;
  private bound: CatalogToolBinder | undefined;
  private managed: ChatRoundCatalog;
  private readonly invocationRegistry = createCodingToolInvocationRegistry({ now: Date.now });
  private selectedCatalog: ChatToolCatalogSelection<Context> | undefined;
  /** Identities of the latest settled additional selection, which the next describe replaces. */
  private jiraSelection: readonly string[] = [];
  private pendingCatalog:
    (ChatToolCatalogSelection<Context> & { readonly binder: CatalogToolBinder }) | undefined;
  private preparedCatalog:
    | (ChatToolCatalogSelection<Context> & {
        readonly binder: CatalogToolBinder;
        readonly requestId: string;
        readonly identities: readonly string[];
      })
    | undefined;
  private activeSelectionRequestId: string | undefined;
  private activeRequest: GatewayCallRequest | undefined;
  private roundDefinitions: readonly ToolDefinition[] = [];
  private inventoryPreparation: Promise<void> | undefined;
  private readonly continuation: GatewayMessage[] = [];
  private readonly runtimeContext: GatewayMessage[] = [];
  private currentToolResponse: NormalizedResponse | undefined;
  private readonly settledExchanges: ChatToolExchange[] = [];
  /** Only server-dispatched inventory reads qualify as incidental; aliases and ids prove nothing. */
  private readonly incidentalKnowledgeReadCallIds = new Set<string>();
  private usableObservation = false;
  /** One active serial dispatch, retired before any later turn can reuse its private snapshot. */
  private activeDraftProgress: ActiveDraftProgress | undefined;
  /** The draft batch call being dispatched; only it may report progress. */
  private activeBatchProgress: ActiveBatchProgress | undefined;
  /** Progress publications in order; a publication failure is diagnosed, never thrown at the batch. */
  private batchPublication: Promise<void> = Promise.resolve();
  /** Batch calls whose approval offer was decided; a batch earns at most one. */
  private readonly offeredBatchCalls = new Set<string>();
  private readonly callIds = new Set<string>();
  private citationLabels: ReadonlyMap<number, string> | undefined;
  /** The marker namespace of the evidence pack the turn's current synthesis actually sent. */
  private evidenceSources: ReadonlyMap<number, string> | undefined;
  private notify: ((message: ChatMessage) => void | Promise<void>) | undefined;
  /** The turn's own envelope refused a model attempt; the caller's caps are not this turn's. */
  private envelopeRefusedAttempt = false;
  /** The transcript-built answer of a turn that ended early; it may outlive the turn's signal. */
  private endedAnswer: NormalizedResponse | undefined;
  /** A change of the Chat's scope ended the turn, and its answer names the writes it made. */
  private scopeChangeEnded = false;
  private scopeInterruption: ChatGenerationInterruption | undefined;
  private readonly abortController = new AbortController();
  private promptTokens = 0;
  private completionTokens = 0;
  private activeModelId: string | undefined;
  private activeModel: ModelPort | undefined;
  private activeAttemptAdmission: GatewayCallRequest["attemptAdmission"];
  private readonly nestedModelConfirmations = new WeakMap<NormalizedResponse, () => void>();
  private readonly limits: HarnessLimits;
  private elidedResults = 0;
  private reservedTranscriptBytes = CHAT_TOOL_TRANSCRIPT_BASE_BYTES;
  private readonly instruction: GatewayMessage;
  private toolDefinitions: readonly ToolDefinition[];
  /** The correction the next round carries after the gateway's own correction was rejected too. */
  private correction: GatewayMessage | undefined;
  /** A correction about a claimed action is answered without any tool: it can never write. */
  private correctionWithoutTools = false;
  /** The claimed actions a correction round was asked about, and who to tell in which language. */
  private claimedKinds: readonly ("announced-create" | "tool-call-as-text")[] = [];
  private claimedPersonText = "";
  /** The turn corrected a rejected call and no round has dispatched a tool call since. */
  private correctedSinceProgress = false;
  /** The first admission of a correction round follows an attempt the turn could not use. */
  private correctionAdmissionPending = false;
  /** The answer that left out listed report findings; it stands if the corrected round fails. */
  private uncorrectedAnswer: NormalizedResponse | undefined;
  /** Transcript exchanges when that answer was given; any later exchange makes it stale. */
  private uncorrectedExchangeCount = 0;
  protected constructor(private readonly options: ChatToolTurnOptions<Context>) {
    this.managed = options.managed;
    this.toolDefinitions = gatewayToolDefinitions(
      options.managed.catalog,
      options.managed.projection.profile,
    );
    this.instruction =
      options.guidance === undefined
        ? TOOL_TURN_INSTRUCTION
        : { role: "system", content: `${TOOL_TURN_RULES} ${options.guidance}` };
    this.context = {
      ...options.context,
      signal: AbortSignal.any([options.context.signal, this.abortController.signal]),
      selectJiraOperations: this.selectJiraOperations,
      selectedJiraOperations: (): readonly string[] => this.jiraSelection,
      jiraDiscoveryResultFits: this.jiraDiscoveryResultFits,
      ...this.turnReadouts(),
      retainDraftProgress: (
        actionId: string,
        invocationId: string,
        snapshot: () => CatalogJsonObject,
      ): void => {
        this.retainDraftProgress(actionId, invocationId, snapshot);
      },
      reportBatchProgress: (progress: ChatToolBatchProgress): void => {
        this.reportBatchProgress(progress);
      },
      remainingModelCalls: (): number => this.remainingNestedModelCalls(),
      confirmModelOperation: (response: NormalizedResponse): void => {
        const confirm = this.nestedModelConfirmations.get(response);
        this.nestedModelConfirmations.delete(response);
        confirm?.();
      },
      meterModel: (_model: ModelPort): ModelPort => ({
        call: (request, signal): Promise<NormalizedResponse> =>
          this.callNestedModel(request, signal),
      }),
    };
    this.limits = chatToolTurnLimits(options.budget);
    this.budget = createHarnessCatalogBudget({
      ...this.context,
      counters: this.counters,
      limits: this.limits,
      now: Date.now,
      deadlineAt: Date.parse(this.context.deadlineAt),
    });
  }
  private retainDraftProgress(
    actionId: string,
    invocationId: string,
    snapshot: () => CatalogJsonObject,
  ): void {
    const active = this.activeDraftProgress;
    requireDispatch(
      active?.actionId === actionId && active.snapshot === undefined,
      "invalid",
      "recovery-required",
    );
    active.invocationId = invocationId;
    active.snapshot = snapshot;
  }
  private async callNestedModel(
    request: GatewayCallRequest,
    signal: AbortSignal,
  ): Promise<NormalizedResponse> {
    // Keep the accepted conversation's readiness/configuration guard as well as its meter.
    const admitted = this.activeModel;
    requireDispatch(admitted !== undefined, "denied", "authority-invalid");
    let confirm: (() => void) | undefined;
    try {
      const response = await admitted.call(
        withNestedCallerAdmission(request, this.activeAttemptAdmission, (reservation) => {
          confirm = groundedToolAttemptConfirmation(reservation);
          return groundedNestedToolCallRelease(reservation);
        }),
        AbortSignal.any([signal, this.context.signal]),
      );
      this.chargeUsage(response);
      if (confirm !== undefined) this.nestedModelConfirmations.set(response, confirm);
      return response;
    } catch (error) {
      // A failed nested call stays spent when its tool publishes the failure as data.
      this.chargeFailedUsage(error);
      throw error;
    }
  }
  private get binder(): CatalogToolBinder {
    this.bound ??= this.options.bind(this.context, this.budget.port, this.invocationRegistry);
    return this.bound;
  }
  private readonly selectJiraOperations = (
    identities: readonly string[],
    result: CatalogJsonObject,
  ): Promise<void> => this.prepareToolSelection(identities, result);
  private readonly jiraDiscoveryResultFits = (result: CatalogJsonObject): boolean =>
    this.activeRequest !== undefined &&
    this.selectionFits(this.activeRequest, this.roundDefinitions, result);
  /** Compile and admit a candidate without replacing the current round's immutable offer. */
  private async prepareToolSelection(
    identities: readonly string[],
    result: CatalogJsonObject,
  ): Promise<void> {
    const request = this.activeRequest;
    const requestId = this.activeSelectionRequestId;
    requireDispatch(
      this.options.selectTools !== undefined && request !== undefined && requestId !== undefined,
      "failed",
      "handler-unavailable",
    );
    const selection = await this.options.selectTools(identities);
    try {
      this.context.signal.throwIfAborted();
      const binder = selection.bind(this.context, this.budget.port, this.invocationRegistry);
      const offered = binder.offer();
      const definitions = gatewayToolDefinitions(
        selection.managed.catalog,
        selection.managed.projection.profile,
      );
      const tools = offeredDefinitions(selection.managed, definitions, offered);
      requireDispatch(this.selectionFits(request, tools, result), "denied", "budget-exhausted");
      requireDispatch(this.activeSelectionRequestId === requestId, "cancelled", "parent-cancelled");
      this.preparedCatalog = { ...selection, binder, requestId, identities: [...identities] };
    } catch (error) {
      await selection.close();
      throw error;
    }
  }
  private selectionFits(
    request: GatewayCallRequest,
    tools: readonly ToolDefinition[],
    result: CatalogJsonObject,
  ): boolean {
    const config = this.options.deps.gatewayConfig?.current();
    const capability =
      config === undefined ? undefined : findConfiguredCapability(config, request.modelId);
    if (capability?.kind !== "chat") return false;
    return chatToolSelectionFits(
      {
        ...request,
        messages: [
          this.instruction,
          ...this.runtimeContext,
          ...request.messages,
          ...this.continuation,
          { role: "tool", content: JSON.stringify(result) },
        ],
      },
      tools,
      deriveContextProfileFromCapability(capability),
      config?.providers.find((provider) => provider.modelId === request.modelId)
        ?.reasoningHistoryField,
    );
  }
  private async activateToolSelection(): Promise<void> {
    const pending = this.pendingCatalog;
    if (pending === undefined) return;
    this.pendingCatalog = undefined;
    const previous = this.selectedCatalog;
    this.selectedCatalog = pending;
    this.managed = pending.managed;
    this.bound = pending.binder;
    this.toolDefinitions = gatewayToolDefinitions(
      this.managed.catalog,
      this.managed.projection.profile,
    );
    await previous?.close();
  }
  private async releaseToolSelection(): Promise<void> {
    const pending = this.pendingCatalog;
    const selected = this.selectedCatalog;
    const prepared = this.preparedCatalog;
    this.pendingCatalog = undefined;
    this.selectedCatalog = undefined;
    this.preparedCatalog = undefined;
    this.jiraSelection = [];
    if (selected !== undefined) {
      this.managed = this.options.managed;
      this.bound = undefined;
      this.toolDefinitions = gatewayToolDefinitions(
        this.managed.catalog,
        this.managed.projection.profile,
      );
    }
    await Promise.all([pending?.close(), selected?.close(), prepared?.close()]);
  }
  private async finalizeTurn(): Promise<void> {
    try {
      await this.releaseToolSelection();
    } catch (error) {
      reportTurnFailure(this.options, error, "chat.tool-turn.selection-release");
    }
    // Selection cleanup must not prevent private cleanup; neither may replace the retained outcome.
    try {
      await this.options.finalizeTurn?.();
    } catch (error) {
      reportTurnFailure(this.options, error, "chat.tool-turn.finalize");
    }
  }
  private async settleToolSelection(requestId: string, succeeded: boolean): Promise<void> {
    const prepared = this.preparedCatalog;
    if (prepared?.requestId !== requestId) return;
    this.preparedCatalog = undefined;
    if (!succeeded) {
      await prepared.close();
      return;
    }
    const previous = this.pendingCatalog;
    this.pendingCatalog = prepared;
    recordJiraCatalogSelection(processServerLogSink(), {
      correlationId: this.options.correlationId,
      surface: "chat",
      previous: this.jiraSelection,
      selected: prepared.identities,
    });
    this.jiraSelection = prepared.identities;
    await previous?.close();
  }
  /** The turn's retained authority must still be live; Keiko does not limit tokens (#4346). */
  protected abstract admitAuthorityModelCall(): boolean;
  protected abstract observedMutation(
    call: NormalizedResponse["toolCalls"][number],
    identity: string,
    result: ToolResultEnvelope,
  ): ChatToolExchange["mutationOutcome"];
  protected refreshWriteApproval(callId: string): void {
    refreshChatToolWriteApproval(this.options, callId);
  }
  private approvalContext(signal: AbortSignal): ChatToolApprovalContext {
    return {
      ...this.options,
      signal,
      publish: () => this.publish(),
      writeExchange: (id) => this.writeExchange(id),
    };
  }
  protected waitForReadConsent(grant: ChatToolReadGrantView): Promise<void> {
    return acceptChatToolReadGrant({ ...this.options, publish: () => this.publish() }, grant);
  }
  protected waitForWriteConsent(
    approval: ChatToolWriteApprovalView,
    signal: AbortSignal,
  ): Promise<void> {
    return waitForChatToolWriteConsent(this.approvalContext(signal), approval);
  }
  protected consentPorts(): {
    readonly requestReadConsent: (
      grant: ChatToolReadGrantView,
      signal: AbortSignal,
    ) => Promise<void>;
    readonly requestWriteConsent: (
      approval: ChatToolWriteApprovalView,
      signal: AbortSignal,
    ) => Promise<void>;
    readonly reviewableWrite: (action: {
      readonly actionId: string;
      readonly argumentsDigest: string;
    }) => boolean;
    readonly draftItemRefs: (action: {
      readonly actionId: string;
      readonly argumentsDigest: string;
    }) => readonly string[] | undefined;
  } {
    return {
      requestReadConsent: (grant) => this.waitForReadConsent(grant),
      requestWriteConsent: (approval, signal) => this.waitForWriteConsent(approval, signal),
      reviewableWrite: (action) => this.reviewableWrite(action),
      draftItemRefs: (action) => this.draftItemRefs(action),
    };
  }
  /** Refs of the persisted draft the human reviews, only while it matches the approved digest. */
  protected draftItemRefs(action: {
    readonly actionId: string;
    readonly argumentsDigest: string;
  }): readonly string[] | undefined {
    const exchange = this.writeExchange(action.actionId);
    if (exchange === undefined || !this.reviewableWrite(action)) return undefined;
    return parseJiraDraft(exchange.call.arguments)?.items.map((item) => item.ref);
  }
  /** Approval must match the actual persisted preview after the store's credential floor. */
  protected reviewableWrite(action: {
    readonly actionId: string;
    readonly argumentsDigest: string;
  }): boolean {
    const exchange = this.writeExchange(action.actionId);
    return (
      exchange !== undefined &&
      sha256Hex(canonicalise(exchange.call.arguments)) === action.argumentsDigest
    );
  }
  private admitModelCall(): boolean {
    return !this.context.signal.aborted && this.admitAuthorityModelCall();
  }
  public onTranscript(listener: (message: ChatMessage) => void | Promise<void>): void {
    this.notify = listener;
  }
  public hasUsableObservation(): boolean {
    return this.usableObservation;
  }
  protected async publish(): Promise<void> {
    const message = this.options.deps.store.findMessageById(this.options.message.id);
    if (message !== undefined) await this.notify?.(message);
  }
  protected writeExchange(invocationId: string): ChatToolExchange | undefined {
    const { deps, message } = this.options;
    return deps.store
      .findMessageById(message.id)
      ?.toolTranscript?.exchanges.find(
        (exchange) =>
          sha256Hex(canonicalise({ messageId: message.id, callId: exchange.call.id })) ===
          invocationId,
      );
  }
  private readonly admitAttempt: ModelAttempt = () => {
    if (
      this.endedEarly ||
      this.counters.modelCalls >= this.limits.maxModelCalls ||
      !this.admitModelCall()
    ) {
      this.envelopeRefusedAttempt = true;
      return undefined;
    }
    this.counters.modelCalls++;
    return { settle: (): void => undefined };
  };
  // A tool turn is a multi-round task with settled work behind it: a model that ends a round after
  // reasoning without a tool call or an answer gets the gateway's ONE steered repair instead of
  // ending the whole turn (S09 of epic #4173: Qwen read the field metadata, produced nothing, and
  // the turn ended with no writes). The repair is bounded by the turn's own model-call envelope.
  private requestForAttempt(request: GatewayCallRequest): GatewayCallRequest {
    return {
      ...request,
      answerRepair: "steered",
      attemptAdmission: (input): ReturnType<ModelAttempt> => {
        const existing = request.attemptAdmission?.(this.claimCorrectionAdmission(input));
        if (request.attemptAdmission !== undefined && existing === undefined) return undefined;
        const current = this.admitAttempt(input);
        if (current === undefined) {
          existing?.settle(undefined, false, "none");
          return undefined;
        }
        return {
          ...(existing?.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: existing.maxOutputTokens }),
          settle: (usage, dispatched, state): void => {
            current.settle(usage, dispatched, state);
            existing?.settle(usage, dispatched, state);
          },
        };
      },
    };
  }
  private claimCorrectionAdmission(
    input: Parameters<ModelAttempt>[0],
  ): Parameters<ModelAttempt>[0] {
    if (!this.correctionAdmissionPending) return input;
    this.correctionAdmissionPending = false;
    return { ...input, correctsUnusableAttempt: true };
  }
  private async *meteredStream(
    model: ModelPort,
    request: GatewayCallRequest,
    signal: AbortSignal,
  ): AsyncIterable<GatewayStreamChunk> {
    requireDispatch(model.callStream !== undefined, "invalid", "unsupported-capability");
    const before = this.counters.modelCalls;
    for await (const chunk of model.callStream(
      this.requestForAttempt(request),
      AbortSignal.any([signal, this.context.signal]),
    )) {
      requireDispatch(this.counters.modelCalls > before, "denied", "budget-exhausted");
      yield chunk;
    }
  }

  public meter(model: ModelPort): ModelPort {
    return {
      ...model,
      call: async (request, signal): Promise<NormalizedResponse> => {
        const before = this.counters.modelCalls;
        const response = await model.call(
          this.requestForAttempt(request),
          AbortSignal.any([signal, this.context.signal]),
        );
        requireDispatch(this.counters.modelCalls > before, "denied", "budget-exhausted");
        return response;
      },
      ...(model.callStream === undefined
        ? {}
        : {
            callStream: (request, signal) => this.meteredStream(model, request, signal),
          }),
    };
  }
  /** Persists and publishes a page of the running batch when its counted state changed. */
  private reportBatchProgress(progress: ChatToolBatchProgress): void {
    const active = this.activeBatchProgress;
    requireDispatch(
      active !== undefined && isChatToolBatchProgress(progress),
      "invalid",
      "recovery-required",
    );
    const key = [progress.phase, progress.draftedCount, progress.failedCount].join(":");
    if (active.publishedKey === key) return;
    const { deps, message, correlationId } = this.options;
    try {
      deps.store.updateChatToolTranscript(
        message.id,
        { kind: "progress", callId: active.callId, batchProgress: progress },
        correlationId,
      );
    } catch (error: unknown) {
      // A page that cannot be persisted is dropped; the batch and its next page carry on.
      reportTurnFailure(this.options, error);
      return;
    }
    active.publishedKey = key;
    this.batchPublication = this.batchPublication
      .then(() => this.publish())
      .catch((error: unknown) => {
        reportTurnFailure(this.options, error);
      });
  }
  /** Model calls left for nested work once the turn's own answer rounds are kept. */
  private remainingNestedModelCalls(): number {
    return Math.max(
      0,
      this.limits.maxModelCalls - this.counters.modelCalls - ANSWER_ROUND_MODEL_CALL_RESERVE,
    );
  }

  private async dispatchWithProgress(
    call: NormalizedResponse["toolCalls"][number],
    identity: string,
  ): Promise<{
    outcome: Awaited<ReturnType<CatalogToolBinder["dispatch"]>>;
    progress: ActiveDraftProgress;
  }> {
    const invocation = call.invocation;
    requireDispatch(invocation !== undefined, "invalid", "replay-conflict");
    const progress: ActiveDraftProgress = { actionId: identity };
    this.activeDraftProgress =
      invocation.toolRef.canonicalId === JIRA_DRAFT_TOOL_ID ? progress : undefined;
    this.activeSelectionRequestId = identity;
    this.activeBatchProgress =
      invocation.toolRef.canonicalId === JIRA_DRAFT_BATCH_TOOL_ID ? { callId: call.id } : undefined;
    try {
      const outcome = await this.binder.dispatch(invocation, {
        actionId: identity,
        idempotencyKey: identity,
      });
      return { outcome, progress };
    } finally {
      this.activeDraftProgress = undefined;
      this.activeSelectionRequestId = undefined;
      this.activeBatchProgress = undefined;
      await this.batchPublication;
    }
  }
  private async prepareInvocation(
    call: NormalizedResponse["toolCalls"][number],
    identity: string,
  ): Promise<void> {
    const prepared = await this.options.prepareInvocation?.(publicToolCall(call), identity, {
      requestReadConsent: (grant) => this.waitForReadConsent(grant),
      publishHumanInput: async (view) => {
        this.options.deps.store.updateChatToolTranscript(
          this.options.message.id,
          { kind: "human-input", callId: call.id, view },
          this.options.correlationId,
        );
        await this.publish();
      },
    });
    if (prepared?.sourceDigest === undefined) return;
    const { deps, message, correlationId } = this.options;
    deps.store.updateChatToolTranscript(
      message.id,
      { kind: "write-prepared", callId: call.id, sourceDigest: prepared.sourceDigest },
      correlationId,
    );
    await this.publish();
  }
  private async dispatch(
    call: NormalizedResponse["toolCalls"][number],
    origin?: "runtime",
  ): Promise<void> {
    const { deps, message, correlationId } = this.options;
    const managed = this.managed;
    requireDispatch(
      call.invocation !== undefined && !this.callIds.has(call.id),
      "invalid",
      "replay-conflict",
    );
    this.callIds.add(call.id);
    await this.startExchange(call, call.invocation);
    const identity = sha256Hex(canonicalise({ messageId: message.id, callId: call.id }));
    try {
      await this.prepareInvocation(call, identity);
      const { outcome, progress } = await this.dispatchWithProgress(call, identity);
      requireDispatch(outcome.kind === "settled", "invalid", "recovery-required");
      await this.settleToolSelection(identity, outcome.result.status === "completed");
      this.refreshWriteApproval(call.id);
      const descriptor = managed.catalog.descriptors.find(
        (entry) => entry.toolRef.canonicalId === call.invocation?.toolRef.canonicalId,
      );
      requireDispatch(descriptor !== undefined, "invalid", "recovery-required");
      this.budget.acceptReceipt(outcome.receipt, descriptor);
      const mutationOutcome = this.observedMutation(call, identity, outcome.result);
      const draftProgress = interruptedDraftProgress(progress, outcome.result, mutationOutcome);
      deps.store.updateChatToolTranscript(
        message.id,
        {
          kind: "settled",
          callId: call.id,
          result: outcome.result,
          ...(draftProgress === undefined ? {} : { draftProgress }),
          binding: {
            descriptor,
            projectionDigest: managed.projection.projectionDigest,
          },
          ...(mutationOutcome === undefined ? {} : { mutationOutcome }),
        },
        correlationId,
      );
      this.appendObservedExchange(call.id, origin);
      await this.publish();
    } finally {
      this.options.finalizeInvocation?.(identity);
    }
  }
  private async startExchange(
    call: NormalizedResponse["toolCalls"][number],
    invocation: NonNullable<NormalizedResponse["toolCalls"][number]["invocation"]>,
  ): Promise<void> {
    const { deps, message, correlationId } = this.options;
    const publicCall = publicToolCall(call);
    const operationBinding = startedOperationBinding(invocation);
    this.reserveTranscript(publicCall, invocation.toolRef.canonicalId);
    deps.store.updateChatToolTranscript(
      message.id,
      {
        kind: "started",
        call: publicCall,
        ...(operationBinding === undefined ? {} : { operationBinding }),
      },
      correlationId,
    );
    await this.publish();
  }
  /** A call whose worst-case exchange no longer fits the stored transcript ends the turn. */
  private reserveTranscript(call: ChatToolExchange["call"], canonicalId: string): void {
    const descriptor = this.managed.catalog.descriptors.find(
      (entry) => entry.toolRef.canonicalId === canonicalId,
    );
    requireDispatch(descriptor !== undefined, "invalid", "recovery-required");
    const reserved = this.reservedTranscriptBytes + chatToolExchangeReservation(call, descriptor);
    requireDispatch(reserved <= CHAT_TOOL_TRANSCRIPT_MAX_BYTES, "denied", "budget-exhausted");
    this.reservedTranscriptBytes = reserved;
  }
  private appendObservedExchange(id: string, origin: "runtime" | undefined): void {
    const stored = this.options.deps.store
      .findMessageById(this.options.message.id)
      ?.toolTranscript?.exchanges.find((exchange) => exchange.call.id === id);
    requireDispatch(stored?.result !== undefined, "invalid", "recovery-required");
    const messages = gatewayMessagesForToolExchange(stored);
    this.recordCondensedResult(stored);
    if (origin === "runtime")
      this.runtimeContext.push(
        ...promptStableRuntimeMessages(messages, this.runtimeContext.length),
      );
    else
      this.continuation.push(
        ...(this.currentToolResponse === undefined
          ? messages
          : messages.filter((entry) => entry.role === "tool")),
      );
    this.settledExchanges.push(stored);
    // Only this turn's validated, redacted result actually published to the model is evidence.
    // A successful empty list is useful; a settled denial, failure or missing payload is not.
    if (usableModelObservation(stored, origin)) this.usableObservation = true;
  }

  private recordCondensedResult(stored: ChatToolExchange): void {
    const condensed = jiraDraftCondensedRows(
      stored.result?.toolRef?.canonicalId,
      stored.result?.data,
    );
    if (condensed === undefined) return;
    recordChatToolTurnResultCondensed(processServerLogSink(), {
      correlationId: this.options.correlationId,
      messageId: this.options.message.id,
      ...condensed,
    });
  }

  public async *stream(
    callStream: NonNullable<ModelPort["callStream"]>,
    request: GatewayCallRequest,
    signal: AbortSignal,
    retryFollows?: (error: unknown) => boolean,
  ): AsyncIterable<GatewayStreamChunk> {
    const response = await this.call(
      {
        call: (round, abort): Promise<NormalizedResponse> =>
          collectToolRound(callStream({ ...round, stream: true }, abort)),
      },
      request,
      signal,
      undefined,
      retryFollows,
    );
    // A deadline answer is already built from the stored transcript and admits no further work.
    requireDispatch(
      response === this.endedAnswer || (!signal.aborted && !this.context.signal.aborted),
      "denied",
      "authority-invalid",
    );
    if (response.content.length > 0) yield { type: "delta", token: response.content };
    yield { type: "done", response };
  }

  private admitRound(modelId: string, signal: AbortSignal): void {
    this.requireRoundAdmission(modelId, signal);
    this.counters.iterations++;
  }

  private requireRoundAdmission(modelId: string, signal: AbortSignal): void {
    // A round past the envelope's tool-call budget could only be refused after a model call.
    requireDispatch(
      this.counters.toolCalls < this.limits.maxToolCalls,
      "denied",
      "budget-exhausted",
    );
    requireDispatch(
      !signal.aborted && !this.context.signal.aborted && Date.now() < this.deadlineAtMs,
      "denied",
      "budget-exhausted",
    );
    requireDispatch(
      chatModelSupportsTools(this.options.deps, modelId),
      "denied",
      "authority-invalid",
    );
  }

  public get signal(): AbortSignal {
    return this.context.signal;
  }
  public get deadlineAtMs(): number {
    return Date.parse(this.context.authorityExpiresAt);
  }

  public async call(
    model: ModelPort,
    request: GatewayCallRequest,
    signal: AbortSignal,
    observeRound?: (response: NormalizedResponse) => void,
    retryFollows?: (error: unknown) => boolean,
  ): Promise<NormalizedResponse> {
    if (this.endedEarly)
      throw new CallerAttemptAdmissionError("An ended tool turn cannot start another model call");
    this.activeModelId = request.modelId;
    this.activeModel = model;
    this.activeAttemptAdmission = request.attemptAdmission;
    this.activeRequest = request;
    let keepSelection = false;
    const cancel = (): void => {
      this.abortController.abort();
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    const { deps, message } = this.options;
    const release = onChatScopeInterruption(deps, message.chatId, (reason) =>
      this.endForScopeChange(reason),
    );
    try {
      return await this.runRounds(model, request, signal, observeRound, retryFollows);
    } catch (error) {
      // The owning window retry keeps this same turn and its settled effects open.
      if (this.retryKeepsTurnOpen(signal) && retryFollows?.(error) === true) {
        keepSelection = true;
        throw error;
      }
      const partial = this.failedAnswer(error, request.modelId, signal);
      if (partial === undefined) throw error;
      return partial;
    } finally {
      release();
      signal.removeEventListener("abort", cancel);
      if (!keepSelection) await this.finalizeTurn();
    }
  }

  /** A refusal belongs to this adopted retry only; ordinary caller refusals keep their contract. */
  public settleRetryFailure(
    error: unknown,
    originalFailure: unknown,
    modelId: string,
    signal: AbortSignal,
  ): NormalizedResponse | undefined {
    if (
      !(originalFailure instanceof ContextOverflowError) ||
      originalFailure.reportedContextWindowTokens === undefined ||
      (!(error instanceof GatewayError) && !(error instanceof CatalogDispatchFault))
    )
      return undefined;
    return this.failedAnswer(
      isGatewayAdmissionRefusal(error) ? originalFailure : error,
      modelId,
      signal,
    );
  }

  private failedAnswer(
    error: unknown,
    modelId: string,
    signal: AbortSignal,
  ): NormalizedResponse | undefined {
    this.clearCorrection();
    if (this.scopeInterruption === CHAT_TURN_JIRA_AUTHENTICATION_FAILED)
      return this.partialAnswer(error, modelId, signal);
    return this.answerBeforeCorrection(signal) ?? this.partialAnswer(error, modelId, signal);
  }

  /**
   * A write the turn made must not vanish behind a bare cancellation when the Chat's mode or sources
   * change: the turn stops at once and answers from its transcript (#4175). A turn with nothing
   * to report stays a cancellation.
   */
  private endForScopeChange(reason?: ChatGenerationInterruption): boolean {
    const { deps, message } = this.options;
    const exchanges = deps.store.findMessageById(message.id)?.toolTranscript?.exchanges ?? [];
    if (this.context.signal.aborted || !chatToolTurnHoldsWrite(exchanges)) return false;
    this.scopeChangeEnded = true;
    this.scopeInterruption = reason;
    this.abortController.abort(reason);
    return true;
  }

  private retryKeepsTurnOpen(signal: AbortSignal): boolean {
    return (
      this.endedAnswer === undefined &&
      this.counters.modelCalls < this.limits.maxModelCalls &&
      this.counters.iterations < this.limits.maxIterations &&
      !signal.aborted &&
      !this.context.signal.aborted &&
      Date.now() < Date.parse(this.context.authorityExpiresAt)
    );
  }

  private transcriptExchangeCount(): number {
    const { deps, message } = this.options;
    return deps.store.findMessageById(message.id)?.toolTranscript?.exchanges.length ?? 0;
  }

  private knowledgeAnswer(answer: NormalizedResponse): NormalizedResponse {
    const coverage = knowledgeTurnCoverage(this.settledExchanges, {
      incidentalReadCallIds: [...this.incidentalKnowledgeReadCallIds],
    });
    logKnowledgeCoverage(this.options.correlationId, coverage);
    return answer;
  }

  /**
   * The model's own answer stands when only its completeness correction failed and that round
   * dispatched nothing: it is a better answer than the transcript. After a further dispatch the
   * transcript answer names every effect. A human stop is not replaced.
   */
  private answerBeforeCorrection(signal: AbortSignal): NormalizedResponse | undefined {
    const answer = this.uncorrectedAnswer;
    // The answer no longer describes the turn once the correction round dispatched another call.
    if (answer === undefined || this.transcriptExchangeCount() !== this.uncorrectedExchangeCount)
      return undefined;
    const expired = Date.now() >= Date.parse(this.context.authorityExpiresAt);
    if ((signal.aborted || this.options.context.signal.aborted) && !expired) return undefined;
    // The correction round failed: the original answer is published, and a false claim in it is
    // followed by one fixed sentence that says so.
    this.endedAnswer = this.knowledgeAnswer(this.withClaimNotice(answer, true));
    return this.endedAnswer;
  }

  private stillClaims(kind: "announced-create" | "tool-call-as-text", content: string): boolean {
    return kind === "announced-create"
      ? announcedCreateCount(this.settledExchanges, content) > 0
      : toolCallsWrittenAsText(content) > 0;
  }

  /**
   * After a claimed-action correction, a published answer that still claims it (or is the original
   * one because the correction round failed) carries one fixed Keiko sentence; nowhere else.
   */
  private withClaimNotice(answer: NormalizedResponse, original: boolean): NormalizedResponse {
    const still = original
      ? this.claimedKinds
      : this.claimedKinds.filter((kind) => this.stillClaims(kind, answer.content));
    if (still.length === 0) return answer;
    return {
      ...answer,
      content: `${answer.content}\n\n${claimNotice(still, this.claimedPersonText)}`,
    };
  }

  /**
   * A turn that already settled tool calls and then ends early answers from its own transcript
   * (#4175): the human sees exactly which writes Jira acknowledged. A human stop is not replaced.
   */
  private partialAnswer(
    error: unknown,
    modelId: string,
    signal: AbortSignal,
  ): NormalizedResponse | undefined {
    const { deps, message, correlationId, budget } = this.options;
    const expired = Date.now() >= Date.parse(this.context.authorityExpiresAt);
    if ((signal.aborted || this.options.context.signal.aborted) && !expired) return undefined;
    const reason = this.endReason(error, expired);
    // Unsettled calls stay in the answer: one may have reached Jira before bookkeeping failed.
    const exchanges = deps.store.findMessageById(message.id)?.toolTranscript?.exchanges ?? [];
    if (reason === undefined || !exchanges.some((exchange) => exchange.result !== undefined))
      return undefined;
    recordChatToolTurnEnded(processServerLogSink(), {
      correlationId,
      messageId: message.id,
      reason,
      exchanges,
      budget,
    });
    logKnowledgeCoverage(
      correlationId,
      knowledgeTurnCoverage(exchanges, {
        incidentalReadCallIds: [...this.incidentalKnowledgeReadCallIds],
      }),
    );
    this.endedAnswer = {
      modelId,
      content: chatToolTurnPartialAnswer(exchanges, reason),
      finishReason: "stop",
      toolCalls: [],
      structuredOutput: null,
      usage: {
        requestId: randomUUID(),
        promptTokens: this.promptTokens,
        completionTokens: this.completionTokens,
        latencyMs: 0,
        costClass: "low",
      },
    };
    return this.endedAnswer;
  }

  private endReason(error: unknown, expired: boolean): ChatToolTurnEndReason | undefined {
    if (this.scopeInterruption === CHAT_TURN_JIRA_AUTHENTICATION_FAILED)
      return "authentication-failed";
    if (expired) return "deadline";
    if (this.scopeChangeEnded) return "authority-invalid";
    return chatToolTurnEndReason(error, {
      envelopeRefusedAttempt: this.envelopeRefusedAttempt,
    });
  }

  /** True once a change of the Chat's scope ended this turn; its answer must reach the human. */
  public get answersAfterScopeChange(): boolean {
    return this.scopeChangeEnded;
  }

  /**
   * True while a deadline that expires now would end this turn with its transcript answer: at least
   * one exchange has settled. A caller must deliver that answer, not cancel it (#4175); a deadline
   * with no settled exchange stays a cancellation.
   */
  public get answersAtDeadline(): boolean {
    const { deps, message } = this.options;
    return (
      deps.store
        .findMessageById(message.id)
        ?.toolTranscript?.exchanges.some((exchange) => exchange.result !== undefined) ?? false
    );
  }

  /**
   * True once this turn ran a change tool (a Jira create, edit, comment), whatever its outcome. The
   * answer then reports that action; a citation repair would regenerate it for nothing.
   */
  public get reportsToolAction(): boolean {
    const { deps, message } = this.options;
    return transcriptReportsToolAction(
      deps.store.findMessageById(message.id)?.toolTranscript?.exchanges ?? [],
    );
  }

  /** The figures Keiko computed for a Jira report in this turn, one per line; none without one. */
  public get reportEvidence(): readonly string[] {
    return reportEvidenceLines(this.settledExchanges);
  }

  /** True once the turn answered from its transcript; callers must deliver, not cancel, it. */
  public get endedEarly(): boolean {
    return this.endedAnswer !== undefined;
  }

  /** Settled observations survive catalog cleanup; repair never reopens a tool or effect. */
  public readOnlySynthesisRequest(request: GatewayCallRequest): GatewayCallRequest {
    const callIds = new Set(
      this.continuation
        .filter((message) => message.role === "tool")
        .map((message) => message.toolCallId),
    );
    const observations = this.settledExchanges
      .filter(
        (exchange) => callIds.has(exchange.call.id) && usableModelObservation(exchange, undefined),
      )
      .flatMap(gatewayMessagesForToolExchange);
    const readOnly = {
      ...request,
      toolCatalog: undefined,
      reasoningScope: `chat:${this.options.message.chatId}`,
    };
    return {
      ...readOnly,
      messages: [...request.messages, ...this.fittedContinuation(readOnly, [], observations)],
    };
  }

  private roundRequest(
    request: GatewayCallRequest,
    offered: ReturnType<CatalogToolBinder["offer"]>,
  ): GatewayCallRequest {
    const managed = this.managed;
    const definitions = offeredDefinitions(managed, this.toolDefinitions, offered);
    this.roundDefinitions = definitions;
    const messages = [this.instruction, ...this.runtimeContext, ...request.messages];
    const round: GatewayCallRequest = {
      ...request,
      stream: false,
      reasoningScope: `chat:${this.options.message.chatId}`,
      messages: [
        ...messages,
        ...this.fittedContinuation({ ...request, messages }, definitions),
        ...(this.correction === undefined ? [] : [this.correction]),
      ],
      toolCatalog: {
        kind: "bound",
        catalog: managed.catalog,
        projection: managed.projection,
        offered,
      },
    };
    if (this.correctionWithoutTools) return { ...round, toolCatalog: undefined };
    return this.fittedRoundOutput(round, offered);
  }
  private fittedRoundOutput(
    request: GatewayCallRequest,
    offered: ReturnType<CatalogToolBinder["offer"]>,
  ): GatewayCallRequest {
    if (this.counters.modelCalls === 0) return request;
    const config = this.options.deps.gatewayConfig?.current();
    const capability =
      config === undefined ? undefined : findConfiguredCapability(config, request.modelId);
    if (capability?.kind !== "chat") return request;
    return fitToolRoundOutput(
      request,
      deriveContextProfileFromCapability(capability),
      offeredDefinitions(this.managed, this.toolDefinitions, offered),
      {
        maxOutputTokens: capability.maxOutputTokens,
        reasoningHistoryField: config?.providers.find(
          (provider) => provider.modelId === request.modelId,
        )?.reasoningHistoryField,
      },
    );
  }
  /** The copy of the continuation sent this round, fitted to the model window (#4175). */
  private fittedContinuation(
    request: GatewayCallRequest,
    tools: readonly ToolDefinition[],
    continuation: readonly GatewayMessage[] = this.continuation,
  ): readonly GatewayMessage[] {
    const config = this.options.deps.gatewayConfig?.current();
    const capability =
      config === undefined ? undefined : findConfiguredCapability(config, request.modelId);
    if (capability?.kind !== "chat") return continuation;
    const output = request.maxOutputTokens ?? capability.maxOutputTokens;
    const profile = deriveContextProfileFromCapability(capability);
    const fixed = countGatewayPromptTokens(
      {
        ...request,
        tools,
        messages: request.messages,
      },
      profile.tokenAccounting,
      {
        contextWindow: profile.maxInputTokens,
        reasoningHistoryField: config?.providers.find(
          (provider) => provider.modelId === request.modelId,
        )?.reasoningHistoryField,
      },
    );
    const budget = Math.floor((capability.contextWindow - output) * CONTINUATION_WINDOW_SHARE);
    const fitted = fitToolContinuation(continuation, this.settledExchanges, budget - fixed);
    if (fitted.elidedCount > this.elidedResults) {
      this.elidedResults = fitted.elidedCount;
      recordChatToolTurnContextFitted(processServerLogSink(), {
        correlationId: this.options.correlationId,
        messageId: this.options.message.id,
        elidedResultCount: fitted.elidedCount,
        continuationMessageCount: continuation.length,
      });
    }
    return fitted.messages;
  }

  /** A bounded source-membership receipt, through the same offered catalog and authority as reads. */
  private async prepareKnowledgeInventory(): Promise<void> {
    const { deps, message } = this.options;
    const managed = this.managed;
    if (chatKnowledgeScopes(deps.store.findChatById(message.chatId)).length === 0) return;
    const tool = managed.projection.tools.find(
      (entry) => entry.toolRef.canonicalId === KNOWLEDGE_DOCUMENTS_TOOL_ID,
    );
    requireDispatch(tool !== undefined, "failed", "handler-unavailable");
    const offered = this.binder.offerTool(tool.toolRef);
    const args = { view: "inventory" };
    const callId = `runtime-inventory-${randomUUID()}`;
    this.incidentalKnowledgeReadCallIds.add(callId);
    await this.dispatch(
      {
        id: callId,
        name: tool.alias,
        arguments: args,
        invocation: {
          kind: "bound",
          toolRef: tool.toolRef,
          projectionDigest: managed.projection.projectionDigest,
          offerId: offered.offerId,
          arguments: args,
        },
      },
      "runtime",
    );
  }

  /**
   * A clean draft batch ends in Keiko's own `jira.draft` call for exactly the staged draft, so the
   * human meets the existing write approval instead of waiting for the model to ask. The call is
   * dispatched like any other: mode, approval, authority, budget and idempotency all still apply,
   * and its result reaches the model's next round like a model-issued one.
   */
  private offerBatchDrafts(calls: NormalizedResponse["toolCalls"]): Promise<void> {
    return this.settleToolCalls(calls, (call) => this.offerBatchDraft(call));
  }
  private async offerBatchDraft(call: NormalizedResponse["toolCalls"][number]): Promise<void> {
    if (
      call.invocation?.toolRef.canonicalId !== JIRA_DRAFT_BATCH_TOOL_ID ||
      this.offeredBatchCalls.has(call.id)
    )
      return;
    this.offeredBatchCalls.add(call.id);
    if (this.batchOfferEnded()) {
      this.recordBatchDraftOffer("turn-ended");
      return;
    }
    const stored = this.options.deps.store
      .findMessageById(this.options.message.id)
      ?.toolTranscript?.exchanges.find((exchange) => exchange.call.id === call.id);
    if (stored === undefined) {
      this.recordBatchDraftOffer("no-stored-result");
      return;
    }
    const decision = batchDraftDecision(stored);
    if (decision.kind === "skip") this.recordBatchDraftOffer(decision.reason);
    else await this.dispatchBatchDraft(decision);
  }
  /** One receipt settles before the next call; callback continuation retains no growing chain. */
  private settleToolCalls(
    calls: NormalizedResponse["toolCalls"],
    settle: (call: NormalizedResponse["toolCalls"][number]) => Promise<void>,
  ): Promise<void> {
    const remaining = calls.values();
    return new Promise<void>((resolve, reject) => {
      const next = (): void => {
        const call = remaining.next();
        if (call.done) {
          resolve();
          return;
        }
        // A flat chain: a synchronous throw in settle becomes a rejection that reaches the caller.
        void Promise.resolve(call.value).then(settle).then(next, reject);
      };
      next();
    });
  }
  /** A cancelled, early-ended or scope-changed turn never gets a draft offered on its behalf. */
  private batchOfferEnded(): boolean {
    return this.context.signal.aborted || this.endedEarly || this.scopeChangeEnded;
  }
  private recordBatchDraftOffer(decision: "dispatched" | BatchDraftSkipReason): void {
    recordChatToolBatchDraftOffer(processServerLogSink(), {
      correlationId: this.options.correlationId,
      messageId: this.options.message.id,
      decision,
    });
  }
  private async dispatchBatchDraft(draft: {
    readonly draftId: string;
    readonly draftDigest: string;
  }): Promise<void> {
    if (this.batchOfferEnded()) {
      this.recordBatchDraftOffer("turn-ended");
      return;
    }
    const tool = this.options.managed.projection.tools.find(
      (entry) => entry.toolRef.canonicalId === JIRA_DRAFT_TOOL_ID,
    );
    if (tool === undefined || this.counters.toolCalls >= this.limits.maxToolCalls) {
      this.recordBatchDraftOffer(tool === undefined ? "not-offered" : "budget-exhausted");
      return;
    }
    this.recordBatchDraftOffer("dispatched");
    const args = { draftId: draft.draftId, draftDigest: draft.draftDigest };
    await this.dispatch({
      id: `runtime-draft-${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      name: tool.alias,
      arguments: args,
      invocation: {
        kind: "bound",
        toolRef: tool.toolRef,
        projectionDigest: this.options.managed.projection.projectionDigest,
        offerId: this.binder.offerTool(tool.toolRef).offerId,
        arguments: args,
      },
    });
  }

  private async runRounds(
    model: ModelPort,
    request: GatewayCallRequest,
    signal: AbortSignal,
    observeRound?: (response: NormalizedResponse) => void,
    retryFollows?: (error: unknown) => boolean,
  ): Promise<NormalizedResponse> {
    this.requireRoundAdmission(request.modelId, signal);
    this.inventoryPreparation ??= this.prepareKnowledgeInventory().catch((error: unknown) => {
      this.inventoryPreparation = undefined;
      throw error;
    });
    await this.inventoryPreparation;
    return new Promise<NormalizedResponse>((resolve, reject) => {
      // Only this completion promise spans rounds; next never returns the next round's promise.
      const next = (): void => {
        void Promise.resolve()
          .then(() => this.runRound(model, request, signal, observeRound, retryFollows))
          .then((answer) => {
            if (answer === undefined) next();
            else resolve(answer);
          }, reject);
      };
      next();
    });
  }
  /** Admission, model usage and every tool receipt of this round precede the next round. */
  private async runRound(
    model: ModelPort,
    request: GatewayCallRequest,
    signal: AbortSignal,
    observeRound?: (response: NormalizedResponse) => void,
    retryFollows?: (error: unknown) => boolean,
  ): Promise<NormalizedResponse | undefined> {
    requireDispatch(
      this.counters.iterations < this.limits.maxIterations,
      "denied",
      "budget-exhausted",
    );
    this.admitRound(request.modelId, signal);
    const offered = this.binder.offer();
    const round = this.roundRequest(request, offered);
    const response = await this.callRound(model, round, signal, retryFollows);
    if (response === undefined) return undefined;
    observeRound?.(response);
    this.chargeUsage(response);
    if (response.toolCalls.length === 0) {
      const answer: NormalizedResponse = {
        ...response,
        usage: {
          ...response.usage,
          promptTokens: this.promptTokens,
          completionTokens: this.completionTokens,
        },
      };
      return this.correctAnswer(answer, request)
        ? undefined
        : this.knowledgeAnswer(this.withClaimNotice(answer, false));
    }
    requireDispatch(
      response.toolCalls.length <= this.limits.maxToolCalls - this.counters.toolCalls,
      "denied",
      "budget-exhausted",
    );
    const prepared = this.withCitationSources(response);
    this.retainToolResponse(request.modelId, prepared);
    await this.settleToolCalls(prepared.toolCalls, (call) => this.dispatch(call));
    await this.activateToolSelection();
    this.currentToolResponse = undefined;
    await this.offerBatchDrafts(prepared.toolCalls);
    this.correctedSinceProgress = false;
    return undefined;
  }

  /** What the turn's tools may read of it: the model it runs on and the sources `[n]` designates. */
  private turnReadouts(): {
    readonly knowledgeReviewModelId: () => string | undefined;
    readonly citationSources: () => ReadonlyMap<number, string>;
  } {
    return {
      knowledgeReviewModelId: (): string | undefined => this.activeModelId,
      citationSources: (): ReadonlyMap<number, string> => this.currentCitationLabels(),
    };
  }

  /**
   * Binds the `[n]` namespace of this turn to the evidence pack its synthesis sent, so a marker in
   * Jira text names that pack's source and never an earlier answer's of the same number.
   */
  bindEvidenceSources(sources: ReadonlyMap<number, string>): void {
    this.evidenceSources = sources;
  }

  /**
   * The sources the model's `[n]` markers designate: the current turn's evidence pack when it sent
   * one, otherwise the chat's latest grounded answer where no older answer defines the same number
   * differently. The same numeral of another turn is never a match, and an ambiguous one is left.
   */
  private currentCitationLabels(): ReadonlyMap<number, string> {
    if (this.evidenceSources !== undefined) return this.evidenceSources;
    const { deps, message } = this.options;
    if (this.citationLabels === undefined) {
      const messages = deps.store.listMessages(message.chatId);
      this.citationLabels = unambiguousCitationLabels(
        messages,
        message.id,
        latestCitationLabels(messages, message.id),
      );
    }
    return this.citationLabels;
  }

  /**
   * Jira text written from a grounded answer names its sources instead of copying the answer's
   * `[n]` markers (#4173 AC2). The rewrite happens before the call is recorded, reviewed or bound
   * to an approval, so the human approves exactly the text Jira receives.
   */
  private withCitationSources(response: NormalizedResponse): NormalizedResponse {
    const writes = response.toolCalls.filter((call) =>
      isJiraTextWrite(call.invocation?.toolRef.canonicalId),
    );
    if (writes.length === 0) return response;
    const { deps, correlationId } = this.options;
    const labels = this.currentCitationLabels();
    const counts = {
      callCount: writes.length,
      labelCount: labels.size,
      resolvedCount: 0,
      unresolvedCount: 0,
      markdownDescriptionCount: 0,
      unscannedTextCount: 0,
    };
    const toolCalls = response.toolCalls.map((call) => {
      if (call.invocation === undefined || !writes.includes(call)) return call;
      const rewrite = resolveJiraCitationMarkers(call.arguments, labels);
      counts.resolvedCount += rewrite.resolvedCount;
      counts.unresolvedCount += rewrite.unresolvedCount;
      counts.markdownDescriptionCount += rewrite.markdownDescriptionCount;
      counts.unscannedTextCount += rewrite.unscannedTextCount;
      const bound = boundArguments(call.invocation.arguments);
      // The shown and the dispatched arguments change together or not at all.
      if (rewrite.arguments === call.arguments || bound === undefined) return call;
      const invocation = {
        ...call.invocation,
        arguments: resolveJiraCitationMarkers(bound, labels).arguments as CatalogJsonObject,
      };
      return { ...call, arguments: rewrite.arguments, invocation };
    });
    recordJiraCitationMarkers(deps.activityLog, correlationId, counts);
    return { ...response, toolCalls };
  }

  private retainToolResponse(modelId: string, response: NormalizedResponse): void {
    const provider = this.options.deps.gatewayConfig
      ?.current()
      ?.providers.find((entry) => entry.modelId === modelId);
    if (provider?.reasoningHistory === undefined) return;
    this.currentToolResponse = response;
    this.continuation.push({
      role: "assistant",
      content: response.content,
      toolCalls: response.toolCalls,
    });
  }

  /** A failed physical call is charged here only when this turn consumes its failure. */
  private chargeFailedUsage(error: unknown): void {
    if (!(error instanceof GatewayError)) return;
    this.promptTokens += error.partialUsage?.promptTokens ?? 0;
    this.completionTokens += error.partialUsage?.completionTokens ?? 0;
  }

  /** Every round's usage, including attempts the gateway discarded, counts against the turn. */
  private chargeUsage(response: NormalizedResponse): void {
    this.promptTokens +=
      response.usage.promptTokens + (response.discardedAttemptUsage?.promptTokens ?? 0);
    this.completionTokens +=
      response.usage.completionTokens + (response.discardedAttemptUsage?.completionTokens ?? 0);
  }

  /**
   * An answer Keiko can check against its own tool results gets ONE further round carrying a fixed
   * correction: an answer that leaves out issues the turn's `jira.report` finding pages list (S11 of
   * epic #4173), one that gives a requirement other issues than its requirement pages state (S12),
   * or one that names issue keys of the turn's Jira projects no tool result and no
   * message shows (S01: an answer claimed a key after three refused creates). The model writes the
   * answer; Keiko only checks it. The round stays inside the Authority Envelope; a second answer
   * stands, and a failed round falls back to the first answer.
   */
  private correctAnswer(answer: NormalizedResponse, request: GatewayCallRequest): boolean {
    if (this.uncorrectedAnswer !== undefined) return false;
    if (this.counters.iterations >= this.limits.maxIterations) return false;
    const correction = this.answerCorrection(answer, request);
    if (correction === undefined) return false;
    this.uncorrectedAnswer = answer;
    this.uncorrectedExchangeCount = this.transcriptExchangeCount();
    this.continuation.push({ role: "assistant", content: answer.content });
    this.correction = { role: "system", content: correction.content };
    const kinds = correction.logs.map((log) => log.correctionKind);
    this.correctionWithoutTools = !correctionRoundOffersTools(kinds);
    this.claimedKinds = correction.logs.flatMap((log) =>
      log.correctionKind === "announced-create" || log.correctionKind === "tool-call-as-text"
        ? [log.correctionKind]
        : [],
    );
    this.claimedPersonText = lastPersonText(request.messages);
    for (const log of correction.logs)
      recordChatToolTurnCorrected(processServerLogSink(), {
        correlationId: this.options.correlationId,
        messageId: this.options.message.id,
        settledExchangeCount: this.settledExchanges.length,
        ...log,
      });
    return true;
  }

  private answerCorrection(
    answer: NormalizedResponse,
    request: GatewayCallRequest,
  ): { readonly content: string; readonly logs: readonly AnswerCorrectionLog[] } | undefined {
    const corrections: { readonly content: string; readonly log: AnswerCorrectionLog }[] = [];
    const omitted = omittedReportFindingKeys(this.settledExchanges, answer.content);
    if (omitted.length > 0)
      corrections.push({
        content: reportFindingCorrection(omitted),
        log: { correctionKind: "report-omission", omittedFindingCount: omitted.length },
      });
    const mismatched = reportCoverageMismatches(this.settledExchanges, answer.content);
    if (mismatched.length > 0)
      corrections.push({
        content: reportCoverageCorrection(mismatched),
        log: { correctionKind: "report-coverage", mismatchedRequirementCount: mismatched.length },
      });
    const context = [...request.messages, ...this.continuation].map((message) => message.content);
    const unsupported = unsupportedIssueKeys(this.settledExchanges, context, answer.content);
    if (unsupported.length > 0)
      corrections.push({
        content: unsupportedIssueKeyCorrection(unsupported),
        log: { correctionKind: "unsupported-issue-key", unsupportedKeyCount: unsupported.length },
      });
    corrections.push(...claimedActionCorrections(this.settledExchanges, answer.content, context));
    const coverage = knowledgeTurnCoverage(this.settledExchanges, {
      incidentalReadCallIds: [...this.incidentalKnowledgeReadCallIds],
    });
    const knowledge = coverage === undefined ? undefined : knowledgeCoverageCorrection(coverage);
    if (knowledge !== undefined && coverage !== undefined)
      corrections.push({
        content: knowledge,
        log: {
          correctionKind: "knowledge-coverage",
          pendingKnowledgePageCount: coverage.pendingPageCount,
        },
      });
    return corrections.length === 0
      ? undefined
      : {
          content: corrections.map((entry) => entry.content).join("\n\n"),
          logs: corrections.map((entry) => entry.log),
        };
  }

  /**
   * A tool call the gateway rejected again after its own schema correction ends neither the turn nor
   * the settled work behind it (S08 of epic #4173: Gemma's second `jira.create` without
   * `links[].type` ended the turn as a model failure), and neither does a round the model completed
   * with nothing at all (S07 and S19: Gemma, after a settled read). The next round carries a body-free
   * correction, once per streak: a round that dispatches a tool call restores the allowance, and a
   * second such round without progress ends the turn as before. Every round stays inside the
   * Authority Envelope's model-call budget; nothing was executed for the unusable round.
   */
  private async callRound(
    model: ModelPort,
    round: GatewayCallRequest,
    signal: AbortSignal,
    retryFollows?: (error: unknown) => boolean,
  ): Promise<NormalizedResponse | undefined> {
    try {
      const response = await model.call(round, this.context.signal);
      this.clearCorrection();
      return response;
    } catch (error) {
      if (this.retryKeepsTurnOpen(signal) && retryFollows?.(error) === true) throw error;
      const correction = this.correctedSinceProgress ? undefined : unusableRoundCorrection(error);
      // The turn ends here: a later synthesis pass that reuses it never inherits the correction.
      this.clearCorrection();
      if (correction === undefined || this.context.signal.aborted) throw error;
      this.chargeFailedUsage(error);
      this.correction = { role: "system", content: correction.content };
      this.correctedSinceProgress = true;
      this.correctionAdmissionPending = true;
      recordChatToolTurnCorrected(processServerLogSink(), {
        correlationId: this.options.correlationId,
        messageId: this.options.message.id,
        settledExchangeCount: this.settledExchanges.length,
        correctionKind: correction.kind,
      });
      return undefined;
    }
  }

  private clearCorrection(): void {
    this.correction = undefined;
    this.correctionWithoutTools = false;
    this.correctionAdmissionPending = false;
  }
}

/** The text of the person's last message, for the language of a fixed notice. */
function lastPersonText(messages: readonly GatewayMessage[]): string {
  const last = [...messages].reverse().find((message) => message.role === "user");
  return typeof last?.content === "string" ? last.content : "";
}

/**
 * What an answer claims that its own turn does not bear out (#4355): a created issue no create call
 * made, a tool call written as text, and internal report result keys printed as if they were prose.
 */
function claimedActionCorrections(
  exchanges: readonly ChatToolExchange[],
  answer: string,
  context: readonly string[],
): { readonly content: string; readonly log: AnswerCorrectionLog }[] {
  const announced = announcedCreateCount(exchanges, answer, context);
  const writtenCalls = toolCallsWrittenAsText(answer);
  const rawKeys = rawReportKeys(exchanges, answer);
  return [
    ...(announced === 0
      ? []
      : [
          {
            content: announcedCreateCorrection(announced),
            log: { correctionKind: "announced-create", announcementCount: announced } as const,
          },
        ]),
    ...(writtenCalls === 0
      ? []
      : [
          {
            content: toolCallAsTextCorrection(writtenCalls),
            log: { correctionKind: "tool-call-as-text", announcementCount: writtenCalls } as const,
          },
        ]),
    ...(rawKeys.length === 0
      ? []
      : [
          {
            content: rawReportKeyCorrection(rawKeys),
            log: { correctionKind: "raw-report-key", rawReportKeyCount: rawKeys.length } as const,
          },
        ]),
  ];
}

const EMPTY_ROUND_CORRECTION =
  "Your previous answer was empty. Call the next tool now, or give the final answer.";

/**
 * What the next round tells the model after a round the turn could not use. The gateway leaves an
 * answer with nothing in it as the model's final word (#3610), and a turn has a next round to give;
 * one whose steered repair already failed has had its correction.
 */
function unusableRoundCorrection(
  error: unknown,
): { readonly content: string; readonly kind: "tool-schema" | "empty-answer" } | undefined {
  if (error instanceof GatewayToolCatalogError) {
    const content = error.correction();
    return content === undefined ? undefined : { content, kind: "tool-schema" };
  }
  return error instanceof ProviderEmptyAnswerError && error.outputRepair === undefined
    ? { content: EMPTY_ROUND_CORRECTION, kind: "empty-answer" }
    : undefined;
}

/** Tool rounds are withheld until their complete result identifies final text or an invocation. */
async function collectToolRound(
  stream: AsyncIterable<GatewayStreamChunk>,
): Promise<NormalizedResponse> {
  for await (const chunk of stream) if (chunk.type === "done") return chunk.response;
  throw new Error("Chat provider stream ended without completion.");
}

/** Consumer-facing turn operations, independent of a provider adapter's private fields. */
export type ChatToolTurnPort = Pick<
  ChatToolTurn,
  | "onTranscript"
  | "hasUsableObservation"
  | "meter"
  | "stream"
  | "call"
  | "signal"
  | "deadlineAtMs"
  | "answersAtDeadline"
  | "answersAfterScopeChange"
  | "endedEarly"
  | "reportsToolAction"
  | "reportEvidence"
  | "readOnlySynthesisRequest"
  | "settleRetryFailure"
  | "bindEvidenceSources"
>;

/** Source-specific authority adapters use the same catalog/log/budget and invocation registry wiring. */
export function bindChatToolCatalog<Consumer extends CatalogConsumer>(options: {
  readonly deps: Pick<UiHandlerDeps, "diagnostics">;
  readonly managed: ManagedProviderCatalog<Consumer>;
  readonly context: Consumer["context"];
  readonly consumerPort: CatalogConsumerPort<Consumer>;
  readonly admission: Pick<CatalogToolBinderInput<Consumer>, "authorityPort" | "approvalPort">;
  readonly budgetPort: CatalogToolBudgetPort<Consumer>;
  readonly invocationRegistry?: CodingToolInvocationRegistry;
}): CatalogToolBinder {
  const { deps, managed, context, consumerPort, admission, budgetPort } = options;
  return createCatalogToolBinder<Consumer>(
    {
      ...admission,
      consumerPort,
      projection: managed.projection,
      handlerBindings: managed.handlerBindings,
      budgetPort,
      logPort: {
        primary: processServerLogSink(),
        diagnostics: deps.diagnostics ?? defaultServerDiagnosticSink,
      },
    },
    {
      catalog: managed.catalog,
      context: () => context,
      now: Date.now,
      mintId: randomUUID,
      invocationRegistry:
        options.invocationRegistry ?? createCodingToolInvocationRegistry({ now: Date.now }),
    },
  );
}
