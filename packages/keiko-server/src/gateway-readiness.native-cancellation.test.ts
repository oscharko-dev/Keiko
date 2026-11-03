import { createServer, type Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { createDefaultChatCapability, type GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import { buildRedactor, type UiHandlerDeps } from "./deps.js";
import { createRunRegistry } from "./runs.js";
import { createInMemoryUiStore } from "./store/index.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import {
  cancellableConversationProbeDeps,
  probeInconclusive,
  runGatewayReadiness,
} from "./gateway-readiness.js";

interface NativeDispatcher {
  dispatch(options: unknown, handler: unknown): boolean;
}

const servers: Server[] = [];
const restoreDispatchers: (() => void)[] = [];

afterEach(async (): Promise<void> => {
  for (const restore of restoreDispatchers.splice(0)) restore();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
          server.closeAllConnections();
        }),
    ),
  );
});

function isDispatcher(value: unknown): value is NativeDispatcher {
  return (
    typeof value === "object" &&
    value !== null &&
    "dispatch" in value &&
    typeof value.dispatch === "function"
  );
}

async function refuseNativeFetchHeaderDeadline(): Promise<() => number> {
  await globalThis.fetch("data:text/plain,initialize-native-dispatcher");
  const dispatchers = globalThis as unknown as Record<symbol, unknown>;
  let intercepted = 0;
  for (const key of [
    Symbol.for("undici.globalDispatcher.1"),
    Symbol.for("undici.globalDispatcher.2"),
  ]) {
    const original = dispatchers[key];
    if (!isDispatcher(original)) continue;
    dispatchers[key] = {
      dispatch: (): boolean => {
        intercepted++;
        const cause = new Error("The native response-header deadline expired.");
        cause.name = "HeadersTimeoutError";
        throw new TypeError("fetch failed", { cause });
      },
    } satisfies NativeDispatcher;
    restoreDispatchers.push(() => {
      dispatchers[key] = original;
    });
  }
  expect(restoreDispatchers.length).toBeGreaterThan(0);
  return (): number => intercepted;
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new TypeError("Expected a loopback test listener.");
  }
  return `http://127.0.0.1:${String(address.port)}/v1`;
}

function readinessDeps(baseUrl: string): UiHandlerDeps & { readonly config: GatewayConfig } {
  const config: GatewayConfig = {
    providers: [
      {
        modelId: "native-readiness",
        baseUrl,
        apiKey: "fixture-token",
        timeoutMs: 900_000,
        maxRetries: 0,
        retryBaseDelayMs: 0,
      },
    ],
    capabilities: [createDefaultChatCapability("native-readiness")],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
  };
  return {
    config,
    configPresent: true,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
  };
}

it("keeps the configured native readiness transport when startup adds cancellation", async () => {
  const intercepted = await refuseNativeFetchHeaderDeadline();
  const events: ServerLogEvent[] = [];
  let requests = 0;
  const baseUrl = await listen(
    createServer((request, response) => {
      requests++;
      request.resume();
      request.once("end", () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }),
        );
      });
    }),
  );
  const report = await runGatewayReadiness(
    { modelId: "native-readiness", options: { probes: ["chat"] } },
    cancellableConversationProbeDeps(
      {
        ...readinessDeps(baseUrl),
        activityLog: { write: (event): void => void events.push(event) },
      },
      new AbortController().signal,
    ),
    "native-readiness-configured-deadline",
  );
  expect(report).toMatchObject({ overallStatus: "ready", probes: [{ status: "passed" }] });
  expect(requests).toBe(1);
  expect(intercepted()).toBe(0);
  expect(events.find((event) => event.op === "http.gateway.egress.planned")?.extra).toMatchObject({
    transport: "native",
    endpointClass: "loopback",
  });
  expect(events.find((event) => event.op === "http.gateway.fetch.started")?.extra).toMatchObject({
    timeoutMs: 900_000,
  });
});

it.each(["outer", "inner"])(
  "cancels native readiness when the %s startup owner stops",
  async (owner) => {
    const outer = new AbortController();
    const inner = new AbortController();
    let received: (() => void) | undefined;
    const receipt = new Promise<void>((resolve) => {
      received = resolve;
    });
    let disconnected: (() => void) | undefined;
    const disconnect = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const baseUrl = await listen(
      createServer((request, response) => {
        request.resume();
        response.once("close", () => disconnected?.());
        received?.();
      }),
    );
    const deps = cancellableConversationProbeDeps(
      cancellableConversationProbeDeps(readinessDeps(baseUrl), outer.signal),
      inner.signal,
    );
    const pending = runGatewayReadiness(
      { modelId: "native-readiness", options: { probes: ["chat"] } },
      deps,
      "native-readiness-cancellation",
    );
    await receipt;
    (owner === "outer" ? outer : inner).abort();
    const report = await pending;
    expect(report).toMatchObject({
      overallStatus: "failed",
      probes: [{ status: "failed" }],
    });
    if ("status" in report) throw new Error("Expected a readiness report.");
    expect(report.probes.every(probeInconclusive)).toBe(true);
    await disconnect;
  },
);

it("classifies a native provider deadline as inconclusive rather than refuting readiness", async () => {
  const events: ServerLogEvent[] = [];
  const baseUrl = await listen(createServer((request) => request.resume()));
  const deps = readinessDeps(baseUrl);
  const config = {
    ...deps.config,
    providers: deps.config.providers.map((provider) => ({ ...provider, timeoutMs: 100 })),
  };
  const report = await runGatewayReadiness(
    { modelId: "native-readiness", options: { probes: ["chat"] } },
    { ...deps, config, activityLog: { write: (event): void => void events.push(event) } },
    "native-readiness-deadline",
    "settings",
  );
  expect(report).toMatchObject({
    overallStatus: "failed",
    probes: [{ warning: "The probe timed out before the provider answered." }],
  });
  if ("status" in report) throw new Error("Expected a readiness report.");
  expect(report.probes.every(probeInconclusive)).toBe(true);
  const event = events.find((entry) => entry.op === "gateway.readiness.completed");
  expect(event).toMatchObject({
    correlationId: "native-readiness-deadline",
    extra: { overallStatus: "failed", inconclusiveProbeCount: 1 },
  });
  expectActivityLogProof(
    "gateway.readiness.completed.line",
    formatActivityLogProofLine(event ?? {}),
  );
});

it("preserves an injected readiness fetch and composes both owner cancellation signals", async () => {
  const outer = new AbortController();
  const inner = new AbortController();
  let observedSignal: AbortSignal | null | undefined;
  const injected = vi.fn((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    observedSignal = init?.signal;
    return Promise.resolve(
      Response.json({ choices: [{ message: { role: "assistant", content: "OK" } }] }),
    );
  });
  const deps = cancellableConversationProbeDeps(
    cancellableConversationProbeDeps(
      { ...readinessDeps("http://127.0.0.1:9/v1"), gatewayReadinessFetch: injected },
      outer.signal,
    ),
    inner.signal,
  );
  const report = await runGatewayReadiness(
    { modelId: "native-readiness", options: { probes: ["chat"] } },
    deps,
    "injected-readiness-cancellation",
  );
  expect(report).toMatchObject({ overallStatus: "ready" });
  expect(injected).toHaveBeenCalledOnce();
  expect(observedSignal?.aborted).toBe(false);
  inner.abort();
  expect(observedSignal?.aborted).toBe(true);
});
