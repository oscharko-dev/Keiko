// #4351 (owner decision 3): a provider that wants its reasoning back on tool turns is detected from
// its own rejection, answered once, and remembered for the deployment, with no model name and no
// hand-edited `reasoningHistory`.
import { describe, expect, it } from "vitest";
import { ContextOverflowError, ProviderError } from "@oscharko-dev/keiko-security/errors/gateway";
import { gatewayCatalogAdvertisement } from "./__fixtures__/toolCatalog.js";
import { Gateway, type GatewayCallRequest } from "./gateway.js";
import { createScriptedGatewayClock } from "./replay.js";
import type { ModelGatewayLogEvent } from "./observability.js";
import type {
  GatewayConfig,
  ModelCapability,
  NormalizedResponse,
  ProviderAdapter,
} from "./types.js";

const MODEL = "restore-fixture";
const CAPABILITY: ModelCapability = {
  id: MODEL,
  kind: "chat",
  contextWindow: 64_000,
  maxOutputTokens: 4_096,
  toolCalling: true,
  structuredOutput: false,
  streaming: true,
  supportsImageInput: false,
  supportsDocumentInput: false,
  workflowEligible: false,
  costClass: "low",
  latencyClass: "standard",
  throughputHint: "fixture",
  preferredUseCases: [],
  knownLimitations: [],
};
const CALL = { id: "call-read", name: "keiko_workspace_read", arguments: { relativePath: "a.ts" } };
const REASONING = "Compare the declarations before reading.";

function answer(tool: boolean): NormalizedResponse {
  return {
    modelId: MODEL,
    content: tool ? "Inspect the declaration." : "Verified.",
    finishReason: tool ? "tool_calls" : "stop",
    toolCalls: tool ? [CALL] : [],
    structuredOutput: null,
    reasoning: REASONING,
    usage: {
      requestId: "fixture",
      promptTokens: 20,
      completionTokens: 10,
      latencyMs: 1,
      costClass: "low",
    },
  };
}

function configuration(setting?: "current-turn" | "required-with-tools"): GatewayConfig {
  return {
    providers: [
      {
        modelId: MODEL,
        baseUrl: "https://model.example/v1",
        apiKey: "fixture-provider-credential",
        timeoutMs: 30_000,
        maxRetries: 1,
        retryBaseDelayMs: 1,
        ...(setting === undefined ? {} : { reasoningHistory: setting }),
      },
    ],
    capabilities: [CAPABILITY],
    circuitBreaker: { failureThreshold: 50, cooldownMs: 1_000, halfOpenProbes: 1 },
  };
}

function request(
  messages: GatewayCallRequest["messages"],
  scope = "session-a",
): GatewayCallRequest {
  return {
    modelId: MODEL,
    messages,
    toolCatalog: gatewayCatalogAdvertisement(createScriptedGatewayClock().now()),
    reasoningScope: scope,
    answerRepair: "steered",
  };
}

const FIRST: GatewayCallRequest["messages"] = [{ role: "user", content: "Inspect." }];

function afterTool(first: NormalizedResponse, tool = CALL): GatewayCallRequest["messages"] {
  return [
    ...FIRST,
    { role: "assistant", content: first.content, toolCalls: first.toolCalls },
    { role: "tool", content: "export const a = 1;", toolCallId: tool.id },
  ];
}

const hasReasoning = (input: GatewayCallRequest): boolean =>
  input.messages.some(
    (message) => message.role === "assistant" && message.reasoningContent !== undefined,
  );

function demanding(
  seen: GatewayCallRequest[],
  rejection: () => Error = () => new ProviderError("reasoning_content must be passed back", 400),
): ProviderAdapter["call"] {
  return (input) => {
    seen.push(input);
    if (seen.length === 1) return Promise.resolve(answer(true));
    if (input.messages.some((m) => m.role === "tool") && !hasReasoning(input))
      return Promise.reject(rejection());
    return Promise.resolve(answer(false));
  };
}

function gatewayFor(
  config: GatewayConfig,
  call: ProviderAdapter["call"],
  events: ModelGatewayLogEvent[] = [],
): Gateway {
  return new Gateway(config, {
    adapter: { call },
    clock: createScriptedGatewayClock(),
    random: () => 0.5,
    log: { write: (event): void => void events.push(event) },
  });
}

