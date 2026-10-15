import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  analyzeLogText,
  DEFAULT_SUPPORT_QUERY_LIMITS,
  executeLocalSupportQuery,
} from "@oscharko-dev/keiko-activity-log/reader";
import { createDefaultChatCapability, parseGatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import { buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
import { buildCspHeader } from "./csp.js";
import { CORRELATION_HEADER, isValidCorrelationId } from "./correlation.js";
import {
  createFileServerLogSink,
  createServerLogger,
  redactLogLabel,
  setServerLogger,
} from "./observability/index.js";
import { closeUiTestServer, startUiTestServer } from "./ui-test-server/_support.js";
import { readPersistedActivityLog } from "../../../tests/support/activity-log-proof.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";

const MODEL = "native-correlation-privacy-proof";
const QUESTION = "Explain the value in src/feature.ts.";
const LONG_ID = "queued-referent-0446-706f10d8-single-initial-A";
const SHORT_ID = "request-short-01";
let directory = "";
const servers: Server[] = [];
const runtimes: UiHandlerDeps[] = [];

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "keiko-correlation-privacy-")));
  vi.stubEnv("KEIKO_STATE_DIR", join(directory, "state"));
  resetServerLogger();
});
afterEach(async () => {
  for (const server of servers.splice(0)) await closeUiTestServer(server);
  for (const deps of runtimes.splice(0)) await deps.dispose?.();
  resetServerLogger();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

async function provider(): Promise<string> {
  const server = createServer((request, response): void => {
    request.resume();
    request.once("end", (): void => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          model: MODEL,
          choices: [
            { message: { role: "assistant", content: "The value is 37. [src/feature.ts:1]" } },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("Unbound provider");
  return `http://127.0.0.1:${String(address.port)}/v1`;
}

function runtime(baseUrl: string): { deps: UiHandlerDeps; chatId: string; stateDir: string } {
  const root = join(directory, "workspace");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/feature.ts"), "export const value = 37;\n");
  const stateDir = join(directory, "state");
  setServerLogger(
    createServerLogger({
      sink: createFileServerLogSink(stateDir, { level: "debug" }),
      level: "debug",
    }),
  );
  const deps = buildUiHandlerDeps({
    configPath: join(stateDir, "gateway.json"),
    evidenceDir: join(stateDir, "evidence"),
    uiDbPath: join(stateDir, "ui.db"),
    env: {},
  });
  runtimes.push(deps);
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
  deps.store.createProject(root, "Correlation privacy proof");
  const chat = deps.store.createChat(root, "Correlation privacy proof", MODEL);
  deps.store.updateChat(chat.id, {
    connectedScope: { kind: "files", relativePaths: ["src/feature.ts"], connectedAtMs: 1 },
  });
  return { deps, chatId: chat.id, stateDir };
}

async function nativeAsk(id: string): Promise<{ stateDir: string; id: string; raw: string }> {
  const { deps, chatId, stateDir } = runtime(await provider());
  const started = await startUiTestServer({
    staticRoot: directory,
    csp: buildCspHeader([]),
    handlerDeps: deps,
  });
  servers.push(started.server);
  const response = await fetch(
    `http://127.0.0.1:${String(started.port)}/api/chats/messages/grounded`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Keiko-CSRF": "1",
        [CORRELATION_HEADER]: id,
      },
      body: JSON.stringify({ chatId, content: QUESTION }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(body).toMatchObject({
    citations: [expect.objectContaining({ scopePath: "src/feature.ts" })],
  });
  const echoed = response.headers.get(CORRELATION_HEADER);
  if (echoed === null) throw new TypeError("Missing native correlation header");
  await closeUiTestServer(started.server);
  servers.splice(servers.indexOf(started.server), 1);
  return { stateDir, id: echoed, raw: readPersistedActivityLog(stateDir) };
}

function assertReconstructable(stateDir: string, id: string, raw: string): void {
  const analysis = analyzeLogText(raw);
  expect(analysis.evidence).toMatchObject({ classification: "supported", corruptLineCount: 0 });
  expect(analysis.evidence.supportedLineCount).toBeGreaterThan(0);
  expect(isValidCorrelationId(id)).toBe(true);
  expect(redactLogLabel(id)).toBe(id);
  for (const trigger of ["query", "export"] as const) {
    const { result } = executeLocalSupportQuery(
      stateDir,
      {
        kind: "closure",
        queryClass: "correlation",
        roots: [id],
        windows: [],
        requiredClasses: { kind: "observed" },
        unresolved: false,
      },
      DEFAULT_SUPPORT_QUERY_LIMITS,
      { trigger },
    );
    expect(result.integrity).toMatchObject({ classification: "supported", corruptLineCount: 0 });
    expect(result.diagnosticSufficiency.reasons).not.toContain("corrupt-evidence");
    expect(result.events.map((event) => event.parsed.view.op)).toEqual(
      expect.arrayContaining([
        "request",
        "search.connected-context.started",
        "search.connected-context.completed",
        "gateway.chat.started",
        "gateway.chat.completed",
        "chat.response.message",
      ]),
    );
    expect(result.closure?.edges.some((edge) => edge.parentCorrelationId === id)).toBe(true);
  }
  expect(raw).not.toContain(QUESTION);
}

describe("native accepted correlation privacy and canonical reconstruction", () => {
  it("normalizes a secret-shaped client ID before header, gateway and parent propagation", async () => {
    expect(redactLogLabel(LONG_ID)).not.toBe(LONG_ID);
    const result = await nativeAsk(LONG_ID);
    assertReconstructable(result.stateDir, result.id, result.raw);
    expect(result.id).not.toBe(LONG_ID);
    expect(result.raw).not.toContain(LONG_ID);
    expect(result.raw).not.toContain("[redacted:secret]");
  });

  it("preserves the short accepted native twin and its complete causal closure", async () => {
    const result = await nativeAsk(SHORT_ID);
    assertReconstructable(result.stateDir, result.id, result.raw);
    expect(result.id).toBe(SHORT_ID);
  });
});
