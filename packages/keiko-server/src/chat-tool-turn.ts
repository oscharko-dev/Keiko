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
} from "@oscharko-dev/keiko-contracts";
import type {
  CatalogConsumerPort,
  CatalogToolBinderInput,
  CatalogToolBudgetPort,
} from "./tool-catalog/catalogToolPorts.js";
import { gatewayMessagesForToolExchange } from "./conversation-gateway.js";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import {
  DEFAULT_LIMITS,
  createHarnessCatalogBudget,
  type ModelPort,
} from "@oscharko-dev/keiko-harness";
import {
  findConfiguredCapability,
  toolCallingConfigurationFingerprint,
  type GatewayCallRequest,
  type NormalizedResponse,
  type GatewayStreamChunk,
} from "@oscharko-dev/keiko-model-gateway";
import { isToolCallingVerificationFresh } from "@oscharko-dev/keiko-contracts/runtime/gateway";
import type { ChatMessage as GatewayMessage, RunCounters } from "@oscharko-dev/keiko-contracts";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ToolConsumerContext } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import type { ToolResultEnvelope } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ChatMessage } from "./store/index.js";
import type { UiHandlerDeps } from "./deps.js";
import type { CatalogConsumer, CatalogToolBinder } from "./tool-catalog/catalogToolPorts.js";
import type { ManagedProviderCatalog } from "./tool-catalog/managedProviderCatalog.js";
import { requireDispatch } from "./tool-catalog/catalogToolErrors.js";

const TOOL_TURN_INSTRUCTION: GatewayMessage = {
  role: "system",
  content:
    "When the user requests an operation supported by an offered tool, invoke the matching tool to request Keiko's required read consent or action approval. Keiko presents the actual consent or approval control and waits for any required decision before the effect. Asking for permission in prose does not open or replace those controls. Invoke modifying tools only when the user has actually requested that change. Server authority, mode, consent, approval and budget checks remain binding.",
};

type ModelAttempt = NonNullable<GatewayCallRequest["attemptAdmission"]>;
export interface ChatToolTurnOptions<Context extends ToolConsumerContext> {
  readonly deps: Pick<UiHandlerDeps, "store" | "gatewayConfig" | "atlassianActionApprovalRegistry">;
  readonly message: ChatMessage;
  readonly context: Context;
  readonly managed: Pick<ManagedProviderCatalog<CatalogConsumer>, "catalog" | "projection">;
  readonly correlationId: string;
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
  private usableObservation = false;
  private readonly callIds = new Set<string>();
  private notify: ((message: ChatMessage) => void | Promise<void>) | undefined;
  private uncertainBudget = false;
  private readonly abortController = new AbortController();
  private promptTokens = 0;
  private completionTokens = 0;
  protected constructor(private readonly options: ChatToolTurnOptions<Context>) {
    this.context = {
      ...options.context,
      signal: AbortSignal.any([options.context.signal, this.abortController.signal]),
    };
    this.budget = createHarnessCatalogBudget({
      ...this.context,
      counters: this.counters,
      limits: DEFAULT_LIMITS,
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
  } {
    return {
      requestReadConsent: (grant, signal) => this.waitForReadConsent(grant, signal),
      requestWriteConsent: (approval, signal) => this.waitForWriteConsent(approval, signal),
      reviewableWrite: (action) => this.reviewableWrite(action),
    };
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
      this.counters.modelCalls >= DEFAULT_LIMITS.maxModelCalls ||
      !this.reservePrompt(promptTokens)
    )
      return undefined;
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
  private requestForAttempt(request: GatewayCallRequest): GatewayCallRequest {
    return {
      ...request,
      attemptAdmission: (input): ReturnType<ModelAttempt> => {
        const existing = request.attemptAdmission?.(input);
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
  private appendObservedExchange(id: string): void {
    const stored = this.options.deps.store
      .findMessageById(this.options.message.id)
      ?.toolTranscript?.exchanges.find((exchange) => exchange.call.id === id);
    requireDispatch(stored?.result !== undefined, "invalid", "recovery-required");
    this.continuation.push(...gatewayMessagesForToolExchange(stored));
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
    requireDispatch(!signal.aborted && !this.context.signal.aborted, "denied", "authority-invalid");
    if (response.content.length > 0) yield { type: "delta", token: response.content };
    yield { type: "done", response };
  }

  private admitRound(modelId: string, signal: AbortSignal): void {
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
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  private async runRounds(
    model: ModelPort,
    request: GatewayCallRequest,
    signal: AbortSignal,
    observeRound?: (response: NormalizedResponse) => void,
  ): Promise<NormalizedResponse> {
    const { managed } = this.options;
    while (this.counters.iterations < DEFAULT_LIMITS.maxIterations) {
      this.admitRound(request.modelId, signal);
      const offered = this.binder.offer();
      const response = await model.call(
        {
          ...request,
          stream: false,
          messages: [TOOL_TURN_INSTRUCTION, ...request.messages, ...this.continuation],
          toolCatalog: {
            kind: "bound",
            catalog: managed.catalog,
            projection: managed.projection,
            offered,
          },
        },
        this.context.signal,
      );
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
        response.toolCalls.length <= DEFAULT_LIMITS.maxToolCalls - this.counters.toolCalls,
        "denied",
        "budget-exhausted",
      );
      for (const call of response.toolCalls) await this.dispatch(call);
    }
    requireDispatch(false, "denied", "budget-exhausted");
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
  "onTranscript" | "hasUsableObservation" | "meter" | "stream" | "call" | "signal" | "deadlineAtMs"
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
