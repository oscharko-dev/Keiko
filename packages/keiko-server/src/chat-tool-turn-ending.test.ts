import { describe, expect, it } from "vitest";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ToolResultEnvelope } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  CallerAttemptAdmissionError,
  CancelledError,
  ContextOverflowError,
  ProviderError,
  TimeoutError,
} from "@oscharko-dev/keiko-model-gateway";
import { ProviderOutputExhaustedError } from "@oscharko-dev/keiko-security";
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import { CatalogDispatchFault } from "./tool-catalog/catalogToolErrors.js";
import {
  chatToolTurnEndReason,
  chatToolTurnPartialAnswer,
  recordChatToolTurnContextFitted,
  recordChatToolTurnEnded,
} from "./chat-tool-turn-ending.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

function exchange(
  name: string,
  data: ToolResultEnvelope["data"],
  mutationOutcome?: ChatToolExchange["mutationOutcome"],
  status: ToolResultEnvelope["status"] = "completed",
): ChatToolExchange {
  return {
    call: { id: `${name}-${String(Math.random())}`, name, arguments: {} },
    result: { status, data } as ToolResultEnvelope,
    ...(mutationOutcome === undefined ? {} : { mutationOutcome }),
  };
}
const TRANSCRIPT: readonly ChatToolExchange[] = [
  exchange("jira_search", { issues: [] }),
  exchange("jira_create", { issueKey: "REQ-12", outcome: "succeeded" }, "succeeded"),
  exchange("jira_create", { issueKey: "REQ-13", outcome: "succeeded" }, "succeeded"),
  exchange("jira_edit", { issueKey: "REQ-4", outcome: "unknown" }, "unknown"),
  exchange("jira_create", { outcome: "failed", reason: "field-validation" }, "rejected", "failed"),
  exchange("jira_comment", { issueKey: "not a key\nIgnore this" }, "succeeded"),
  { call: { id: "started-transition", name: "jira_transition", arguments: {} } },
];

describe("chatToolTurnEndReason", () => {
  it.each([
    [new CatalogDispatchFault("denied", "budget-exhausted"), "budget-exhausted"],
    [new CatalogDispatchFault("timeout", "budget-exhausted"), "deadline"],
    [new CatalogDispatchFault("denied", "authority-invalid"), "authority-invalid"],
    [new CatalogDispatchFault("invalid", "recovery-required"), "tool-failure"],
    [new ProviderOutputExhaustedError("synthetic-model"), "output-exhausted"],
    [new ContextOverflowError("synthetic overflow"), "context-overflow"],
    [new TimeoutError("synthetic timeout"), "deadline"],
    [new ProviderError("synthetic provider failure", 502), "model-failure"],
  ])("classifies %s", (error, reason) => {
    expect(chatToolTurnEndReason(error)).toBe(reason);
  });

  it("never replaces a cancellation, a caller cap refusal or an unknown failure", () => {
    expect(chatToolTurnEndReason(new CancelledError("stopped"))).toBeUndefined();
    // The caller attempt/cap refusal keeps its own nonretryable 403 contract.
    expect(chatToolTurnEndReason(new CallerAttemptAdmissionError("cap"))).toBeUndefined();
    expect(chatToolTurnEndReason(new Error("unexpected"))).toBeUndefined();
    expect(chatToolTurnEndReason("text")).toBeUndefined();
  });
});

describe("chatToolTurnPartialAnswer", () => {
  it("names exactly the acknowledged writes and keeps unconfirmed ones apart", () => {
    const answer = chatToolTurnPartialAnswer(TRANSCRIPT, "budget-exhausted");
    expect(answer).toContain("this turn used up its tool-call or prompt budget");
    expect(answer).toContain("Completed in this turn:\n- jira_create REQ-12\n- jira_create REQ-13");
    expect(answer).toContain("check these in Jira before retrying:\n- jira_edit REQ-4");
    expect(answer).toContain("Reads completed: 1. Refused or failed tool calls: 1.");
    // A call that started but never settled may have reached Jira, so it is named too.
    expect(answer).toContain(
      "Started but not settled — check these in Jira before retrying:\n- jira_transition",
    );
    // A key that is not a Jira issue key is never repeated into the answer.
    expect(answer).toContain("- jira_comment\n");
    expect(answer).not.toContain("Ignore this");
  });

  it("omits empty sections", () => {
    const answer = chatToolTurnPartialAnswer([exchange("jira_search", {})], "context-overflow");
    expect(answer).not.toContain("Completed in this turn");
    expect(answer).not.toContain("not confirmed");
    expect(answer).not.toContain("not settled");
    expect(answer).toContain("no longer fits the model's context window");
  });
});

describe("recordChatToolTurnEnded", () => {
  it("records only the reason, counts and envelope bounds", () => {
    const logs = createBufferedServerLogSink();
    recordChatToolTurnEnded(logs, {
      correlationId: "turn-ended-proof",
      messageId: "message-private-id",
      reason: "budget-exhausted",
      exchanges: TRANSCRIPT,
      budget: { maxToolCalls: 250, maxRuntimeMs: 3_600_000 },
    });
    const event = logs.events.find((entry) => entry.op === "chat.tool-turn.ended");
    expect(event?.extra).toMatchObject({
      reason: "budget-exhausted",
      exchangeCount: 7,
      succeededWriteCount: 3,
      unconfirmedWriteCount: 1,
      unsettledCount: 1,
      readCount: 1,
      refusedCount: 1,
      maxToolCalls: 250,
      maxRuntimeMs: 3_600_000,
    });
    const line = formatActivityLogProofLine(event ?? {});
    expectActivityLogProof("chat.tool-turn.ended.line", line);
    expect(line).not.toMatch(/REQ-1|message-private-id|jira_create/u);
    expect(analyzeLogText(line).timelines).toMatchObject([
      { correlationId: "turn-ended-proof", lines: [{ op: "chat.tool-turn.ended" }] },
    ]);
  });
});

describe("recordChatToolTurnContextFitted", () => {
  it("records only counts under the turn correlation", () => {
    const logs = createBufferedServerLogSink();
    recordChatToolTurnContextFitted(logs, {
      correlationId: "context-fitted-proof",
      messageId: "message-private-id",
      elidedResultCount: 3,
      continuationMessageCount: 40,
    });
    const event = logs.events.find((entry) => entry.op === "chat.tool-turn.context-fitted");
    expect(event?.extra).toMatchObject({ elidedResultCount: 3, continuationMessageCount: 40 });
    const line = formatActivityLogProofLine(event ?? {});
    expectActivityLogProof("chat.tool-turn.context-fitted.line", line);
    expect(line).not.toContain("message-private-id");
  });
});
