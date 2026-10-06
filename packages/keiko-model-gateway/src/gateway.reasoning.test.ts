// #3878: the gateway hands the model's reasoning only to a coding-workbench call, so the Coding
// Workbench can show it, and only while the operator has not switched `codingReasoningDisplay` off
// (owner decision 2026-10-06: on by default, opt-out only). Every other surface keeps its answer
// without reasoning. Either way the completion line records the reasoning share as counts only.
import { describe, expect, it } from "vitest";
import { TransportError } from "@oscharko-dev/keiko-security/errors/gateway";
import { Gateway, type GatewayCallRequest } from "./gateway.js";
import type { ModelGatewayLogEvent, ModelGatewayLogSink } from "./observability.js";
import { createScriptedGatewayClock } from "./replay.js";
import type {
  GatewayConfig,
  GatewayStreamChunk,
  ModelCapability,
  ModelProviderConfig,
  NormalizedResponse,
  ProviderAdapter,
} from "./types.js";

const REASONING = "private thought";

const PROVIDER: ModelProviderConfig = {
  modelId: "example-chat-model",
  baseUrl: "https://provider.example/v1",
  apiKey: "fixture",
  timeoutMs: 30_000,
  maxRetries: 2,
  retryBaseDelayMs: 1,
};

const CAPABILITY: ModelCapability = {
  id: "example-chat-model",
  kind: "chat",
  contextWindow: 64_000,
  maxOutputTokens: 4_096,
  toolCalling: true,
  structuredOutput: true,
  streaming: true,
  supportsImageInput: false,
  supportsDocumentInput: false,
  workflowEligible: false,
  costClass: "medium",
  latencyClass: "standard",
  throughputHint: "fixture",
  preferredUseCases: [],
  knownLimitations: [],
};

function config(codingReasoningDisplay?: GatewayConfig["codingReasoningDisplay"]): GatewayConfig {
  return {
    capabilities: [CAPABILITY],
    providers: [PROVIDER],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 1_000, halfOpenProbes: 1 },
    ...(codingReasoningDisplay === undefined ? {} : { codingReasoningDisplay }),
  };
}

const CODING: GatewayCallRequest = {
  modelId: "example-chat-model",
  messages: [{ role: "user", content: "fix it" }],
  latencyProfile: "coding-workbench",
};
const CHAT: GatewayCallRequest = { modelId: "example-chat-model", messages: CODING.messages };

const REASONED: NormalizedResponse = {
  modelId: "example-chat-model",
  content: "answer",
  finishReason: "stop",
  toolCalls: [],
  structuredOutput: null,
  usage: {
    requestId: "x",
    promptTokens: 3,
    completionTokens: 9,
    latencyMs: 1,
    costClass: "low",
    reasoningTokens: 6,
    reasoningBytes: REASONING.length,
  },
  reasoning: REASONING,
};

const PLAIN: NormalizedResponse = {
  modelId: "example-chat-model",
  content: "answer",
  finishReason: "stop",
  toolCalls: [],
  structuredOutput: null,
  usage: { requestId: "x", promptTokens: 3, completionTokens: 2, latencyMs: 1, costClass: "low" },
};

type Step = GatewayStreamChunk | Error;

const ANSWERED: readonly Step[] = [
  { type: "reasoning", token: REASONING },
  { type: "delta", token: "answer" },
  { type: "done", response: REASONED },
];

// A provider whose every attempt replays the next scripted step list (the last one repeats).
function scriptedAdapter(attempts: readonly (readonly Step[])[]): {
  readonly adapter: ProviderAdapter;
  readonly attempts: () => number;
} {
  let attempt = 0;
  const done = attempts.flat().find((step): step is Extract<Step, { type: "done" }> => {
    return !(step instanceof Error) && step.type === "done";
  });
  return {
    attempts: (): number => attempt,
    adapter: {
      call: (): Promise<NormalizedResponse> => Promise.resolve(done?.response ?? PLAIN),
      callStream: async function* (): AsyncGenerator<GatewayStreamChunk> {
        const steps = attempts[Math.min(attempt, attempts.length - 1)] ?? [];
        attempt += 1;
        await Promise.resolve();
        for (const step of steps) {
          if (step instanceof Error) throw step;
          yield step;
        }
      },
    },
  };
}

function recorder(): {
  readonly events: ModelGatewayLogEvent[];
  readonly sink: ModelGatewayLogSink;
} {
  const events: ModelGatewayLogEvent[] = [];
  return { events, sink: { write: (event): void => void events.push(event) } };
}

function gatewayWith(
  adapter: ProviderAdapter,
  configValue: GatewayConfig,
  log: ModelGatewayLogSink,
): Gateway {
  return new Gateway(configValue, { adapter, log, clock: createScriptedGatewayClock() });
}

async function streamed(
  gateway: Gateway,
  request: GatewayCallRequest,
): Promise<GatewayStreamChunk[]> {
  const chunks: GatewayStreamChunk[] = [];
  for await (const chunk of gateway.chatStream(request)) chunks.push(chunk);
  return chunks;
}

function kinds(chunks: readonly GatewayStreamChunk[]): string[] {
  return chunks.map((chunk) => (chunk.type === "done" ? "done" : `${chunk.type}:${chunk.token}`));
}

function terminal(chunks: readonly GatewayStreamChunk[]): NormalizedResponse {
  const last = chunks.at(-1);
  if (last?.type !== "done") throw new TypeError("the stream ended without a done chunk");
  return last.response;
}

function lineOf(events: readonly ModelGatewayLogEvent[], op: string): ModelGatewayLogEvent {
  const line = events.find((event) => event.op === op);
  if (line === undefined) throw new TypeError(`missing ${op}`);
  return line;
}

