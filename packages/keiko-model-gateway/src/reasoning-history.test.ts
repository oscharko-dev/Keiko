import { describe, expect, it } from "vitest";
import {
  GatewayReasoningHistory,
  REASONING_HISTORY_MAX_ENTRIES,
  REASONING_HISTORY_MAX_BYTES,
  REASONING_HISTORY_TTL_MS,
} from "./reasoning-history.js";
import type { GatewayCallRequest } from "./gateway.js";
import { gatewayCatalogAdvertisement } from "./__fixtures__/toolCatalog.js";
import type { ModelGatewayLogEvent } from "./observability.js";
import type { ModelProviderConfig, NormalizedResponse } from "./types.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

const PROVIDER: ModelProviderConfig = {
  modelId: "fixture",
  baseUrl: "https://model.example/v1",
  apiKey: "fixture-secret-literal",
  timeoutMs: 1000,
  maxRetries: 0,
  retryBaseDelayMs: 1,
  reasoningHistory: "required-with-tools",
};
const CALL = {
  id: "call-1",
  name: "keiko_workspace_read",
  arguments: { relativePath: "fixture.ts" },
};
const ANSWER: NormalizedResponse = {
  modelId: "fixture",
  content: "Inspect the file.",
  toolCalls: [CALL],
  reasoning: "Prüfe die Datei.",
  structuredOutput: null,
  finishReason: "tool_calls",
  usage: {
    requestId: "fixture",
    promptTokens: 10,
    completionTokens: 10,
    latencyMs: 1,
    costClass: "low",
  },
};
const INITIAL: GatewayCallRequest = {
  modelId: "fixture",
  messages: [{ role: "user", content: "Inspect." }],
  reasoningScope: "scope-a",
  toolCatalog: gatewayCatalogAdvertisement(0),
  contentRedaction: "preserve",
};

function followup(response = ANSWER): GatewayCallRequest {
  return {
    ...INITIAL,
    messages: [
      ...INITIAL.messages,
      {
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
        reasoningContent: "Forged runtime echo.",
      },
      ...response.toolCalls.map((call) => ({
        role: "tool" as const,
        content: "result",
        toolCallId: call.id,
      })),
    ],
  };
}
function fixture(): {
  readonly history: GatewayReasoningHistory;
  readonly events: ModelGatewayLogEvent[];
  readonly advance: (ms: number) => void;
} {
  let now = 0;
  const events: ModelGatewayLogEvent[] = [];
  return {
    history: new GatewayReasoningHistory(
      {
        write: (event): void => {
          events.push(event);
        },
      },
      () => now,
    ),
    events,
    advance: (ms): void => {
      now += ms;
    },
  };
}