describe("a provider that demands its reasoning back, detected from its own rejection", () => {
  it("answers the rejected continuation once with the current turn's reasoning, then remembers it", async () => {
    const seen: GatewayCallRequest[] = [];
    const events: ModelGatewayLogEvent[] = [];
    const gateway = gatewayFor(configuration(), demanding(seen), events);
    const first = await gateway.chat(request(FIRST));
    expect(gateway.learnedReasoningOnToolTurns(MODEL)).toBe(false);

    const second = await gateway.chat(request(afterTool(first)));
    expect(second.content).toBe("Verified.");
    // Round 1, the rejected round 2, and its one retry: three provider requests, none repeated.
    expect(seen).toHaveLength(3);
    expect(seen[1] !== undefined && hasReasoning(seen[1])).toBe(false);
    expect(seen[2]?.messages[1]).toHaveProperty("reasoningContent", REASONING);
    expect(gateway.learnedReasoningOnToolTurns(MODEL)).toBe(true);
    // The retry is a closed, registered reason of its own on the existing retry evidence.
    const scheduled = events.filter((event) => event.op === "gateway.retry.scheduled");
    expect(scheduled.map((event) => event.extra?.reason)).toEqual(["reasoning-restore-repair"]);
    // ... and nothing the log carries is the reasoning.
    expect(JSON.stringify(events)).not.toContain(REASONING);
  });

  it("sends the reasoning from the first request once learned: no second rejection to pay for", async () => {
    const seen: GatewayCallRequest[] = [];
    const gateway = gatewayFor(configuration(), demanding(seen));
    const first = await gateway.chat(request(FIRST));
    await gateway.chat(request(afterTool(first)));
    seen.length = 0;
    // A later turn of the same deployment: the model returns a tool call, the next round carries its
    // reasoning at once.
    const turn: GatewayCallRequest["messages"] = [{ role: "user", content: "Again." }];
    const calling = await gateway.chat(request(turn, "session-b"));
    seen.length = 0;
    await gateway.chat(
      request(
        [
          ...turn,
          { role: "assistant", content: calling.content, toolCalls: calling.toolCalls },
          { role: "tool", content: "export const a = 1;", toolCallId: CALL.id },
        ],
        "session-b",
      ),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.messages[1]).toHaveProperty("reasoningContent", REASONING);
  });

  it("surfaces the ORIGINAL error when the retry is rejected again, and learns nothing", async () => {
    let calls = 0;
    const gateway = gatewayFor(configuration(), () => {
      calls += 1;
      if (calls === 1) return Promise.resolve(answer(true));
      return Promise.reject(
        new ProviderError(calls === 2 ? "original rejection" : "second rejection", 400),
      );
    });
    const first = await gateway.chat(request(FIRST));
    await expect(gateway.chat(request(afterTool(first)))).rejects.toThrow("original rejection");
    expect(calls).toBe(3);
    expect(gateway.learnedReasoningOnToolTurns(MODEL)).toBe(false);
  });

  it("lets an explicit provider setting win: no detection, no extra retry", async () => {
    const seen: GatewayCallRequest[] = [];
    const gateway = gatewayFor(configuration("current-turn"), demanding(seen));
    const first = await gateway.chat(request(FIRST));
    await gateway.chat(request(afterTool(first)));
    // The setting restores the reasoning on the first try; the rejection never happens.
    expect(seen).toHaveLength(2);
    expect(seen[1]?.messages[1]).toHaveProperty("reasoningContent", REASONING);
    // A rejection with the setting present is not answered by a detection retry either.
    const refused: GatewayCallRequest[] = [];
    const strict = gatewayFor(configuration("current-turn"), (input) => {
      refused.push(input);
      return refused.length === 1
        ? Promise.resolve(answer(true))
        : Promise.reject(new ProviderError("rejected anyway", 400));
    });
    const calling = await strict.chat(request(FIRST));
    await expect(strict.chat(request(afterTool(calling)))).rejects.toThrow("rejected anyway");
    expect(refused).toHaveLength(2);
  });

  it("does not retry without retained state: a continuation Keiko never saw fails as before", async () => {
    let calls = 0;
    const gateway = gatewayFor(configuration(), () => {
      calls += 1;
      return Promise.reject(new ProviderError("reasoning_content must be passed back", 400));
    });
    // No first round went through this gateway, so nothing is retained for the assistant message.
    await expect(gateway.chat(request(afterTool(answer(true))))).rejects.toThrow(
      "reasoning_content must be passed back",
    );
    expect(calls).toBe(1);
  });

  it.each([
    ["a context overflow", (): Error => new ContextOverflowError("window exceeded")],
    ["a rate limit as 429", (): Error => new ProviderError("slow down", 429)],
    ["a server error", (): Error => new ProviderError("upstream", 500)],
    ["an unauthorised request", (): Error => new ProviderError("no", 401)],
  ])("does not answer %s with a reasoning retry", async (_name, rejection) => {
    const seen: GatewayCallRequest[] = [];
    const base = configuration();
    const [provider] = base.providers;
    if (provider === undefined) throw new TypeError("expected a provider");
    const gateway = gatewayFor(
      { ...base, providers: [{ ...provider, maxRetries: 0 }] },
      demanding(seen, rejection),
    );
    const first = await gateway.chat(request(FIRST));
    await expect(gateway.chat(request(afterTool(first)))).rejects.toThrow();
    // Round 1 and the one rejected request; no restored request followed.
    expect(seen.filter((input) => hasReasoning(input))).toHaveLength(0);
    expect(gateway.learnedReasoningOnToolTurns(MODEL)).toBe(false);
  });

  it("keeps the reasoning only for the current turn until the deployment is learned", async () => {
    let calls = 0;
    const gateway = gatewayFor(configuration(), () => {
      calls += 1;
      return calls === 1
        ? Promise.resolve(answer(true))
        : Promise.reject(new ProviderError("reasoning_content must be passed back", 400));
    });
    const first = await gateway.chat(request(FIRST));
    // A request of a new turn (a new user message) ends the old turn: what was kept for it alone is
    // dropped, so the old turn's continuation can no longer be answered by a restore.
    await gateway
      .chat(request([...afterTool(first), { role: "user", content: "A new question." }]))
      .catch(() => undefined);
    calls = 1;
    await expect(gateway.chat(request(afterTool(first)))).rejects.toThrow(
      "reasoning_content must be passed back",
    );
    // One request, no restored retry behind it.
    expect(calls).toBe(2);
  });

  it("answers a stream rejected before its first chunk the same way", async () => {
    const seen: GatewayCallRequest[] = [];
    const gateway = gatewayFor(configuration(), demanding(seen));
    const first = await gateway.chat(request(FIRST));
    const chunks: string[] = [];
    for await (const chunk of gateway.chatStream(request(afterTool(first)))) {
      chunks.push(chunk.type);
    }
    expect(chunks).toContain("done");
    expect(seen).toHaveLength(3);
    expect(seen[2]?.messages[1]).toHaveProperty("reasoningContent", REASONING);
    expect(gateway.learnedReasoningOnToolTurns(MODEL)).toBe(true);
  });
});

