import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import { randomUUID } from "node:crypto";
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
import type {
  ChatMessage as GatewayMessage,
  ChatToolReadGrantView,
  RunCounters,
} from "@oscharko-dev/keiko-contracts";
import type { ChatMessage } from "../store/index.js";
import type { UiHandlerDeps } from "../deps.js";
import { processServerLogSink } from "../process-log-sink.js";
import { defaultServerDiagnosticSink } from "../diagnostics-log.js";
import { correlationIdOrUnknown } from "../correlation.js";
import { createCatalogToolBinder } from "../tool-catalog/catalogToolDispatch.js";
import { createCodingToolInvocationRegistry } from "../coding-runtime/codingToolInvocationRegistry.js";
import { requireDispatch } from "../tool-catalog/catalogToolErrors.js";
import {
  mintAcceptedJiraChatAuthority,
  reserveCurrentJiraChatAuthority,
  type JiraChatAuthorityDeps,
} from "./jiraChatAuthority.js";
import {
  createJiraChatCatalogAdmission,
  jiraChatCatalogConsumerPort,
  type JiraChatCatalogConsumer,
  type JiraChatCatalogContext,
} from "./jiraChatCatalogConsumer.js";
import type { ManagedProviderCatalog } from "../tool-catalog/managedProviderCatalog.js";
import { projectChatReadGrant } from "./chatReadGrantState.js";

type TurnDeps = JiraChatAuthorityDeps &
  Pick<
    UiHandlerDeps,
    "jiraChatCatalog" | "gatewayConfig" | "atlassianActionApprovalRegistry" | "diagnostics"
  >;
