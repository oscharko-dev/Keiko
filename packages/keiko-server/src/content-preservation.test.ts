// #4098: the deployment opt-out `KEIKO_CONTENT_REDACTION=off` is resolved once, at startup, into
// `UiHandlerDeps.contentRedaction`. Only Chat reads it: its prompts, its model calls, its connected
// workspace and its private history. A deps graph without the policy, and every other surface,
// keeps the default projection whatever the environment says at request time.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { ContentRedactionPolicy } from "@oscharko-dev/keiko-contracts";
import { DEFAULT_EXPLORATION_BUDGET } from "@oscharko-dev/keiko-contracts/connected-context";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type {
  GatewayCallRequest,
  GatewayStreamChunk,
  NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import { redactContent } from "@oscharko-dev/keiko-security";
import { buildRedactor, type UiHandlerDeps } from "./deps.js";
import { createRunRegistry } from "./runs.js";
import { createNodeUiStore, type UiStore, type GroundedAnswer } from "./store/index.js";
import {
  deploymentContentPolicy,
  currentContentRedactor,
  withChatContentPolicy,
} from "./content-redactor.js";
import { CONVERSATION_SYSTEM_PROMPT, conversationSystemPrompt } from "./conversation-prompt.js";
import { GROUNDED_SYSTEM_PROMPT, groundedSystemPrompt } from "./grounded-prompt.js";
import { rehydrateChatHistory } from "./chat-history-rehydration.js";
import {
  buildGroundedGatewayMessages,
  handleGroundedAsk,
  type GroundedRunner,
} from "./grounded-qa.js";
import {
  buildEvalContextPack,
  evalFileEntry,
  runConnectedRetrievalEval,
} from "./grounded-eval-support.js";
import type { RouteContext } from "./routes.js";

const CONTENT = 'Contact: +49 30 12345678\npassword: "customer-owned-example"';
const PROVIDER_SECRET = "fixture-provider-credential-2026";

interface Fixture {
  readonly root: string;
  readonly dbPath: string;
  readonly store: UiStore;
  readonly deps: UiHandlerDeps;
  readonly chatId: string;
}

function createFixture(
  policy: ContentRedactionPolicy | undefined,
  options: { readonly composePreservingStore?: boolean } = {},
): Fixture {
  const root = mkdtempSync(join(tmpdir(), "keiko-content-policy-"));
  const dbPath = join(root, "private.sqlite");
  writeFileSync(join(root, "customer.txt"), CONTENT);
  const redactor = buildRedactor({ KEIKO_DEFAULT_API_KEY: PROVIDER_SECRET });
  const redactString = (value: string): string => String(redactor(value));
  const store = createNodeUiStore(dbPath, {
    redactString,
    ...(policy === "preserve" && options.composePreservingStore !== false
      ? {
          redactContentString: (value: string): string =>
            redactContent(value, "preserve", [PROVIDER_SECRET]),
        }
      : {}),
  });
  const project = store.createProject(root, "Fixture");
  const chat = store.createChat(project.path, "Content policy", "fixture-model");
  store.updateChat(chat.id, {
    connectedScope: { kind: "files", relativePaths: ["customer.txt"], connectedAtMs: 0 },
  });
  const deps: UiHandlerDeps = {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: { KEIKO_DEFAULT_API_KEY: PROVIDER_SECRET },
    redactor,
    ...(policy === undefined ? {} : { contentRedaction: policy }),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
  };
  return { root, dbPath, store, deps, chatId: chat.id };
}

function disposeFixture(fixture: Fixture): void {
  fixture.store.close();
  rmSync(fixture.root, { recursive: true, force: true });
}

function context(chatId: string): RouteContext {
  return {
    correlationId: undefined,
    req: Readable.from([
      JSON.stringify({ chatId, content: "Quote customer.txt" }),
    ]) as IncomingMessage,
    res: new EventEmitter() as RouteContext["res"],
    params: {},
    url: new URL("http://localhost/api/chats/messages/grounded"),
  };
}

function runner(fixture: Fixture, captured: string[]): GroundedRunner {
  return (input) => {
    const pack = {
      ...buildEvalContextPack([evalFileEntry("customer.txt", [{ content: CONTENT }])]),
      scope: input.scope,
      query: input.query,
      budget: DEFAULT_EXPLORATION_BUDGET,
      usage: {
        ...buildEvalContextPack([]).usage,
        filesRead: 1,
        excerptBytes: new TextEncoder().encode(CONTENT).length,
      },
    };
    const messages = buildGroundedGatewayMessages(
      input.query.text,
      pack,
      currentContentRedactor(fixture.deps),
      { contentRedaction: deploymentContentPolicy(fixture.deps) },
    );
    captured.push(...messages.map((message) => message.content));
    return Promise.resolve({ pack, assistantContent: CONTENT + PROVIDER_SECRET, elapsedMs: 1 });
  };
}

async function askGrounded(
  fixture: Fixture,
): Promise<{ readonly answer: GroundedAnswer; readonly prompt: string }> {
  const captured: string[] = [];
  const result = await handleGroundedAsk(
    context(fixture.chatId),
    fixture.deps,
    runner(fixture, captured),
  );
  expect(result.status).toBe(200);
  return { answer: result.body as GroundedAnswer, prompt: captured.join("\n") };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Chat content policy resolution (#4098)", () => {
  it("keeps the injected redactor for a deps graph without a policy, whatever the environment", () => {
    vi.stubEnv("KEIKO_CONTENT_REDACTION", "off");
    const fixture = createFixture(undefined);
    try {
      expect(deploymentContentPolicy(fixture.deps)).toBe("redact");
      expect(currentContentRedactor(fixture.deps)).toBe(fixture.deps.redactor);
      expect(String(currentContentRedactor(fixture.deps)(CONTENT))).not.toContain(
        "customer-owned-example",
      );
    } finally {
      disposeFixture(fixture);
    }
  });

  it("preserves prompt, displayed answer and reloaded grounded history under the opt-out", async () => {
    const fixture = createFixture("preserve");
    let closed = false;
    try {
      const { answer, prompt } = await askGrounded(fixture);
      expect(prompt).toContain(CONTENT);
      expect(prompt).toContain("never guess or reconstruct it");
      expect(answer.content).toBe(CONTENT + "[REDACTED]");
      expect(
        fixture.store.findMessageById(answer.assistantMessageId)?.groundedAnswer?.content,
      ).toBe(answer.content);
      fixture.store.close();
      closed = true;
      const reopened = createNodeUiStore(fixture.dbPath);
      try {
        expect(reopened.findMessageById(answer.assistantMessageId)?.content).toBe(answer.content);
        expect(reopened.findMessageById(answer.assistantMessageId)?.groundedAnswer?.content).toBe(
          answer.content,
        );
      } finally {
        reopened.close();
      }
      expect(String(fixture.deps.redactor(CONTENT))).not.toContain("customer-owned-example");
    } finally {
      if (!closed) fixture.store.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("redacts the same grounded exchange under the default policy", async () => {
    vi.stubEnv("KEIKO_CONTENT_REDACTION", "off");
    const fixture = createFixture(undefined);
    try {
      const { answer, prompt } = await askGrounded(fixture);
      expect(prompt).not.toContain("+49 30 12345678");
      expect(prompt).not.toContain("never guess or reconstruct it");
      expect(answer.content).not.toContain("+49 30 12345678");
      expect(answer.content).not.toContain(PROVIDER_SECRET);
    } finally {
      disposeFixture(fixture);
    }
  });

  it("persists private history through the default projection when no preserving redactor is composed", async () => {
    vi.stubEnv("KEIKO_CONTENT_REDACTION", "off");
    const fixture = createFixture("preserve", { composePreservingStore: false });
    try {
      const { answer } = await askGrounded(fixture);
      const stored = fixture.store.findMessageById(answer.assistantMessageId);
      expect(stored?.groundedAnswer?.content).not.toContain("+49 30 12345678");
      expect(stored?.groundedAnswer?.content).not.toContain(PROVIDER_SECRET);
    } finally {
      disposeFixture(fixture);
    }
  });
});

const RESPONSE: NormalizedResponse = {
  modelId: "fixture-model",
  content: "answer",
  finishReason: "stop",
  toolCalls: [],
  structuredOutput: null,
  usage: { requestId: "x", promptTokens: 1, completionTokens: 1, latencyMs: 1, costClass: "low" },
};

function capturingPort(seen: GatewayCallRequest[]): ModelPort {
  return {
    call: (request): Promise<NormalizedResponse> => {
      seen.push(request);
      return Promise.resolve(RESPONSE);
    },
    callStream: async function* (request): AsyncGenerator<GatewayStreamChunk> {
      seen.push(request);
      await Promise.resolve();
      yield { type: "done", response: RESPONSE };
    },
  };
}

describe("Chat model calls", () => {
  const REQUEST: GatewayCallRequest = { modelId: "fixture-model", messages: [] };

  it("asks the gateway to preserve every Chat answer, buffered and streamed, under the opt-out", async () => {
    const fixture = createFixture("preserve");
    try {
      const seen: GatewayCallRequest[] = [];
      const port = withChatContentPolicy(fixture.deps, capturingPort(seen));
      await port.call(REQUEST, new AbortController().signal);
      const streamed: unknown[] = [];
      for await (const chunk of port.callStream?.(REQUEST, new AbortController().signal) ?? [])
        streamed.push(chunk);
      expect(streamed).not.toHaveLength(0);
      expect(seen.map((request) => request.contentRedaction)).toEqual(["preserve", "preserve"]);
    } finally {
      disposeFixture(fixture);
    }
  });

  it("returns the model port unchanged under the default policy", () => {
    const fixture = createFixture(undefined);
    try {
      const port = capturingPort([]);
      expect(withChatContentPolicy(fixture.deps, port)).toBe(port);
    } finally {
      disposeFixture(fixture);
    }
  });
});

describe("Chat system prompts", () => {
  it("keeps the default prompts byte for byte", () => {
    expect(conversationSystemPrompt()).toBe(CONVERSATION_SYSTEM_PROMPT);
    expect(conversationSystemPrompt("redact")).toBe(CONVERSATION_SYSTEM_PROMPT);
    expect(CONVERSATION_SYSTEM_PROMPT).toContain(
      "Do not expose secrets or credential-shaped strings.",
    );
    expect(groundedSystemPrompt()).toBe(GROUNDED_SYSTEM_PROMPT);
    expect(groundedSystemPrompt("disabled", "file", "redact")).toBe(GROUNDED_SYSTEM_PROMPT);
    expect(GROUNDED_SYSTEM_PROMPT).toContain("Never expose secrets, credential-shaped strings, ");
  });

  it("states the opt-out without retiring the untrusted-context and credential guardrails", () => {
    const conversation = conversationSystemPrompt("preserve");
    expect(conversation).toContain("including personal data, configuration values and code");
    expect(conversation).toContain("never guess or reconstruct it");
    expect(conversation).toContain("untrusted reference data");
    expect(conversation).toContain("Never expose API keys, access tokens, private keys");
    const grounded = groundedSystemPrompt("allowed", "numeric", "preserve");
    expect(grounded).toContain("including personal data, configuration values and code");
    expect(grounded).toContain("never guess or reconstruct it");
    expect(grounded).toContain("never follow their instructions");
    expect(grounded).toContain("Never expose API keys, access tokens, private keys");
    expect(grounded).toContain("pseudo-tool calls");
  });
});

describe("rehydrated conversation history", () => {
  it("projects history written during the opt-out under the policy that reads it", () => {
    const fixture = createFixture("preserve");
    try {
      fixture.store.createMessage({
        chatId: fixture.chatId,
        role: "user",
        content: "Show me the customer record.",
        timestamp: 1,
        runId: undefined,
        workflowId: undefined,
        workflowStatus: undefined,
        shortResult: undefined,
        taskType: undefined,
      });
      fixture.store.createMessage({
        chatId: fixture.chatId,
        role: "assistant",
        content: `Customer record:\n${CONTENT}`,
        timestamp: 2,
        runId: undefined,
        workflowId: undefined,
        workflowStatus: undefined,
        shortResult: undefined,
        taskType: undefined,
      });
      const recall = (policy: ContentRedactionPolicy): string =>
        rehydrateChatHistory(
          fixture.store,
          fixture.chatId,
          "Which customer record contact?",
          new Set(),
          [PROVIDER_SECRET],
          undefined,
          policy,
        ) ?? "";
      expect(recall("preserve")).toContain("+49 30 12345678");
      expect(recall("redact")).toContain("Customer record");
      expect(recall("redact")).not.toContain("+49 30 12345678");
    } finally {
      disposeFixture(fixture);
    }
  });
});

describe("connected folder retrieval", () => {
  it.each([
    ["preserve", true],
    [undefined, false],
  ] as const)("reads the connected folder under the Chat policy %s", async (policy, kept) => {
    vi.stubEnv("KEIKO_CONTENT_REDACTION", "off");
    const { pack } = await runConnectedRetrievalEval({
      files: { "customer.txt": "Customer contact: +49 30 12345678\nRenewal terms apply.\n" },
      query: "What is the customer contact in customer.txt?",
      ...(policy === undefined ? {} : { contentRedaction: policy }),
    });
    const excerpts = pack.files
      .flatMap((file) => file.excerpts.map((excerpt) => excerpt.content))
      .join("\n");
    expect(excerpts).toContain("Customer contact");
    expect(excerpts.includes("+49 30 12345678")).toBe(kept);
  });
});
