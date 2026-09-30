// Customer report on 1.1.13: the field customer's LiteLLM `hosted_vllm` model declares no context
// window, so Keiko planned it as a 4,096-token model and every grounded question failed with a
// context overflow. These tests pin the server half of the repair: the startup probe and every
// provider overflow answer adopt the deployment's real window, persisted and applied without a
// configuration-generation bump, and an admitted turn re-plans and retries exactly once.
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assumedChatCapability,
  createDefaultChatCapability,
  findConfiguredCapability,
  parseGatewayConfig,
  type ModelCapability,
} from "@oscharko-dev/keiko-model-gateway";
import { ContextOverflowError, ProviderError } from "@oscharko-dev/keiko-security/errors/gateway";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
import {
  adoptReportedContextWindow,
  contextWindowProbesSettledForTests,
  discoverAssumedContextWindow,
  withAdoptedContextWindowRetry,
} from "./gateway-context-window.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { readChatContextStatus } from "./chat-context-status.js";

const MODEL = "gemma-4-31b-it";
const roots: string[] = [];
const disposals: UiHandlerDeps[] = [];

afterEach(async () => {
  resetServerLogger();
  for (const deps of disposals.splice(0)) await deps.dispose?.();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function capture(): ReturnType<typeof createBufferedServerLogSink> {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
  return sink;
}

function rejection(message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: null, code: "400" } }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

function fixture(
  capability: ModelCapability,
  fetchImpl?: typeof fetch,
): { deps: UiHandlerDeps; configPath: string } {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "keiko-context-window-"));
  roots.push(root);
  const built = buildUiHandlerDeps({
    configPath: undefined,
    evidenceDir: join(root, "evidence"),
    uiDbPath: join(root, "ui.db"),
    env: {},
  });
  disposals.push(built);
  const deps: UiHandlerDeps =
    fetchImpl === undefined ? built : { ...built, gatewayReadinessFetch: fetchImpl };
  const holder = deps.gatewayConfig;
  if (holder === undefined) throw new Error("expected a runtime gateway config");
  holder.set(
    parseGatewayConfig({
      providers: [
        {
          modelId: MODEL,
          baseUrl: "https://litellm.example.invalid/v1",
          apiKey: "fake-test-key",
          timeoutMs: 5_000,
          maxRetries: 0,
          retryBaseDelayMs: 1,
        },
      ],
      capabilities: [capability],
      circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 1 },
    }),
    true,
  );
  return { deps, configPath: holder.storagePath };
}

function persistedLine(sink: ReturnType<typeof createBufferedServerLogSink>, op: string): string {
  return formatActivityLogProofLine(sink.events.find((event) => event.op === op) ?? {});
}

function stored(deps: UiHandlerDeps): ModelCapability | undefined {
  const config = deps.gatewayConfig?.current();
  return config === undefined ? undefined : findConfiguredCapability(config, MODEL);
}

describe("context-window probe", () => {
  it("adopts the window vLLM names, persisted, without a generation bump", async () => {
    const sink = capture();
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        rejection("max_tokens=1000000000 cannot be greater than max_model_len=65536."),
      ),
    );
    const { deps, configPath } = fixture(assumedChatCapability(MODEL), fetchImpl);
    const generation = deps.gatewayConfig?.generation();
    discoverAssumedContextWindow(deps, MODEL, "corr-startup-window");
    await contextWindowProbesSettledForTests(deps);

    expect(stored(deps)?.contextWindow).toBe(65_536);
    expect(stored(deps)).not.toHaveProperty("contextWindowAssumed");
    expect(deps.gatewayConfig?.generation()).toBe(generation);
    expectActivityLogProof(
      "gateway.context-window.probe.line",
      persistedLine(sink, "gateway.context-window.probe"),
    );
    expectActivityLogProof(
      "gateway.context-window.adoption.line",
      persistedLine(sink, "gateway.context-window.adoption"),
    );
    const persisted = readFileSync(configPath, "utf8");
    expect(persisted).toContain('"contextWindow": 65536');
    expect(persisted).not.toContain("contextWindowAssumed");
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        op: "gateway.context-window.probe",
        correlationId: "corr-startup-window",
        extra: expect.objectContaining({ state: "reported", contextWindow: 65_536 }) as unknown,
      }),
    );
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        op: "gateway.context-window.adoption",
        extra: expect.objectContaining({
          source: "window-probe",
          state: "adopted",
          previousContextWindow: 4_096,
          wasAssumed: true,
        }) as unknown,
      }),
    );
  });

  it("asks each deployment once and keeps the assumption when the provider states nothing", async () => {
    const sink = capture();
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), {
          status: 200,
        }),
      ),
    );
    const { deps } = fixture(assumedChatCapability(MODEL), fetchImpl);
    discoverAssumedContextWindow(deps, MODEL, "corr-first");
    discoverAssumedContextWindow(deps, MODEL, "corr-second");
    await contextWindowProbesSettledForTests(deps);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(stored(deps)?.contextWindowAssumed).toBe(true);
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        op: "gateway.context-window.probe",
        extra: expect.objectContaining({ state: "not-reported", httpStatus: 200 }) as unknown,
      }),
    );
  });

  it("never probes a model whose window was declared", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { deps } = fixture(
      { ...createDefaultChatCapability(MODEL), contextWindow: 32_768 },
      fetchImpl,
    );
    discoverAssumedContextWindow(deps, MODEL, "corr-declared");
    await contextWindowProbesSettledForTests(deps);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("provider-reported window adoption", () => {
  it("replaces even a declared window in either direction with the provider's statement", () => {
    const sink = capture();
    const { deps } = fixture({ ...createDefaultChatCapability(MODEL), contextWindow: 32_768 });
    adoptReportedContextWindow(
      deps,
      { modelId: MODEL, contextWindowTokens: 16_384, correlationId: "corr-overflow" },
      "provider-overflow",
    );
    expect(stored(deps)?.contextWindow).toBe(16_384);
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        op: "gateway.context-window.adoption",
        correlationId: "corr-overflow",
        extra: expect.objectContaining({
          source: "provider-overflow",
          state: "adopted",
          previousContextWindow: 32_768,
          wasAssumed: false,
        }) as unknown,
      }),
    );
  });

  it("records an unchanged statement without rewriting the configuration", () => {
    const sink = capture();
    const { deps } = fixture({ ...createDefaultChatCapability(MODEL), contextWindow: 32_768 });
    const before = deps.gatewayConfig?.current();
    adoptReportedContextWindow(
      deps,
      { modelId: MODEL, contextWindowTokens: 32_768, correlationId: "corr-same" },
      "provider-overflow",
    );
    expect(deps.gatewayConfig?.current()).toBe(before);
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        op: "gateway.context-window.adoption",
        extra: expect.objectContaining({ state: "unchanged" }) as unknown,
      }),
    );
  });
});

