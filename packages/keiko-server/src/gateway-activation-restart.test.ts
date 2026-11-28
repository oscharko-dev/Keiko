import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("forgets an explicitly deactivated model", async () => {
    const first = start();
    activate(first);
    const ctx = {
      correlationId: "corr-deactivate-restart",
      req: Readable.from([Buffer.from(JSON.stringify({ modelId: MODEL }))]) as IncomingMessage,
      res: {} as RouteContext["res"],
      params: {},
      url: new URL("http://127.0.0.1/api/gateway/readiness/deactivation"),
    } satisfies RouteContext;
    expect(await handleGatewayDeactivation(ctx, first)).toMatchObject({
      status: 200,
      body: { outcome: "deactivated" },
    });
    const second = await restart(first);
    expect(currentConversationReady(second, MODEL)).toBe(false);
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

  it("forgets every activation when the configuration is replaced", async () => {
    const first = start();
    activate(first);
    first.gatewayConfig?.set(first.gatewayConfig.current(), true, "corr-replace");
    expect(currentConversationReady(first, MODEL)).toBe(false);
    const second = await restart(first);
    expect(currentConversationReady(second, MODEL)).toBe(false);
  });
});
