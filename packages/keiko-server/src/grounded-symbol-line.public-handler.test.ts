import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { performance } from "node:perf_hooks";
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

const MODEL = "symbol-line-reference-proof";
const TARGET_PATH = "src/large.ts";
const FACT = "export function physicalLine8999() { return value8999 + peer8999(); }";
let root = "";
let stateDir = "";
const stores: UiHandlerDeps["store"][] = [];

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "keiko-symbol-line-reference-"));
  stateDir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-symbol-line-state-"));
  vi.stubEnv("KEIKO_STATE_DIR", stateDir);
  resetServerLogger();
  const source = Array.from(
    { length: 10_000 },
    (_, index) =>
      `export function physicalLine${String(index)}() { return value${String(index)} + peer${String(index)}(); }`,
  ).join("\n");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, TARGET_PATH), source);
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
        content: `The named routine returns the value plus its peer. [${path}:9000]`,
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: {
          requestId: "symbol-line-proof",
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
      { modelId: MODEL, baseUrl: "https://symbol-line.example.invalid/v1", apiKey: "fixture" },
    ],
    capabilities: [
      { ...createDefaultChatCapability(MODEL), contextWindow: 32768, maxOutputTokens: 2048 },
    ],
  });
  const store = createInMemoryUiStore();
  stores.push(store);
  store.createProject(root, "Symbol line reference");
  const chat = store.createChat(root, "Symbol line reference", MODEL);
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
  expect(details?.explicitPathAdmittedCount).toBe(1);
  expect(details?.explicitPathRejectedCount).toBe(0);
  expect(records.map((record) => record.op)).not.toContain("server-log.write-failed");
  expect(requests[0]?.stream).toBe(false);
  const prompt = requests[0]?.messages[1]?.content;
  if (typeof prompt !== "string") throw new TypeError("Expected the actual fitted grounded prompt");
  return prompt;
}

describe("physical-line lookup through the actual public grounded handler", () => {
  it("retains line 9000 in a 10,000-line file without synchronous prefix rescans", async () => {
    const started = performance.now();
    const prompt = await ask(`Explain ${TARGET_PATH}:9000`, TARGET_PATH);
    const elapsed = performance.now() - started;
    expect(prompt.includes(`File: ${TARGET_PATH}`)).toBe(true);
    expect(prompt.includes(FACT)).toBe(true);
    expect(elapsed).toBeLessThan(5_000);
  }, 60_000);
});