describe("Gateway reasoning policy (#3878)", () => {
  it("forwards the reasoning of a coding-workbench stream by default", async () => {
    const log = recorder();
    const gateway = gatewayWith(scriptedAdapter([ANSWERED]).adapter, config(), log.sink);

    const chunks = await streamed(gateway, CODING);

    expect(kinds(chunks)).toEqual([`reasoning:${REASONING}`, "delta:answer", "done"]);
    expect(terminal(chunks).reasoning).toBe(REASONING);
    expect(lineOf(log.events, "gateway.stream.completed").extra).toMatchObject({
      reasoningBytes: REASONING.length,
      reasoningTokens: 6,
      reasoningDisposition: "forwarded",
    });
    expect(JSON.stringify(log.events)).not.toContain(REASONING);
  });

  it("discards it when the operator switched codingReasoningDisplay off, keeping the counts", async () => {
    const log = recorder();
    const gateway = gatewayWith(scriptedAdapter([ANSWERED]).adapter, config("off"), log.sink);

    const chunks = await streamed(gateway, CODING);

    expect(kinds(chunks)).toEqual(["delta:answer", "done"]);
    const answer = terminal(chunks);
    expect(answer).not.toHaveProperty("reasoning");
    expect(answer.usage).toMatchObject({ reasoningBytes: REASONING.length, reasoningTokens: 6 });
    expect(lineOf(log.events, "gateway.stream.completed").extra).toMatchObject({
      reasoningBytes: REASONING.length,
      reasoningDisposition: "discarded",
    });
  });

  it("discards it on every other surface, whatever the switch says", async () => {
    const log = recorder();
    const gateway = gatewayWith(scriptedAdapter([ANSWERED]).adapter, config("on"), log.sink);

    const chunks = await streamed(gateway, CHAT);

    expect(kinds(chunks)).toEqual(["delta:answer", "done"]);
    expect(terminal(chunks)).not.toHaveProperty("reasoning");
    expect(lineOf(log.events, "gateway.stream.completed").extra).toMatchObject({
      reasoningDisposition: "discarded",
    });
  });

  it("records no reasoning share for an answer that carried none", async () => {
    const log = recorder();
    const plain: readonly Step[] = [
      { type: "delta", token: "answer" },
      { type: "done", response: PLAIN },
    ];
    const gateway = gatewayWith(scriptedAdapter([plain]).adapter, config(), log.sink);

    await streamed(gateway, CODING);

    const extra = lineOf(log.events, "gateway.stream.completed").extra;
    expect(extra).toMatchObject({ reasoningBytes: 0, reasoningDisposition: "none" });
    expect(extra).not.toHaveProperty("reasoningTokens");
  });

  it.each([
    ["a coding-workbench call", CODING, undefined, "forwarded"],
    ["a coding-workbench call with the display off", CODING, "off", "discarded"],
    ["any other call", CHAT, undefined, "discarded"],
  ] as const)(
    "applies the same policy to the buffered answer of %s",
    async (_label, request, display, disposition) => {
      const log = recorder();
      const gateway = gatewayWith(scriptedAdapter([ANSWERED]).adapter, config(display), log.sink);

      const answer = await gateway.chat(request);

      expect(answer.content).toBe("answer");
      expect(answer.reasoning).toBe(disposition === "forwarded" ? REASONING : undefined);
      expect(answer.usage).toMatchObject({ reasoningBytes: REASONING.length, reasoningTokens: 6 });
      expect(lineOf(log.events, "gateway.chat.completed").extra).toMatchObject({
        reasoningBytes: REASONING.length,
        reasoningTokens: 6,
        reasoningDisposition: disposition,
      });
      expect(JSON.stringify(log.events)).not.toContain(REASONING);
    },
  );

  // A discarded thought was never delivered, so a startup failure after it may still be retried;
  // a forwarded one was delivered, and replaying the stream would duplicate it (ADR-0003).
  it("still retries a startup failure that only discarded reasoning preceded", async () => {
    const failing: readonly Step[] = [
      { type: "reasoning", token: "first try" },
      new TransportError("connection dropped"),
    ];
    const scripted = scriptedAdapter([failing, ANSWERED]);
    const gateway = gatewayWith(scripted.adapter, config("off"), recorder().sink);

    const chunks = await streamed(gateway, CODING);

    expect(kinds(chunks)).toEqual(["delta:answer", "done"]);
    expect(scripted.attempts()).toBe(2);
  });

  it("never replays a stream whose forwarded reasoning already reached the caller", async () => {
    const failing: readonly Step[] = [
      { type: "reasoning", token: "first try" },
      new TransportError("connection dropped"),
    ];
    const scripted = scriptedAdapter([failing, ANSWERED]);
    const gateway = gatewayWith(scripted.adapter, config(), recorder().sink);
    const seen: string[] = [];

    await expect(
      (async (): Promise<void> => {
        for await (const chunk of gateway.chatStream(CODING)) seen.push(kinds([chunk])[0] ?? "");
      })(),
    ).rejects.toBeInstanceOf(TransportError);

    expect(seen).toEqual(["reasoning:first try"]);
    expect(scripted.attempts()).toBe(1);
  });

  it("forwards the reasoning of a non-streaming adapter's fallback answer on a coding call", async () => {
    const adapter: ProviderAdapter = { call: () => Promise.resolve(REASONED) };
    const gateway = gatewayWith(adapter, config(), recorder().sink);

    const chunks = await streamed(gateway, CODING);

    expect(kinds(chunks)).toEqual([`reasoning:${REASONING}`, "delta:answer", "done"]);
  });
});
