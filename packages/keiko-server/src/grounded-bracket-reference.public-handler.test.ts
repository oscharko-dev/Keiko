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

const MODEL = "bracket-reference-proof";
const BRACKET_PATH = "app/z-users/[id]/page.tsx";
const ORDINARY_PATH = "app/z-users/42/page.tsx";
const FACT = "export const namedRouteFact = 42;";
let root = "";
let stateDir = "";
const stores: UiHandlerDeps["store"][] = [];

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "keiko-bracket-reference-"));
  stateDir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-bracket-state-"));
  vi.stubEnv("KEIKO_STATE_DIR", stateDir);
  resetServerLogger();
  const decoys = Array.from({ length: 120 }, (_, index) => [
    `app/a-decoy-${String(index).padStart(3, "0")}/page.tsx`,
    `export const unrelatedRouteFact${String(index)} = false;\n`,
  ]);
  for (const [path, content] of [[BRACKET_PATH, FACT], [ORDINARY_PATH, FACT], ...decoys]) {
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
        content: `The named route fact is 42. [${path}:1]`,
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: {
          requestId: "bracket-proof",
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
      { modelId: MODEL, baseUrl: "https://bracket.example.invalid/v1", apiKey: "fixture" },
    ],
    capabilities: [
      { ...createDefaultChatCapability(MODEL), contextWindow: 32768, maxOutputTokens: 2048 },
    ],
  });
  const store = createInMemoryUiStore();
  stores.push(store);
  store.createProject(root, "Bracket reference");
  const chat = store.createChat(root, "Bracket reference", MODEL);
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
  expect(requests[0]?.stream).toBe(false);
  const prompt = requests[0]?.messages[1]?.content;
  if (typeof prompt !== "string") throw new TypeError("Expected the actual fitted grounded prompt");
  return prompt;
}

describe("literal bracket paths through the actual public grounded handler", () => {
  it.each([
    { query: `Explain ${BRACKET_PATH}`, path: BRACKET_PATH },
    { query: `Explain \`${BRACKET_PATH}\``, path: BRACKET_PATH },
    { query: `Explain ${ORDINARY_PATH}`, path: ORDINARY_PATH },
  ])("sends the explicitly named fact despite 120 same-basename decoys: $query", async (row) => {
    const prompt = await ask(row.query, row.path);
    expect(prompt.includes(`File: ${row.path}`)).toBe(true);
    expect(prompt.includes(FACT)).toBe(true);
  });
});