// A turn the deployment learned its way through: the next request after it carries the reasoning.
async function learnedGateway(
  call: ProviderAdapter["call"],
  events: ModelGatewayLogEvent[] = [],
): Promise<Gateway> {
  const warmup: GatewayCallRequest[] = [];
  let live = false;
  const gateway = gatewayFor(
    configuration(),
    (input, options) => (live ? call(input, options) : demanding(warmup)(input, options)),
    events,
  );
  const first = await gateway.chat(request(FIRST));
  await gateway.chat(request(afterTool(first)));
  expect(gateway.learnedReasoningOnToolTurns(MODEL)).toBe(true);
  live = true;
  return gateway;
}

describe("a learned deployment that stops wanting its reasoning is unlearned (owner decision 3)", () => {
  const TURN: GatewayCallRequest["messages"] = [{ role: "user", content: "Again." }];
  const continuation = (calling: NormalizedResponse): GatewayCallRequest["messages"] => [
    ...TURN,
    { role: "assistant", content: calling.content, toolCalls: calling.toolCalls },
    { role: "tool", content: "export const a = 1;", toolCallId: CALL.id },
  ];

  it("answers a plain 400 on a restored continuation once without it, and unlearns on success", async () => {
    const seen: GatewayCallRequest[] = [];
    const events: ModelGatewayLogEvent[] = [];
    // The deployment now rejects any continuation that carries reasoning.
    const gateway = await learnedGateway((input) => {
      seen.push(input);
      if (seen.length === 1) return Promise.resolve(answer(true));
      return hasReasoning(input)
        ? Promise.reject(new ProviderError("reasoning_content is not accepted", 400))
        : Promise.resolve(answer(false));
    }, events);
    events.length = 0;
    const calling = await gateway.chat(request(TURN, "session-b"));
    const done = await gateway.chat(request(continuation(calling), "session-b"));
    expect(done.content).toBe("Verified.");
    // Round 1, the rejected restored round 2, and its one retry without reasoning.
    expect(seen).toHaveLength(3);
    expect(seen[1] !== undefined && hasReasoning(seen[1])).toBe(true);
    expect(seen[2] !== undefined && hasReasoning(seen[2])).toBe(false);
    expect(gateway.learnedReasoningOnToolTurns(MODEL)).toBe(false);
    expect(
      events
        .filter((event) => event.op === "gateway.retry.scheduled")
        .map((event) => event.extra?.reason),
    ).toEqual(["reasoning-withhold-repair"]);
    expect(
      events
        .filter((event) => event.op === "gateway.reasoning-history")
        .map((event) => event.extra?.state),
    ).toContain("unlearned");
    // Unlearned: the next continuation is sent without reasoning at once.
    seen.length = 0;
    const again = await gateway.chat(request(TURN, "session-c"));
    seen.length = 0;
    await gateway.chat(request(continuation(again), "session-c"));
    expect(seen).toHaveLength(1);
    expect(seen[0] !== undefined && hasReasoning(seen[0])).toBe(false);
  });

  it("stays learned when the retry without reasoning is rejected too, and surfaces the original error", async () => {
    let calls = 0;
    const gateway = await learnedGateway(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(answer(true));
      return Promise.reject(
        new ProviderError(calls === 2 ? "original unrelated rejection" : "second rejection", 400),
      );
    });
    const calling = await gateway.chat(request(TURN, "session-b"));
    await expect(gateway.chat(request(continuation(calling), "session-b"))).rejects.toThrow(
      "original unrelated rejection",
    );
    // Round 1, the rejected request, one retry: one repair per call.
    expect(calls).toBe(3);
    expect(gateway.learnedReasoningOnToolTurns(MODEL)).toBe(true);
  });

  it("grants no withhold retry when the setting is explicit", async () => {
    const seen: GatewayCallRequest[] = [];
    const gateway = gatewayFor(configuration("current-turn"), (input) => {
      seen.push(input);
      return seen.length === 1
        ? Promise.resolve(answer(true))
        : Promise.reject(new ProviderError("rejected anyway", 400));
    });
    const calling = await gateway.chat(request(TURN, "session-b"));
    await expect(gateway.chat(request(continuation(calling), "session-b"))).rejects.toThrow(
      "rejected anyway",
    );
    expect(seen).toHaveLength(2);
  });
});

