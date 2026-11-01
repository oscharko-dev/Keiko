import { randomUUID } from "node:crypto";
import { createCatalogToolBinder } from "./tool-catalog/catalogToolDispatch.js";
import { createCodingToolInvocationRegistry } from "./coding-runtime/codingToolInvocationRegistry.js";
import { processServerLogSink } from "./process-log-sink.js";
import { defaultServerDiagnosticSink } from "./diagnostics-log.js";
import {
  waitForChatToolReadConsent,
  waitForChatToolWriteConsent,
  refreshChatToolWriteApproval,
  type ChatToolApprovalContext,
} from "./chat-tool-approvals.js";
import type {
  ChatToolReadGrantView,
  ChatToolWriteApprovalView,
  ChatMessage as GatewayMessage,
  RunCounters,
} from "@oscharko-dev/keiko-contracts";
import type {
  CatalogConsumerPort,
  CatalogToolBinderInput,
  CatalogToolBudgetPort,
  CatalogConsumer,
  CatalogToolBinder,
} from "./tool-catalog/catalogToolPorts.js";
import { gatewayMessagesForToolExchange } from "./conversation-gateway.js";
import { parseJiraDraft } from "@oscharko-dev/keiko-connectors";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import { createHarnessCatalogBudget, type ModelPort } from "@oscharko-dev/keiko-harness";
import type { HarnessLimits } from "@oscharko-dev/keiko-contracts/runtime/harness";
import type { ChatToolAuthorityEnvelope } from "@oscharko-dev/keiko-contracts/runtime/chat-tool-authority";
import { chatToolTurnLimits } from "./chat-tool-turn-budget.js";
import {
  chatToolTurnEndReason,
  chatToolTurnPartialAnswer,
  recordChatToolTurnContextFitted,
  recordChatToolTurnCorrected,
  recordChatToolTurnEnded,
} from "./chat-tool-turn-ending.js";
import { estimateGatewayMessageTokens, fitToolContinuation } from "./chat-tool-continuation-fit.js";
import { estimateTokens } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import {
  findConfiguredCapability,
  GatewayToolCatalogError,
  toolCallingConfigurationFingerprint,
  type GatewayCallRequest,
  type NormalizedResponse,
  type GatewayStreamChunk,
} from "@oscharko-dev/keiko-model-gateway";
import { isToolCallingVerificationFresh } from "@oscharko-dev/keiko-contracts/runtime/gateway";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ToolConsumerContext } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import type { ToolResultEnvelope } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ChatMessage } from "./store/index.js";
import {
  CHAT_TOOL_TRANSCRIPT_BASE_BYTES,
  CHAT_TOOL_TRANSCRIPT_MAX_BYTES,
  chatToolExchangeReservation,
} from "./store/chatToolTranscript.js";
import type { UiHandlerDeps } from "./deps.js";
import type { ManagedProviderCatalog } from "./tool-catalog/managedProviderCatalog.js";
import { requireDispatch } from "./tool-catalog/catalogToolErrors.js";

const TOOL_TURN_RULES =
  "When the user requests an operation supported by an offered tool, invoke the matching tool to request Keiko's required read consent or action approval. Keiko presents the actual consent or approval control and waits for any required decision before the effect. Asking for permission in prose does not open or replace those controls. Invoke modifying tools only when the user has actually requested that change. Server authority, mode, consent, approval and budget checks remain binding.";
const TOOL_TURN_INSTRUCTION: GatewayMessage = { role: "system", content: TOOL_TURN_RULES };

// Local estimates are not provider counts; the margin keeps the gateway's exact admission and its
// one context-window retry as the authority.
const CONTINUATION_WINDOW_SHARE = 0.8;
type ModelAttempt = NonNullable<GatewayCallRequest["attemptAdmission"]>;
export interface ChatToolTurnOptions<Context extends ToolConsumerContext> {
  readonly deps: Pick<UiHandlerDeps, "store" | "gatewayConfig" | "atlassianActionApprovalRegistry">;
  readonly message: ChatMessage;
  readonly context: Context;
  readonly managed: Pick<ManagedProviderCatalog<CatalogConsumer>, "catalog" | "projection">;
  readonly correlationId: string;
  /** The accepted Authority Envelope budget; it is the turn's only duration and call bound. */
  readonly budget: ChatToolAuthorityEnvelope["budget"];
  /** Rules shared by every offered tool of a source, said once instead of in each description. */
  readonly guidance?: string;
  readonly bind: (
    context: Context,
    budget: ReturnType<typeof createHarnessCatalogBudget>["port"],
  ) => CatalogToolBinder;
}
export function chatModelSupportsTools(
  deps: Pick<UiHandlerDeps, "gatewayConfig">,
  modelId: string,
): boolean {
  const config = deps.gatewayConfig?.current();
  if (config === undefined) return false;
  const provider = config.providers.find((candidate) => candidate.modelId === modelId);
  const capability = findConfiguredCapability(config, modelId);
  return (
    provider !== undefined &&
    capability?.kind === "chat" &&
    capability.toolCalling &&
    capability.toolCallingVerification?.configurationFingerprint ===
      toolCallingConfigurationFingerprint(provider) &&
    isToolCallingVerificationFresh(capability.toolCallingVerification, { nowMs: Date.now() })
  );
}

