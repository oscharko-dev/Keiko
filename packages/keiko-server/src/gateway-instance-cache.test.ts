import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Gateway, parseGatewayConfig, type GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import {
  gatewayForConfig,
  gatewayForRuntimeConfig,
  resetGatewayInstanceCacheForTests,
} from "./gateway-instance-cache.js";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
  type BufferedServerLogSink,
  type ServerLogThreshold,
} from "./observability/index.js";

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

// Installs the process logger the production code under test reads and hands back the buffer its
// lines land in. Shared by both activity-log suites: they assert on different lines, not on a
// different way of capturing them.
function capture(level: ServerLogThreshold): BufferedServerLogSink {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level }));
  return sink;
}

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
    const direct = gatewayForConfig(current);

    generation += 1;

    expect(gatewayForRuntimeConfig(source)).not.toBe(initial);
    expect(gatewayForConfig(current)).toBe(direct);
  });

  it("shares a replacement config at the same generation with direct callers", () => {
    let current = config();
    const source = {
      current: (): GatewayConfig => current,
      generation: (): number => 0,
    };
    gatewayForRuntimeConfig(source);
    current = config();
    const direct = gatewayForConfig(current);

    expect(gatewayForRuntimeConfig(source)).toBe(direct);
  });

  it("invalidates the runtime gateway when the current config becomes unavailable", () => {
    const current = config();
    let available: GatewayConfig | undefined = current;
    const source = {
      current: (): GatewayConfig | undefined => available,
      generation: (): number => 0,
    };
    const initial = gatewayForRuntimeConfig(source);
    const direct = gatewayForConfig(current);

    available = undefined;

    expect(gatewayForRuntimeConfig(source)).toBeUndefined();
    expect(gatewayForConfig(current)).toBe(direct);
    available = current;
    expect(gatewayForRuntimeConfig(source)).not.toBe(initial);
  });
});

// Which gateway instance a caller got is invisible from the outside, yet it decides whether an
// open circuit breaker is still open. These lines are the only record of a reset.
describe("gateway instance cache activity log", () => {
  afterEach(() => {
    resetServerLogger();
  });

  it("records the reset that discards circuit-breaker state when the generation advances", () => {
    const current = config();
    let generation = 0;
    const source = {
      current: (): GatewayConfig => current,
      generation: (): number => generation,
    };
    gatewayForRuntimeConfig(source);
    const sink = capture("info");

    generation += 1;
    gatewayForRuntimeConfig(source);

    expect(sink.events).toEqual([
      {
        level: "info",
        category: "gateway",
        op: "gateway.instance.reset",
        correlationId: undefined,
        durationMs: undefined,
        status: undefined,
        errorKind: undefined,
        extra: { generation: 1, reason: "generation-changed", lifecycleReset: true },
      },
    ]);
  });

  it("separates a same-generation rebind from a reset", () => {
    let current = config();
    const source = {
      current: (): GatewayConfig => current,
      generation: (): number => 0,
    };
    gatewayForRuntimeConfig(source);
    const sink = capture("info");

    current = config();
    gatewayForRuntimeConfig(source);

    expect(sink.events.map((event) => event.op)).toEqual(["gateway.instance.bound"]);
    expect(sink.events[0]?.extra).toEqual({
      generation: 0,
      reason: "rebound",
      lifecycleReset: false,
    });
  });

  it("keeps the steady-state reuse out of the log at info and reports it at debug", () => {
    const current = config();
    const source = { current: (): GatewayConfig => current, generation: (): number => 7 };
    gatewayForRuntimeConfig(source);

    const atInfo = capture("info");
    const reused = gatewayForRuntimeConfig(source);
    expect(atInfo.events).toEqual([]);

    const atDebug = capture("debug");
    expect(gatewayForRuntimeConfig(source)).toBe(reused);
    expect(atDebug.events.map((event) => event.op)).toEqual(["gateway.instance.reused"]);
    expect(atDebug.events[0]?.level).toBe("debug");
  });

  it("warns once when the runtime config disappears and stays quiet while it is still absent", () => {
    let available: GatewayConfig | undefined = config();
    const source = {
      current: (): GatewayConfig | undefined => available,
      generation: (): number => 3,
    };
    gatewayForRuntimeConfig(source);
    const sink = capture("info");

    available = undefined;
    expect(gatewayForRuntimeConfig(source)).toBeUndefined();
    expect(gatewayForRuntimeConfig(source)).toBeUndefined();

    expect(sink.events).toEqual([
      {
        level: "warn",
        category: "gateway",
        op: "gateway.instance.unavailable",
        correlationId: undefined,
        durationMs: undefined,
        status: undefined,
        errorKind: undefined,
        extra: { generation: 3, reason: "config-withdrawn" },
      },
    ]);
  });

  it("names a never-configured install apart from a withdrawn config, and recovery apart from both", () => {
    let available: GatewayConfig | undefined = undefined;
    const source = {
      current: (): GatewayConfig | undefined => available,
      generation: (): number => 0,
    };
    const sink = capture("info");

    expect(gatewayForRuntimeConfig(source)).toBeUndefined();
    available = config();
    gatewayForRuntimeConfig(source);

    expect(sink.events.map((event) => event.extra)).toEqual([
      { generation: 0, reason: "unconfigured" },
      { generation: 0, reason: "recovered", lifecycleReset: true },
    ]);
    expect(sink.events.map((event) => event.op)).toEqual([
      "gateway.instance.unavailable",
      "gateway.instance.reset",
    ]);
  });
});

// The cache is the ONLY production composition site for a Gateway the BFF hands to a request, so
// it is also the only place that can wire `GatewayDeps.log`. Constructed without it the gateway
// resolves the frozen no-op sink and its entire decision surface — retries, breaker trips, route
// refusals — is unreachable no matter how the process logger is configured. These tests therefore
// assert on a line the GATEWAY emits, not on the constructor argument: a route refusal needs no
// network and is one of the three fail-closed decisions that reach the caller as one opaque error.
describe("gateway instance cache — wiring the gateway's own activity log", () => {
  afterEach(() => {
    resetServerLogger();
  });

  async function refuseUnknownModel(gateway: Gateway | undefined): Promise<void> {
    if (gateway === undefined) throw new Error("expected a gateway");
    await expect(
      gateway.chat({ modelId: "not-configured", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow();
  }

  it("gives a config-keyed gateway the process sink", async () => {
    const sink = capture("info");

    await refuseUnknownModel(gatewayForConfig(config()));

    expect(sink.events.map((event) => event.op)).toContain("gateway.route.rejected");
  });

  it("gives a lifecycle-reset replacement instance the process sink too", async () => {
    const current = config();
    let generation = 0;
    const source = {
      current: (): GatewayConfig => current,
      generation: (): number => generation,
    };
    gatewayForRuntimeConfig(source);
    const sink = capture("info");

    generation += 1;
    await refuseUnknownModel(gatewayForRuntimeConfig(source));

    const rejection = sink.events.find((event) => event.op === "gateway.route.rejected");
    expect(rejection).toMatchObject({
      level: "warn",
      category: "gateway",
      extra: { modelId: "not-configured", reason: "no-provider-configured" },
    });
  });
});
