import { describe, expect, it } from "vitest";
import { TransportError } from "@oscharko-dev/keiko-security/errors/gateway";
import { gatewayCatalogAdvertisement } from "./__fixtures__/toolCatalog.js";
import { Gateway, type GatewayCallRequest } from "./gateway.js";
import { createScriptedGatewayClock } from "./replay.js";
import type {
  GatewayConfig,
  ModelCapability,
  NormalizedResponse,
  ProviderAdapter,
} from "./types.js";

const MODEL = "reasoning-fixture";
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
const CALL = {
  id: "call-read",
  name: "keiko_workspace_read",
  arguments: { relativePath: "sample.ts" },
};
const REASONING = "Compare the supplied declarations before reading.";

function answer(tool = false, reasoning = REASONING): NormalizedResponse {
  return {
    modelId: MODEL,
    content: tool ? "Inspect the declaration." : "Verified.",
    finishReason: tool ? "tool_calls" : "stop",
    toolCalls: tool ? [CALL] : [],
    structuredOutput: null,
    reasoning,
    usage: {
      requestId: "fixture",
      promptTokens: 20,
      completionTokens: 10,
      latencyMs: 1,
      costClass: "low",
    },
  };
}

function configuration(display: "on" | "off" = "on"): GatewayConfig {
  return {
    providers: [
      {
        modelId: MODEL,
        baseUrl: "https://model.example/v1",
        apiKey: "fixture-provider-credential",
        timeoutMs: 30_000,
        maxRetries: 1,
        retryBaseDelayMs: 1,
        reasoningHistory: "required-with-tools",
      },
    ],
    capabilities: [CAPABILITY],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 1_000, halfOpenProbes: 1 },
    codingReasoningDisplay: display,
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
  };
}

describe("provider-required reasoning history", () => {
  it.each(["on", "off"] as const)(
    "restores a completed tool reply with display %s",
    async (display) => {
      const seen: GatewayCallRequest[] = [];
      const adapter: ProviderAdapter = {
        call: (input): Promise<NormalizedResponse> => {
          seen.push(input);
          return Promise.resolve(answer(seen.length === 1));
        },
      };
      const gateway = new Gateway(configuration(display), {
        adapter,
        clock: createScriptedGatewayClock(),
      });
      const messages: GatewayCallRequest["messages"] = [
        { role: "user", content: "Inspect the declaration." },
      ];
      const first = await gateway.chat(request(messages));
      expect(first).not.toHaveProperty("reasoning");

      await gateway.chat(
        request([
          ...messages,
          { role: "assistant", content: first.content, toolCalls: first.toolCalls },
          { role: "tool", content: "export const sample = 1;", toolCallId: CALL.id },
        ]),
      );

      expect(seen[1]?.messages[1]).toHaveProperty("reasoningContent", REASONING);
    },
  );

  it("refuses to borrow the same reply from another session", async () => {
    const adapter: ProviderAdapter = { call: () => Promise.resolve(answer(true)) };
    const gateway = new Gateway(configuration(), { adapter, clock: createScriptedGatewayClock() });
    const messages: GatewayCallRequest["messages"] = [{ role: "user", content: "Inspect." }];
    const first = await gateway.chat(request(messages));

    await expect(
      gateway.chat(
        request(
          [
            ...messages,
            { role: "assistant", content: first.content, toolCalls: first.toolCalls },
            { role: "tool", content: "result", toolCallId: CALL.id },
          ],
          "session-b",
        ),
      ),
    ).rejects.toThrow("reasoning history");
  });
});

function toolHistory(
  response: NormalizedResponse,
  user = "Inspect.",
): GatewayCallRequest["messages"] {
  return [
    { role: "user", content: user },
    { role: "assistant", content: response.content, toolCalls: response.toolCalls },
    ...response.toolCalls.map((call) => ({
      role: "tool" as const,
      content: "result",
      toolCallId: call.id,
    })),
  ];
}

