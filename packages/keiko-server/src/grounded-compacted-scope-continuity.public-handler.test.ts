import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroundedAnswer } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { createInMemoryEvidenceStore, loadEvidence } from "@oscharko-dev/keiko-evidence";
import {
  createDefaultChatCapability,
  parseGatewayConfig,
  type GatewayRequest,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import { buildRedactor, type UiHandlerDeps } from "./deps.js";
import { handleGroundedAsk } from "./grounded-qa.js";
import type { RouteContext } from "./routes.js";
import { createRunRegistry } from "./runs.js";
import { createInMemoryUiStore } from "./store/index.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { readPersistedActivityLog } from "../../../tests/support/activity-log-proof.js";

const MODEL = "compacted-scope-continuity-proof";
const PATH = "src/validation.ts";
const OLD_FACT = "OLD_ROOT_VALUE_13";
const LIVE_FACT = "CURRENT_ROOT_VALUE_42";
const INVOICE_FACT = "CURRENT_INVOICE_VALUE_77";
let directory = "";
const stores: UiHandlerDeps["store"][] = [];

beforeEach(() => {
  directory = mkdtempSync(join(realpathSync(tmpdir()), "keiko-compacted-scope-"));
  vi.stubEnv("KEIKO_STATE_DIR", join(directory, "state"));
  resetServerLogger();
  for (const name of ["a", "b"]) {
    const root = join(directory, name);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, PATH),
      `export const validation = "${name === "a" ? OLD_FACT : LIVE_FACT}";\n`,
    );
    writeFileSync(
      join(root, "src/invoice.ts"),
      `export function reconcileInvoice() { return "invoice reconciliation ${INVOICE_FACT}"; }\n`,
    );
  }
});

afterEach(() => {
  resetServerLogger();
  vi.unstubAllEnvs();
  for (const store of stores.splice(0)) store.close();
  rmSync(directory, { recursive: true, force: true });
});

function modelFor(requests: GatewayRequest[]): ModelPort {
  return {
    call(request): Promise<NormalizedResponse> {
      requests.push(request);
      return Promise.resolve({
        modelId: MODEL,
        content: `The current value is documented [${PATH}:1].`,
        finishReason: "stop" as const,
        toolCalls: [],
        structuredOutput: null,
        usage: {
          requestId: "compacted-scope-proof",
          promptTokens: 1,
          completionTokens: 1,
          latencyMs: 0,
          costClass: "medium" as const,
        },
      });
    },
  };
}

function history(deps: UiHandlerDeps, chatId: string): void {
  const messages = Array.from({ length: 80 }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: "Review documentation and preserve the agreed validation requirements. ".repeat(40),
  }));
  messages.push(
    { role: "user", content: `Explain ${PATH}.` },
    { role: "assistant", content: `The earlier value was ${OLD_FACT} [${PATH}:1].` },
  );
  for (const [index, message] of messages.entries())
    deps.store.createMessage({
      ...message,
      chatId,
      timestamp: index + 1,
      runId: undefined,
      workflowId: undefined,
      attachments: [],
    });
}

function fixture(requests: GatewayRequest[]): {
  readonly deps: UiHandlerDeps;
  readonly chatId: string;
} {
  const config = parseGatewayConfig({
    providers: [
      { modelId: MODEL, baseUrl: "https://compaction.example.invalid/v1", apiKey: "fixture" },
    ],
    capabilities: [
      { ...createDefaultChatCapability(MODEL), contextWindow: 8192, maxOutputTokens: 1024 },
    ],
  });
  const store = createInMemoryUiStore();
  stores.push(store);
  const root = join(directory, "a");
  store.createProject(root, "Compacted history scope");
  const chat = store.createChat(root, "Compacted history scope", MODEL);
  store.updateChat(chat.id, {
    connectedScope: { kind: "workspace-root", relativePaths: [], connectedAtMs: 0 },
  });
  const deps: UiHandlerDeps = {
    config,
    configPresent: true,
    env: {},
    store,
    redactor: buildRedactor({}, config),
    registry: createRunRegistry(),
    evidenceStore: createInMemoryEvidenceStore(),
    modelPortFactory: () => modelFor(requests),
  };
  history(deps, chat.id);
  return { deps, chatId: chat.id };
}

function route(chatId: string, content: string): RouteContext {
  const req = Readable.from([
    Buffer.from(JSON.stringify({ chatId, content, modelId: MODEL })),
  ]) as IncomingMessage;
  req.headers = {};
  return {
    req,
    res: new EventEmitter() as RouteContext["res"],
    url: new URL("http://localhost/api/chats/messages/grounded"),
    params: {},
    correlationId: "compacted-scope-public-handler",
  };
}

