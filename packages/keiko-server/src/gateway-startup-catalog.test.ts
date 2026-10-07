import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDefaultChatCapability, parseGatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import { buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";

const compositions: UiHandlerDeps[] = [];
const directories: string[] = [];
afterEach(async (): Promise<void> => {
  for (const deps of compositions.splice(0)) await deps.dispose?.();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

it("discovers LiteLLM chat models and verifies tools at startup without opening a window", async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-startup-catalog-"));
  directories.push(dir);
  const discovery = vi.fn().mockResolvedValue({
    modelIds: ["chat-model", "new-chat"],
    chatModelIds: ["chat-model", "new-chat"],
    embeddingModelIds: [],
    modelMetadata: {
      "chat-model": { contextWindow: 64_000 },
      "new-chat": { contextWindow: 64_000 },
    },
  });
  const fetch = vi.fn().mockImplementation((_input: unknown, init: RequestInit) => {
    const tools = typeof init.body === "string" && init.body.includes("report_readiness");
    return Promise.resolve(
      Response.json({
        choices: [
          {
            message: {
              content: "OK",
              ...(tools
                ? {
                    tool_calls: [
                      { function: { name: "report_readiness", arguments: '{"status":"ok"}' } },
                    ],
                  }
                : {}),
            },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  const deps = buildUiHandlerDeps({
    configPath: undefined,
    env: {},
    uiDbPath: join(dir, "ui.db"),
    evidenceDir: join(dir, "evidence"),
    gatewayModelDiscovery: discovery,
  });
  compositions.push(deps);
  const config = parseGatewayConfig({
    providers: [
      {
        modelId: "chat-model",
        baseUrl: "https://provider.example.invalid/v1",
        apiKey: "throwaway-key",
        tokenCounter: "litellm",
        timeoutMs: 1000,
        maxRetries: 0,
        retryBaseDelayMs: 1,
      },
    ],
    capabilities: [
      {
        ...createDefaultChatCapability("chat-model"),
        contextWindow: 32_000,
        maxOutputTokens: 2000,
      },
    ],
  });
  deps.gatewayConfig?.set(config, true, "corr-startup-catalog");
  await vi.waitFor(() => {
    expect(deps.gatewayConfig?.current()?.providers.map((provider) => provider.modelId)).toContain(
      "new-chat",
    );
    expect(
      deps.gatewayConfig?.current()?.capabilities?.find((model) => model.id === "new-chat")
        ?.toolCalling,
    ).toBe(true);
  });
  expect(discovery).toHaveBeenCalledTimes(1);
  expect(deps.gatewayConfig?.current()?.providers[0]?.baseUrl).toBe(config.providers[0]?.baseUrl);
  expect(deps.gatewayConfig?.verifiedCapability("new-chat")?.fields.conversationReady).toBe(true);
});
