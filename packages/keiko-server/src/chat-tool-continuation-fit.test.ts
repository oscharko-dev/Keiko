import { describe, expect, it } from "vitest";
import { deriveContextProfile } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import type { ChatMessage as GatewayMessage } from "@oscharko-dev/keiko-contracts";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ToolResultEnvelope } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { gatewayMessagesForToolExchange } from "./conversation-gateway.js";
import {
  estimateGatewayMessageTokens,
  fitToolContinuation,
  fitToolRoundOutput,
} from "./chat-tool-continuation-fit.js";

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

function reviewExchange(
  data: Record<string, unknown> = {},
  receipt: Record<string, unknown> = {},
): ChatToolExchange {
  return exchange(40, {
    status: "failed",
    reason: "provider-reported-error",
    toolRef: { canonicalId: "keiko.knowledge.review", contractVersion: 2 },
    data: {
      outcome: "failed",
      reason: "model-output-invalid",
      failureStage: "model-output-invalid",
      validationReason: "anchor-range",
      sourceAvailable: true,
      privateBody: BULK,
      ...data,
    },
    ...receipt,
  });
}
function forcedReviewCompaction(review: ChatToolExchange): {
  readonly compacted: Record<string, unknown>;
  readonly last: GatewayMessage | undefined;
} {
  const newest = EXCHANGES.at(-1);
  if (newest === undefined) throw new TypeError("Missing newest exchange");
  const exchanges = [review, newest];
  const continuation = continuationOf(exchanges);
  const fitted = fitToolContinuation(continuation, exchanges, 0);
  expect(fitted.elidedCount).toBe(1);
  expect(fitted.messages.at(-1)).toEqual(continuation.at(-1));
  return {
    compacted: JSON.parse(fitted.messages[1]?.content ?? "") as Record<string, unknown>,
    last: fitted.messages.at(-1),
  };
}

