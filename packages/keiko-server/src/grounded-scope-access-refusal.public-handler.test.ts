import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GroundedAnswer } from "@oscharko-dev/keiko-contracts/bff-wire";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import {
  createDefaultChatCapability,
  parseGatewayConfig,
  type GatewayCallRequest,
} from "@oscharko-dev/keiko-model-gateway";
import { buildRedactor, type UiHandlerDeps } from "./deps.js";
import { createInMemoryUiStore } from "./store/index.js";
import { createRunRegistry } from "./runs.js";
import { handleGroundedAsk } from "./grounded-qa.js";
import { mockRequest, mockResponse } from "./_support.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";

const MODEL = "scope-access-refusal-fixture";
const cleanups: (() => void)[] = [];
afterEach(() => {
  resetServerLogger();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function scriptedAnswer(calls: GatewayCallRequest[], content: string): ModelPort {
  return {
    call: (request): ReturnType<ModelPort["call"]> => {
      calls.push(request);
      return Promise.resolve({
        modelId: MODEL,
        content,
        toolCalls: [],
        structuredOutput: null,
        finishReason: "stop",
        usage: {
          requestId: "scope-access-refusal",
          promptTokens: 100,
          completionTokens: 20,
          latencyMs: 1,
          costClass: "medium",
        },
      });
    },
  };
}

function fixture(
  content: string,
  path = "src/Feature.ts",
): {
  readonly deps: UiHandlerDeps;
  readonly chatId: string;
  readonly calls: GatewayCallRequest[];
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-access-refusal-")));
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(
    join(root, path),
    path === "src/Feature.ts"
      ? "export function Feature() { return true; }\n"
      : "// Fixture\n".repeat(179) + "export function Feature() { return true; }\n// End\n// End\n",
  );
  const store = createInMemoryUiStore();
  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  store.createProject(root, "Scope access refusal");
  const chat = store.createChat(root, "Scope access refusal", MODEL);
  store.updateChat(chat.id, {
    connectedScopes: [
      { kind: "directory", root, relativePaths: [path.split("/")[0] ?? "src"], connectedAtMs: 1 },
    ],
  });
  const calls: GatewayCallRequest[] = [];
  const config = parseGatewayConfig({
    providers: [
      { modelId: MODEL, baseUrl: "https://refusal.example.invalid/v1", apiKey: "fixture" },
    ],
    capabilities: [
      { ...createDefaultChatCapability(MODEL), contextWindow: 32768, maxOutputTokens: 1024 },
    ],
  });
  return {
    chatId: chat.id,
    calls,
    deps: {
      config,
      configPresent: true,
      env: {},
      store,
      redactor: buildRedactor({}, config),
      registry: createRunRegistry(),
      evidenceStore: createInMemoryEvidenceStore(),
      modelPortFactory: () => scriptedAnswer(calls, content),
    },
  };
}

async function ask(
  content: string,
  german: boolean,
  path = "src/Feature.ts",
): Promise<{
  readonly answer: Extract<GroundedAnswer, { groundingKind: "connected-context" }>;
  readonly calls: readonly GatewayCallRequest[];
}> {
  const setup = fixture(content, path);
  const result = await handleGroundedAsk(
    {
      params: {},
      correlationId: "scope-access-refusal-public",
      url: new URL("http://localhost/api/chats/messages/grounded"),
      req: mockRequest({
        body: JSON.stringify({
          chatId: setup.chatId,
          content: german ? `Erkläre ${path}` : `Explain ${path}`,
        }),
      }),
      res: mockResponse().res,
    },
    setup.deps,
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const answer = result.body as GroundedAnswer;
  if (answer.groundingKind !== "connected-context")
    throw new TypeError("Expected connected answer");
  return { answer, calls: setup.calls };
}

const CASES = [
  {
    content: "I cannot inspect the previously referenced file within this selected scope.",
    kind: "refusal",
    calls: 1,
    german: false,
  },
  {
    content: "Ich kann die zuvor referenzierte Datei in diesem ausgewählten Scope nicht einsehen.",
    kind: "refusal",
    calls: 1,
    german: true,
  },
  {
    content: "No evidence found in the connected scope.",
    kind: "refusal",
    calls: 1,
    german: false,
  },
  { content: "Keine Belege gefunden.", kind: "refusal", calls: 1, german: true },
  { content: "Please paste Feature.ts", kind: "clarification", calls: 1, german: false },
  { content: "Bitte zeige Feature.ts", kind: "clarification", calls: 1, german: true },
  {
    content:
      "I cannot inspect the previously referenced file within this selected scope. Feature returns true.",
    kind: "answer",
    calls: 2,
    german: false,
  },
  {
    content:
      "Ich kann die zuvor referenzierte Datei in diesem ausgewählten Scope nicht einsehen. Feature gibt true zurück.",
    kind: "answer",
    calls: 2,
    german: true,
  },
  {
    content: "The product cannot inspect files in the selected scope.",
    kind: "answer",
    calls: 2,
    german: false,
  },
  {
    content: "Das Produkt kann Dateien im ausgewählten Scope nicht einsehen.",
    kind: "answer",
    calls: 2,
    german: true,
  },
  {
    content: "Feature returns true [source:1|src/Feature.ts:1].",
    kind: "answer",
    calls: 1,
    german: false,
    cited: true,
  },
  {
    content: "Feature gibt true zurück [source:1|src/Feature.ts:1].",
    kind: "answer",
    calls: 1,
    german: true,
    cited: true,
  },
] as const;

describe("public selected-scope access refusals", () => {
  it.each(CASES)("preserves claim-sensitive citation admission: $content", async (test) => {
    const turn = await ask(test.content, test.german);
    expect(turn.answer.answerKind).toBe(test.kind);
    expect(turn.calls).toHaveLength(test.calls);
    const cited = "cited" in test;
    expect(turn.answer.citations.length > 0).toBe(cited);
    expect(turn.answer.uncertainty.some((marker) => marker.kind === "uncited-answer")).toBe(
      test.kind === "answer" && !cited,
    );
    if (test.calls === 1)
      expect(turn.calls[0]?.messages.map((message) => message.content).join("\n")).not.toContain(
        "Insert citation markers",
      );
  });
});

describe("public literal bracket citations", () => {
  it.each([false, true])(
    "accepts the actual dynamic page marker without repair (German: %s)",
    async (german) => {
      const path = "app/users/[id]/page.tsx";
      const content = `${german ? "Feature gibt true zurück" : "Feature returns true"} [${path}:180-182].`;
      const turn = await ask(content, german, path);
      expect(turn.calls).toHaveLength(1);
      expect(turn.answer.citations).toMatchObject([
        { scopePath: path, lineRange: { startLine: 180, endLine: 182 } },
      ]);
      expect(turn.answer.uncertainty.map((marker) => marker.kind)).not.toContain("uncited-answer");
      expect(turn.answer.uncertainty.map((marker) => marker.kind)).not.toContain(
        "unsupported-citation",
      );
    },
  );
});
