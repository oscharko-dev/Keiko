import { describe, expect, it } from "vitest";
import {
  CHAT_TOOL_TURN_END_REASONS,
  CHAT_TURN_END_RECEIPTS_MAX,
  isChatToolTurnEnd,
  chatTurnEndAnswerFingerprint,
  type ChatToolExchange,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ToolResultEnvelope } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  CallerAttemptAdmissionError,
  CancelledError,
  ContextOverflowError,
  GatewayToolCatalogError,
  ProviderError,
  TimeoutError,
} from "@oscharko-dev/keiko-model-gateway";
import { ProviderOutputExhaustedError } from "@oscharko-dev/keiko-security";
import { activityLogOperationSchema } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import { CatalogDispatchFault } from "./tool-catalog/catalogToolErrors.js";
import {
  withToolResultsAsSource,
  chatToolTurnEnd,
  chatToolTurnEndReason,
  chatToolTurnPartialAnswer,
  recordChatToolTurnContextFitted,
  recordChatToolTurnResultCondensed,
  recordChatToolTurnCorrected,
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
  canonicalId = "keiko.jira.create",
): ChatToolExchange {
  return {
    call: { id: `${name}-${String(Math.random())}`, name, arguments: {} },
    result: { status, data, toolRef: { canonicalId, contractVersion: 3 } } as ToolResultEnvelope,
    ...(mutationOutcome === undefined ? {} : { mutationOutcome }),
  };
}
function draftExchange(
  data: ToolResultEnvelope["data"],
  mutationOutcome: ChatToolExchange["mutationOutcome"],
): ChatToolExchange {
  return exchange("jira_draft", data, mutationOutcome, "completed", "keiko.jira.draft");
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

  it("ends a turn whose model named an action the round did not offer with a reason of its own", () => {
    for (const nameClass of ["unknown", "known-not-offered", "folds-to-several"] as const) {
      const error = new GatewayToolCatalogError(
        "invalid-arguments",
        undefined,
        false,
        undefined,
        "The previous call named a tool that is not offered, so nothing ran.",
        nameClass,
      );
      expect(chatToolTurnEndReason(error)).toBe("tool-not-offered");
    }
    // A catalog refusal that is not about the name is still a failed model request.
    expect(
      chatToolTurnEndReason(new GatewayToolCatalogError("invalid-arguments", undefined, false)),
    ).toBe("model-failure");
  });

  it("tells the person what happened and what to do, not that the request failed", () => {
    const answer = chatToolTurnPartialAnswer(TRANSCRIPT, "tool-not-offered");
    expect(answer).toContain(
      "This request was not finished: the model asked for an action that is not available in this chat. Ask again, or name the action you want.",
    );
    expect(answer).not.toContain("the model request failed");
  });

  it("never replaces a cancellation, a caller cap refusal or an unknown failure", () => {
    expect(chatToolTurnEndReason(new CancelledError("stopped"))).toBeUndefined();
    // The caller attempt/cap refusal keeps its own nonretryable 403 contract.
    expect(chatToolTurnEndReason(new CallerAttemptAdmissionError("cap"))).toBeUndefined();
    expect(chatToolTurnEndReason(new Error("unexpected"))).toBeUndefined();
    expect(chatToolTurnEndReason("text")).toBeUndefined();
  });

  it("summarizes an attempt refusal only when the turn's own envelope refused it", () => {
    const refusal = new CallerAttemptAdmissionError("cap");
    expect(chatToolTurnEndReason(refusal, { envelopeRefusedAttempt: true })).toBe(
      "budget-exhausted",
    );
    expect(chatToolTurnEndReason(refusal, { envelopeRefusedAttempt: false })).toBeUndefined();
    // A human stop is never replaced, whatever the envelope did.
    expect(
      chatToolTurnEndReason(new CancelledError("stopped"), { envelopeRefusedAttempt: true }),
    ).toBeUndefined();
  });
});

