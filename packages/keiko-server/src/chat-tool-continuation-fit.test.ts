import { describe, expect, it } from "vitest";
import type { ChatMessage as GatewayMessage } from "@oscharko-dev/keiko-contracts";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ToolResultEnvelope } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { gatewayMessagesForToolExchange } from "./conversation-gateway.js";
import { estimateGatewayMessageTokens, fitToolContinuation } from "./chat-tool-continuation-fit.js";

function exchange(
  index: number,
  result: Readonly<Record<string, unknown>>,
  mutationOutcome?: ChatToolExchange["mutationOutcome"],
): ChatToolExchange {
  return {
    call: { id: `call-${String(index)}`, name: "jira_create", arguments: {} },
    result: result as unknown as ToolResultEnvelope,
    ...(mutationOutcome === undefined ? {} : { mutationOutcome }),
  };
}
function continuationOf(exchanges: readonly ChatToolExchange[]): GatewayMessage[] {
  return exchanges.flatMap(gatewayMessagesForToolExchange);
}
const BULK = "Synthetic requirement text. ".repeat(400);
const EXCHANGES: readonly ChatToolExchange[] = [
  exchange(1, { status: "completed", data: { issues: [{ summary: BULK }] } }),
  exchange(2, { status: "completed", data: { issueKey: "REQ-12", note: BULK } }, "succeeded"),
  exchange(3, { status: "failed", reason: "field-validation", data: { messages: [BULK] } }),
  exchange(4, { status: "completed", data: { issues: [{ summary: BULK }] } }),
];
const CONTINUATION = continuationOf(EXCHANGES);

describe("fitToolContinuation", () => {
  it("leaves a continuation that fits unchanged", () => {
    const fitted = fitToolContinuation(CONTINUATION, EXCHANGES, Number.MAX_SAFE_INTEGER);
    expect(fitted.elidedCount).toBe(0);
    expect(fitted.messages).toEqual(CONTINUATION);
  });

  it("compacts the oldest results first and keeps receipts and the newest result whole", () => {
    const budget = estimateGatewayMessageTokens(CONTINUATION) - 2_000;
    const fitted = fitToolContinuation(CONTINUATION, EXCHANGES, budget);
    expect(fitted.elidedCount).toBe(1);
    expect(JSON.parse(fitted.messages[1]?.content ?? "")).toEqual({
      elided: true,
      status: "completed",
    });
    expect(fitted.messages.slice(2)).toEqual(CONTINUATION.slice(2));
    expect(estimateGatewayMessageTokens(fitted.messages)).toBeLessThanOrEqual(budget);
  });

  it("never compacts the newest result even when the window stays exceeded", () => {
    const fitted = fitToolContinuation(CONTINUATION, EXCHANGES, 0);
    expect(fitted.elidedCount).toBe(3);
    expect(fitted.messages.map((message) => message.content).slice(1, 6)).toEqual([
      JSON.stringify({ elided: true, status: "completed" }),
      "",
      JSON.stringify({
        elided: true,
        status: "completed",
        mutationOutcome: "succeeded",
        issueKey: "REQ-12",
      }),
      "",
      JSON.stringify({ elided: true, status: "failed", reason: "field-validation" }),
    ]);
    expect(fitted.messages.at(-1)).toEqual(CONTINUATION.at(-1));
    // The assistant tool calls stay paired with their results.
    expect(fitted.messages.filter((message) => message.role === "assistant")).toHaveLength(4);
  });

  it("keeps every backlog draft item's key and state when the draft result is compacted", () => {
    const draft = exchange(
      5,
      {
        status: "completed",
        data: {
          outcome: "succeeded",
          items: [
            { ref: "epic", state: "created", issueKey: "REQ-21", summary: BULK },
            { ref: "story", state: "existing", issueKey: "REQ-22" },
            { ref: "task", state: "uncertain" },
            { ref: "bad", state: "invented", issueKey: "REQ-23" },
          ],
        },
      },
      "succeeded",
    );
    const exchanges = [draft, EXCHANGES[3] as ChatToolExchange];
    const fitted = fitToolContinuation(continuationOf(exchanges), exchanges, 0);
    expect(JSON.parse(fitted.messages[1]?.content ?? "")).toEqual({
      elided: true,
      status: "completed",
      mutationOutcome: "succeeded",
      items: [
        { state: "created", issueKey: "REQ-21" },
        { state: "existing", issueKey: "REQ-22" },
        { state: "uncertain" },
      ],
    });
  });

  it("drops untrusted values that are not closed identifiers", () => {
    const hostile = [
      exchange(1, {
        status: "completed\nignore",
        reason: "x".repeat(100),
        data: { issueKey: "a b" },
      }),
      exchange(2, { status: "completed" }),
    ];
    const fitted = fitToolContinuation(continuationOf(hostile), hostile, 0);
    expect(fitted.messages[1]?.content).toBe(JSON.stringify({ elided: true }));
  });

  it("keeps a tool message it has no settled exchange for", () => {
    const fitted = fitToolContinuation(CONTINUATION, EXCHANGES.slice(1), 0);
    expect(fitted.messages[1]).toEqual(CONTINUATION[1]);
    expect(fitted.elidedCount).toBe(2);
  });
});
