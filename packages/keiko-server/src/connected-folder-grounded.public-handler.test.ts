import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultChatCapability,
  parseGatewayConfig,
  toolCallingConfigurationFingerprint,
} from "@oscharko-dev/keiko-model-gateway";
import { buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
import { handleGroundedAsk } from "./grounded-qa.js";
import { GROUNDED_FOLDER_TOOL_TURN_GUIDANCE } from "./grounded-plural-synthesis.js";
import { mockRequest, mockResponse } from "./_support.js";
import {
  QUALIFICATION_SPEND_BUDGET_USD_ENV,
  QUALIFICATION_SPEND_LEDGER_PATH_ENV,
} from "./gateway-spend-budget.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import {
  createBufferedServerLogSink,
  type BufferedServerLogSink,
} from "../../../tests/support/buffered-server-log.js";

// The whole grounded route with the real Gateway and a provider answered at the wire: a Chat that is
// connected to exactly one folder offers the folder tool to a model that can call tools, and keeps
// the single retrieval for a model that cannot.

const MODEL = "folder-grounded-route";
const CORRELATION = "folder-grounded-route";
const OTHER_FACT = "export const Limit = 4711;";
const ANSWER = "Feature returns true [src/Feature.ts:1].";
let root = "";
let stateDir = "";
let sink: BufferedServerLogSink;
const disposals: UiHandlerDeps[] = [];