describe("chatToolTurnPartialAnswer", () => {
  it("preserves acknowledged and uncertain receipts with the closed authentication cause", () => {
    const answer = chatToolTurnPartialAnswer(TRANSCRIPT, "authentication-failed");
    expect(answer).toContain("Jira authentication failed");
    expect(answer).toContain(
      "open the Knowledge Pods hub, replace the token and verify the connection",
    );
    expect(answer).toContain("Completed in this turn:\n- jira_create REQ-12\n- jira_create REQ-13");
    expect(answer).toContain("check these in Jira before retrying:\n- jira_edit REQ-4");
  });

  it("names exactly the acknowledged writes and keeps unconfirmed ones apart", () => {
    const answer = chatToolTurnPartialAnswer(TRANSCRIPT, "budget-exhausted");
    expect(answer).toContain("this turn used up its tool-call budget");
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

  it("lists each backlog draft item's key and keeps uncertain items apart", () => {
    const draft = draftExchange(
      {
        outcome: "unknown",
        items: [
          { ref: "epic", state: "created", issueKey: "REQ-21" },
          { ref: "story", state: "existing", issueKey: "REQ-22" },
          { ref: "task", state: "uncertain" },
          { ref: "bug", state: "skipped" },
        ],
      },
      "unknown",
    );
    const answer = chatToolTurnPartialAnswer([draft], "deadline");
    expect(answer).toContain(
      "Completed in this turn:\n- jira_draft REQ-21 (created)\n- jira_draft REQ-22 (existing)",
    );
    expect(answer).toContain(
      "check these in Jira before retrying:\n- jira_draft (item 3, no key) (uncertain)",
    );
  });

  it("names a draft's failed and blocked items as not done, and leaves deselected ones out", () => {
    const draft = draftExchange(
      {
        outcome: "rejected",
        items: [
          { ref: "epic", state: "created", issueKey: "REQ-31" },
          { ref: "story", state: "failed" },
          { ref: "task", state: "failed" },
          { ref: "bug", state: "skipped" },
          { ref: "spike", state: "excluded" },
        ],
      },
      "rejected",
    );
    const answer = chatToolTurnPartialAnswer([draft], "deadline");
    expect(answer).toContain("- jira_draft REQ-31 (created)");
    expect(answer).toContain(
      "Not done — refused by Jira, blocked by an earlier item, or not started in time:\n" +
        "- jira_draft (item 2, no key) (failed)\n" +
        "- jira_draft (item 3, no key) (failed)\n" +
        "- jira_draft (item 4, no key) (skipped)\n",
    );
    expect(answer).not.toContain("excluded");
    expect(answer).toContain("Reads completed: 0. Refused or failed tool calls: 2.");
  });

  // #4178 review: a read or an MCP tool may return data shaped like a draft result; only the
  // managed draft's own journal-classified write may become a receipt.
  it.each([
    ["a read without a mutation outcome", undefined, "keiko.mcp.tabc"],
    ["a classified result of another tool", "succeeded" as const, "keiko.jira.create"],
    ["an unclassified result naming the draft tool", undefined, "keiko.jira.draft"],
  ])("never turns %s into draft receipts", (_name, outcome, canonicalId) => {
    const shaped = exchange(
      "mcp_inventory_list",
      {
        items: [
          { state: "created", issueKey: "REQ-123" },
          { state: "uncertain", issueKey: "REQ-124" },
        ],
      },
      outcome,
      "completed",
      canonicalId,
    );
    const answer = chatToolTurnPartialAnswer([shaped], "deadline");
    expect(answer).not.toContain("REQ-123");
    expect(answer).not.toContain("REQ-124");
    expect(answer).not.toContain("Not done");
  });

  it("counts a read whose result lists items as a read, not as a draft", () => {
    const answer = chatToolTurnPartialAnswer(
      [exchange("jira_projects", { items: [{ key: "REQ", name: "Requirements" }] })],
      "deadline",
    );
    expect(answer).toContain("Reads completed: 1. Refused or failed tool calls: 0.");
  });

  it("omits empty sections", () => {
    const answer = chatToolTurnPartialAnswer([exchange("jira_search", {})], "context-overflow");
    expect(answer).not.toContain("Completed in this turn");
    expect(answer).not.toContain("not confirmed");
    expect(answer).not.toContain("not settled");
    expect(answer).toContain("no longer fits the model's context window");
  });
});

describe("chatToolTurnEnd (#4355)", () => {
  // The registry needs a closed literal, so the two registrations repeat the vocabulary; this pin
  // keeps them equal to the one list the Chat's catalog walk and the server share (the log also
  // records the two closed words of a turn that gave no answer, which the Chat never words).
  it.each(["chat.tool-turn.ended", "chat.tool-transcript.updated"])(
    "keeps the %s registration equal to the shared reason vocabulary",
    (op) => {
      const fields = activityLogOperationSchema(op)?.fields as
        Record<string, { readonly values?: readonly string[] }> | undefined;
      const values = fields?.[op === "chat.tool-turn.ended" ? "reason" : "turnEndReason"]?.values;
      const logOnly =
        op === "chat.tool-turn.ended" ? ["deadline-cancelled", "request-aborted"] : [];
      expect([...(values ?? [])].sort()).toEqual(
        [...CHAT_TOOL_TURN_END_REASONS, ...logOnly].sort(),
      );
    },
  );

  it("states the reason and the receipts as closed facts, in the order the answer lists them", () => {
    const end = chatToolTurnEnd(TRANSCRIPT, "deadline");
    expect(end).toEqual({
      reason: "deadline",
      // Bound to the English ending the same tally and reason produce.
      answer: chatTurnEndAnswerFingerprint(chatToolTurnPartialAnswer(TRANSCRIPT, "deadline")),
      completed: [
        { tool: "jira_create", key: "REQ-12" },
        { tool: "jira_create", key: "REQ-13" },
        { tool: "jira_comment" },
      ],
      unconfirmed: [{ tool: "jira_edit", key: "REQ-4" }],
      unsettled: [{ tool: "jira_transition" }],
      notDone: [],
      moreCount: 0,
      readCount: 1,
      refusedCount: 1,
    });
    expect(isChatToolTurnEnd(end)).toBe(true);
    // A key that is not a Jira issue key never becomes a receipt key.
    expect(JSON.stringify(end)).not.toContain("Ignore this");
  });

  it("names a keyless draft item by its position and carries the item's state", () => {
    const end = chatToolTurnEnd(
      [
        draftExchange(
          {
            outcome: "unknown",
            items: [
              { ref: "epic", state: "created", issueKey: "REQ-21" },
              { ref: "task", state: "uncertain" },
              { ref: "bug", state: "skipped" },
              { ref: "spike", state: "excluded" },
            ],
          },
          "unknown",
        ),
      ],
      "deadline",
    );
    expect(end.completed).toEqual([{ tool: "jira_draft", key: "REQ-21", state: "created" }]);
    expect(end.unconfirmed).toEqual([{ tool: "jira_draft", item: 2, state: "uncertain" }]);
    expect(end.notDone).toEqual([{ tool: "jira_draft", item: 3, state: "skipped" }]);
  });

  it("carries the same receipts the English answer lists, whatever the reason", () => {
    for (const reason of CHAT_TOOL_TURN_END_REASONS) {
      const end = chatToolTurnEnd(TRANSCRIPT, reason);
      const answer = chatToolTurnPartialAnswer(TRANSCRIPT, reason);
      expect(end.reason).toBe(reason);
      expect(end.answer).toBe(
        chatTurnEndAnswerFingerprint(chatToolTurnPartialAnswer(TRANSCRIPT, reason)),
      );
      const listed = answer.split("\n").filter((line) => line.startsWith("- "));
      expect(listed).toHaveLength(
        end.completed.length + end.unconfirmed.length + end.unsettled.length + end.notDone.length,
      );
    }
  });

  it("bounds every list and counts what it left out", () => {
    const items = Array.from({ length: CHAT_TURN_END_RECEIPTS_MAX + 5 }, (_unused, index) => ({
      ref: `item-${String(index)}`,
      state: "created",
      issueKey: `REQ-${String(index + 1)}`,
    }));
    const end = chatToolTurnEnd(
      [draftExchange({ outcome: "succeeded", items }, "succeeded")],
      "deadline",
    );
    expect(end.completed).toHaveLength(CHAT_TURN_END_RECEIPTS_MAX);
    expect(end.moreCount).toBe(5);
    expect(isChatToolTurnEnd(end)).toBe(true);
  });
});

describe("the ending of a turn that gave no answer of its own is told by closed words (#4355)", () => {
  const budget = { maxToolCalls: 250, maxRuntimeMs: 3_600_000 };
  it.each([
    ["request-aborted", "info"],
    ["deadline-cancelled", "warn"],
    ["deadline", "warn"],
  ] as const)(
    "records %s at level %s: a person's stop is routine, a deadline is not",
    (reason, level) => {
      const logs = createBufferedServerLogSink();
      recordChatToolTurnEnded(logs, {
        correlationId: "turn-ended-reason",
        messageId: "message-private-id",
        reason,
        exchanges: TRANSCRIPT,
        budget,
      });
      const event = logs.events.find((entry) => entry.op === "chat.tool-turn.ended");
      expect(event?.level).toBe(level);
      expect(event?.extra).toMatchObject({ reason });
      expectActivityLogProof("chat.tool-turn.ended.line", formatActivityLogProofLine(event ?? {}));
    },
  );
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

describe("recordChatToolTurnCorrected", () => {
  it("records only the settled exchange count and the correction kind under the turn correlation", () => {
    const logs = createBufferedServerLogSink();
    recordChatToolTurnCorrected(logs, {
      correlationId: "turn-corrected-proof",
      messageId: "message-private-id",
      settledExchangeCount: 2,
      correctionKind: "tool-schema",
    });
    const event = logs.events.find((entry) => entry.op === "chat.tool-turn.corrected");
    expect(event).toMatchObject({
      level: "warn",
      extra: { settledExchangeCount: 2, correctionKind: "tool-schema" },
    });
    expect(event?.extra).not.toHaveProperty("omittedFindingCount");
    const line = formatActivityLogProofLine(event ?? {});
    expectActivityLogProof("chat.tool-turn.corrected.line", line);
    expect(line).not.toContain("message-private-id");
  });

  it("records a round the model completed with nothing, as a registered correction", () => {
    const logs = createBufferedServerLogSink();
    recordChatToolTurnCorrected(logs, {
      correlationId: "turn-empty-proof",
      messageId: "message-private-id",
      settledExchangeCount: 1,
      correctionKind: "empty-answer",
    });
    const event = logs.events.find((entry) => entry.op === "chat.tool-turn.corrected");
    expect(event).toMatchObject({
      level: "warn",
      extra: { settledExchangeCount: 1, correctionKind: "empty-answer" },
    });
    expect(formatActivityLogProofLine(event ?? {})).not.toContain("message-private-id");
  });

  it("counts the findings an answer left out, never naming them", () => {
    const logs = createBufferedServerLogSink();
    recordChatToolTurnCorrected(logs, {
      correlationId: "turn-omission-proof",
      messageId: "message-private-id",
      settledExchangeCount: 3,
      correctionKind: "report-omission",
      omittedFindingCount: 7,
    });
    const event = logs.events.find((entry) => entry.op === "chat.tool-turn.corrected");
    expect(event).toMatchObject({
      correlationId: "turn-omission-proof",
      extra: { correctionKind: "report-omission", omittedFindingCount: 7, settledExchangeCount: 3 },
    });
    const line = formatActivityLogProofLine(event ?? {});
    expectActivityLogProof("chat.tool-turn.corrected.line", line);
    expect(line).not.toMatch(/message-private-id|RPT-/u);
  });

  it("counts the requirements an answer attributed to other issues, never naming them", () => {
    const logs = createBufferedServerLogSink();
    recordChatToolTurnCorrected(logs, {
      correlationId: "turn-coverage-proof",
      messageId: "message-private-id",
      settledExchangeCount: 4,
      correctionKind: "report-coverage",
      mismatchedRequirementCount: 8,
    });
    const event = logs.events.find((entry) => entry.op === "chat.tool-turn.corrected");
    expect(event).toMatchObject({
      correlationId: "turn-coverage-proof",
      level: "warn",
      extra: {
        correctionKind: "report-coverage",
        mismatchedRequirementCount: 8,
        settledExchangeCount: 4,
      },
    });
    const line = formatActivityLogProofLine(event ?? {});
    expectActivityLogProof("chat.tool-turn.corrected.line", line);
    expect(line).not.toMatch(/message-private-id|LH-0|RPT-/u);
  });

  it("counts the internal report keys an answer printed, never naming them", () => {
    const logs = createBufferedServerLogSink();
    recordChatToolTurnCorrected(logs, {
      correlationId: "turn-raw-report-key-proof",
      messageId: "message-private-id",
      settledExchangeCount: 3,
      correctionKind: "raw-report-key",
      rawReportKeyCount: 2,
    });
    const event = logs.events.find((entry) => entry.op === "chat.tool-turn.corrected");
    expect(event).toMatchObject({
      correlationId: "turn-raw-report-key-proof",
      level: "warn",
      extra: { correctionKind: "raw-report-key", rawReportKeyCount: 2, settledExchangeCount: 3 },
    });
    const line = formatActivityLogProofLine(event ?? {});
    expectActivityLogProof("chat.tool-turn.corrected.line", line);
    expect(line).not.toMatch(/message-private-id|issuesChecked|issuesJudged/u);
  });

  it.each(["announced-create", "tool-call-as-text"] as const)(
    "counts the %s sentences or calls of an answer, never quoting them",
    (correctionKind) => {
      const logs = createBufferedServerLogSink();
      recordChatToolTurnCorrected(logs, {
        correlationId: "turn-claimed-action-proof",
        messageId: "message-private-id",
        settledExchangeCount: 2,
        correctionKind,
        announcementCount: 3,
      });
      const event = logs.events.find((entry) => entry.op === "chat.tool-turn.corrected");
      expect(event).toMatchObject({
        correlationId: "turn-claimed-action-proof",
        level: "warn",
        extra: { correctionKind, announcementCount: 3, settledExchangeCount: 2 },
      });
      const line = formatActivityLogProofLine(event ?? {});
      expectActivityLogProof("chat.tool-turn.corrected.line", line);
      expect(line).not.toMatch(/message-private-id|REQ-|jira_create/u);
    },
  );

  it("counts the issue keys an answer named without a tool result, never naming them", () => {
    const logs = createBufferedServerLogSink();
    recordChatToolTurnCorrected(logs, {
      correlationId: "turn-unsupported-key-proof",
      messageId: "message-private-id",
      settledExchangeCount: 7,
      correctionKind: "unsupported-issue-key",
      unsupportedKeyCount: 1,
    });
    const event = logs.events.find((entry) => entry.op === "chat.tool-turn.corrected");
    expect(event).toMatchObject({
      correlationId: "turn-unsupported-key-proof",
      level: "warn",
      extra: {
        correctionKind: "unsupported-issue-key",
        unsupportedKeyCount: 1,
        settledExchangeCount: 7,
      },
    });
    expect(event?.extra).not.toHaveProperty("omittedFindingCount");
    const line = formatActivityLogProofLine(event ?? {});
    expectActivityLogProof("chat.tool-turn.corrected.line", line);
    expect(line).not.toMatch(/message-private-id|REQ-|SYN-/u);
  });
});

// Persisted transcript rows intentionally omit dispatch origin (old-reader compatibility).
// Only the live turn's private custody can decide whether a model result supports this answer.
describe("withToolResultsAsSource", () => {
  const answer = {
    userMessageId: "source-marker-proof",
    uncertainty: [
      { kind: "uncited-answer", claim: "synthetic missing citation" },
      { kind: "unsupported-citation", claim: "synthetic unsupported citation" },
    ],
  };
  it("retains source warnings without a usable model observation", () => {
    expect(withToolResultsAsSource(answer, { hasUsableObservation: () => false })).toBe(answer);
  });
  it("removes only the untraceable note after a privately settled usable result", () => {
    expect(
      withToolResultsAsSource(answer, { hasUsableObservation: () => true }).uncertainty,
    ).toEqual([answer.uncertainty[1]]);
    expect(answer.uncertainty).toHaveLength(2);
  });
});

describe("recordChatToolTurnResultCondensed", () => {
  it("records the stored and the sent row counts under the turn correlation", () => {
    const logs = createBufferedServerLogSink();
    recordChatToolTurnResultCondensed(logs, {
      correlationId: "result-condensed-proof",
      messageId: "message-private-id",
      rowCount: 370,
      keptRowCount: 1,
    });
    const event = logs.events.find((entry) => entry.op === "chat.tool-turn.result-condensed");
    expect(event?.extra).toMatchObject({ rowCount: 370, keptRowCount: 1 });
    const line = formatActivityLogProofLine(event ?? {});
    expectActivityLogProof("chat.tool-turn.result-condensed.line", line);
    expect(line).not.toContain("message-private-id");
  });
});