describe("an unrelated 400 on a tool continuation with retained reasoning", () => {
  it("costs exactly one extra provider call, surfaces the original error and learns nothing", async () => {
    const seen: GatewayCallRequest[] = [];
    const events: ModelGatewayLogEvent[] = [];
    const gateway = gatewayFor(
      configuration(),
      (input) => {
        seen.push(input);
        return seen.length === 1
          ? Promise.resolve(answer(true))
          : Promise.reject(new ProviderError(`unsupported parameter ${String(seen.length)}`, 400));
      },
      events,
    );
    const first = await gateway.chat(request(FIRST));
    await expect(gateway.chat(request(afterTool(first)))).rejects.toThrow(
      "unsupported parameter 2",
    );
    expect(seen).toHaveLength(3);
    expect(gateway.learnedReasoningOnToolTurns(MODEL)).toBe(false);
    expect(events.filter((event) => event.op === "gateway.retry.scheduled")).toHaveLength(1);
    expect(
      events
        .filter((event) => event.op === "gateway.reasoning-history")
        .map((event) => event.extra?.state),
    ).not.toContain("learned");
  });
});

describe("what is kept for the current turn alone is dropped when the turn ENDS", () => {
  // A continuation of the first round, answered by a provider that would demand reasoning back.
  async function endedBy(
    end: (gateway: Gateway, first: NormalizedResponse) => Promise<unknown>,
  ): Promise<{ readonly calls: () => number; readonly replay: () => Promise<unknown> }> {
    let calls = 0;
    let rejectAll = false;
    const gateway = gatewayFor(configuration(), () => {
      calls += 1;
      if (calls === 1) return Promise.resolve(answer(true));
      if (rejectAll) return Promise.reject(new ProviderError("reasoning_content missing", 400));
      return Promise.resolve(answer(false));
    });
    const first = await gateway.chat(request(FIRST));
    await end(gateway, first);
    rejectAll = true;
    calls = 1;
    return {
      calls: (): number => calls,
      replay: (): Promise<unknown> => gateway.chat(request(afterTool(first))),
    };
  }

  it("on a final answer", async () => {
    const turn = await endedBy((gateway, first) => gateway.chat(request(afterTool(first))));
    await expect(turn.replay()).rejects.toThrow("reasoning_content missing");
    // One request and no restored retry behind it: nothing of the ended turn remains.
    expect(turn.calls()).toBe(2);
  });

  it("on a failure", async () => {
    let calls = 0;
    const base = configuration();
    const [provider] = base.providers;
    if (provider === undefined) throw new TypeError("expected a provider");
    // No provider retries, so each request below is one provider call.
    const gateway = gatewayFor({ ...base, providers: [{ ...provider, maxRetries: 0 }] }, () => {
      calls += 1;
      if (calls === 1) return Promise.resolve(answer(true));
      return Promise.reject(new ProviderError("reasoning_content missing", 400));
    });
    const first = await gateway.chat(request(FIRST));
    // The first rejection is answered by the restore retry, which fails too: the call has failed.
    await expect(gateway.chat(request(afterTool(first)))).rejects.toThrow();
    calls = 1;
    await expect(gateway.chat(request(afterTool(first)))).rejects.toThrow();
    // The failure ended the turn: the replay is one request, with no restore retry behind it.
    expect(calls).toBe(2);
    expect(gateway.learnedReasoningOnToolTurns(MODEL)).toBe(false);
  });

  it("on a cancellation", async () => {
    let calls = 0;
    const controller = new AbortController();
    const gateway = gatewayFor(configuration(), (input) => {
      calls += 1;
      if (calls === 1) return Promise.resolve(answer(true));
      if (input.cancellationSignal?.aborted === true) return Promise.reject(new Error("aborted"));
      return Promise.reject(new ProviderError("reasoning_content missing", 400));
    });
    const first = await gateway.chat(request(FIRST));
    controller.abort();
    await expect(
      gateway.chat({ ...request(afterTool(first)), cancellationSignal: controller.signal }),
    ).rejects.toThrow();
    calls = 1;
    await expect(gateway.chat(request(afterTool(first)))).rejects.toThrow(
      "reasoning_content missing",
    );
    expect(calls).toBe(2);
  });
});