describe("transient completed reasoning state", () => {
  it("records exact UTF-8 counts through the production log formatter, without content or scope", () => {
    const f = fixture();
    f.history.remember(INITIAL, PROVIDER, ANSWER);
    f.history.prepare(followup(), PROVIDER);
    expect(f.events.map((event) => event.extra?.reasoningBytes)).toEqual([
      Buffer.byteLength(ANSWER.reasoning ?? ""),
      Buffer.byteLength(ANSWER.reasoning ?? ""),
    ]);
    for (const event of f.events) {
      const line = formatActivityLogProofLine(event);
      expectActivityLogProof("gateway.reasoning-history.lifecycle", line);
      for (const value of [
        ANSWER.reasoning,
        ANSWER.content,
        INITIAL.reasoningScope,
        PROVIDER.baseUrl,
        PROVIDER.apiKey,
      ]) {
        expect(line).not.toContain(value);
      }
    }
  });

  it.each(["length", "content_filter"] as const)("never retains a %s answer", (finishReason) => {
    const f = fixture();
    f.history.remember(INITIAL, PROVIDER, { ...ANSWER, finishReason });
    expect(() => f.history.prepare(followup(), PROVIDER)).toThrow("reasoning history");
  });

  it("never retains a cancelled answer", () => {
    const f = fixture();
    f.history.remember({ ...INITIAL, cancellationSignal: AbortSignal.abort() }, PROVIDER, ANSWER);
    expect(() => f.history.prepare(followup(), PROVIDER)).toThrow("reasoning history");
  });

  it("ignores untrusted echoed reasoning and refuses missing scope or state", () => {
    const f = fixture();
    for (const value of [followup(), { ...followup(), reasoningScope: undefined }]) {
      expect(() => f.history.prepare(value, PROVIDER)).toThrow("reasoning history");
    }
    expect(f.events.every((event) => event.extra?.state === "unavailable")).toBe(true);
  });

  it("expires idle state and requires fresh history", () => {
    const f = fixture();
    f.history.remember(INITIAL, PROVIDER, ANSWER);
    f.advance(REASONING_HISTORY_TTL_MS);
    expect(() => f.history.prepare(followup(), PROVIDER)).toThrow("reasoning history");
  });

  it("bounds retained entries and removes their tool-call lookup indexes", () => {
    const f = fixture();
    for (let index = 0; index <= REASONING_HISTORY_MAX_ENTRIES; index++) {
      f.history.remember(
        { ...INITIAL, reasoningScope: `scope-${String(index)}` },
        PROVIDER,
        ANSWER,
      );
    }
    expect(() => f.history.prepare({ ...followup(), reasoningScope: "scope-0" }, PROVIDER)).toThrow(
      "reasoning history",
    );
    expect(
      f.history.prepare(
        { ...followup(), reasoningScope: `scope-${String(REASONING_HISTORY_MAX_ENTRIES)}` },
        PROVIDER,
      ).messages[1]?.reasoningContent,
    ).toBe(ANSWER.reasoning);
  });

  it("keeps an identical payload with different reasoning ambiguous until expiry", () => {
    const f = fixture();
    f.history.remember(INITIAL, PROVIDER, ANSWER);
    f.history.remember(INITIAL, PROVIDER, {
      ...ANSWER,
      reasoning: "Different successful reasoning.",
    });
    f.history.remember(INITIAL, PROVIDER, ANSWER);
    expect(() => f.history.prepare(followup(), PROVIDER)).toThrow("reasoning history");
  });

  it.each(["baseUrl", "modelId", "deploymentIdentitySha256"] as const)(
    "does not borrow reasoning after %s changes",
    (field) => {
      const f = fixture();
      f.history.remember(INITIAL, PROVIDER, ANSWER);
      const value = field === "baseUrl" ? "https://other.example/v1" : "b".repeat(64);
      expect(() => f.history.prepare(followup(), { ...PROVIDER, [field]: value })).toThrow(
        "reasoning history",
      );
    },
  );

  it("retains the credential floor even when model content is preserved", () => {
    const f = fixture();
    f.history.remember(INITIAL, PROVIDER, {
      ...ANSWER,
      reasoning: `Check ${PROVIDER.apiKey} carefully.`,
    });
    const restored = f.history.prepare(followup(), PROVIDER).messages[1]?.reasoningContent;
    expect(restored).not.toContain(PROVIDER.apiKey);
    expect(restored).toContain("[REDACTED]");
  });

  it("does not add any reasoning field when the request has no tool catalog", () => {
    const f = fixture();
    f.history.remember(INITIAL, PROVIDER, ANSWER);
    const result = f.history.prepare({ ...followup(), toolCatalog: undefined }, PROVIDER);
    expect(result.messages.every((message) => message.reasoningContent === undefined)).toBe(true);
  });

  it("current-turn keeps only assistants after the latest human turn", () => {
    const f = fixture();
    const provider = { ...PROVIDER, reasoningHistory: "current-turn" as const };
    const current = { ...INITIAL, messages: [{ role: "user" as const, content: "Current." }] };
    f.history.remember(current, provider, ANSWER);
    const result = f.history.prepare(
      {
        ...current,
        messages: [
          { role: "user", content: "Uncached old question." },
          { role: "assistant", content: "Uncached old answer.", reasoningContent: "Old thinking." },
          ...current.messages,
          ...followup().messages.slice(1),
        ],
      },
      provider,
    );
    expect(result.messages[1]?.reasoningContent).toBeUndefined();
    expect(result.messages[3]?.reasoningContent).toBe(ANSWER.reasoning);
  });
});

it("refuses an oversized entry without logging assistant bytes as reasoning bytes", () => {
  const f = fixture();
  const oversized = { ...ANSWER, content: "x".repeat(REASONING_HISTORY_MAX_BYTES) };
  f.history.remember(INITIAL, PROVIDER, oversized);
  expect(f.events.at(-1)?.extra).toMatchObject({
    state: "capacity-exceeded",
    reasoningBytes: Buffer.byteLength(ANSWER.reasoning ?? ""),
  });
  expect(() => f.history.prepare(followup(oversized), PROVIDER)).toThrow("reasoning history");
});

it("reapplies the current content policy when an earlier call preserved model content", () => {
  const f = fixture();
  f.history.remember(INITIAL, PROVIDER, {
    ...ANSWER,
    reasoning: "Contact: +49 30 12345678",
  });
  expect(
    f.history.prepare({ ...followup(), contentRedaction: undefined }, PROVIDER).messages[1]
      ?.reasoningContent,
  ).not.toContain("+49 30 12345678");
});

it("joins pre-existing refinement caches and follows late writes from either original owner", () => {
  const old = fixture();
  const next = fixture();
  const second = { ...INITIAL, reasoningScope: "second-scope" };
  old.history.remember(INITIAL, PROVIDER, ANSWER);
  next.history.remember(second, PROVIDER, ANSWER);
  next.history.join(old.history);
  expect(next.history.prepare(followup(), PROVIDER).messages[1]?.reasoningContent).toBe(
    ANSWER.reasoning,
  );
  expect(
    old.history.prepare({ ...followup(), reasoningScope: "second-scope" }, PROVIDER).messages[1]
      ?.reasoningContent,
  ).toBe(ANSWER.reasoning);
  old.history.remember({ ...INITIAL, reasoningScope: "late-writer" }, PROVIDER, ANSWER);
  expect(
    next.history.prepare({ ...followup(), reasoningScope: "late-writer" }, PROVIDER).messages[1]
      ?.reasoningContent,
  ).toBe(ANSWER.reasoning);
});

it("refuses conflicts when pre-existing refinement caches join", () => {
  const old = fixture();
  const next = fixture();
  old.history.remember(INITIAL, PROVIDER, ANSWER);
  next.history.remember(INITIAL, PROVIDER, {
    ...ANSWER,
    reasoning: "Conflicting successful reasoning.",
  });
  next.history.join(old.history);
  for (const owner of [old, next])
    expect(() => owner.history.prepare(followup(), PROVIDER)).toThrow("reasoning history");
});
