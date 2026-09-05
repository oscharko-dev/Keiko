// Proves the production composition of `PrDescriptionServiceOptions.generation` (#3399 mounts
// #3398's `generatePrDescription`, epic #3384 Frozen Product Decision 8):
//   * No configured model profile composes to `undefined` — the ONE closed reason
//     `prDescriptionRoutes.ts`'s "unavailable" fallback exists for.
//   * A configured profile reuses the SAME cached Gateway instance every other server caller
//     reuses (`gateway-instance-cache.ts`), never a second Gateway.
//   * Branding is derived from the SAME `resolvePrDescriptionBrandingFromConfig` producer #3398
//     built, never restated here.
//   * `errorEvidence` is body-free: dist-anchored frames/cause chain, never the error's own message.
//   * The `pr-description.generation.*` ops fire through the composed path end to end.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseGatewayConfig, type GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import {
  gatewayForRuntimeConfig,
  resetGatewayInstanceCacheForTests,
  type RuntimeGatewayConfigSource,
} from "../gateway-instance-cache.js";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
  type BufferedServerLogSink,
} from "../observability/index.js";
import { createProductionPrDescriptionGeneration } from "./prDescriptionGeneration.js";

function config(): GatewayConfig {
  return parseGatewayConfig({
    providers: [
      {
        modelId: "test-chat",
        baseUrl: "https://gateway.example.com/v1",
        apiKey: "test-token",
      },
    ],
    branding: { logoUrl: `https://cdn.example.org/${"a".repeat(40)}/keiko-logo.svg` },
  });
}

function source(current: GatewayConfig | undefined): RuntimeGatewayConfigSource {
  return { current: () => current, generation: () => 1 };
}

let logs: BufferedServerLogSink;

beforeEach(() => {
  resetGatewayInstanceCacheForTests();
  logs = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink: logs, level: "debug" }));
});
afterEach(() => {
  resetServerLogger();
});

describe("createProductionPrDescriptionGeneration (#3399)", () => {
  it("composes to undefined when no runtime config source is wired at all", () => {
    expect(createProductionPrDescriptionGeneration(undefined)).toBeUndefined();
  });

  it("composes to undefined — a closed reason, not a throw — when no model profile is configured", () => {
    expect(createProductionPrDescriptionGeneration(source(undefined))).toBeUndefined();
  });

  it("reuses the SAME cached Gateway instance every other server caller reuses", () => {
    const cfg = config();
    const runtimeConfig = source(cfg);
    const expectedGateway = gatewayForRuntimeConfig(runtimeConfig);
    const generation = createProductionPrDescriptionGeneration(runtimeConfig);
    expect(generation?.gateway).toBe(expectedGateway);
  });

  it("carries the exact resolved config through, unmodified", () => {
    const cfg = config();
    const generation = createProductionPrDescriptionGeneration(source(cfg));
    expect(generation?.config).toBe(cfg);
  });

  it("derives branding from the SAME producer #3398 built, never a restated formula", () => {
    const cfg = config();
    const generation = createProductionPrDescriptionGeneration(source(cfg));
    expect(generation?.branding).toEqual({
      immutableLogoUrl: cfg.branding?.logoUrl,
      availability: "public",
    });
  });

  it("falls back to no branding fact when the operator configured no logo", () => {
    const raw = config();
    const cfg = parseGatewayConfig({
      providers: raw.providers.map((provider) => ({
        modelId: provider.modelId,
        baseUrl: "https://gateway.example.com/v1",
        apiKey: "test-token",
      })),
    });
    const generation = createProductionPrDescriptionGeneration(source(cfg));
    expect(generation?.branding).toEqual({});
  });

  it("reports body-free, dist-anchored error evidence — never the error's own message", () => {
    const generation = createProductionPrDescriptionGeneration(source(config()));
    const secretMessage = "leaked api key sk-should-never-appear";
    const evidence = generation?.errorEvidence?.(new Error(secretMessage));
    expect(evidence).toBeDefined();
    expect(JSON.stringify(evidence)).not.toContain(secretMessage);
    expect(Array.isArray(evidence?.frames)).toBe(true);
    expect(Array.isArray(evidence?.causeChain)).toBe(true);
  });

  it("emits the pr-description.generation.* ops through the composed log port end to end", () => {
    const generation = createProductionPrDescriptionGeneration(source(config()));
    generation?.log.write({ category: "gateway", op: "pr-description.generation.started", extra: {} });
    const ops = logs.events.map((event) => event.op);
    expect(ops).toContain("pr-description.generation.started");
  });
});