async function ask(content: string, reconnect: boolean): Promise<string> {
  const requests: GatewayRequest[] = [];
  const { deps, chatId } = fixture(requests);
  const root = join(directory, reconnect ? "b" : "a");
  if (reconnect)
    deps.store.updateChat(chatId, {
      connectedScope: { kind: "workspace-root", root, relativePaths: [], connectedAtMs: 1 },
    });
  else writeFileSync(join(root, PATH), `export const validation = "${LIVE_FACT}";\n`);
  const response = await handleGroundedAsk(route(chatId, content), deps);
  expect(response.status).toBe(200);
  const answer = response.body as GroundedAnswer;
  if (answer.groundingKind !== "connected-context")
    throw new TypeError("Expected folder grounding");
  expect(answer.contextPack.contextSummary?.compactionActive).toBe(true);
  const compacted = deps.evidenceStore.list().filter((id) => id.startsWith("chat-"));
  expect(compacted.length).toBeGreaterThan(0);
  expect(
    compacted.some((id) => (loadEvidence(deps.evidenceStore, id)?.compaction?.length ?? 0) > 0),
  ).toBe(true);
  expect(requests.length).toBeGreaterThan(0);
  const prompt = requests[0]?.messages.map((message) => message.content).join("\n") ?? "";
  expect(prompt).toContain("Earlier conversation reference data");
  assertIndependentReferenceChannel(content);
  return (
    prompt
      .split("Repository evidence excerpts:")[1]
      ?.split("Known uncertainty from retrieval:")[0] ?? ""
  );
}

function assertIndependentReferenceChannel(content: string): void {
  if (!content.includes("invoice reconciliation")) return;
  const records = readPersistedActivityLog(join(directory, "state"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const selection = records.find(
    (record) => record.op === "search.connected-context.selection-details",
  );
  expect(selection?.continuityReferentSource).toBe("none");
  expect(selection?.continuityReferentCount).toBe(0);
}

function freshSources(request: GatewayRequest | undefined): string {
  if (request === undefined) throw new TypeError("Expected an actual dispatched grounded prompt");
  const prompt = request.messages.map((message) => message.content).join("\n");
  return (
    prompt
      .split("Repository evidence excerpts:")[1]
      ?.split("Known uncertainty from retrieval:")[0] ?? ""
  );
}

describe("compacted eligible tail remains a reference without current-root source authority", () => {
  it("retains a real compacted prior ask while fetching identical paths from the reconnected root", async () => {
    const requests: GatewayRequest[] = [];
    const { deps, chatId } = fixture(requests);
    const first = await handleGroundedAsk(route(chatId, `Explain ${PATH}`), deps);
    expect(first.status).toBe(200);
    const firstAnswer = first.body as GroundedAnswer;
    if (firstAnswer.groundingKind !== "connected-context")
      throw new TypeError("Expected grounding");
    expect(firstAnswer.contextPack.contextSummary?.compactionActive).toBe(true);
    expect(freshSources(requests[0])).toContain(OLD_FACT);
    const firstCount = requests.length;
    deps.store.updateChat(chatId, {
      connectedScope: {
        kind: "workspace-root",
        root: join(directory, "b"),
        relativePaths: [],
        connectedAtMs: 1,
      },
    });
    const second = await handleGroundedAsk(route(chatId, "Can you see it now?"), deps);
    expect(second.status).toBe(200);
    const secondAnswer = second.body as GroundedAnswer;
    if (secondAnswer.groundingKind !== "connected-context")
      throw new TypeError("Expected grounding");
    expect(secondAnswer.contextPack.contextSummary?.compactionActive).toBe(true);
    const source = freshSources(requests[firstCount]);
    expect(source).toContain(LIVE_FACT);
    expect(source).not.toContain(OLD_FACT);
    expect(deps.evidenceStore.list().filter((id) => id.startsWith("chat-")).length).toBeGreaterThan(
      1,
    );
  });

  it.each(["Can you see it now?", "Siehst du sie jetzt?"])(
    "re-reads the latest cited source after actual conversation-lane compaction: %s",
    async (query) => {
      const source = await ask(query, false);
      expect(source).toContain(`File: ${PATH}`);
      expect(source).toContain(LIVE_FACT);
      expect(source).not.toContain(OLD_FACT);
    },
  );

  it.each(["Can you see it now?", "Siehst du sie jetzt?"])(
    "reads the newly connected root for an identical relative basename: %s",
    async (query) => {
      const source = await ask(query, true);
      expect(source).toContain(`File: ${PATH}`);
      expect(source).toContain(LIVE_FACT);
      expect(source).not.toContain(OLD_FACT);
    },
  );

  it.each(["Explain invoice reconciliation", "Erkläre invoice reconciliation"])(
    "keeps an independent topic independent after compaction and reconnect: %s",
    async (query) => {
      const source = await ask(query, true);
      expect(source).toContain("File: src/invoice.ts");
      expect(source).toContain(INVOICE_FACT);
      expect(source).not.toContain(OLD_FACT);
    },
  );
});