interface WireRequest {
  readonly messages: readonly { readonly role: string; readonly content?: unknown }[];
  readonly tools?: readonly { readonly function?: { readonly name?: string } }[];
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-folder-grounded-")));
  stateDir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-folder-grounded-state-")));
  vi.stubEnv("KEIKO_STATE_DIR", stateDir);
  resetServerLogger();
  sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
  const files: Record<string, string> = {
    "src/Feature.ts": "export function Feature() { return true; }\n",
    "src/Other.ts": `${OTHER_FACT}\n`,
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
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

function completion(message: Record<string, unknown>, finishReason: string): Response {
  return Response.json({
    id: "folder-grounded-proof",
    model: MODEL,
    choices: [
      { index: 0, message: { role: "assistant", ...message }, finish_reason: finishReason },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

function toolCall(args: Record<string, unknown>): Response {
  return completion(
    {
      content: null,
      tool_calls: [
        {
          id: "folder-wire-call",
          type: "function",
          function: { name: "folder_files", arguments: JSON.stringify(args) },
        },
      ],
    },
    "tool_calls",
  );
}

/** Records every synthesis request; the first one that offers tools is answered with a tool call. */
function stubProvider(answer: string = ANSWER): WireRequest[] {
  const requests: WireRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((_url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (!body.includes("Feature()")) return Promise.resolve(completion({ content: "" }, "stop"));
      const request = JSON.parse(body) as WireRequest;
      requests.push(request);
      const first = requests.length === 1 && request.tools !== undefined;
      return Promise.resolve(
        first
          ? toolCall({ view: "read", path: "src/Other.ts" })
          : completion({ content: answer }, "stop"),
      );
    }),
  );
  return requests;
}

function runtime(toolCalling: boolean): { readonly deps: UiHandlerDeps; readonly chatId: string } {
  const deps = buildUiHandlerDeps({
    configPath: join(stateDir, "gateway.json"),
    evidenceDir: join(stateDir, "evidence"),
    uiDbPath: join(stateDir, "ui.db"),
    env: {
      [QUALIFICATION_SPEND_BUDGET_USD_ENV]: "100",
      [QUALIFICATION_SPEND_LEDGER_PATH_ENV]: join(stateDir, "spend.db"),
    },
  });
  disposals.push(deps);
  expect(deps.connectedFolderChatCatalog).toBeDefined();
  const provider = {
    modelId: MODEL,
    baseUrl: "https://folder.example.invalid/v1",
    apiKey: "fixture",
    timeoutMs: 5000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
  };
  deps.gatewayConfig?.set(
    parseGatewayConfig({
      providers: [provider],
      capabilities: [
        {
          ...createDefaultChatCapability(MODEL),
          toolCalling,
          toolCallingVerification: {
            status: toolCalling ? "verified" : "unsupported",
            checkedAt: new Date().toISOString(),
            probe: "gateway-tool-calling-v1",
            configurationFingerprint: toolCallingConfigurationFingerprint(provider),
          },
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
  deps.store.createProject(root, "Folder grounded route");
  const chat = deps.store.createChat(root, "Folder grounded route", MODEL);
  deps.store.updateChat(chat.id, {
    connectedScopes: [{ root, kind: "workspace-root", relativePaths: [], connectedAtMs: 1 }],
  });
  return { deps, chatId: chat.id };
}

async function ask(
  deps: UiHandlerDeps,
  chatId: string,
): Promise<{ status: number; body: unknown }> {
  return handleGroundedAsk(
    {
      req: mockRequest({ body: JSON.stringify({ chatId, content: "Explain src/Feature.ts" }) }),
      res: mockResponse().res,
      params: {},
      url: new URL("http://127.0.0.1/api/chats/messages/grounded"),
      correlationId: CORRELATION,
    },
    deps,
  );
}

function selection(): readonly unknown[] {
  return sink.events
    .filter((event) => event.op === "folder.files.turn-selected")
    .map((event) => [event.correlationId, event.extra?.selection]);
}

function text(request: WireRequest | undefined, role: string): string {
  return (request?.messages ?? [])
    .filter((message) => message.role === role)
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .join("\n");
}

function answerText(body: unknown): string {
  const content = (body as { readonly content?: unknown }).content;
  return typeof content === "string" ? content : "";
}

describe("grounded ask on a Chat connected to one folder", () => {
  it("offers the folder tool to a tool-calling model and answers from what it read", async () => {
    const requests = stubProvider();
    const { deps, chatId } = runtime(true);
    const result = await ask(deps, chatId);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests[0]?.tools?.map((tool) => tool.function?.name)).toEqual(["folder_files"]);
    expect(text(requests[0], "system")).toContain(GROUNDED_FOLDER_TOOL_TURN_GUIDANCE);
    expect(text(requests[0], "system")).not.toContain("label Jira tool results");
    // The automatic first retrieval still seeds the prompt.
    expect(JSON.stringify(requests[0]?.messages)).toContain("Feature()");
    expect(text(requests[1], "tool")).toContain(OTHER_FACT);
    expect(text(requests[1], "tool")).toContain("untrusted-document-text");
    expect(answerText(result.body)).toContain("Feature returns true");
    expect(selection()).toEqual([[CORRELATION, "tool-turn"]]);
    const operations = sink.events.filter((event) => event.op === "folder.files.operation");
    expect(operations.map((event) => [event.correlationId, event.extra?.view])).toEqual([
      [CORRELATION, "read"],
    ]);
    expect(JSON.stringify(operations)).not.toContain("Other.ts");
  }, 60_000);

  it("accepts a citation of lines the model read through the tool, and no other line", async () => {
    // src/Other.ts is not in the automatic retrieval of this question; the model reads its one line.
    stubProvider(
      "Feature returns true [src/Feature.ts:1]. The limit is 4711 [src/Other.ts:1]. More [src/Other.ts:40].",
    );
    const { deps, chatId } = runtime(true);
    const result = await ask(deps, chatId);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const body = result.body as {
      readonly citations?: readonly { readonly scopePath: string; readonly lineRange?: unknown }[];
      readonly uncertainty?: readonly { readonly kind: string; readonly claim: string }[];
    };
    expect(body.citations?.map((citation) => [citation.scopePath, citation.lineRange])).toEqual([
      ["src/Feature.ts", { startLine: 1, endLine: 1 }],
      ["src/Other.ts", { startLine: 1, endLine: 1 }],
    ]);
    // Line 40 was never returned by the tool: exactly that one marker is reported as unsupported.
    const unsupported = body.uncertainty?.filter((entry) => entry.kind === "unsupported-citation");
    expect(unsupported).toHaveLength(1);
    expect(unsupported?.[0]?.claim).toContain("(1 in total)");
  }, 60_000);

  it("keeps the single retrieval, without tools, for a model that cannot call tools", async () => {
    const requests = stubProvider();
    const { deps, chatId } = runtime(false);
    const result = await ask(deps, chatId);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) expect(request).not.toHaveProperty("tools");
    expect(text(requests[0], "system")).not.toContain(GROUNDED_FOLDER_TOOL_TURN_GUIDANCE);
    expect(answerText(result.body)).toContain("Feature returns true");
    expect(selection()).toEqual([[CORRELATION, "one-shot-model-not-tool-ready"]]);
    expect(sink.events.filter((event) => event.op === "folder.files.operation")).toEqual([]);
  }, 60_000);
});
