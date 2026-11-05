import type {
  ChatMessage as GatewayMessage,
  ContextProfile,
  ToolDefinition,
} from "@oscharko-dev/keiko-contracts";
import type { GatewayCallRequest } from "@oscharko-dev/keiko-model-gateway";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import { estimateTokens } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { knowledgeCoverageReceipt } from "./chat-tool-knowledge-coverage.js";
import {
  chatToolDraftReceipts,
  chatToolIssueKey,
  chatToolRequirementReceipts,
} from "./chat-tool-receipts.js";

/**
 * Keeps a long Chat tool turn inside the model window (#4175). The oldest settled tool results are
 * replaced, oldest first, by a compact record that keeps what the model needs to continue — the
 * status, the closed reason, the mutation outcome and the issue keys (per item for a backlog draft,
 * with each item's state) — so completed writes are never
 * repeated and the turn is not stopped merely because it did a lot of work. The newest result is
 * always kept whole. Only the copy sent to the model changes; the stored transcript is untouched.
 */

function closedString(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(value) ? value : undefined;
}
function receiptsOf(exchange: ChatToolExchange): object {
  const data = exchange.result?.data;
  const issueKey = chatToolIssueKey(data);
  const items = chatToolDraftReceipts(exchange);
  const requirements = chatToolRequirementReceipts(data);
  return {
    ...knowledgeCoverageReceipt(exchange),
    ...(issueKey === undefined ? {} : { issueKey }),
    ...(items === undefined ? {} : { items }),
    ...(requirements === undefined ? {} : { requirements }),
  };
}
/** Compacted from the stored, structured exchange — never re-parsed from the sent text. */
function compactExchange(exchange: ChatToolExchange): string {
  const result = exchange.result;
  return JSON.stringify({
    elided: true,
    status: closedString(result?.status),
    reason: closedString(result?.reason),
    mutationOutcome: closedString(exchange.mutationOutcome),
    ...receiptsOf(exchange),
  });
}
export function estimateGatewayMessageTokens(messages: readonly GatewayMessage[]): number {
  return messages.reduce(
    (sum, message) =>
      sum +
      estimateTokens(message.content) +
      (message.toolCalls === undefined ? 0 : estimateTokens(JSON.stringify(message.toolCalls))),
    0,
  );
}

export interface FittedToolContinuation {
  readonly messages: readonly GatewayMessage[];
  readonly elidedCount: number;
}

/**
 * `budgetTokens` is what the continuation may use after the fixed prompt and output reserve.
 * `exchanges` are the settled exchanges the continuation's tool messages were built from.
 */
export function fitToolContinuation(
  continuation: readonly GatewayMessage[],
  exchanges: readonly ChatToolExchange[],
  budgetTokens: number,
): FittedToolContinuation {
  const byCallId = new Map(exchanges.map((exchange) => [exchange.call.id, exchange]));
  const messages = [...continuation];
  let total = estimateGatewayMessageTokens(messages);
  let elidedCount = 0;
  const lastTool = messages.map((message) => message.role).lastIndexOf("tool");
  for (let index = 0; index < lastTool && total > budgetTokens; index++) {
    const message = messages[index];
    const exchange = message?.role === "tool" ? byCallId.get(message.toolCallId ?? "") : undefined;
    if (message === undefined || exchange === undefined) continue;
    const content = compactExchange(exchange);
    if (content.length >= message.content.length) continue;
    total -= estimateTokens(message.content) - estimateTokens(content);
    messages[index] = { ...message, content };
    elidedCount++;
  }
  return { messages, elidedCount };
}

/** Preserve the complete turn when its maximum answer reserve alone would overflow the window.
 * The gateway still owns exact/provider admission; this only lowers the caller's maximum output.
 */
export function fitToolRoundOutput(
  request: GatewayCallRequest,
  profile: ContextProfile,
  tools: readonly ToolDefinition[],
  limits: {
    readonly maxOutputTokens: number;
    readonly reasoningHistoryField?: "reasoning_content" | "reasoning" | undefined;
  },
): GatewayCallRequest {
  const requested = request.maxOutputTokens ?? profile.reservedOutputTokens;
  if (
    !Number.isSafeInteger(requested) ||
    requested < 256 ||
    (limits.maxOutputTokens > 0 && requested > limits.maxOutputTokens)
  )
    return request;
  const promptTokens = countGatewayPromptTokens({ ...request, tools }, profile.tokenAccounting, {
    contextWindow: profile.maxInputTokens,
    reasoningHistoryField: limits.reasoningHistoryField,
  });
  if (promptTokens > (profile.inputTokenLimit ?? Number.POSITIVE_INFINITY)) return request;
  const available = Math.floor(profile.maxInputTokens - profile.safetyMarginTokens - promptTokens);
  return available >= 256 && available < requested
    ? { ...request, maxOutputTokens: available }
    : request;
}