type Accepted = Extract<ReturnType<typeof mintAcceptedJiraChatAuthority>, { ok: true }>;
type ModelAttempt = NonNullable<GatewayCallRequest["attemptAdmission"]>;
interface TurnOptions {
  readonly deps: TurnDeps;
  readonly message: ChatMessage;
  readonly authority: Accepted;
  readonly managed: ManagedProviderCatalog<JiraChatCatalogConsumer>;
  readonly signal: AbortSignal;
  readonly correlationId: string;
}
export function jiraChatModelSupportsTools(
  deps: Pick<TurnDeps, "gatewayConfig">,
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

/** One accepted ordinary Chat turn; the existing registry and Harness own its cumulative budgets. */
export class JiraChatToolTurn {
  private readonly counters: RunCounters = {
    iterations: 0,
    modelCalls: 0,
    toolCalls: 0,
    commandExecutions: 0,
    failureAttempts: 0,
    browserNavigations: 0,
  };
  private readonly context: JiraChatCatalogContext;
  private readonly budget: ReturnType<typeof createHarnessCatalogBudget>;
  private readonly binder: ReturnType<typeof createCatalogToolBinder<JiraChatCatalogConsumer>>;
  private readonly continuation: GatewayMessage[] = [];
  private readonly callIds = new Set<string>();
  private notify: ((message: ChatMessage) => void | Promise<void>) | undefined;
  private uncertainBudget = false;
  private promptTokens = 0;
  private completionTokens = 0;
  public constructor(private readonly options: TurnOptions) {
    const { authority, deps, managed, signal, correlationId, message } = options;
    this.context = {
      runId: authority.envelope.runId,
      correlationId,
      chatId: message.chatId,
      authority: authority.reference.envelopeDigest,
      authorityReference: authority.reference,
      authorityExpiresAt: authority.envelope.expiresAt,
      deadlineAt: authority.envelope.expiresAt,
      signal,
    };
    this.budget = createHarnessCatalogBudget({
      ...this.context,
      counters: this.counters,
      limits: DEFAULT_LIMITS,
      now: Date.now,
      deadlineAt: Date.parse(authority.envelope.expiresAt),
    });
    this.binder = createCatalogToolBinder<JiraChatCatalogConsumer>(
      {
        ...createJiraChatCatalogAdmission({
          deps,
          context: () => this.context,
          now: Date.now,
          requestReadConsent: (grant) => this.waitForConsent(grant),
        }),
        consumerPort: jiraChatCatalogConsumerPort,
        projection: managed.projection,
        handlerBindings: managed.handlerBindings,
        budgetPort: this.budget.port,
        logPort: {
          primary: processServerLogSink(),
          diagnostics: deps.diagnostics ?? defaultServerDiagnosticSink,
        },
      },
      {
        catalog: managed.catalog,
        context: () => this.context,
        now: Date.now,
        mintId: randomUUID,
        invocationRegistry: createCodingToolInvocationRegistry({ now: Date.now }),
      },
    );
  }
  public onTranscript(listener: (message: ChatMessage) => void | Promise<void>): void {
    this.notify = listener;
  }
  private async publish(): Promise<void> {
    const message = this.options.deps.store.findMessageById(this.options.message.id);
    if (message !== undefined) await this.notify?.(message);
  }
  private async waitForConsent(grant: ChatToolReadGrantView): Promise<void> {
    const { deps, message, correlationId, signal } = this.options;
    const registry = deps.atlassianActionApprovalRegistry;
    requireDispatch(registry !== undefined, "denied", "approval-required");
    deps.store.updateChatToolTranscript(message.id, { kind: "read-consent", grant }, correlationId);
    await this.publish();
    await registry.waitForChatReadGrant(grant.grantId, signal);
    const current = registry.getChatReadGrant(grant.grantId, correlationId);
    const view =
      current === undefined
        ? { ...grant, state: "expired" as const }
        : projectChatReadGrant(current.grant);
    deps.store.updateChatToolTranscript(
      message.id,
      { kind: "read-consent", grant: view },
      correlationId,
    );
    await this.publish();
  }
  private reservePrompt(promptTokens: number): boolean {
    const { deps, message, authority, correlationId } = this.options;
    return (
      !this.uncertainBudget &&
      !this.context.signal.aborted &&
      reserveCurrentJiraChatAuthority(
        deps,
        message.chatId,
        authority.reference,
        { toolCalls: 0, promptTokens, patchBytes: 0 },
        new Date().toISOString(),
        correlationId,
      ).ok
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
    const descriptor = managed.catalog.descriptors.find(
      (entry) => entry.toolRef.canonicalId === call.invocation?.toolRef.canonicalId,
    );
    requireDispatch(descriptor !== undefined, "invalid", "recovery-required");
    this.budget.acceptReceipt(outcome.receipt, descriptor);
    deps.store.updateChatToolTranscript(
      message.id,
      {
        kind: "settled",
        callId: call.id,
        result: outcome.result,
        binding: { descriptor, projectionDigest: managed.projection.projectionDigest },
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
    this.continuation.push(
      { role: "assistant", content: "", toolCalls: [stored.call] },
      { role: "tool", toolCallId: id, content: JSON.stringify(stored.result) },
    );
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
      jiraChatModelSupportsTools(this.options.deps, modelId),
      "denied",
      "authority-invalid",
    );
  }

  public async call(
    model: ModelPort,
    request: GatewayCallRequest,
    signal: AbortSignal,
  ): Promise<NormalizedResponse> {
    const { managed } = this.options;
    while (this.counters.iterations < DEFAULT_LIMITS.maxIterations) {
      this.admitRound(request.modelId, signal);
      const offered = this.binder.offer();
      const response = await model.call(
        {
          ...request,
          stream: false,
          messages: [...request.messages, ...this.continuation],
          toolCatalog: {
            kind: "bound",
            catalog: managed.catalog,
            projection: managed.projection,
            offered,
          },
        },
        this.context.signal,
      );
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
  throw new Error("Jira Chat provider stream ended without completion.");
}

export async function createJiraChatToolTurn(
  deps: TurnDeps,
  modelId: string,
  message: ChatMessage,
  signal: AbortSignal,
  correlationId: string | undefined,
): Promise<JiraChatToolTurn | undefined> {
  if (
    deps.store.findChatById(message.chatId)?.jiraPodBinding === undefined ||
    !jiraChatModelSupportsTools(deps, modelId)
  )
    return undefined;
  const authority = mintAcceptedJiraChatAuthority(deps, {
    chatId: message.chatId,
    userMessageId: message.id,
    startedAtMs: message.timestamp,
    nowMs: Date.now(),
    correlationId: correlationIdOrUnknown(correlationId),
  });
  requireDispatch(
    authority.ok && deps.jiraChatCatalog !== undefined,
    "denied",
    "authority-invalid",
  );
  const remaining = Date.parse(authority.envelope.expiresAt) - Date.now();
  requireDispatch(remaining > 0, "denied", "authority-expired");
  return new JiraChatToolTurn({
    deps,
    message,
    authority,
    managed: await deps.jiraChatCatalog.get(),
    signal: AbortSignal.any([signal, AbortSignal.timeout(remaining)]),
    correlationId: correlationIdOrUnknown(correlationId),
  });
}
export function scopeJiraChatToolTurn(
  deps: UiHandlerDeps,
  turn: JiraChatToolTurn | undefined,
): UiHandlerDeps {
  if (turn === undefined) return deps;
  return {
    ...deps,
    modelPortFactory: (id): ReturnType<UiHandlerDeps["modelPortFactory"]> => {
      const model = deps.modelPortFactory(id);
      return model === undefined ? undefined : turn.meter(model);
    },
  };
}
