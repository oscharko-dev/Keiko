import { describe, expect, it } from "vitest";
import { Gateway, createDefaultChatCapability } from "@oscharko-dev/keiko-model-gateway";
import type { GatewayStreamChunk, NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import { deriveContextProfileFromCapability } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import { selectGatewayPromptAssembly, type GatewayPromptAssembly } from "./chat-prompt-budget.js";
import { createInMemoryUiStore } from "./store/index.js";

const capability = {
  ...createDefaultChatCapability("long-chat"),
  contextWindow: 32_000,
  maxOutputTokens: 0,
  supportsImageInput: true,
};
const profile = deriveContextProfileFromCapability(capability);
const answer = Array.from(
  { length: 30 },
  (_, index) =>
    `Abschnitt ${String(index)}: Wir prüfen die Anforderungen, behalten die Korrekturen und dokumentieren die nächsten Schritte.`,
).join("\n\n");
const response: NormalizedResponse = {
  modelId: capability.id,
  content: answer,
  toolCalls: [],
  structuredOutput: null,
  finishReason: "stop",
  usage: {
    requestId: "fixture",
    promptTokens: 1,
    completionTokens: 1,
    latencyMs: 1,
    costClass: "low",
  },
};

function fixture(): {
  gateway: Gateway;
  store: ReturnType<typeof createInMemoryUiStore>;
  chatId: string;
} {
  const store = createInMemoryUiStore();
  store.createProject(process.cwd(), "Fixture");
  const chat = store.createChat(process.cwd(), "Long conversation", capability.id);
  const gateway = new Gateway(
    {
      capabilities: [capability],
      providers: [
        {
          modelId: capability.id,
          baseUrl: "https://fixture.example/v1",
          apiKey: "fixture",
          timeoutMs: 1000,
          maxRetries: 0,
          retryBaseDelayMs: 1,
        },
      ],
      circuitBreaker: { failureThreshold: 3, cooldownMs: 1000, halfOpenProbes: 1 },
    },
    {
      adapter: {
        call: (): Promise<NormalizedResponse> => Promise.resolve(response),
        callStream: async function* (): AsyncGenerator<GatewayStreamChunk> {
          yield { type: "done", response: await Promise.resolve(response) };
        },
      },
    },
  );
  return { store, chatId: chat.id, gateway };
}

function appendTurn(target: ReturnType<typeof fixture>, turn: number): void {
  for (const role of ["user", "assistant"] as const) {
    target.store.createMessage({
      chatId: target.chatId,
      role,
      content: role === "user" ? `Bitte prüfe die nächste Änderung ${String(turn)}.` : answer,
      timestamp: turn * 2 + (role === "assistant" ? 1 : 0),
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
  }
}

const image = {
  type: "image_url" as const,
  image_url: { url: `data:image/png;base64,${Buffer.alloc(1_048_576).toString("base64")}` },
};

function assembledTurn(
  target: ReturnType<typeof fixture>,
  turn: number,
  imageCount: number,
): {
  selected: GatewayPromptAssembly;
  input: { modelId: string; messages: GatewayPromptAssembly["messages"] };
} {
  const history = target.store.listMessages(target.chatId);
  const selected = selectGatewayPromptAssembly({
    historyPrefix: history,
    historyTurnCount: history.length,
    request: {
      content: `Weiter mit Schritt ${String(turn)}.`,
      discussionMode: undefined,
      imageCount,
    },
    profile,
    memoryEntries: [],
    documentContext: [],
    redactionSecrets: [],
  });
  expect(selected, `assembly at turn ${String(turn)}`).toBeDefined();
  if (selected === undefined) throw new Error("Missing assembled conversation");
  expect(selected.messages.every((message) => message.contentParts === undefined)).toBe(true);
  const messages = selected.messages.map((message, index) =>
    imageCount > 0 && index === selected.messages.length - 1
      ? { ...message, contentParts: [{ type: "text" as const, text: message.content }, image] }
      : message,
  );
  return { selected, input: { modelId: capability.id, messages } };
}

async function admittedTurn(
  target: ReturnType<typeof fixture>,
  turn: number,
  imageCount: number,
  streaming: boolean,
): Promise<{ compacted: boolean; diagnosticDifference: number }> {
  const { selected, input } = assembledTurn(target, turn, imageCount);
  if (streaming) {
    const chunks = [];
    for await (const chunk of target.gateway.chatStream(input)) chunks.push(chunk);
    expect(chunks.at(-1)?.type).toBe("done");
  } else await expect(target.gateway.chat(input)).resolves.toMatchObject({ content: answer });
  const counted = countGatewayPromptTokens(input, profile.tokenAccounting, {
    contextWindow: profile.maxInputTokens,
  });
  expect(counted).toBeLessThanOrEqual(profile.effectiveInputBudget);
  appendTurn(target, turn);
  return {
    compacted: selected.compaction !== undefined,
    diagnosticDifference: selected.diagnostics.totalEstimatedTokens - counted,
  };
}

describe.each([false, true])("long-chat gateway admission, streaming=%s", (streaming) => {
  it.each([0, 1])(
    "continues through compaction with %i image on the latest turn",
    async (imageCount) => {
      const target = fixture();
      const results = [];
      for (let turn = 1; turn <= 60; turn += 1) {
        results.push(await admittedTurn(target, turn, imageCount, streaming));
      }
      expect(results.filter((result) => result.compacted).length).toBeGreaterThan(10);
      expect(results.every((result) => result.diagnosticDifference === 0)).toBe(true);
    },
  );
});
