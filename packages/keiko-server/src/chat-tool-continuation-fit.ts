import type { ChatMessage as GatewayMessage } from "@oscharko-dev/keiko-contracts";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import { estimateTokens } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";

/**
 * Keeps a long Chat tool turn inside the model window (#4175). The oldest settled tool results are
 * replaced, oldest first, by a compact record that keeps what the model needs to continue — the
 * status, the closed reason, the mutation outcome and the issue key — so completed writes are never
 * repeated and the turn is not stopped merely because it did a lot of work. The newest result is
 * always kept whole. Only the copy sent to the model changes; the stored transcript is untouched.
 */
const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,254}-[1-9]\d{0,17}$/u;

function closedString(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(value) ? value : undefined;
}
function issueKeyOf(data: unknown): object {
  const key =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Readonly<Record<string, unknown>>).issueKey
      : undefined;
  return typeof key === "string" && ISSUE_KEY.test(key) ? { issueKey: key } : {};
}
/** Compacted from the stored, structured exchange — never re-parsed from the sent text. */
function compactExchange(exchange: ChatToolExchange): string {
  const result = exchange.result;
  return JSON.stringify({
    elided: true,
    status: closedString(result?.status),
    reason: closedString(result?.reason),
    mutationOutcome: closedString(exchange.mutationOutcome),
    ...issueKeyOf(result?.data),
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