describe("review-v2 failure compaction", () => {
  it.each(["model-output-invalid", "model-port-unavailable", "budget-port-unavailable"] as const)(
    "retains only the source-checked closed %s facts through actual forced compaction",
    (stage) => {
      const review = reviewExchange({
        reason: stage,
        failureStage: stage,
        ...(stage === "model-output-invalid" ? {} : { validationReason: undefined }),
      });
      const before = JSON.stringify(review);
      const { compacted } = forcedReviewCompaction(review);
      expect(compacted).toEqual({
        elided: true,
        status: "failed",
        reason: "provider-reported-error",
        failureStage: stage,
        sourceAvailable: true,
        ...(stage === "model-output-invalid" ? { validationReason: "anchor-range" } : {}),
      });
      expect(JSON.stringify(compacted)).not.toContain("Synthetic requirement text");
      expect(JSON.stringify(review)).toBe(before);
    },
  );

  it.each([
    [{}, { toolRef: { canonicalId: "external.tool", contractVersion: 2 } }],
    [{}, { toolRef: { canonicalId: "keiko.knowledge.documents", contractVersion: 2 } }],
    [{}, { toolRef: { canonicalId: "keiko.knowledge.review", contractVersion: 1 } }],
    [{}, { status: "completed" }],
    [{}, { reason: "handler-failed" }],
    [{ outcome: "succeeded" }, {}],
    [{ reason: "unavailable" }, {}],
    [{ sourceAvailable: false }, {}],
    [{ sourceAvailable: "true" }, {}],
    [{ sourceAvailable: undefined }, {}],
    [{ reason: "private-stage", failureStage: "private-stage" }, {}],
    [{ validationReason: "PRIVATE_MODEL_TEXT" }, {}],
    [{ validationReason: { private: BULK } }, {}],
  ] as const)(
    "does not carry source-availability or diagnosis from an untrusted or legacy receipt: %s",
    (data, receipt) => {
      const { compacted } = forcedReviewCompaction(reviewExchange(data, receipt));
      expect(compacted).not.toHaveProperty("failureStage");
      expect(compacted).not.toHaveProperty("validationReason");
      expect(compacted).not.toHaveProperty("sourceAvailable");
      expect(JSON.stringify(compacted)).not.toContain("PRIVATE_MODEL_TEXT");
    },
  );
});

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
        toolRef: { canonicalId: "keiko.jira.draft", contractVersion: 3 },
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
    const newest = EXCHANGES.at(-1);
    if (newest === undefined) throw new Error("Missing newest exchange");
    const exchanges = [draft, newest];
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

  it("keeps every key of a compact draft whose created keys are scattered", () => {
    const draft = exchange(
      5,
      {
        status: "completed",
        toolRef: { canonicalId: "keiko.jira.draft", contractVersion: 3 },
        data: {
          outcome: "succeeded",
          compact: true,
          items: [],
          createdRanges: ["SYN-1,SYN-3,SYN-5..SYN-9", "SYN-2001"],
          summary: BULK,
        },
      },
      "succeeded",
    );
    const newest = EXCHANGES.at(-1);
    if (newest === undefined) throw new Error("Missing newest exchange");
    const exchanges = [draft, newest];
    const fitted = fitToolContinuation(continuationOf(exchanges), exchanges, 0);
    expect(JSON.parse(fitted.messages[1]?.content ?? "")).toEqual({
      elided: true,
      status: "completed",
      mutationOutcome: "succeeded",
      items: [
        { state: "created", issueKey: "SYN-1" },
        { state: "created", issueKey: "SYN-3" },
        { state: "created", issueKey: "SYN-5..SYN-9" },
        { state: "created", issueKey: "SYN-2001" },
      ],
    });
  });

  it("never compacts a read's draft-shaped items into write receipts", () => {
    const read = exchange(5, {
      status: "completed",
      toolRef: { canonicalId: "keiko.mcp.tabc", contractVersion: 1 },
      data: { items: [{ state: "created", issueKey: "REQ-123", note: BULK }] },
    });
    const newest = EXCHANGES.at(-1);
    if (newest === undefined) throw new Error("Missing newest exchange");
    const exchanges = [read, newest];
    const fitted = fitToolContinuation(continuationOf(exchanges), exchanges, 0);
    expect(JSON.parse(fitted.messages[1]?.content ?? "")).toEqual({
      elided: true,
      status: "completed",
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

// Output is a maximum: a continued turn may use the remaining window without losing its sources.
describe("fitToolRoundOutput", () => {
  const tools = [
    {
      name: "read",
      description: "Read source material",
      parameters: { type: "object", properties: {} },
    },
  ];
  const request = {
    modelId: "fit-proof",
    messages: [{ role: "user" as const, content: "Synthetic source. ".repeat(100) }],
    maxOutputTokens: 1024,
    responseFormat: {
      type: "json_schema" as const,
      name: "result",
      strict: true,
      schema: { type: "object", properties: {} },
    },
  };
  const limits = { maxOutputTokens: 1024 };
  const prompt = countGatewayPromptTokens({ ...request, tools });
  const profile = deriveContextProfile({
    maxInputTokens: prompt + 256 + 600,
    reservedOutputTokens: 1024,
    safetyMarginTokens: 256,
  });

  it("accounts for tools and structured output while preserving full input and its safety margin", () => {
    const fitted = fitToolRoundOutput(request, profile, tools, limits);
    expect(fitted.maxOutputTokens).toBe(600);
    expect(fitted.messages).toBe(request.messages);
    expect(fitted.responseFormat).toBe(request.responseFormat);
    expect(
      countGatewayPromptTokens({ ...fitted, tools }) +
        (fitted.maxOutputTokens ?? 0) +
        profile.safetyMarginTokens,
    ).toBe(profile.maxInputTokens);
  });

  it("does not consume an independent input ceiling or leave an unusably small output", () => {
    expect(
      fitToolRoundOutput(request, { ...profile, inputTokenLimit: prompt - 1 }, tools, limits),
    ).toBe(request);
    expect(
      fitToolRoundOutput(
        request,
        { ...profile, maxInputTokens: prompt + 256 + 255 },
        tools,
        limits,
      ),
    ).toBe(request);
  });

  it("accepts a valid explicit output maximum above the profile default reserve", () => {
    const explicit = { ...request, maxOutputTokens: 1536 };
    expect(
      fitToolRoundOutput(explicit, profile, tools, { maxOutputTokens: 2048 }).maxOutputTokens,
    ).toBe(600);
  });

  it("never increases a requested reserve or repairs invalid caller output bounds", () => {
    expect(fitToolRoundOutput(request, { ...profile, maxInputTokens: 32768 }, tools, limits)).toBe(
      request,
    );
    const invalid = { ...request, maxOutputTokens: 0 };
    expect(fitToolRoundOutput(invalid, profile, tools, limits)).toBe(invalid);
    const over = { ...request, maxOutputTokens: 2048 };
    expect(fitToolRoundOutput(over, profile, tools, limits)).toBe(over);
  });
});

const STAGED_REFERENCE = {
  draftId: "b0e5678a-2974-4a6b-a56c-9e74fc989a85",
  draftDigest: "a".repeat(64),
};
function stageExchange(
  data: Record<string, unknown> = {},
  receipt: Record<string, unknown> = {},
): ChatToolExchange {
  const staged = exchange(60, {
    status: "completed",
    toolRef: { canonicalId: "keiko.jira.draft.stage", contractVersion: 1 },
    data: {
      outcome: "succeeded",
      ...STAGED_REFERENCE,
      newDraft: true,
      itemCount: 2,
      pageCount: 1,
      unresolvedRefCount: 0,
      unresolvedRefs: [],
      privateBody: BULK,
      ...data,
    },
    ...receipt,
  });
  return { ...staged, call: { ...staged.call, name: "jira_draft_stage" } };
}
function forcedStageCompaction(stage: ChatToolExchange): Record<string, unknown> {
  const newest = EXCHANGES.at(-1);
  if (newest === undefined) throw new TypeError("Missing newest exchange");
  const exchanges = [stage, newest];
  const original = continuationOf(exchanges);
  const fitted = fitToolContinuation(original, exchanges, 0);
  expect(fitted.elidedCount).toBe(1);
  expect(fitted.messages.at(-1)).toEqual(original.at(-1));
  return JSON.parse(fitted.messages[1]?.content ?? "") as Record<string, unknown>;
}
describe("stored Jira stage receipt compaction", () => {
  it("retains exact stored ID, digest and counts after real forced compaction without claiming a mutation", () => {
    const stage = stageExchange();
    const before = JSON.stringify(stage);
    expect(forcedStageCompaction(stage)).toEqual({
      elided: true,
      status: "completed",
      ...STAGED_REFERENCE,
      itemCount: 2,
      pageCount: 1,
      unresolvedRefCount: 0,
      unresolvedRefs: [],
    });
    expect(JSON.stringify(stage)).toBe(before);
  });
  it("retains the bounded unresolved references and their truthful total for the next append", () => {
    const unresolvedRefs = Array.from({ length: 32 }, (_, index) => `task${String(index)}`);
    const compacted = forcedStageCompaction(
      stageExchange({ itemCount: 100, pageCount: 2, unresolvedRefCount: 35, unresolvedRefs }),
    );
    expect(compacted).toMatchObject({
      ...STAGED_REFERENCE,
      itemCount: 100,
      pageCount: 2,
      unresolvedRefCount: 35,
      unresolvedRefs,
    });
    expect(compacted).not.toHaveProperty("items");
    expect(compacted).not.toHaveProperty("mutationOutcome");
    expect(JSON.stringify(compacted)).not.toContain("Synthetic requirement text");
  });
  it.each([
    [{}, { toolRef: { canonicalId: "external.tool", contractVersion: 1 } }],
    [{}, { toolRef: { canonicalId: "keiko.jira.draft.stage", contractVersion: 2 } }],
    [{}, { toolRef: { canonicalId: "keiko.jira.draft", contractVersion: 3 } }],
    [{}, { status: "failed" }],
    [{ outcome: "rejected" }, {}],
    [{ draftId: "private body" }, {}],
    [{ draftId: STAGED_REFERENCE.draftId + "\n" }, {}],
    [{ draftDigest: "A".repeat(64) }, {}],
    [{ itemCount: -1 }, {}],
    [{ itemCount: Number.NaN }, {}],
    [{ itemCount: 1.5 }, {}],
    [{ itemCount: 16 * 1024 * 1024 + 1 }, {}],
    [{ itemCount: 51, pageCount: 1 }, {}],
    [{ pageCount: 0 }, {}],
    [{ pageCount: 3 }, {}],
    [{ unresolvedRefCount: 1 }, {}],
    [{ unresolvedRefCount: 1, unresolvedRefs: ["private text with spaces"] }, {}],
    [{ unresolvedRefCount: 1, unresolvedRefs: ["task\n"] }, {}],
    [{ unresolvedRefCount: 2, unresolvedRefs: ["task", "task"] }, {}],
  ] as const)(
    "rejects forged stage identity, status, references or count facts: %s",
    (data, receipt) => {
      const compacted = forcedStageCompaction(stageExchange(data, receipt));
      expect(compacted).not.toHaveProperty("draftId");
      expect(compacted).not.toHaveProperty("draftDigest");
      expect(compacted).not.toHaveProperty("unresolvedRefs");
      expect(compacted).not.toHaveProperty("itemCount");
    },
  );
});