describe("withAdoptedContextWindowRetry", () => {
  function overflow(window: number): ContextOverflowError {
    const error = new ContextOverflowError("provider reported context overflow");
    error.reportedContextWindowTokens = window;
    return error;
  }

  it("re-plans and retries once after the overflow taught Keiko the real window", async () => {
    const sink = capture();
    const { deps } = fixture(assumedChatCapability(MODEL));
    const planned: number[] = [];
    const result = await withAdoptedContextWindowRetry(
      deps,
      { modelId: MODEL, surface: "chat-buffered", correlationId: "corr-retry" },
      () => {
        planned.push(stored(deps)?.contextWindow ?? 0);
        if (planned.length === 1) {
          // What the Gateway's report hook does synchronously before rethrowing.
          adoptReportedContextWindow(
            deps,
            { modelId: MODEL, contextWindowTokens: 8_192, correlationId: "corr-retry" },
            "provider-overflow",
          );
          return Promise.reject(overflow(8_192));
        }
        return Promise.resolve("answer");
      },
    );
    expect(result).toBe("answer");
    expect(planned).toEqual([4_096, 8_192]);
    expectActivityLogProof(
      "gateway.context-window.retry.line",
      persistedLine(sink, "gateway.context-window.retry"),
    );
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        op: "gateway.context-window.retry",
        correlationId: "corr-retry",
        extra: expect.objectContaining({
          surface: "chat-buffered",
          plannedContextWindow: 128_000,
          contextWindow: 8_192,
        }) as unknown,
      }),
    );
  });

  it("does not retry when the window was already planned, after content, or for other errors", async () => {
    const { deps } = fixture({ ...createDefaultChatCapability(MODEL), contextWindow: 8_192 });
    const attempt = vi.fn(() => Promise.reject(overflow(8_192)));
    await expect(
      withAdoptedContextWindowRetry(
        deps,
        { modelId: MODEL, surface: "grounded", correlationId: undefined },
        attempt,
      ),
    ).rejects.toBeInstanceOf(ContextOverflowError);
    expect(attempt).toHaveBeenCalledTimes(1);

    const assumed = fixture(assumedChatCapability(MODEL)).deps;
    const afterContent = vi.fn(() => {
      adoptReportedContextWindow(
        assumed,
        { modelId: MODEL, contextWindowTokens: 8_192, correlationId: "c" },
        "provider-overflow",
      );
      return Promise.reject(overflow(8_192));
    });
    await expect(
      withAdoptedContextWindowRetry(
        assumed,
        { modelId: MODEL, surface: "chat-stream", correlationId: "c", retryable: () => false },
        afterContent,
      ),
    ).rejects.toBeInstanceOf(ContextOverflowError);
    expect(afterContent).toHaveBeenCalledTimes(1);

    const other = vi.fn(() => Promise.reject(new ProviderError("upstream failed", 502)));
    await expect(
      withAdoptedContextWindowRetry(
        deps,
        { modelId: MODEL, surface: "chat-buffered", correlationId: undefined },
        other,
      ),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(other).toHaveBeenCalledTimes(1);
  });
});

describe("context status of an assumed window", () => {
  it("tells the meter that the window is assumed and plans the default geometry", () => {
    const { deps } = fixture(assumedChatCapability(MODEL));
    const project = mkdtempSync(join(realpathSync(tmpdir()), "keiko-assumed-project-"));
    roots.push(project);
    deps.store.createProject(project, "Assumed");
    const chatId = deps.store.createChat(project, "Assumed", MODEL).id;
    const status = readChatContextStatus(deps, chatId, MODEL);
    expect(status.contextWindowAssumed).toBe(true);
    expect(status.contextWindowTokens).toBe(128_000);
    expect(status.inputBudgetTokens).toBe(116_000);
  });
});