describe("a model counts as served only once an actual call completed (#4351)", () => {
  it("is false before any call and after a failed one, true after a completed buffered call", async () => {
    let fail = true;
    const gateway = gatewayFor(
      ((): GatewayConfig => {
        const base = configuration();
        const [provider] = base.providers;
        if (provider === undefined) throw new TypeError("expected a provider");
        return { ...base, providers: [{ ...provider, maxRetries: 0 }] };
      })(),
      () =>
        fail ? Promise.reject(new ProviderError("down", 500)) : Promise.resolve(answer(false)),
    );
    expect(gateway.hasServedModel(MODEL)).toBe(false);
    await expect(gateway.chat(request(FIRST))).rejects.toThrow();
    expect(gateway.hasServedModel(MODEL)).toBe(false);
    fail = false;
    await gateway.chat(request(FIRST));
    expect(gateway.hasServedModel(MODEL)).toBe(true);
    expect(gateway.hasServedModel("unknown-model")).toBe(false);
  });

  it("is true after a completed streamed call", async () => {
    const gateway = gatewayFor(configuration(), () => Promise.resolve(answer(false)));
    const types: string[] = [];
    for await (const chunk of gateway.chatStream(request(FIRST))) types.push(chunk.type);
    expect(types).toContain("done");
    expect(gateway.hasServedModel(MODEL)).toBe(true);
  });
});
