import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import { ConfigInvalidError } from "@oscharko-dev/keiko-security/errors/gateway";
import { redactContent } from "@oscharko-dev/keiko-security";
import {
  ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { toolCallingConfigurationFingerprint } from "./provider-identity.js";
import type { GatewayCallRequest } from "./gateway.js";
import type { ModelGatewayLogSink } from "./observability.js";
import type { ChatMessage, ModelProviderConfig, NormalizedResponse } from "./types.js";

export const REASONING_HISTORY_MAX_BYTES = 32 * 1024 * 1024;
export const REASONING_HISTORY_MAX_ENTRIES = 2_048;
export const REASONING_HISTORY_TTL_MS = 30 * 60_000;

const HISTORY_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.reasoning-history",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "reasoning-history.GatewayReasoningHistory.record",
  fields: {
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["restored", "retained", "unavailable", "capacity-exceeded"],
    },
    messageCount: { type: "integer", dataClass: "count", required: true },
    reasoningBytes: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["gateway-chat-call", "gateway-stream-call"],
  proofIds: ["gateway.reasoning-history.lifecycle"],
  releaseImpact: "patch",
});

export class ReasoningHistoryUnavailableError extends ConfigInvalidError {
  constructor() {
    super("Required reasoning history is unavailable; start a fresh session.");
  }
}

interface RetainedReasoning {
  readonly reasoning: string;
  readonly assistant: ChatMessage;
  readonly callKeys: readonly string[];
  readonly bytes: number;
  ambiguous?: true;
  expiresAt: number;
}

function withoutReasoning(message: ChatMessage): ChatMessage {
  const { reasoningContent: _discarded, toolCalls, ...plain } = message;
  return {
    ...plain,
    ...((toolCalls?.length ?? 0) === 0
      ? {}
      : {
          toolCalls: toolCalls?.map(({ id, name, arguments: args }) => ({
            id,
            name,
            arguments: args,
          })),
        }),
  };
}

function needsHistory(request: GatewayCallRequest, provider: ModelProviderConfig): boolean {
  return provider.reasoningHistory !== undefined && request.toolCatalog !== undefined;
}

function needsMessage(
  request: GatewayCallRequest,
  provider: ModelProviderConfig,
  message: ChatMessage,
  index: number,
): boolean {
  if (message.role !== "assistant") return false;
  if (provider.reasoningHistory !== "current-turn") return true;
  return !request.messages.slice(index + 1).some((entry) => entry.role === "user");
}

/** Context fitting may elide old tool results. Match the user and exact completed assistant. */
function historyKey(
  request: GatewayCallRequest,
  provider: ModelProviderConfig,
  messages: readonly ChatMessage[],
  end: number,
): string {
  let start = end;
  while (start > 0 && messages[start]?.role !== "user") start--;
  const user = messages[start];
  const assistant = messages[end];
  return sha256Hex(
    canonicalise([
      request.reasoningScope,
      toolCallingConfigurationFingerprint(provider),
      user?.role === "user" ? withoutReasoning(user) : null,
      assistant === undefined ? null : withoutReasoning(assistant),
    ]),
  );
}

function callKey(request: GatewayCallRequest, provider: ModelProviderConfig, id: string): string {
  return sha256Hex(
    canonicalise([request.reasoningScope, toolCallingConfigurationFingerprint(provider), id]),
  );
}

function sameCalls(candidate: ChatMessage, retained: ChatMessage): boolean {
  const expected = withoutReasoning(retained).toolCalls ?? [];
  return (withoutReasoning(candidate).toolCalls ?? []).every((call) =>
    expected.some((saved) => canonicalise(saved) === canonicalise(call)),
  );
}

function addAssistantCalls(
  message: ChatMessage,
  assistant: ChatMessage,
  calls: Set<string>,
): boolean {
  if (!sameCalls(message, assistant)) return false;
  if (message.content !== "" && message.content !== assistant.content) return false;
  for (const call of message.toolCalls ?? []) {
    if (calls.has(call.id)) return false;
    calls.add(call.id);
  }
  return true;
}

function addGroupMessage(
  message: ChatMessage,
  assistant: ChatMessage,
  calls: Set<string>,
  results: Map<string, ChatMessage>,
): boolean {
  if (message.role === "assistant") return addAssistantCalls(message, assistant, calls);
  if (message.role !== "tool" || message.toolCallId === undefined) return false;
  if (!calls.has(message.toolCallId) || results.has(message.toolCallId)) return false;
  results.set(message.toolCallId, message);
  return true;
}