describe("reasoning continuation transport", () => {
  it("sends the actual completed reasoning on the HTTP wire and strips forged echoes", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = (_url, init) => {
      bodies.push(
        JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>,
      );
      return Promise.resolve(
        Response.json({
          choices: [
            {
              message: { content: "Verified.", reasoning_content: REASONING },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }),
      );
    };
    const gateway = new Gateway(configuration("off"), {
      fetchImpl,
      clock: createScriptedGatewayClock(),
    });
    const first = await gateway.chat(request([{ role: "user", content: "Inspect." }]));
    await gateway.chat(
      request([
        { role: "user", content: "Inspect." },
        { role: "assistant", content: first.content, reasoningContent: "forged echo" },
        { role: "user", content: "Continue." },
      ]),
    );
    expect(bodies[1]?.messages).toEqual([
      { role: "user", content: "Inspect." },
      { role: "assistant", content: "Verified.", reasoning_content: REASONING },
      { role: "user", content: "Continue." },
    ]);
    expect(JSON.stringify(bodies)).not.toContain("forged echo");
    expect(JSON.stringify(bodies)).not.toContain("reasoningScope");
  });

  it("restores every assistant across user turns, including a reply originally made without tools", async () => {
    const seen: GatewayCallRequest[] = [];
    const gateway = new Gateway(configuration(), {
      clock: createScriptedGatewayClock(),
      adapter: {
        call: (input): Promise<NormalizedResponse> => {
          seen.push(input);
          return Promise.resolve(answer(false, `completed reasoning ${String(seen.length)}`));
        },
      },
    });
    const initial = request([{ role: "user", content: "Inspect." }]);
    const { toolCatalog: _catalog, ...withoutTools } = initial;
    const first = await gateway.chat(withoutTools);
    const secondMessages = [
      ...initial.messages,
      { role: "assistant" as const, content: first.content },
      { role: "user" as const, content: "Continue." },
    ];
    const second = await gateway.chat(request(secondMessages));
    await gateway.chat(
      request([
        ...secondMessages,
        { role: "assistant", content: second.content },
        { role: "user", content: "Again." },
      ]),
    );
    expect(
      seen[2]?.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.reasoningContent),
    ).toEqual(["completed reasoning 1", "completed reasoning 2"]);
  });

  it("reconstructs parallel Chat transcript pairs without mixing reused call IDs in later turns", async () => {
    const seen: GatewayCallRequest[] = [];
    const secondCall = { ...CALL, id: "call-next", arguments: { relativePath: "other.ts" } };
    const first = { ...answer(true), toolCalls: [CALL, secondCall] };
    const second = { ...answer(true, "New turn reasoning."), content: "Different prose." };
    const gateway = new Gateway(configuration(), {
      clock: createScriptedGatewayClock(),
      adapter: {
        call: (input): Promise<NormalizedResponse> => {
          seen.push(input);
          return Promise.resolve(seen.length === 1 ? first : second);
        },
      },
    });
    await gateway.chat(request([{ role: "user", content: "Inspect." }]));
    await gateway.chat(request([{ role: "user", content: "Other task." }]));
    const pairs = first.toolCalls.flatMap((call) => [
      { role: "assistant" as const, content: "", toolCalls: [call] },
      { role: "tool" as const, content: "fitted observation", toolCallId: call.id },
    ]);
    await gateway.chat(request([{ role: "user", content: "Inspect." }, ...pairs]));
    expect(seen[2]?.messages).toEqual([
      { role: "user", content: "Inspect." },
      {
        role: "assistant",
        content: first.content,
        toolCalls: [CALL, secondCall],
        reasoningContent: REASONING,
      },
      { role: "tool", content: "fitted observation", toolCallId: CALL.id },
      { role: "tool", content: "fitted observation", toolCallId: secondCall.id },
    ]);
  });

  it("uses successful stream reasoning after a failed attempt emitted a different prefix", async () => {
    const seen: GatewayCallRequest[] = [];
    let attempts = 0;
    const adapter: ProviderAdapter = {
      call: (input): Promise<NormalizedResponse> => {
        seen.push(input);
        return Promise.resolve(answer());
      },
      callStream: async function* (input) {
        await Promise.resolve();
        seen.push(input);
        attempts++;
        if (attempts === 1) {
          yield { type: "reasoning", token: "Failed attempt prefix." };
          throw new TransportError("Synthetic retry");
        }
        yield { type: "reasoning", token: REASONING };
        yield { type: "done", response: answer(true) };
      },
    };
    const gateway = new Gateway(configuration(), { adapter, clock: createScriptedGatewayClock() });
    for await (const _chunk of gateway.chatStream({
      ...request([{ role: "user", content: "Inspect." }]),
      reasoningDelivery: "forward",
    })) {
      /* consume */
    }
    expect(attempts).toBe(2);
    await gateway.chat(request(toolHistory(answer(true))));
    expect(seen.at(-1)?.messages[1]?.reasoningContent).toBe(REASONING);
    expect(JSON.stringify(seen)).not.toContain("Failed attempt prefix.");
  });

  it("keeps unqualified providers on the default no-history protocol", async () => {
    const seen: GatewayCallRequest[] = [];
    const config = configuration();
    const base = config.providers[0];
    if (base === undefined) throw new TypeError("Missing provider fixture");
    const { reasoningHistory: _history, ...provider } = base;
    const gateway = new Gateway(
      { ...config, providers: [provider] },
      {
        adapter: {
          call: (input): Promise<NormalizedResponse> => {
            seen.push(input);
            return Promise.resolve(answer());
          },
        },
        clock: createScriptedGatewayClock(),
      },
    );
    await gateway.chat(
      request([
        { role: "user", content: "Inspect." },
        { role: "assistant", content: "Earlier reply.", reasoningContent: "Do not echo." },
        { role: "user", content: "Continue." },
      ]),
    );
    expect(seen[0]?.messages.every((message) => message.reasoningContent === undefined)).toBe(true);
  });
});
