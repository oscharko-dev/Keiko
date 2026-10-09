import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import {
  createDefaultChatCapability,
  parseGatewayConfig,
  type GatewayRequest,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import { buildRedactor, type UiHandlerDeps } from "./deps.js";
import { handleGroundedAsk } from "./grounded-qa.js";
import { createRunRegistry } from "./runs.js";
import type { RouteContext } from "./routes.js";
import { createInMemoryUiStore } from "./store/index.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { readPersistedActivityLog } from "../../../tests/support/activity-log-proof.js";

const MODEL = "long-extension-reference-proof";
const LONG_PATH = "src/z-final/application.properties";
const ORDINARY_PATH = "src/z-final/handler.ts";
const FACT = "namedFileFact=42";
let root = "";
let stateDir = "";
const stores: UiHandlerDeps["store"][] = [];

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "keiko-long-extension-reference-"));
  stateDir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-long-extension-state-"));
  vi.stubEnv("KEIKO_STATE_DIR", stateDir);
  resetServerLogger();
  const decoys = Array.from({ length: 120 }, (_, index) => [
    `src/a-decoy-${String(index).padStart(3, "0")}/application.properties`,
    `export const unrelatedFileFact${String(index)} = false;\n`,
  ]);
  for (const [path, content] of [[LONG_PATH, FACT], [ORDINARY_PATH, FACT], ...decoys]) {
    if (path === undefined || content === undefined) throw new TypeError("Expected a fixture file");
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
});
afterEach(() => {
  resetServerLogger();
  vi.unstubAllEnvs();
  for (const store of stores.splice(0)) store.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

function modelFor(requests: GatewayRequest[], path: string): ModelPort {
  return {
    call(request): Promise<NormalizedResponse> {
      requests.push(request);
      return Promise.resolve({
        modelId: request.modelId,
        content: `The named file fact is 42. [${path}:1]`,
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: {
          requestId: "long-extension-proof",
          promptTokens: 1,
          completionTokens: 1,
          latencyMs: 0,
          costClass: "medium",
        },
      });
    },
  };
}

function runtime(
  requests: GatewayRequest[],
  path: string,
): { readonly deps: UiHandlerDeps; readonly chatId: string } {
  const config = parseGatewayConfig({
    providers: [
      { modelId: MODEL, baseUrl: "https://long-extension.example.invalid/v1", apiKey: "fixture" },
    ],
    capabilities: [
      { ...createDefaultChatCapability(MODEL), contextWindow: 32768, maxOutputTokens: 2048 },
    ],
  });
  const store = createInMemoryUiStore();
  stores.push(store);
  store.createProject(root, "Long extension reference");
  const chat = store.createChat(root, "Long extension reference", MODEL);
  store.updateChat(chat.id, {
    connectedScope: { kind: "workspace-root", relativePaths: [], connectedAtMs: 0 },
  });
  return {
    chatId: chat.id,
    deps: {
      config,
      configPresent: true,
      env: {},
      redactor: buildRedactor({}),
      registry: createRunRegistry(),
      evidenceStore: {
        put: () => "",
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
      modelPortFactory: () => modelFor(requests, path),
      store,
    },
  };
}

async function ask(query: string, path: string): Promise<string> {
  const requests: GatewayRequest[] = [];
  const { deps, chatId } = runtime(requests, path);
  const req = Readable.from([
    Buffer.from(JSON.stringify({ chatId, projectPath: root, modelId: MODEL, content: query })),
  ]) as IncomingMessage;
  req.headers = {};
  const ctx: RouteContext = {
    req,
    res: new EventEmitter() as RouteContext["res"],
    url: new URL("http://localhost/api/chats/messages/grounded"),
    params: {},
    correlationId: "bracket-public-handler",
  };
  const response = await handleGroundedAsk(ctx, deps);
  expect(response.status).toBe(200);
  const records = readPersistedActivityLog(stateDir)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const details = records.find((record) => record.op === "search.connected-context.source-details");
  expect(records.map((record) => record.op)).not.toContain("server-log.write-failed");
  expect(requests[0]?.stream).toBe(false);
  const prompt = requests[0]?.messages[1]?.content;
  if (typeof prompt !== "string") throw new TypeError("Expected the actual fitted grounded prompt");
  expect(prompt.includes(`File: ${path}`)).toBe(true);
  expect(prompt.includes(FACT)).toBe(true);
  expect(details?.explicitPathAdmittedCount).toBe(1);
  expect(details?.explicitPathRejectedCount).toBe(0);
  return prompt;
}

describe("complete supported extension paths through the actual public grounded handler", () => {
  it.each([
    { query: `Explain ${LONG_PATH}`, path: LONG_PATH },
    { query: `Explain \`${LONG_PATH}\``, path: LONG_PATH },
    { query: `Explain ${ORDINARY_PATH}`, path: ORDINARY_PATH },
  ])("sends the explicitly named fact despite 120 same-basename decoys: $query", async (row) => {
    const prompt = await ask(row.query, row.path);
    expect(prompt.includes(`File: ${row.path}`)).toBe(true);
    expect(prompt.includes(FACT)).toBe(true);
  });
});
