import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultChatCapability, parseGatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import { buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
import { handleGroundedAsk } from "./grounded-qa.js";
import type { RouteContext } from "./routes.js";
import {
  QUALIFICATION_SPEND_BUDGET_USD_ENV,
  QUALIFICATION_SPEND_LEDGER_PATH_ENV,
} from "./gateway-spend-budget.js";
import { readPersistedActivityLog } from "../../../tests/support/activity-log-proof.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";

const MODEL = "physical-synthesis-ceiling-proof";
const MISSING = "I need more evidence.\nMissing evidence: [lib/Companion.ts]";
const CITED = "Feature returns true [src/Feature.ts:1].";
const UNCITED = "Feature returns true.";
const FOLLOW_UP = "Companion is 42 [lib/Companion.ts:1].";
const OVERFLOW = "context-overflow";
let root = "";
let stateDir = "";
const disposals: UiHandlerDeps[] = [];

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "keiko-synthesis-ceiling-"));
  stateDir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-synthesis-state-"));
  vi.stubEnv("KEIKO_STATE_DIR", stateDir);
  resetServerLogger();
  for (const [path, content] of Object.entries({
    "src/Feature.ts": "export function Feature() { return true; }\n",
    "lib/Companion.ts": "42;\n",
  })) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
});

afterEach(async () => {
  for (const deps of disposals.splice(0)) await deps.dispose?.();
  resetServerLogger();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

function providerResponse(content: string): Response {
  if (content === OVERFLOW)
    return new Response(
      JSON.stringify({
        error: {
          message: "max_tokens=1000000000 cannot be greater than max_model_len=8192.",
          type: null,
          code: "400",
        },
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  return new Response(
    JSON.stringify({
      id: "physical-synthesis-proof",
      model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function configuredRuntime(): { readonly deps: UiHandlerDeps; readonly chatId: string } {
  const env = {
    [QUALIFICATION_SPEND_BUDGET_USD_ENV]: "100",
    [QUALIFICATION_SPEND_LEDGER_PATH_ENV]: join(stateDir, "spend.db"),
  };
  const deps = buildUiHandlerDeps({
    configPath: join(stateDir, "gateway.json"),
    evidenceDir: join(stateDir, "evidence"),
    uiDbPath: join(stateDir, "ui.db"),
    env,
  });
  disposals.push(deps);
  deps.gatewayConfig?.set(
    parseGatewayConfig({
      providers: [
        {
          modelId: MODEL,
          baseUrl: "https://synthesis.example.invalid/v1",
          apiKey: "fixture",
          maxRetries: 0,
        },
      ],
      capabilities: [
        {
          ...createDefaultChatCapability(MODEL),
          contextWindow: 32768,
          maxOutputTokens: 1024,
          pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 },
        },
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
  deps.store.createProject(root, "Physical synthesis ceiling");
  const chat = deps.store.createChat(root, "Physical synthesis ceiling", MODEL);
  deps.store.updateChat(chat.id, {
    connectedScope: { kind: "workspace-root", relativePaths: [], connectedAtMs: 0 },
  });
  return { deps, chatId: chat.id };
}

function route(chatId: string): RouteContext {
  const req = Readable.from([
    Buffer.from(
      JSON.stringify({
        chatId,
        projectPath: root,
        modelId: MODEL,
        content: "Explain src/Feature.ts",
      }),
    ),
  ]) as IncomingMessage;
  req.headers = {};
  return {
    req,
    res: new EventEmitter() as RouteContext["res"],
    url: new URL("http://localhost/api/chats/messages/grounded"),
    params: {},
    correlationId: "physical-synthesis-public-handler",
  };
}

async function scriptedProviderTurn(answers: readonly string[]): Promise<{
  readonly requests: readonly string[];
  readonly records: readonly Record<string, unknown>[];
  readonly spendReservations: number;
}> {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((_url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (!body.includes("File: src/Feature.ts")) return Promise.resolve(providerResponse(CITED));
      requests.push(body);
      return Promise.resolve(providerResponse(answers[requests.length - 1] ?? CITED));
    }),
  );
  const { deps, chatId } = configuredRuntime();
  const budget = deps.gatewayConfig?.spendBudget;
  if (budget === undefined) throw new TypeError("Expected the real durable spend budget");
  const reserve = vi.spyOn(budget, "reserve");
  const result = await handleGroundedAsk(route(chatId), deps);
  expect(result.status).toBe(200);
  const records = readPersistedActivityLog(stateDir)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(records.map((record) => record.op)).not.toContain("server-log.write-failed");
  return { requests, records, spendReservations: reserve.mock.calls.length };
}

describe("the shared two-call ceiling across actual configured gateway synthesis attempts", () => {
  it.each([
    ["ordinary cited answer", [CITED], 1],
    ["ordinary follow-up", [MISSING, FOLLOW_UP], 2],
    ["ordinary marker repair", [UNCITED, CITED], 2],
  ] as const)("preserves the healthy %s control", async (_label, answers, count) => {
    const turn = await scriptedProviderTurn(answers);
    expect(turn.requests).toHaveLength(count);
    expect(turn.spendReservations).toBe(count);
  });

  it.each([
    ["adopted-window retry followed by unread declaration", [OVERFLOW, MISSING, FOLLOW_UP]],
    ["adopted-window retry followed by marker repair", [OVERFLOW, UNCITED, CITED]],
    ["unread declaration followed by an adopted-window retry", [MISSING, OVERFLOW, FOLLOW_UP]],
  ] as const)("never dispatches a third synthesis after %s", async (_label, answers) => {
    const turn = await scriptedProviderTurn(answers);
    expect(turn.records.some((record) => record.op === "gateway.context-window.retry")).toBe(true);
    expect(turn.spendReservations).toBe(turn.requests.length);
    expect(turn.requests.length).toBeLessThanOrEqual(2);
  });
});
