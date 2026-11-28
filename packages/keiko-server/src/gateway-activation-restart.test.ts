import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_ACTIVATION_FILE } from "./model-activation-memory.js";
import { buildUiHandlerDeps, currentConversationReady, type UiHandlerDeps } from "./deps.js";
import { handleGatewayDeactivation } from "./gateway-readiness.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import type { RouteContext } from "./routes.js";

// Owner decision 2026-11-28: an activated model is remembered across a restart. A restart is two
// compositions over the same state directory; the provider is a fetch double that must stay silent.
const MODEL = "chat-a";
const baseEnv = {
  KEIKO_MODEL_CHAT_A_API_KEY: "sk-test-activation-credential",
  KEIKO_MODEL_CHAT_A_BASE_URL: "http://127.0.0.1:41999/v1",
};

type ProviderList = NonNullable<
  ReturnType<NonNullable<UiHandlerDeps["gatewayConfig"]>["current"]>
>["providers"];

describe("activated models across a server restart", () => {
  let dir: string;
  const compositions: UiHandlerDeps[] = [];
  const fetchDouble = vi.fn<typeof fetch>(() => Promise.reject(new Error("no request expected")));

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-activation-restart-")));
    vi.stubGlobal("fetch", fetchDouble);
  });
  afterEach(async () => {
    for (const deps of compositions.splice(0)) await deps.dispose?.();
    vi.unstubAllGlobals();
    resetServerLogger();
    fetchDouble.mockClear();
    rmSync(dir, { recursive: true, force: true });
  });

  function start(env: Record<string, string> = baseEnv): UiHandlerDeps {
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      env: { ...env, KEIKO_MEMORY_DIR: join(dir, "memory") },
      uiDbPath: join(dir, "ui.db"),
      evidenceDir: join(dir, "evidence"),
    });
    compositions.push(deps);
    return deps;
  }

  async function restart(
    deps: UiHandlerDeps,
    env?: Record<string, string>,
  ): Promise<UiHandlerDeps> {
    compositions.splice(compositions.indexOf(deps), 1);
    await deps.dispose?.();
    return start(env);
  }

  function activate(deps: UiHandlerDeps): void {
    const holder = deps.gatewayConfig;
    if (holder === undefined) throw new TypeError("Expected the gateway holder.");
    holder.recordVerifiedCapability(
      MODEL,
      { conversationReady: true },
      new Date().toISOString(),
      holder.generation(),
    );
    expect(currentConversationReady(deps, MODEL)).toBe(true);
  }

  it("is inactive on the first start and restores a matching activation without a request", async () => {
    const first = start();
    expect(currentConversationReady(first, MODEL)).toBe(false);
    activate(first);
    const second = await restart(first);
    expect(currentConversationReady(second, MODEL)).toBe(true);
    // Remembering a proof claims nothing more than basic chat: no tool-calling proof comes back.
    expect(second.gatewayConfig?.verifiedCapability(MODEL)?.fields).toEqual({
      conversationReady: true,
    });
    expect(fetchDouble).not.toHaveBeenCalled();
  });

  it("records the restore as a registered, body-free activity line", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const first = start();
    activate(first);
    const second = await restart(first);
    expect(currentConversationReady(second, MODEL)).toBe(true);
    const lines = sink.events.filter((event) => event.op === "gateway.activation.persistence");
    const restored = lines.find(
      (line) => line.extra?.change === "restored" && line.extra.count === 1,
    );
    if (restored === undefined) throw new TypeError("No restore line was recorded");
    expect(lines.some((line) => line.extra?.change === "saved")).toBe(true);
    expectActivityLogProof(
      "gateway.activation.persistence.line",
      formatActivityLogProofLine(restored),
    );
  });

  it("stays activated through repeated restarts", async () => {
    let deps = start();
    activate(deps);
    for (let restarts = 0; restarts < 3; restarts += 1) {
      deps = await restart(deps);
      expect(currentConversationReady(deps, MODEL)).toBe(true);
    }
    expect(fetchDouble).not.toHaveBeenCalled();
  });

  it("is inactive after a restart when the endpoint changed", async () => {
    const first = start();
    activate(first);
    const second = await restart(first, {
      ...baseEnv,
      KEIKO_MODEL_CHAT_A_BASE_URL: "http://127.0.0.1:41998/v1",
    });
    expect(currentConversationReady(second, MODEL)).toBe(false);
  });

  it("is inactive after a restart when the credential changed", async () => {
    const first = start();
    activate(first);
    const second = await restart(first, {
      ...baseEnv,
      KEIKO_MODEL_CHAT_A_API_KEY: "sk-test-rotated-credential",
    });
    expect(currentConversationReady(second, MODEL)).toBe(false);
  });

  function deactivation(
    deps: UiHandlerDeps,
    correlationId: string,
  ): ReturnType<typeof handleGatewayDeactivation> {
    const ctx = {
      correlationId,
      req: Readable.from([Buffer.from(JSON.stringify({ modelId: MODEL }))]) as IncomingMessage,
      res: {} as RouteContext["res"],
      params: {},
      url: new URL("http://127.0.0.1/api/gateway/readiness/deactivation"),
    } satisfies RouteContext;
    return handleGatewayDeactivation(ctx, deps);
  }

  it("forgets an explicitly deactivated model", async () => {
    const first = start();
    activate(first);
    expect(await deactivation(first, "corr-deactivate-restart")).toMatchObject({
      status: 200,
      body: { outcome: "deactivated" },
    });
    const second = await restart(first);
    expect(currentConversationReady(second, MODEL)).toBe(false);
  });

  it("refuses to report a deactivation its record could not take, and settles it on the repeat", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const first = start();
    activate(first);
    // A directory where the record belongs refuses both its rewrite and its removal.
    const record = join(dir, MODEL_ACTIVATION_FILE);
    rmSync(record);
    mkdirSync(join(record, "blocker"), { recursive: true });
    expect(await deactivation(first, "corr-record-failed")).toMatchObject({
      status: 500,
      body: { error: { code: "RECORD_FAILED" } },
    });
    // The process itself no longer uses the model.
    expect(currentConversationReady(first, MODEL)).toBe(false);
    const outcomes = sink.events
      .filter((event) => event.op === "gateway.readiness.deactivation")
      .map((event) => event.extra?.outcome);
    expect(outcomes).toEqual(["record-failed"]);
    rmSync(record, { recursive: true });
    // The same deactivation again retries the record although the model is already inactive.
    expect(await deactivation(first, "corr-record-retry")).toMatchObject({
      status: 200,
      body: { outcome: "not-activated" },
    });
    const second = await restart(first);
    expect(currentConversationReady(second, MODEL)).toBe(false);
  });

  describe("with several models", () => {
    const threeModels = {
      ...baseEnv,
      KEIKO_MODEL_CHAT_B_API_KEY: "sk-test-activation-credential-b",
      KEIKO_MODEL_CHAT_B_BASE_URL: "http://127.0.0.1:41998/v1",
      KEIKO_MODEL_CHAT_C_API_KEY: "sk-test-activation-credential-c",
      KEIKO_MODEL_CHAT_C_BASE_URL: "http://127.0.0.1:41997/v1",
    };

    function holderOf(deps: UiHandlerDeps): NonNullable<UiHandlerDeps["gatewayConfig"]> {
      if (deps.gatewayConfig === undefined) throw new TypeError("Expected the gateway holder.");
      return deps.gatewayConfig;
    }

    function activateModels(deps: UiHandlerDeps, ...modelIds: string[]): void {
      const holder = holderOf(deps);
      for (const modelId of modelIds)
        holder.recordVerifiedCapability(
          modelId,
          { conversationReady: true },
          new Date().toISOString(),
          holder.generation(),
        );
    }

    function deactivationOf(
      deps: UiHandlerDeps,
      modelId: string,
      correlationId: string,
    ): ReturnType<typeof handleGatewayDeactivation> {
      return handleGatewayDeactivation(
        {
          correlationId,
          req: Readable.from([Buffer.from(JSON.stringify({ modelId }))]) as IncomingMessage,
          res: {} as RouteContext["res"],
          params: {},
          url: new URL("http://127.0.0.1/api/gateway/readiness/deactivation"),
        },
        deps,
      );
    }

    it("keeps restored activations on disk when a deactivation of an inactive model settles first", async () => {
      const first = start(threeModels);
      activateModels(first, "chat-a", "chat-b");
      const second = await restart(first, threeModels);
      expect(currentConversationReady(second, "chat-a")).toBe(true);
      // Deactivating a model that was never activated writes nothing that forgets the others.
      expect(await deactivationOf(second, "chat-c", "corr-inactive")).toMatchObject({
        status: 200,
        body: { outcome: "not-activated" },
      });
      expect(await deactivationOf(second, "chat-c", "corr-inactive-again")).toMatchObject({
        status: 200,
        body: { outcome: "not-activated" },
      });
      const third = await restart(second, threeModels);
      expect(currentConversationReady(third, "chat-a")).toBe(true);
      expect(currentConversationReady(third, "chat-b")).toBe(true);
    });

    it("logs each removal of one settled change under its own reason", () => {
      const sink = createBufferedServerLogSink();
      setServerLogger(createServerLogger({ sink, level: "info" }));
      const deps = start(threeModels);
      activateModels(deps, "chat-a", "chat-b");
      const holder = holderOf(deps);
      sink.events.length = 0;
      holder.settleObservations?.(() => {
        holder.clearVerifiedCapability("chat-a", undefined, { cause: "deactivated" });
        holder.clearVerifiedCapability("chat-b", undefined, { cause: "invalidated" });
      });
      const lines = sink.events
        .filter((event) => event.op === "gateway.activation.persistence")
        .map((event) => event.extra)
        .filter((extra) => extra?.change === "discarded");
      expect(lines).toContainEqual(expect.objectContaining({ reason: "deactivated", count: 1 }));
      expect(lines).toContainEqual(expect.objectContaining({ reason: "invalidated", count: 1 }));
    });

    it("does not persist the transient set of a change that threw", async () => {
      const first = start(threeModels);
      activateModels(first, "chat-a", "chat-b");
      const holder = holderOf(first);
      expect(() => {
        holder.settleObservations?.(() => {
          holder.clearVerifiedCapability("chat-a");
          holder.clearVerifiedCapability("chat-b");
          throw new Error("the change failed midway");
        });
      }).toThrow("failed midway");
      const second = await restart(first, threeModels);
      expect(currentConversationReady(second, "chat-a")).toBe(true);
      expect(currentConversationReady(second, "chat-b")).toBe(true);
    });
  });

  it("forgets a model whose observation a failure invalidated", async () => {
    const first = start();
    activate(first);
    first.gatewayConfig?.clearVerifiedCapability(MODEL, undefined, {
      cause: "invalidated",
      correlationId: "corr-invalidated",
    });
    const second = await restart(first);
    expect(currentConversationReady(second, MODEL)).toBe(false);
  });

  describe("when the configuration is saved again", () => {
    const twoModels = {
      ...baseEnv,
      KEIKO_MODEL_CHAT_B_API_KEY: "sk-test-activation-credential-b",
      KEIKO_MODEL_CHAT_B_BASE_URL: "http://127.0.0.1:41998/v1",
    };

    function activateBoth(deps: UiHandlerDeps): void {
      const holder = deps.gatewayConfig;
      if (holder === undefined) throw new TypeError("Expected the gateway holder.");
      for (const modelId of ["chat-a", "chat-b"])
        holder.recordVerifiedCapability(
          modelId,
          { conversationReady: true },
          new Date().toISOString(),
          holder.generation(),
        );
    }

    function saved(deps: UiHandlerDeps, change: (providers: ProviderList) => ProviderList): void {
      const holder = deps.gatewayConfig;
      const config = holder?.current();
      if (holder === undefined || config === undefined) throw new TypeError("Expected a config.");
      holder.set({ ...config, providers: change(config.providers) }, true, "corr-saved");
    }

    function discarded(sink: ReturnType<typeof createBufferedServerLogSink>): unknown[] {
      return sink.events
        .filter((event) => event.op === "gateway.activation.persistence")
        .filter(
          (event) => event.extra?.change === "discarded" && event.extra.reason !== "first-start",
        )
        .map((event) => event.extra);
    }

    it("adding a model keeps the other activated models", async () => {
      const sink = createBufferedServerLogSink();
      setServerLogger(createServerLogger({ sink, level: "info" }));
      const first = start(twoModels);
      activateBoth(first);
      saved(first, (providers) => [
        ...providers,
        ...providers.slice(0, 1).map((provider) => ({ ...provider, modelId: "chat-c" })),
      ]);
      expect(currentConversationReady(first, "chat-a")).toBe(true);
      expect(currentConversationReady(first, "chat-b")).toBe(true);
      expect(currentConversationReady(first, "chat-c")).toBe(false);
      expect(discarded(sink)).toEqual([]);
      // Only the basic-chat proof is carried over a save, never a feature proof.
      expect(first.gatewayConfig?.verifiedCapability("chat-a")?.fields).toEqual({
        conversationReady: true,
      });
      const second = await restart(first, twoModels);
      expect(currentConversationReady(second, "chat-a")).toBe(true);
      expect(currentConversationReady(second, "chat-b")).toBe(true);
      expect(fetchDouble).not.toHaveBeenCalled();
    });

    it("changing one model's endpoint drops only that model", async () => {
      const sink = createBufferedServerLogSink();
      setServerLogger(createServerLogger({ sink, level: "info" }));
      const first = start(twoModels);
      activateBoth(first);
      saved(first, (providers) =>
        providers.map((provider) =>
          provider.modelId === "chat-b"
            ? { ...provider, baseUrl: "http://127.0.0.1:41997/v1" }
            : provider,
        ),
      );
      expect(currentConversationReady(first, "chat-a")).toBe(true);
      expect(currentConversationReady(first, "chat-b")).toBe(false);
      expect(discarded(sink)).toContainEqual(
        expect.objectContaining({ reason: "configuration-changed", count: 1 }),
      );
      const second = await restart(first, {
        ...twoModels,
        KEIKO_MODEL_CHAT_B_BASE_URL: "http://127.0.0.1:41997/v1",
      });
      expect(currentConversationReady(second, "chat-a")).toBe(true);
      expect(currentConversationReady(second, "chat-b")).toBe(false);
    });

    it("drops a model that a save removed and keeps the rest", () => {
      const first = start(twoModels);
      activateBoth(first);
      saved(first, (providers) => providers.filter((provider) => provider.modelId !== "chat-b"));
      expect(currentConversationReady(first, "chat-a")).toBe(true);
      expect(currentConversationReady(first, "chat-b")).toBe(false);
    });

    it("drops a model whose credential a save changed", () => {
      const first = start(twoModels);
      activateBoth(first);
      saved(first, (providers) =>
        providers.map((provider) =>
          provider.modelId === "chat-a" ? { ...provider, apiKey: "sk-test-rotated" } : provider,
        ),
      );
      expect(currentConversationReady(first, "chat-a")).toBe(false);
      expect(currentConversationReady(first, "chat-b")).toBe(true);
    });
  });

  it("logs a record-driven invalidation under the correlation id of the check that caused it", () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const first = start();
    activate(first);
    first.gatewayConfig?.recordVerifiedCapability(
      MODEL,
      { conversationReady: false },
      new Date().toISOString(),
      first.gatewayConfig.generation(),
      undefined,
      undefined,
      { correlationId: "corr-record-invalidated" },
    );
    const line = sink.events.find(
      (event) =>
        event.op === "gateway.activation.persistence" && event.extra?.reason === "invalidated",
    );
    expect(line?.correlationId).toBe("corr-record-invalidated");
  });
});