/** Shared bounded tool loop; provider adapters own authority, consent and mutation settlement. */
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
  private readonly continuation: GatewayMessage[] = [];
  private readonly settledExchanges: ChatToolExchange[] = [];
  private usableObservation = false;
  private readonly callIds = new Set<string>();
  private notify: ((message: ChatMessage) => void | Promise<void>) | undefined;
  private uncertainBudget = false;
  /** The turn's own envelope refused a model attempt; the caller's caps are not this turn's. */
  private envelopeRefusedAttempt = false;
  /** The transcript-built answer of a turn that ended early; it may outlive the turn's signal. */
  private endedAnswer: NormalizedResponse | undefined;
  private readonly abortController = new AbortController();
  private promptTokens = 0;
  private completionTokens = 0;
  private readonly limits: HarnessLimits;
  private elidedResults = 0;
  private reservedTranscriptBytes = CHAT_TOOL_TRANSCRIPT_BASE_BYTES;
  private readonly instruction: GatewayMessage;
  /** The correction the next round carries after the gateway's own correction was rejected too. */
  private correction: GatewayMessage | undefined;
  /** The turn corrected a rejected call and no round has dispatched a tool call since. */
  private correctedSinceProgress = false;
  /** The first admission of a correction round follows an attempt the turn could not use. */
  private correctionAdmissionPending = false;
  protected constructor(private readonly options: ChatToolTurnOptions<Context>) {
    this.instruction =
      options.guidance === undefined
        ? TOOL_TURN_INSTRUCTION
        : { role: "system", content: `${TOOL_TURN_RULES} ${options.guidance}` };
    this.context = {
      ...options.context,
      signal: AbortSignal.any([options.context.signal, this.abortController.signal]),
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
  private get binder(): CatalogToolBinder {
    this.bound ??= this.options.bind(this.context, this.budget.port);
    return this.bound;
  }
  protected abstract reserveAuthorityPrompt(promptTokens: number): boolean;
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
  protected waitForReadConsent(grant: ChatToolReadGrantView, signal: AbortSignal): Promise<void> {
    return waitForChatToolReadConsent(this.approvalContext(signal), grant);
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
      requestReadConsent: (grant, signal) => this.waitForReadConsent(grant, signal),
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
  private reservePrompt(promptTokens: number): boolean {
    return (
      !this.uncertainBudget &&
      !this.context.signal.aborted &&
      this.reserveAuthorityPrompt(promptTokens)
    );
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
  private readonly admitAttempt: ModelAttempt = ({ promptTokens }) => {
    if (
      this.counters.modelCalls >= this.limits.maxModelCalls ||
      !this.reservePrompt(promptTokens)
    ) {
      this.envelopeRefusedAttempt = true;
      return undefined;
    }
    this.counters.modelCalls++;
    let settled = false;
    return {
      settle: (usage): void => {
        if (settled) return;
        settled = true;
        if (
          usage !== undefined &&
          usage.promptTokens > promptTokens &&
          !this.reservePrompt(usage.promptTokens - promptTokens)
        )
          this.uncertainBudget = true;
      },
    };
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
      requireDispatch(
        this.counters.modelCalls > before && !this.uncertainBudget,
        "denied",
        "budget-exhausted",
      );
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
        requireDispatch(
          this.counters.modelCalls > before && !this.uncertainBudget,
          "denied",
          "budget-exhausted",
        );
        return response;
      },
      ...(model.callStream === undefined
        ? {}
        : { callStream: (request, signal) => this.meteredStream(model, request, signal) }),
    };
  }
  private async dispatch(call: NormalizedResponse["toolCalls"][number]): Promise<void> {
    const { deps, message, correlationId, managed } = this.options;
    requireDispatch(
      call.invocation !== undefined && !this.callIds.has(call.id),
      "invalid",
      "replay-conflict",
    );
    this.callIds.add(call.id);
    const publicCall = { id: call.id, name: call.name, arguments: call.arguments };
    this.reserveTranscript(publicCall, call.invocation.toolRef.canonicalId);
    deps.store.updateChatToolTranscript(
      message.id,
      { kind: "started", call: publicCall },
      correlationId,
    );
    await this.publish();
    const identity = sha256Hex(canonicalise({ messageId: message.id, callId: call.id }));
    const outcome = await this.binder.dispatch(call.invocation, {
      actionId: identity,
      idempotencyKey: identity,
    });
    requireDispatch(outcome.kind === "settled", "invalid", "recovery-required");
    this.refreshWriteApproval(call.id);
    const descriptor = managed.catalog.descriptors.find(
      (entry) => entry.toolRef.canonicalId === call.invocation?.toolRef.canonicalId,
    );
    requireDispatch(descriptor !== undefined, "invalid", "recovery-required");
    this.budget.acceptReceipt(outcome.receipt, descriptor);
    const mutationOutcome = this.observedMutation(call, identity, outcome.result);
    deps.store.updateChatToolTranscript(
      message.id,
      {
        kind: "settled",
        callId: call.id,
        result: outcome.result,
        binding: { descriptor, projectionDigest: managed.projection.projectionDigest },
        ...(mutationOutcome === undefined ? {} : { mutationOutcome }),
      },
      correlationId,
    );
    this.appendObservedExchange(call.id);
    await this.publish();
  }
  /** A call whose worst-case exchange no longer fits the stored transcript ends the turn. */
  private reserveTranscript(call: ChatToolExchange["call"], canonicalId: string): void {
    const descriptor = this.options.managed.catalog.descriptors.find(
      (entry) => entry.toolRef.canonicalId === canonicalId,
    );
    requireDispatch(descriptor !== undefined, "invalid", "recovery-required");
    const reserved = this.reservedTranscriptBytes + chatToolExchangeReservation(call, descriptor);
    requireDispatch(reserved <= CHAT_TOOL_TRANSCRIPT_MAX_BYTES, "denied", "budget-exhausted");
    this.reservedTranscriptBytes = reserved;
  }
  private appendObservedExchange(id: string): void {
    const stored = this.options.deps.store
      .findMessageById(this.options.message.id)
      ?.toolTranscript?.exchanges.find((exchange) => exchange.call.id === id);
    requireDispatch(stored?.result !== undefined, "invalid", "recovery-required");
    this.continuation.push(...gatewayMessagesForToolExchange(stored));
    this.settledExchanges.push(stored);
    // Only this turn's validated, redacted result actually published to the model is evidence.
    // A successful empty list is useful; a settled denial, failure or missing payload is not.
    if (
      stored.result.status === "completed" &&
      stored.result.data !== null &&
      (stored.mutationOutcome === undefined || stored.mutationOutcome === "succeeded")
    )
      this.usableObservation = true;
  }

  public async *stream(
    callStream: NonNullable<ModelPort["callStream"]>,
    request: GatewayCallRequest,
    signal: AbortSignal,
  ): AsyncIterable<GatewayStreamChunk> {
    const response = await this.call(
      {
        call: (round, abort): Promise<NormalizedResponse> =>
          collectToolRound(callStream({ ...round, stream: true }, abort)),
      },
      request,
      signal,
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
    // A round past the envelope's tool-call budget could only be refused after a model call.
    requireDispatch(
      this.counters.toolCalls < this.limits.maxToolCalls,
      "denied",
      "budget-exhausted",
    );
    this.counters.iterations++;
    requireDispatch(
      !signal.aborted && !this.context.signal.aborted && !this.uncertainBudget,
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
  ): Promise<NormalizedResponse> {
    const cancel = (): void => {
      this.abortController.abort();
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    try {
      return await this.runRounds(model, request, signal, observeRound);
    } catch (error) {
      const partial = this.partialAnswer(error, request.modelId, signal);
      if (partial === undefined) throw error;
      return partial;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
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
    const reason = expired
      ? "deadline"
      : chatToolTurnEndReason(error, { envelopeRefusedAttempt: this.envelopeRefusedAttempt });
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

  /** True once the turn answered from its transcript; callers must deliver, not cancel, it. */
  public get endedEarly(): boolean {
    return this.endedAnswer !== undefined;
  }

  private roundRequest(
    request: GatewayCallRequest,
    offered: ReturnType<CatalogToolBinder["offer"]>,
  ): GatewayCallRequest {
    const { managed } = this.options;
    return {
      ...request,
      stream: false,
      messages: [
        this.instruction,
        ...request.messages,
        ...this.fittedContinuation(request),
        ...(this.correction === undefined ? [] : [this.correction]),
      ],
      toolCatalog: {
        kind: "bound",
        catalog: managed.catalog,
        projection: managed.projection,
        offered,
      },
    };
  }
  /** The copy of the continuation sent this round, fitted to the model window (#4175). */
  private fittedContinuation(request: GatewayCallRequest): readonly GatewayMessage[] {
    const config = this.options.deps.gatewayConfig?.current();
    const capability =
      config === undefined ? undefined : findConfiguredCapability(config, request.modelId);
    if (capability?.kind !== "chat") return this.continuation;
    const output = request.maxOutputTokens ?? capability.maxOutputTokens;
    const fixed =
      estimateGatewayMessageTokens([this.instruction, ...request.messages]) +
      estimateTokens(JSON.stringify(this.options.managed.projection));
    const budget = Math.floor((capability.contextWindow - output) * CONTINUATION_WINDOW_SHARE);
    const fitted = fitToolContinuation(this.continuation, this.settledExchanges, budget - fixed);
    if (fitted.elidedCount > this.elidedResults) {
      this.elidedResults = fitted.elidedCount;
      recordChatToolTurnContextFitted(processServerLogSink(), {
        correlationId: this.options.correlationId,
        messageId: this.options.message.id,
        elidedResultCount: fitted.elidedCount,
        continuationMessageCount: this.continuation.length,
      });
    }
    return fitted.messages;
  }

  private async runRounds(
    model: ModelPort,
    request: GatewayCallRequest,
    signal: AbortSignal,
    observeRound?: (response: NormalizedResponse) => void,
  ): Promise<NormalizedResponse> {
    while (this.counters.iterations < this.limits.maxIterations) {
      this.admitRound(request.modelId, signal);
      const offered = this.binder.offer();
      const round = this.roundRequest(request, offered);
      const response = await this.callRound(model, round); // NOSONAR typescript:S9382 -- each round depends on the previous round's results
      if (response === undefined) continue;
      observeRound?.(response);
      this.promptTokens +=
        response.usage.promptTokens + (response.discardedAttemptUsage?.promptTokens ?? 0);
      this.completionTokens +=
        response.usage.completionTokens + (response.discardedAttemptUsage?.completionTokens ?? 0);
      if (response.toolCalls.length === 0)
        return {
          ...response,
          usage: {
            ...response.usage,
            promptTokens: this.promptTokens,
            completionTokens: this.completionTokens,
          },
        };
      requireDispatch(
        response.toolCalls.length <= this.limits.maxToolCalls - this.counters.toolCalls,
        "denied",
        "budget-exhausted",
      );
      for (const call of response.toolCalls) await this.dispatch(call); // NOSONAR typescript:S9382 -- dispatches share authority/budgets; receipts, mutation journals and transcripts must settle before the next admission
      this.correctedSinceProgress = false;
    }
    requireDispatch(false, "denied", "budget-exhausted");
  }

  /**
   * A tool call the gateway rejected again after its own schema correction ends neither the turn nor
   * the settled work behind it (S08 of epic #4173: Gemma's second `jira.create` without
   * `links[].type` ended the turn as a model failure). The next round carries the same body-free
   * correction, once per streak: a round that dispatches a tool call restores the allowance, and a
   * second rejection without progress ends the turn as before. Every round stays inside the
   * Authority Envelope's model-call and prompt budget; nothing was executed for the rejected call.
   */
  private async callRound(
    model: ModelPort,
    round: GatewayCallRequest,
  ): Promise<NormalizedResponse | undefined> {
    try {
      const response = await model.call(round, this.context.signal);
      this.correction = undefined;
      this.correctionAdmissionPending = false;
      return response;
    } catch (error) {
      const correction =
        error instanceof GatewayToolCatalogError && !this.correctedSinceProgress
          ? error.correction()
          : undefined;
      // The turn ends here: a later synthesis pass that reuses it never inherits the correction.
      this.correction = undefined;
      this.correctionAdmissionPending = false;
      if (correction === undefined || this.context.signal.aborted) throw error;
      this.correction = { role: "system", content: correction };
      this.correctedSinceProgress = true;
      this.correctionAdmissionPending = true;
      recordChatToolTurnCorrected(processServerLogSink(), {
        correlationId: this.options.correlationId,
        messageId: this.options.message.id,
        settledExchangeCount: this.settledExchanges.length,
      });
      return undefined;
    }
  }
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
  | "endedEarly"
>;

/** Source-specific authority adapters use the same catalog/log/budget and invocation registry wiring. */
export function bindChatToolCatalog<Consumer extends CatalogConsumer>(options: {
  readonly deps: Pick<UiHandlerDeps, "diagnostics">;
  readonly managed: ManagedProviderCatalog<Consumer>;
  readonly context: Consumer["context"];
  readonly consumerPort: CatalogConsumerPort<Consumer>;
  readonly admission: Pick<CatalogToolBinderInput<Consumer>, "authorityPort" | "approvalPort">;
  readonly budgetPort: CatalogToolBudgetPort<Consumer>;
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
      invocationRegistry: createCodingToolInvocationRegistry({ now: Date.now }),
    },
  );
}