/** Chat's durable tool transcript contains individual pairs. Reconstruct only an exact saved group. */
function restoreToolGroup(
  messages: readonly ChatMessage[],
  start: number,
  assistant: ChatMessage,
): { readonly messages: readonly ChatMessage[]; readonly end: number } | undefined {
  const expected = new Set(assistant.toolCalls?.map((call) => call.id));
  const calls = new Set<string>();
  const results = new Map<string, ChatMessage>();
  for (let index = start; index < messages.length; index++) {
    const message = messages[index];
    if (message === undefined || !addGroupMessage(message, assistant, calls, results))
      return undefined;
    if (results.size === expected.size) {
      const ordered = (assistant.toolCalls ?? []).flatMap((call) => {
        const result = results.get(call.id);
        return result === undefined ? [] : [result];
      });
      return { messages: [assistant, ...ordered], end: index };
    }
  }
  return undefined;
}

function completedAssistant(response: NormalizedResponse): ChatMessage {
  return withoutReasoning({
    role: "assistant",
    content: response.content,
    toolCalls: response.toolCalls,
  });
}

function retainable(
  request: GatewayCallRequest,
  provider: ModelProviderConfig,
  response: NormalizedResponse,
): boolean {
  return (
    provider.reasoningHistory !== undefined &&
    request.reasoningScope !== undefined &&
    request.cancellationSignal?.aborted !== true &&
    (response.finishReason === "stop" || response.finishReason === "tool_calls")
  );
}

/** Bounded protocol state only: completed responses, scoped to a caller-owned session and model.
 * Runtime-echoed reasoning is never trusted. No disk, logs, exports or model-name heuristics. */
export class GatewayReasoningHistory {
  private parent: GatewayReasoningHistory | undefined;
  private readonly entries = new Map<string, RetainedReasoning>();
  private readonly calls = new Map<string, Set<string>>();
  private bytes = 0;

  constructor(
    private readonly log: ModelGatewayLogSink,
    private readonly now: () => number,
  ) {}

