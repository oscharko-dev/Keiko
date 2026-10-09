import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectedContextGroundedAnswer } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import {
  createDefaultChatCapability,
  parseGatewayConfig,
  type GatewayCallRequest,
} from "@oscharko-dev/keiko-model-gateway";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import { mockRequest, mockResponse } from "./_support.js";
import { buildRedactor, type UiHandlerDeps } from "./deps.js";
import { handleGroundedAsk } from "./grounded-qa.js";
import { createRunRegistry } from "./runs.js";
import { createInMemoryUiStore } from "./store/index.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { readPersistedActivityLog } from "../../../tests/support/activity-log-proof.js";

const MODEL = "manifest-behavior-proof";
const TARGET = "src/policy/validation.ts";
const FACT = "export const maxPermissions = 37;";
const QUESTION =
  "How are package manifests validated before loading, and what is the maximum number of permissions?";
let directory = "";
const stores: UiHandlerDeps["store"][] = [];

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "keiko-manifest-behavior-")));
  vi.stubEnv("KEIKO_STATE_DIR", join(directory, "state"));
  resetServerLogger();
});
afterEach(() => {
  resetServerLogger();
  vi.unstubAllEnvs();
  for (const store of stores.splice(0)) store.close();
  rmSync(directory, { recursive: true, force: true });
});

function populate(root: string): void {
  mkdirSync(join(root, "src/policy"), { recursive: true });
  writeFileSync(
    join(root, TARGET),
    [
      "// Package manifests and configuration envelopes are validated before loading.",
      "// The maximum number of permissions is governed by this limit.",
      FACT,
      "export function validatePermissions(count: number): boolean { return count <= maxPermissions; }",
    ].join("\n"),
  );
  writeFileSync(join(root, "package.json"), '{"name":"manifest-behavior-fixture"}\n');
  for (let index = 0; index < 65; index += 1)
    writeFileSync(
      join(root, `navigation-${String(index)}.txt`),
      "Ordinary unrelated release navigation and reference information.\n".repeat(40),
    );
}

function promptText(request: GatewayCallRequest): string {
  return request.messages.map((message) => message.content).join("\n");
}

function firstPrompt(requests: readonly GatewayCallRequest[]): string {
  const request = requests[0];
  if (request === undefined) throw new TypeError("Missing actual synthesis dispatch");
  return promptText(request);
}

function scriptedModel(requests: GatewayCallRequest[]): ModelPort {
  return {
    call(request): ReturnType<ModelPort["call"]> {
      requests.push(request);
      const prompt = promptText(request);
      return Promise.resolve({
        modelId: MODEL,
        content: prompt.includes(FACT)
          ? `The maximum number of permissions is 37. [${TARGET}:3]`
          : prompt.includes("Which package manifests define this workspace?")
            ? "The package manifest defines this workspace. [package.json:1]"
            : `Missing evidence: [${TARGET}]`,
        toolCalls: [],
        structuredOutput: null,
        finishReason: "stop",
        usage: {
          requestId: "manifest-behavior-proof",
          promptTokens: 1,
          completionTokens: 1,
          latencyMs: 1,
          costClass: "medium",
        },
      });
    },
  };
}

function runtime(requests: GatewayCallRequest[]): { deps: UiHandlerDeps; chatId: string } {
  const root = join(directory, "workspace");
  populate(root);
  const config = parseGatewayConfig({
    providers: [
      { modelId: MODEL, baseUrl: "https://manifest.example.invalid/v1", apiKey: "fixture" },
    ],
    capabilities: [
      { ...createDefaultChatCapability(MODEL), contextWindow: 32768, maxOutputTokens: 2048 },
    ],
    groundedAnswers: { ownAssessment: "disabled" },
  });
  const store = createInMemoryUiStore();
  stores.push(store);
  store.createProject(root, "Manifest behavior");
  const chat = store.createChat(root, "Manifest behavior", MODEL);
  store.updateChat(chat.id, {
    connectedScope: { kind: "workspace-root", relativePaths: [], connectedAtMs: 1 },
  });
  return {
    chatId: chat.id,
    deps: {
      config,
      configPresent: true,
      env: {},
      redactor: buildRedactor({}, config),
      registry: createRunRegistry(),
      evidenceStore: createInMemoryEvidenceStore(),
      modelPortFactory: () => scriptedModel(requests),
      store,
    },
  };
}

async function ask(question: string): Promise<{
  readonly answer: ConnectedContextGroundedAnswer;
  readonly requests: readonly GatewayCallRequest[];
  readonly completed: Readonly<Record<string, unknown>> | undefined;
  readonly source: Readonly<Record<string, unknown>> | undefined;
}> {
  const requests: GatewayCallRequest[] = [];
  const { deps, chatId } = runtime(requests);
  const response = await handleGroundedAsk(
    {
      req: mockRequest({ body: JSON.stringify({ chatId, content: question }) }),
      res: mockResponse().res,
      params: {},
      url: new URL("http://localhost/api/chats/messages/grounded"),
      correlationId: "manifest-behavior-public",
    },
    deps,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const raw = readPersistedActivityLog(join(directory, "state"));
  expect(raw).not.toContain(QUESTION);
  const records = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return {
    answer: response.body as ConnectedContextGroundedAnswer,
    requests,
    completed: records.find((record) => record.op === "search.connected-context.completed"),
    source: records.find((record) => record.op === "search.connected-context.source-details"),
  };
}

describe("manifest behavior retains source search through the default public handler", () => {
  it.each([
    QUESTION,
    QUESTION.replace("package manifests", "configuration envelopes"),
    `${QUESTION} Read ${TARGET}.`,
  ])("sends the validation implementation for %s", async (question) => {
    const { answer, requests, completed, source } = await ask(question);
    expect(firstPrompt(requests)).toContain(FACT);
    expect(answer.content).toContain("37");
    expect(
      answer.citations.some(
        (citation) => citation.scopePath === TARGET && citation.lineRange?.startLine === 3,
      ),
    ).toBe(true);
    expect(completed?.retrievalIntent).toBe("targeted-code-search");
    expect(source?.metadataInjectionReason).toBe("none");
  });

  it("preserves the canonical workspace manifest inventory request", async () => {
    const { answer, requests, completed, source } = await ask(
      "Which package manifests define this workspace?",
    );
    expect(requests).toHaveLength(1);
    expect(firstPrompt(requests)).toContain("File: package.json");
    expect(answer.citations.some((citation) => citation.scopePath === "package.json")).toBe(true);
    expect(completed?.retrievalIntent).toBe("project-metadata");
    expect(source?.metadataInjectionReason).toBe("intent");
  });
});
