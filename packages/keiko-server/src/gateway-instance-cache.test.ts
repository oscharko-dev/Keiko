import { beforeEach, describe, expect, it } from "vitest";

import { parseGatewayConfig, type GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import {
  gatewayForConfig,
  gatewayForRuntimeConfig,
  resetGatewayInstanceCacheForTests,
} from "./gateway-instance-cache.js";

function config(): GatewayConfig {
  return parseGatewayConfig({
    providers: [
      {
        modelId: "test-chat",
        baseUrl: "https://gateway.example.com/v1",
        apiKey: "test-token",
      },
    ],
  });
}

beforeEach(() => {
  resetGatewayInstanceCacheForTests();
});

describe("gateway instance cache", () => {
  it("reuses a config-keyed gateway when the runtime source is resolved later", () => {
    const current = config();
    const direct = gatewayForConfig(current);
    const runtime = gatewayForRuntimeConfig({ current: () => current, generation: () => 0 });

    expect(runtime).toBe(direct);
  });

  it("reuses a runtime-keyed gateway when the same config is resolved directly later", () => {
    const current = config();
    const runtime = gatewayForRuntimeConfig({ current: () => current, generation: () => 0 });

    expect(gatewayForConfig(current)).toBe(runtime);
  });
});
