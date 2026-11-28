import { describe, expect, it } from "vitest";
import { openCodeGatewayCatalogAdvertisement } from "./__fixtures__/toolCatalog.js";
import { Gateway, type GatewayCallRequest } from "./gateway.js";
import { OpenAiAdapter } from "./openai-adapter.js";
import { createScriptedGatewayClock } from "./replay.js";
import type { GatewayConfig, ModelCapability } from "./types.js";

// Finding O-5: a local KV cache (llama.cpp / Ollama) reuses only a byte-identical request prefix.
// This pins that the upstream body of one session's turn N+1 starts with the messages and tools of
// turn N, so a slow first byte cannot come from Keiko rewriting earlier turns.
const MODEL = "prefix-fixture";
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
const NOW = Date.parse("2026-11-27T00:00:00Z");

function toolReply(index: number): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: `Step ${String(index)}.`,
            reasoning_content: `Reasoning ${String(index)}.`,
            tool_calls: [
              {
                id: `call-${String(index)}`,
                type: "function",
                function: {
                  name: "keiko_workspace_discover",
                  arguments: '{"mode":"keywords","directory":"","query":"a","maxResults":10}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 30, completion_tokens: 7 },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

function config(reasoningHistory: boolean): GatewayConfig {
  return {
    providers: [
      {
        modelId: MODEL,
        baseUrl: "https://model.example/v1",
        apiKey: "fixture-provider-credential",
        timeoutMs: 30_000,
        maxRetries: 0,
        retryBaseDelayMs: 1,
        ...(reasoningHistory ? { reasoningHistory: "required-with-tools" as const } : {}),
      },
    ],
    capabilities: [CAPABILITY],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 1_000, halfOpenProbes: 1 },
  };
}

interface UpstreamBody {
  readonly messages: readonly unknown[];
  readonly tools: unknown;
}

async function runSession(reasoningHistory: boolean): Promise<readonly UpstreamBody[]> {
  const bodies: UpstreamBody[] = [];
  const adapter = new OpenAiAdapter({
    fetchImpl: (_url, init): Promise<Response> => {
      bodies.push(JSON.parse(init?.body as string) as UpstreamBody);
      return Promise.resolve(toolReply(bodies.length));
    },
    now: (): number => NOW,
    requestId: "prefix",
    costClass: "low",
    log: { write: (): void => undefined },
  });
  const gateway = new Gateway(config(reasoningHistory), {
    adapter,
    clock: createScriptedGatewayClock(),
  });
  let messages: GatewayCallRequest["messages"] = [
    { role: "system", content: "You are the coding agent." },
    { role: "user", content: "Inspect the repository." },
  ];
  for (let turn = 1; turn <= 4; turn++) {
    const reply = await gateway.chat({
      modelId: MODEL,
      messages,
      toolCatalog: openCodeGatewayCatalogAdvertisement(NOW + turn * 1_000),
      reasoningScope: "session-a",
    });
    messages = [
      ...messages,
      { role: "assistant", content: reply.content, toolCalls: reply.toolCalls },
      { role: "tool", content: `result ${String(turn)}`, toolCallId: `call-${String(turn)}` },
    ];
  }
  return bodies;
}

describe.each([false, true])(
  "upstream prompt prefix (reasoning history %s)",
  (reasoningHistory) => {
    it("keeps every earlier message and the tool list byte-identical in the next request", async () => {
      const bodies = await runSession(reasoningHistory);
      expect(bodies).toHaveLength(4);
      for (let turn = 1; turn < bodies.length; turn++) {
        const previous = bodies[turn - 1];
        const next = bodies[turn];
        if (previous === undefined || next === undefined) throw new Error("missing body");
        expect(next.messages).toHaveLength(previous.messages.length + 2);
        expect(JSON.stringify(next.tools)).toBe(JSON.stringify(previous.tools));
        previous.messages.forEach((message, index) => {
          expect(JSON.stringify(next.messages[index])).toBe(JSON.stringify(message));
        });
      }
    });
  },
);
