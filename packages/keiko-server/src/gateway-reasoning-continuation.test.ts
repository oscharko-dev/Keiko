import { afterEach, expect, it, vi } from "vitest";
import { createInitialToolCatalog, compileToolProjection } from "@oscharko-dev/keiko-tool-catalog";
import {
  createDefaultChatCapability,
  type GatewayCallRequest,
  type GatewayConfig,
} from "@oscharko-dev/keiko-model-gateway";
import {
  gatewayForConfig,
  gatewayForRuntimeConfig,
  resetGatewayInstanceCacheForTests,
} from "./gateway-instance-cache.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";

const MODEL = "continuation-fixture";
const CONFIG: GatewayConfig = {
  providers: [
    {
      modelId: MODEL,
      baseUrl: "https://provider.example/v1",
      apiKey: "fixture",
      timeoutMs: 1000,
      maxRetries: 0,
      retryBaseDelayMs: 1,
      reasoningHistory: "required-with-tools",
    },
  ],
  capabilities: [
    {
      ...createDefaultChatCapability(MODEL),
      contextWindow: 64000,
      maxOutputTokens: 4096,
      toolCalling: true,
      streaming: false,
    },
  ],
  circuitBreaker: { failureThreshold: 5, cooldownMs: 1000, halfOpenProbes: 1 },
};
function request(
  messages: GatewayCallRequest["messages"],
  scope = "session-a",
): GatewayCallRequest {
  const catalog = createInitialToolCatalog();
  const projection = compileToolProjection(catalog, { id: "legacy-native", version: 1 });
  return {
    modelId: MODEL,
    reasoningScope: scope,
    messages,
    toolCatalog: {
      kind: "bound",
      catalog,
      projection,
      offered: {
        binding: {
          catalogRevision: catalog.catalogRevision,
          profile: projection.profile,
          projectionDigest: projection.projectionDigest,
          handlerSetDigest: projection.projectionDigest,
          readiness: "ready",
        },
        offerId: "continuation-offer",
        toolRefs: projection.tools.map((tool) => tool.toolRef),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
    },
  };
}
function upstream(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({
          choices: [
            {
              message: { content: "Ready.", reasoning_content: "Completed fixture reasoning." },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }),
      ),
    ),
  );
}
const INITIAL = [{ role: "user", content: "Inspect." }] as const;
const FOLLOWUP = [
  ...INITIAL,
  { role: "assistant", content: "Ready." },
  { role: "user", content: "Continue." },
] as const;
afterEach(() => {
  vi.unstubAllGlobals();
  resetGatewayInstanceCacheForTests();
  resetServerLogger();
});

it.each([false, true])(
  "retains completed continuation through same-generation refinement, including pre-created target=%s",
  async (precreated) => {
    upstream();
    let current = CONFIG;
    let generation = 0;
    const source = { current: (): GatewayConfig => current, generation: (): number => generation };
    const first = gatewayForRuntimeConfig(source);
    if (first === undefined) throw new TypeError("Missing gateway fixture");
    await first.chat(request(INITIAL));
    current = {
      ...CONFIG,
      capabilities: CONFIG.capabilities?.map((capability) => ({
        ...capability,
        contextWindow: 32000,
      })),
    };
    const direct = precreated ? gatewayForConfig(current) : undefined;
    const refined = gatewayForRuntimeConfig(source);
    if (refined === undefined) throw new TypeError("Missing refined gateway fixture");
    if (direct !== undefined) expect(refined).toBe(direct);
    await expect(refined.chat(request(FOLLOWUP))).resolves.toMatchObject({ content: "Ready." });
    generation++;
    await expect(gatewayForRuntimeConfig(source)?.chat(request(FOLLOWUP))).rejects.toThrow(
      "reasoning history",
    );
  },
);

it("does not reconnect retired direct-instance history after a real generation change", async () => {
  upstream();
  let current = CONFIG;
  let generation = 0;
  const source = { current: (): GatewayConfig => current, generation: (): number => generation };
  const old = gatewayForRuntimeConfig(source);
  if (old === undefined) throw new TypeError("Missing gateway fixture");
  await old.chat(request(INITIAL));
  current = { ...CONFIG };
  generation++;
  gatewayForRuntimeConfig(source);
  expect(gatewayForConfig(CONFIG)).toBe(old);
  current = CONFIG;
  const rebound = gatewayForRuntimeConfig(source);
  expect(gatewayForConfig(CONFIG)).toBe(rebound);
  await expect(rebound?.chat(request(FOLLOWUP))).rejects.toThrow("reasoning history");
});

it("does not resurrect pre-withdrawal state when recovery keeps the generation number", async () => {
  upstream();
  let current: GatewayConfig | undefined = CONFIG;
  const source = { current: (): GatewayConfig | undefined => current, generation: (): number => 0 };
  const old = gatewayForRuntimeConfig(source);
  if (old === undefined) throw new TypeError("Missing gateway fixture");
  await old.chat(request(INITIAL));
  current = undefined;
  expect(gatewayForRuntimeConfig(source)).toBeUndefined();
  current = { ...CONFIG };
  gatewayForRuntimeConfig(source);
  current = CONFIG;
  await expect(gatewayForRuntimeConfig(source)?.chat(request(FOLLOWUP))).rejects.toThrow(
    "reasoning history",
  );
});
