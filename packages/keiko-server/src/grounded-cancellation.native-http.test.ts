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
import { createChatTurnSerializer } from "./chat-turn-serializer.js";
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
  answerContent: string;
  readonly requests: string[];
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
                message: { role: "assistant", content: state.answerContent },
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
    requests: [],
    answerContent: "The value is 37. [src/feature.ts:1]",
    closes: 0,
    entered: deferred(),
  };
  const server = createServer((req, res): void => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string): void => {
      body += chunk;
    });
    req.once("end", (): void => {
      state.requests.push(body);
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
  content = QUESTION,
): Promise<Response> {
  return fetch(`${base}/api/chats/messages/grounded`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
    body: JSON.stringify({ chatId, content, clientTurnId }),
    signal: signal ?? AbortSignal.timeout(10_000),
  });
}

function desktopRequest(
  base: string,
  chatId: string,
  surface: "buffered" | "streamed" | "regenerated",
  signal: AbortSignal,
  assistantMessageId?: string,
): Promise<Response> {
  const suffix = { buffered: "", streamed: "/stream", regenerated: "/regenerate" }[surface];
  return fetch(`${base}/api/desktop/chat${suffix}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
    body: JSON.stringify({
      chatId,
      projectPath: join(directory, "workspace"),
      content: QUESTION,
      assistantMessageId,
    }),
    signal,
  });
}

function patchChat(base: string, chatId: string, patch: unknown): Promise<Response> {
  return fetch(`${base}/api/chats?id=${encodeURIComponent(chatId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(3_000),
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
  it("cancels the active native answer before acknowledging a connected-source change", async () => {
    const upstream = await provider();
    const { deps, chatId, dbPath } = runtime(upstream.baseUrl);
    const base = await nativeServer(deps);
    const controller = new AbortController();
    const pending = ask(base, chatId, "source-change-native-turn", controller.signal).catch(
      (error: unknown) => error,
    );
    try {
      await upstream.state.entered.promise;
      const root = join(directory, "workspace");
      writeFileSync(join(root, "src/selected.ts"), "export const selected = 73;\n");
      const scopes = [
        { root, kind: "files", relativePaths: ["src/selected.ts"], connectedAtMs: 2 },
      ];
      const update = await fetch(`${base}/api/chats?id=${encodeURIComponent(chatId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
        body: JSON.stringify({ connectedScopes: scopes }),
        signal: AbortSignal.timeout(3_000),
      });
      expect(update.status).toBe(200);
      const cancelled = await pending;
      expect(cancelled).toBeInstanceOf(Response);
      expect((cancelled as Response).status).toBe(499);
      expect(await (cancelled as Response).json()).toMatchObject({ error: { code: "CANCELLED" } });
      await vi.waitFor(() => {
        expect(upstream.state.closes).toBe(1);
      });
      expect(upstream.state.calls).toBe(1);
      expect(deps.store.findChatById(chatId)?.connectedScopes).toEqual(scopes);
      assertReopened(dbPath, chatId, "cancelled");
      expect(listEvidence(deps.evidenceStore)).toEqual([]);
      expect(upstream.state.requests[0]).toContain("export const value = 37;");
      expect(upstream.state.requests[0]).not.toContain("export const selected = 73;");
      upstream.state.mode = "healthy";
      upstream.state.answerContent = "The selected value is 73. [src/selected.ts:1]";
      const next = await ask(
        base,
        chatId,
        "new-scope-answer",
        undefined,
        "Explain src/selected.ts.",
      );
      expect(next.status).toBe(200);
      expect(((await next.json()) as { content: string }).content).toContain("73");
      expect(upstream.state.calls).toBe(2);
      expect(upstream.state.requests.at(-1)).toContain("export const selected = 73;");
      expect(upstream.state.requests.at(-1)).not.toContain("export const value = 37;");
    } finally {
      controller.abort();
      await pending;
    }
  });

  it.each(["buffered", "streamed", "regenerated"] as const)(
    "cancels a native %s answer when a new source is connected",
    async (surface) => {
      const upstream = await provider();
      const { deps, chatId } = runtime(upstream.baseUrl);
      deps.store.updateChat(chatId, { connectedScopes: null });
      const base = await nativeServer(deps);
      const controller = new AbortController();
      upstream.state.mode = "healthy";
      expect((await desktopRequest(base, chatId, "buffered", controller.signal)).status).toBe(200);
      const history = deps.store.listMessages(chatId);
      upstream.state.mode = "hold";
      const pending = desktopRequest(
        base,
        chatId,
        surface,
        controller.signal,
        history.at(-1)?.id,
      ).then(async (response) => ({ status: response.status, body: await response.text() }));
      try {
        await upstream.state.entered.promise;
        expect(
          (
            await patchChat(base, chatId, {
              connectedScopes: [{ kind: "workspace-root", relativePaths: [], connectedAtMs: 2 }],
            })
          ).status,
        ).toBe(200);
        const result = await pending;
        if (surface === "streamed") {
          expect(result.status).toBe(200);
          expect(result.body).toBe("event: cancelled\ndata: {}\n\n");
        } else expect(result.status).toBe(499);
        await vi.waitFor(() => {
          expect(upstream.state.closes).toBe(1);
        });
        expect(upstream.state.calls).toBe(2);
        expect(deps.store.listMessages(chatId).slice(0, history.length)).toEqual(history);
        expect(
          deps.store.listMessages(chatId).filter((message) => message.role === "assistant"),
        ).toHaveLength(1);
      } finally {
        controller.abort();
        await pending.catch((error: unknown) => error);
      }
    },
  );

  it.each([
    { connectedScopes: [{ kind: "files", relativePaths: ["../outside.ts"], connectedAtMs: 2 }] },
    { connectedScopes: [{ kind: "files", relativePaths: ["src/missing.ts"], connectedAtMs: 2 }] },
    { connectedScopes: null, title: "" },
    { connectedScopes: null, expectedGroundingScopeIdentity: `gsi-v1:${"0".repeat(64)}` },
  ])(
    "rejects invalid or conflicting patches without cancelling the held answer: %j",
    async (patch) => {
      const upstream = await provider();
      const { deps, chatId } = runtime(upstream.baseUrl);
      const base = await nativeServer(deps);
      const controller = new AbortController();
      const pending = ask(base, chatId, "held-invalid-change", controller.signal).catch(
        (error: unknown) => error,
      );
      try {
        await upstream.state.entered.promise;
        const before = deps.store.findChatById(chatId);
        const response = await patchChat(base, chatId, patch);
        expect([400, 403, 404, 409]).toContain(response.status);
        expect(upstream.state.closes).toBe(0);
        expect(upstream.state.calls).toBe(1);
        expect(deps.store.findChatById(chatId)).toEqual(before);
      } finally {
        controller.abort();
        await pending;
      }
    },
  );

  it("does not cancel for canonical duplicate sources or timestamp-only changes", async () => {
    const upstream = await provider();
    const { deps, chatId } = runtime(upstream.baseUrl);
    const serializer = createChatTurnSerializer();
    const enter = vi.spyOn(serializer, "runExclusive");
    const base = await nativeServer({ ...deps, chatTurnSerializer: serializer });
    const controller = new AbortController();
    const pending = ask(base, chatId, "held-noop-change", controller.signal).catch(
      (error: unknown) => error,
    );
    try {
      await upstream.state.entered.promise;
      const scope = {
        root: join(directory, "workspace"),
        kind: "files",
        relativePaths: ["src/feature.ts"],
        connectedAtMs: 2,
      };
      const update = patchChat(base, chatId, { connectedScopes: [scope, scope] });
      await vi.waitFor(() => {
        expect(enter).toHaveBeenCalledTimes(2);
      });
      expect(upstream.state.closes).toBe(0);
      expect(upstream.state.calls).toBe(1);
      controller.abort();
      await pending;
      expect((await update).status).toBe(200);
      expect(deps.store.findChatById(chatId)?.connectedScopes).toEqual([scope]);
    } finally {
      controller.abort();
      await pending;
    }
  });

  it("cancels on adding a second repository and preserves the complete earlier conversation", async () => {
    const upstream = await provider();
    upstream.state.mode = "healthy";
    const { deps, chatId, stateDir } = runtime(upstream.baseUrl);
    const base = await nativeServer(deps);
    expect((await ask(base, chatId, "completed-before-source-change")).status).toBe(200);
    const history = deps.store.listMessages(chatId);
    const evidence = listEvidence(deps.evidenceStore);
    upstream.state.mode = "hold";
    const controller = new AbortController();
    const pending = ask(base, chatId, "held-second-repository", controller.signal);
    try {
      await upstream.state.entered.promise;
      const root = join(directory, "other-repository");
      mkdirSync(root);
      writeFileSync(join(root, "feature.ts"), "export const second = 73;\n");
      const previous = deps.store.findChatById(chatId)?.connectedScopes ?? [];
      const scopes = [
        ...previous,
        { root, kind: "workspace-root", relativePaths: [], connectedAtMs: 2 },
      ];
      expect((await patchChat(base, chatId, { connectedScopes: scopes })).status).toBe(200);
      expect((await pending).status).toBe(499);
      expect(deps.store.listMessages(chatId).slice(0, history.length)).toEqual(history);
      expect(listEvidence(deps.evidenceStore)).toEqual(evidence);
      expect(deps.store.findChatById(chatId)?.connectedScopes).toEqual(scopes);
      const raw = readPersistedActivityLog(stateDir);
      expect(analyzeLogText(raw).evidence.classification).toBe("supported");
      expect(raw).toContain('"outcome":"cancellation-requested"');
      expect(raw).toContain('"cancelledGenerationCount":1');
      expect(raw).not.toContain(root);
      expect(raw).not.toContain(QUESTION);
    } finally {
      controller.abort();
      await pending.catch((error: unknown) => error);
    }
  });

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
