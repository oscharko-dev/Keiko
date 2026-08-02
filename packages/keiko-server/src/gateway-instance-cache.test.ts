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

  it("invalidates the runtime gateway when the generation advances for the same config object", () => {
    const current = config();
    let generation = 0;
    const source = {
      current: (): GatewayConfig => current,
      generation: (): number => generation,
    };
    const initial = gatewayForRuntimeConfig(source);

    generation += 1;

    expect(gatewayForRuntimeConfig(source)).not.toBe(initial);
  });

  it("invalidates the runtime gateway when the current config becomes unavailable", () => {
    const current = config();
    let available: GatewayConfig | undefined = current;
    const source = {
      current: (): GatewayConfig | undefined => available,
      generation: (): number => 0,
    };
    const initial = gatewayForRuntimeConfig(source);

    available = undefined;

    expect(gatewayForRuntimeConfig(source)).toBeUndefined();
    available = current;
    expect(gatewayForRuntimeConfig(source)).not.toBe(initial);
  });
});
