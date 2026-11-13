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
