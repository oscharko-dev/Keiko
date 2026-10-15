import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import { listEvidence } from "@oscharko-dev/keiko-evidence";
import {
  CancelledError,
  createDefaultChatCapability,
  parseGatewayConfig,
} from "@oscharko-dev/keiko-model-gateway";
import { buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
import { buildCspHeader } from "./csp.js";
import { runGroundedAskInput } from "./grounded-qa.js";
import { createNodeUiStore } from "./store/index.js";
import {
  createFileServerLogSink,
  createServerLogger,
  setServerLogger,
} from "./observability/index.js";
import { closeUiTestServer, startUiTestServer } from "./ui-test-server/_support.js";
import { readPersistedActivityLog } from "../../../tests/support/activity-log-proof.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";

const MODEL = "grounded-native-cancellation-proof";
const QUESTION = "Explain the value in src/feature.ts.";
let directory = "";
const servers: Server[] = [];
const disposals: UiHandlerDeps[] = [];

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "keiko-native-cancellation-")));
  vi.stubEnv("KEIKO_STATE_DIR", join(directory, "state"));
  resetServerLogger();
});
afterEach(async () => {
  for (const server of servers.splice(0)) await closeUiTestServer(server);
  for (const deps of disposals.splice(0)) await deps.dispose?.();
  resetServerLogger();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

interface ProviderState {
  mode: "hold" | "healthy" | "failure";
  calls: number;
  closes: number;
  readonly entered: ReturnType<typeof deferred>;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function providerReply(res: ServerResponse, state: ProviderState): void {
  state.calls += 1;
  if (state.mode === "hold") {
    res.once("close", (): void => {
      state.closes += 1;
    });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    state.entered.resolve();
    return;
  }
  res.writeHead(state.mode === "failure" ? 503 : 200, { "content-type": "application/json" });
  res.end(
    JSON.stringify(
      state.mode === "failure"
        ? { error: { message: "Synthetic outage" } }
        : {
            id: "native-cancel-proof",
            model: MODEL,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "The value is 37. [src/feature.ts:1]" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
    ),
  );
}

async function provider(): Promise<{ baseUrl: string; state: ProviderState }> {
  const state: ProviderState = {
    mode: "hold",
    calls: 0,
    closes: 0,
    entered: deferred(),
  };
  const server = createServer((req, res): void => {
    req.resume();
    req.once("end", (): void => {
      providerReply(res, state);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("Unbound provider");
  return { baseUrl: `http://127.0.0.1:${String(address.port)}/v1`, state };
}

function runtime(baseUrl: string): {
  deps: UiHandlerDeps;
  chatId: string;
  dbPath: string;
  stateDir: string;
} {
  const root = join(directory, "workspace");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/feature.ts"), "export const value = 37;\n");
  const stateDir = join(directory, "state");
  const sink = createFileServerLogSink(stateDir, { level: "debug" });
  setServerLogger(createServerLogger({ sink, level: "debug" }));
  const dbPath = join(stateDir, "ui.db");
  const deps = buildUiHandlerDeps({
    configPath: join(stateDir, "gateway.json"),
    evidenceDir: join(stateDir, "evidence"),
    uiDbPath: dbPath,
    env: {},
  });
  disposals.push(deps);
  deps.gatewayConfig?.set(
    parseGatewayConfig({
      providers: [{ modelId: MODEL, baseUrl, apiKey: "fixture", maxRetries: 0 }],
      capabilities: [
        { ...createDefaultChatCapability(MODEL), contextWindow: 32768, maxOutputTokens: 1024 },
      ],
    }),
    true,
  );
  deps.gatewayConfig?.recordVerifiedCapability(
    MODEL,
    { conversationReady: true },
    new Date().toISOString(),
    deps.gatewayConfig.generation(),
  );
  deps.store.createProject(root, "Native cancellation proof");
  const chat = deps.store.createChat(root, "Native cancellation proof", MODEL);
  deps.store.updateChat(chat.id, {
    connectedScope: { kind: "files", relativePaths: ["src/feature.ts"], connectedAtMs: 1 },
  });
  return { deps, chatId: chat.id, dbPath, stateDir };
}

async function nativeServer(deps: UiHandlerDeps): Promise<string> {
  const started = await startUiTestServer({
    staticRoot: directory,
    csp: buildCspHeader([]),
    handlerDeps: deps,
  });
  servers.push(started.server);
  return `http://127.0.0.1:${String(started.port)}`;
}

function ask(
  base: string,
  chatId: string,
  clientTurnId: string,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${base}/api/chats/messages/grounded`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
    body: JSON.stringify({ chatId, content: QUESTION, clientTurnId }),
    signal: signal ?? AbortSignal.timeout(10_000),
  });
}

function assertReopened(dbPath: string, chatId: string, state: "cancelled" | "failed"): void {
  const reopened = createNodeUiStore(dbPath);
  try {
    expect(reopened.listMessages(chatId)).toMatchObject([{ role: "user", turnState: state }]);
    expect(reopened.listMessages(chatId)).toHaveLength(1);
  } finally {
    reopened.close();
  }
}

describe("native grounded turn cancellation persistence", () => {
  it("persists the actual client stop through SQLite reopen and releases the native upstream once", async () => {
    const upstream = await provider();
    const { deps, chatId, dbPath, stateDir } = runtime(upstream.baseUrl);
    const fail = vi.spyOn(deps.store, "failChatTurn");
    const base = await nativeServer(deps);
    const controller = new AbortController();
    const pending = ask(base, chatId, "cancel-native-turn", controller.signal).catch(
      (error: unknown) => error,
    );
    await upstream.state.entered.promise;
    controller.abort();
    await pending;
    await vi.waitFor(() => {
      expect(fail).toHaveBeenCalled();
      expect(upstream.state.closes).toBe(1);
    });
    expect(fail).toHaveBeenCalledExactlyOnceWith(chatId, "cancel-native-turn", "cancelled");
    expect(upstream.state.calls).toBe(1);
    expect(listEvidence(deps.evidenceStore)).toEqual([]);
    expect(deps.store.listMessages(chatId)).toMatchObject([
      { role: "user", turnState: "cancelled" },
    ]);
    assertReopened(dbPath, chatId, "cancelled");
    const raw = readPersistedActivityLog(stateDir);
    expect(analyzeLogText(raw).evidence.classification).toBe("supported");
    expect(raw).toContain('"errorKind":"cancelled"');
    expect(raw).not.toContain(QUESTION);
    upstream.state.mode = "healthy";
    const healthy = await ask(base, chatId, "healthy-after-cancel");
    expect(healthy.status).toBe(200);
    expect(deps.store.listMessages(chatId).map((message) => message.turnState)).toEqual([
      "cancelled",
      "completed",
      undefined,
    ]);
    expect(upstream.state.calls).toBe(2);
  });

  it("retains failed for an actual native provider failure and still permits recovery", async () => {
    const upstream = await provider();
    upstream.state.mode = "failure";
    const { deps, chatId, dbPath } = runtime(upstream.baseUrl);
    const base = await nativeServer(deps);
    const response = await ask(base, chatId, "provider-failure-turn");
    expect(response.status).toBe(503);
    assertReopened(dbPath, chatId, "failed");
    expect(listEvidence(deps.evidenceStore)).toEqual([]);
    upstream.state.mode = "healthy";
    expect((await ask(base, chatId, "recover-after-failure")).status).toBe(200);
  });

  it.each(["cancelled", "failed"] as const)(
    "settles an explicit runner %s result with the existing terminal state",
    async (state) => {
      const upstream = await provider();
      const { deps, chatId, dbPath } = runtime(upstream.baseUrl);
      const error =
        state === "cancelled"
          ? new CancelledError("fixture cancellation")
          : new TypeError("fixture failure");
      const pending = runGroundedAskInput(
        { chatId, content: QUESTION, clientTurnId: `runner-${state}`, modelId: undefined },
        deps,
        { runner: () => Promise.reject(error) },
      );
      if (state === "cancelled") expect((await pending).status).toBe(499);
      else await expect(pending).rejects.toBe(error);
      assertReopened(dbPath, chatId, state);
      expect(upstream.state.calls).toBe(0);
    },
  );
});
