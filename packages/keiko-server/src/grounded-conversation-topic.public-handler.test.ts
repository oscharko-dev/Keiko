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
import { runConnectedRetrievalEval } from "./grounded-eval-support.js";
import { handleGroundedAsk } from "./grounded-qa.js";
import { createRunRegistry } from "./runs.js";
import type { RouteContext } from "./routes.js";
import { createInMemoryUiStore } from "./store/index.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";

const MODEL = "topic-continuity-proof";
const INVOICE_PATH = "src/invoice.ts";
const LEGACY_PATHS = Array.from(
  { length: 6 },
  (_, index) => `src/legacy/handler${String(index)}.ts`,
);
const FILES = {
  [INVOICE_PATH]: 'export function reconcileInvoice() { return "invoice reconciliation"; }\n',
  ...Object.fromEntries(
    LEGACY_PATHS.map((path, index) => [
      path,
      [
        `export function legacyHandler${String(index)}() {`,
        ...Array.from(
          { length: 45 },
          () => "  // Legacy transport dispatch retains response compatibility and terminal state.",
        ),
        "  return true;",
        "}",
      ].join("\n"),
    ]),
  ),
};
const HISTORY = [
  { role: "user" as const, content: "Explain the legacy transport handlers." },
  {
    role: "assistant" as const,
    content: `Legacy transport handlers: ${LEGACY_PATHS.map((path) => `[${path}:1]`).join(", ")}.`,
  },
];
let root = "";
let stateDir = "";
const stores: UiHandlerDeps["store"][] = [];

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "keiko-topic-continuity-"));
  stateDir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-topic-state-"));
  vi.stubEnv("KEIKO_STATE_DIR", stateDir);
  resetServerLogger();
  for (const [path, content] of Object.entries(FILES)) {
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

function modelFor(requests: GatewayRequest[]): ModelPort {
  return {
    call(request): Promise<NormalizedResponse> {
      requests.push(request);
      return Promise.resolve({
        modelId: request.modelId,
        content: `The invoice routine reconciles totals. [${INVOICE_PATH}:1]`,
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: {
          requestId: "topic-proof",
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
  withHistory: boolean,
): {
  readonly deps: UiHandlerDeps;
  readonly chatId: string;
} {
  const config = parseGatewayConfig({
    providers: [{ modelId: MODEL, baseUrl: "https://topic.example.invalid/v1", apiKey: "fixture" }],
    capabilities: [
      { ...createDefaultChatCapability(MODEL), contextWindow: 4096, maxOutputTokens: 1024 },
    ],
  });
  const store = createInMemoryUiStore();
  stores.push(store);
  store.createProject(root, "Topic continuity");
  const chat = store.createChat(root, "Topic continuity", MODEL);
  store.updateChat(chat.id, {
    connectedScope: { kind: "workspace-root", relativePaths: [], connectedAtMs: 0 },
  });
  let timestamp = 1;
  for (const message of withHistory ? HISTORY : [])
    store.createMessage({
      ...message,
      chatId: chat.id,
      timestamp: timestamp++,
      runId: undefined,
      workflowId: undefined,
      attachments: [],
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
      modelPortFactory: () => modelFor(requests),
      store,
    },
  };
}

async function ask(query: string, withHistory = true): Promise<string> {
  const requests: GatewayRequest[] = [];
  const { deps, chatId } = runtime(requests, withHistory);
  const req = Readable.from([
    Buffer.from(JSON.stringify({ chatId, projectPath: root, modelId: MODEL, content: query })),
  ]) as IncomingMessage;
  req.headers = {};
  const ctx: RouteContext = {
    req,
    res: new EventEmitter() as RouteContext["res"],
    url: new URL("http://localhost/api/chats/messages/grounded"),
    params: {},
    correlationId: "topic-public-handler",
  };
  const response = await handleGroundedAsk(ctx, deps);
  expect(response.status).toBe(200);
  expect(requests[0]?.stream).toBe(false);
  const prompt = requests[0]?.messages[1]?.content;
  if (typeof prompt !== "string") throw new TypeError("Expected a fitted grounded prompt");
  return prompt;
}

function legacyEvidence(prompt: string): {
  readonly headers: number;
  readonly bodies: number;
} {
  return {
    headers: LEGACY_PATHS.filter((path) => prompt.includes(`File: ${path}`)).length,
    bodies: Array.from(
      { length: 6 },
      (_, index) => `export function legacyHandler${String(index)}()`,
    ).filter((marker) => prompt.includes(marker)).length,
  };
}

describe("independent topics through the real public grounded handler", () => {
  it.each(["Explain invoice reconciliation", "Erkläre invoice reconciliation"])(
    "preserves the new topic's evidence within a supported 4096-token model window: %s",
    async (query) => {
      const control = await ask(query, false);
      const prompt = await ask(query);
      expect(prompt.includes(`File: ${INVOICE_PATH}`)).toBe(true);
      expect(legacyEvidence(prompt)).toEqual(legacyEvidence(control));
    },
  );

  it.each(['Explain "invoice reconciliation"', "Explain reconcileInvoice"])(
    "preserves independently anchored topic control: %s",
    async (query) => {
      const prompt = await ask(query);
      expect(prompt.includes(`File: ${INVOICE_PATH}`)).toBe(true);
      expect(legacyEvidence(prompt)).toEqual({ headers: 0, bodies: 0 });
    },
  );

  it("preserves the history-free natural-language control", async () => {
    const prompt = await ask("Explain invoice reconciliation", false);
    expect(prompt.includes(`File: ${INVOICE_PATH}`)).toBe(true);
  });

  it.each(["Can you see it now?", "Siehst du sie jetzt?"])(
    "still supplies the actual earlier source for a genuine referential follow-up: %s",
    async (query) => {
      const prompt = await ask(query);
      expect(LEGACY_PATHS.some((path) => prompt.includes(`File: ${path}`))).toBe(true);
    },
  );

  it("does not increase current-topic retrieval work compared with a history-free ask", async () => {
    const query = "Explain invoice reconciliation";
    const control = await runConnectedRetrievalEval({ files: FILES, query });
    const withHistory = await runConnectedRetrievalEval({ files: FILES, query, history: HISTORY });
    expect(withHistory.pack.usage.searchCalls).toBe(control.pack.usage.searchCalls);
    expect(withHistory.pack.usage.excerptBytes).toBe(control.pack.usage.excerptBytes);
    expect(withHistory.pack.files.map((file) => file.scopePath)).toEqual(
      control.pack.files.map((file) => file.scopePath),
    );
  });
});