  prepare(request: GatewayCallRequest, provider: ModelProviderConfig): GatewayCallRequest {
    const root = this.root();
    if (root !== this) return root.prepare(request, provider);
    if (!needsHistory(request, provider))
      return { ...request, messages: request.messages.map(withoutReasoning) };
    this.prune();
    const messages = this.restoreGroups(request, provider);
    let count = 0;
    let bytes = 0;
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      if (
        message === undefined ||
        !needsMessage({ ...request, messages }, provider, message, index)
      )
        continue;
      const key = historyKey(request, provider, messages, index);
      const retained = request.reasoningScope === undefined ? undefined : this.entries.get(key);
      if (retained === undefined || retained.ambiguous === true) this.unavailable(request);
      retained.expiresAt = this.now() + REASONING_HISTORY_TTL_MS;
      this.entries.delete(key);
      this.entries.set(key, retained);
      messages[index] = {
        ...message,
        reasoningContent: redactContent(
          retained.reasoning,
          request.contentRedaction === "preserve" ? "preserve" : "redact",
          [provider.apiKey],
        ),
      };
      count++;
      bytes += Buffer.byteLength(retained.reasoning, "utf8");
    }
    this.record(request, "restored", count, bytes);
    return { ...request, messages };
  }

  remember(
    request: GatewayCallRequest,
    provider: ModelProviderConfig,
    response: NormalizedResponse,
  ): void {
    const root = this.root();
    if (root !== this) {
      root.remember(request, provider, response);
      return;
    }
    if (!retainable(request, provider, response)) return;
    const message = completedAssistant(response);
    const messages = [...request.messages, message];
    const key = historyKey(request, provider, messages, messages.length - 1);
    const reasoning = redactContent(
      response.reasoning ?? "",
      request.contentRedaction === "preserve" ? "preserve" : "redact",
      [provider.apiKey],
    );
    const assistant = withoutReasoning(message);
    const bytes =
      Buffer.byteLength(reasoning, "utf8") + Buffer.byteLength(canonicalise(assistant), "utf8");
    this.prune();
    const previous = this.entries.get(key);
    if (
      previous !== undefined &&
      (previous.ambiguous === true || previous.reasoning !== reasoning)
    ) {
      previous.ambiguous = true;
      this.record(request, "unavailable", 1, 0);
      return;
    }
    const callKeys = (assistant.toolCalls ?? []).map((call) => callKey(request, provider, call.id));
    const entry = {
      reasoning,
      assistant,
      callKeys,
      bytes,
      expiresAt: this.now() + REASONING_HISTORY_TTL_MS,
    };
    const state = this.retain(key, entry);
    this.record(request, state, 1, Buffer.byteLength(reasoning, "utf8"));
  }

  private retain(key: string, entry: RetainedReasoning): "retained" | "capacity-exceeded" {
    const { bytes, callKeys } = entry;
    this.remove(key);
    if (bytes > REASONING_HISTORY_MAX_BYTES) {
      return "capacity-exceeded";
    }
    while (
      this.entries.size >= REASONING_HISTORY_MAX_ENTRIES ||
      this.bytes + bytes > REASONING_HISTORY_MAX_BYTES
    ) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
    this.entries.set(key, entry);
    for (const call of callKeys) {
      const keys = this.calls.get(call) ?? new Set<string>();
      keys.add(key);
      this.calls.set(call, keys);
    }
    this.bytes += bytes;
    return "retained";
  }

  /** Join same-generation refinements, including existing instances and their in-flight writers. */
  join(source: GatewayReasoningHistory): void {
    const target = this.root();
    const other = source.root();
    if (target === other) return;
    target.prune();
    other.prune();
    for (const [key, entry] of other.entries) target.mergeEntry(key, entry);
    other.entries.clear();
    other.calls.clear();
    other.bytes = 0;
    other.parent = target;
  }

  private root(): GatewayReasoningHistory {
    if (this.parent === undefined) return this;
    this.parent = this.parent.root();
    return this.parent;
  }

  private mergeEntry(key: string, entry: RetainedReasoning): void {
    const previous = this.entries.get(key);
    if (previous !== undefined) {
      if (
        previous.ambiguous === true ||
        entry.ambiguous === true ||
        previous.reasoning !== entry.reasoning
      )
        previous.ambiguous = true;
      previous.expiresAt = Math.max(previous.expiresAt, entry.expiresAt);
    } else this.retain(key, entry);
  }

  private restoreGroups(request: GatewayCallRequest, provider: ModelProviderConfig): ChatMessage[] {
    const messages: ChatMessage[] = [];
    let index = 0;
    while (index < request.messages.length) {
      const message = request.messages[index];
      if (message === undefined) {
        index++;
        continue;
      }
      const group = this.restoreGroup(request, provider, index, message);
      if (group === undefined) {
        messages.push(withoutReasoning(message));
        index++;
      } else {
        messages.push(...group.messages);
        index = group.end + 1;
      }
    }
    return messages;
  }

  private restoreGroup(
    request: GatewayCallRequest,
    provider: ModelProviderConfig,
    index: number,
    message: ChatMessage,
  ): ReturnType<typeof restoreToolGroup> {
    const first = message.role === "assistant" ? message.toolCalls?.[0]?.id : undefined;
    if (first === undefined) return undefined;
    let restored: ReturnType<typeof restoreToolGroup>;
    for (const key of this.calls.get(callKey(request, provider, first)) ?? []) {
      const group = this.candidateGroup(key, request, provider, index);
      if (group === undefined) continue;
      if (restored !== undefined) return undefined;
      restored = group;
    }
    return restored;
  }

  private candidateGroup(
    key: string,
    request: GatewayCallRequest,
    provider: ModelProviderConfig,
    index: number,
  ): ReturnType<typeof restoreToolGroup> {
    const retained = this.entries.get(key);
    if (retained === undefined || retained.ambiguous === true) return undefined;
    const prefix = [...request.messages.slice(0, index), retained.assistant];
    if (key !== historyKey(request, provider, prefix, index)) return undefined;
    return restoreToolGroup(request.messages, index, retained.assistant);
  }

  private unavailable(request: GatewayCallRequest): never {
    this.record(request, "unavailable", 1, 0);
    throw new ReasoningHistoryUnavailableError();
  }

  private prune(): void {
    for (const [key, retained] of this.entries) {
      if (retained.expiresAt <= this.now()) this.remove(key);
    }
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    for (const call of entry?.callKeys ?? []) {
      const keys = this.calls.get(call);
      keys?.delete(key);
      if (keys?.size === 0) this.calls.delete(call);
    }
    this.bytes -= entry?.bytes ?? 0;
    this.entries.delete(key);
  }

  private record(
    request: GatewayCallRequest,
    state: "restored" | "retained" | "unavailable" | "capacity-exceeded",
    messageCount: number,
    reasoningBytes: number,
  ): void {
    this.log.write(
      activityLogEvent(
        HISTORY_OPERATION,
        {
          correlationId: request.logContext?.correlationId ?? ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
        },
        { state, messageCount, reasoningBytes, completeness: "complete", loss: "none" },
      ),
    );
  }
}
