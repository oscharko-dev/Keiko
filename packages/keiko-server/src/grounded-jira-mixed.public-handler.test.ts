import {
  openKnowledgeStore,
  resolveKnowledgeStorePath,
  updateCapsuleState,
} from "@oscharko-dev/keiko-local-knowledge";
import { seedCapsuleWithVectors } from "@oscharko-dev/keiko-local-knowledge/testing";
import { handleSendDesktopChat } from "./chat-handlers.js";
import { handleSendDesktopChatStream } from "./chat-stream-handlers.js";
import { handleDecideChatWriteApproval } from "./atlassian/chatWriteApprovalRoutes.js";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultChatCapability,
  parseGatewayConfig,
  toolCallingConfigurationFingerprint,
} from "@oscharko-dev/keiko-model-gateway";
import type {
  AtlassianHttpBodyPort,
  AtlassianCredentialMetadata,
} from "@oscharko-dev/keiko-connectors";
import type { GroundedAnswer } from "@oscharko-dev/keiko-contracts/bff-wire";
import { buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
import { handleGroundedAsk } from "./grounded-qa.js";
import { mockRequest, mockResponse } from "./_support.js";
import type { RouteContext } from "./routes.js";
import { jiraChatActorDigest } from "./atlassian/jiraPodAccess.js";
import { handleDecideChatReadConsent } from "./atlassian/chatReadConsentRoutes.js";
import {
  QUALIFICATION_SPEND_BUDGET_USD_ENV,
  QUALIFICATION_SPEND_LEDGER_PATH_ENV,
} from "./gateway-spend-budget.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";

const MODEL = "mixed-chat-proof";
const POD = "d5f5681e-ce98-4c3c-b27e-51d707c9d018";
const CITED =
  "Feature returns true [src/Feature.ts:1].\n\nJira tool result: project SYN is visible.";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  resetServerLogger();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function context(body: Record<string, unknown>, approvalId?: string): RouteContext {
  return {
    req: mockRequest({ body: JSON.stringify(body) }),
    res: mockResponse().res,
    url: new URL("http://127.0.0.1/api/chats/messages/grounded"),
    params: approvalId === undefined ? {} : { approvalId },
    correlationId: "mixed-chat-proof",
  };
}
function metadata(deps: UiHandlerDeps): AtlassianCredentialMetadata {
  const ownerDigest = jiraChatActorDigest(deps);
  if (ownerDigest === undefined) throw new Error("Missing operator");
  return {
    schemaVersion: "1",
    authRef: "synthetic-credential",
    displayName: "Synthetic Jira",
    baseUrl: "https://jira.example.invalid",
    createdAt: 1,
    generation: 1,
    provider: "jira",
    deployment: "data-center",
    authScheme: "bearer-pat",
    livePod: {
      podId: POD,
      ownerDigest,
      creationRequestId: "d5f5681e-ce98-4c3c-b27e-51d707c9d019",
      verificationRevision: 1,
      verificationInProgress: false,
      verificationStatus: "ok",
    },
  };
}
function runtime(mutation = false): {
  deps: UiHandlerDeps;
  chatId: string;
  root: string;
  jiraRequests: string[];
} {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "keiko-mixed-chat-"));
  const state = mkdtempSync(join(realpathSync(tmpdir()), "keiko-mixed-state-"));
  vi.stubEnv("KEIKO_STATE_DIR", state);
  resetServerLogger();
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "Feature.ts"), "export function Feature() { return true; }\n");
  const deps = buildUiHandlerDeps({
    configPath: join(state, "gateway.json"),
    evidenceDir: join(state, "evidence"),
    uiDbPath: join(state, "ui.db"),
    env: {
      [QUALIFICATION_SPEND_BUDGET_USD_ENV]: "100",
      [QUALIFICATION_SPEND_LEDGER_PATH_ENV]: join(state, "spend.db"),
    },
  });
  cleanup.push(async () => {
    await deps.dispose?.();
    resetServerLogger();
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });
  configure(deps);
  deps.store.createProject(root);
  const chat = deps.store.createChat(root, "Mixed Chat", MODEL);
  deps.store.updateChat(
    chat.id,
    {
      connectedScope: { kind: "workspace-root", relativePaths: [], connectedAtMs: 0 },
      jiraPodId: POD,
    },
    { verifiedJiraPod: { podId: POD, authenticationGeneration: 1 } },
  );
  const credentials = deps.atlassianConnectorCredentials;
  const approvals = deps.atlassianActionApprovalRegistry;
  if (credentials === undefined || approvals === undefined) throw new Error("Missing owners");
  vi.spyOn(credentials.custody, "list").mockReturnValue([metadata(deps)]);
  const jiraRequests: string[] = [];
  vi.spyOn(credentials, "httpBodyPortFactory").mockImplementation(
    (_metadata, _correlation, lifecycle) =>
      (request): ReturnType<AtlassianHttpBodyPort> => {
        expect(lifecycle?.beforeDispatch?.(request)).toBe(true);
        jiraRequests.push(request.method);
        const status = request.method === "GET" ? 200 : 201;
        lifecycle?.onResponse?.(request, status);
        const bodyText = JSON.stringify(
          mutation
            ? { id: "10001", body: "Synthetic approved comment" }
            : [{ id: "10000", key: "SYN", name: "Synthetic Project" }],
        );
        return Promise.resolve({
          kind: "response",
          status,
          bodyText,
          bodyBytes: Buffer.byteLength(bodyText),
          truncated: false,
        });
      },
  );
  vi.spyOn(approvals, "waitForChatReadGrant").mockImplementation(async (id) => {
    const result = await handleDecideChatReadConsent(
      context({ decision: "approve", disclosureVersion: "jira-chat-read-v1" }, id),
      deps,
    );
    expect(result.status).toBe(200);
  });
  vi.spyOn(approvals, "waitForChatWriteApproval").mockImplementation(async (id) => {
    const entry = approvals.getChatWriteApproval(id);
    if (entry === undefined) throw new Error("Missing write approval");
    const result = await handleDecideChatWriteApproval(
      context({ decision: "approve", actionDigest: entry.approval.actionDigest }, id),
      deps,
    );
    expect(result.status).toBe(200);
  });
  return { deps, chatId: chat.id, root, jiraRequests };
}
function configure(deps: UiHandlerDeps): void {
  const provider = {
    modelId: MODEL,
    baseUrl: "https://mixed.example.invalid/v1",
    apiKey: "fixture",
    timeoutMs: 5000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
  };
  const config = deps.gatewayConfig;
  if (config === undefined) throw new Error("Missing gateway");
  config.set(
    parseGatewayConfig({
      providers: [provider],
      capabilities: [
        {
          ...createDefaultChatCapability(MODEL),
          contextWindow: 32768,
          maxOutputTokens: 1024,
          pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 },
          toolCalling: true,
          toolCallingVerification: {
            status: "verified",
            checkedAt: new Date().toISOString(),
            probe: "gateway-tool-calling-v1",
            configurationFingerprint: toolCallingConfigurationFingerprint(provider),
          },
        },
      ],
    }),
    true,
  );
  config.recordVerifiedCapability(
    MODEL,
    { conversationReady: true },
    new Date().toISOString(),
    config.generation(),
  );
}
function outputCap(body: string): number {
  const request = JSON.parse(body) as {
    readonly max_tokens?: number;
    readonly max_completion_tokens?: number;
  };
  return request.max_tokens ?? request.max_completion_tokens ?? 0;
}
function providerBody(init: RequestInit | undefined): string {
  return typeof init?.body === "string" ? init.body : "";
}
function isToolStep(body: string, step: ProviderStep): boolean {
  return body.includes('"tools":') && (step === "tool" || step === "write");
}
function responseContent(body: string, step: ProviderStep, steps: readonly ProviderStep[]): string {
  return body.includes("Citations:")
    ? "Feature returns true [1]. Jira tool result: project SYN is visible."
    : finalContent(step, steps);
}
function finalContent(step: ProviderStep, steps: readonly ProviderStep[]): string {
  if (step === "uncited") return "Feature returns true.";
  return steps.includes("uncited") ? "Feature returns true [src/Feature.ts:1]." : CITED;
}
type ProviderStep = "tool" | "write" | "answer" | "uncited" | "overflow";
function provider(steps: readonly ProviderStep[] = ["tool", "answer"]): string[] {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((_url, init) => {
      const body = providerBody(init);
      const productive = body.includes("File: src/Feature.ts") || body.includes("Citations:");
      const step = productive ? (steps[requests.length] ?? "answer") : "answer";
      if (productive) requests.push(body);
      if (step === "overflow")
        return Promise.resolve(
          Response.json(
            {
              error: {
                message: "max_tokens=1000000000 cannot be greater than max_model_len=8192.",
                code: "400",
              },
            },
            { status: 400 },
          ),
        );
      const tools = isToolStep(body, step);
      return Promise.resolve(
        Response.json({
          id: "mixed-response",
          model: MODEL,
          choices: [
            {
              index: 0,
              message: tools
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: `mixed-call-${String(requests.length)}`,
                        type: "function",
                        function: {
                          name: step === "write" ? "jira_comment" : "jira_projects",
                          arguments:
                            step === "write"
                              ? JSON.stringify({
                                  issueKey: "KEIKO-1",
                                  body: "Synthetic approved comment",
                                })
                              : "{}",
                        },
                      },
                    ],
                  }
                : {
                    role: "assistant",
                    content: responseContent(body, step, steps),
                  },
              finish_reason: tools ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    }),
  );
  return requests;
}

describe("mixed Jira and Data scope through the production gateway", () => {
  it("retrieves the existing evidence pack before Jira orchestration and preserves separate citations", async () => {
    const f = runtime();
    const requests = provider();
    const response = await handleGroundedAsk(
      context({
        chatId: f.chatId,
        content: "Explain src/Feature.ts and list the Jira projects.",
        modelId: MODEL,
      }),
      f.deps,
    );
    expect(response.status).toBe(200);
    expect(f.jiraRequests).toEqual(["GET"]);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.includes("File: src/Feature.ts"))).toBe(true);
    expect(requests[0]).toContain('"tools":');
    expect(requests[1]).toContain('"role":"tool"');
    expect((response.body as GroundedAnswer).content).toContain("Jira tool result");
    expect(JSON.stringify((response.body as GroundedAnswer).citations)).not.toContain("jira");
    expect(
      f.deps.store.listMessages(f.chatId).find((message) => message.role === "user")?.toolTranscript
        ?.exchanges,
    ).toHaveLength(1);
  });
});

it("keeps tool orchestration outside the one answer plus one repair synthesis ceiling", async () => {
  const f = runtime();
  const requests = provider(["tool", "tool", "uncited", "answer"]);
  const response = await handleGroundedAsk(
    context({
      chatId: f.chatId,
      content: "Explain src/Feature.ts and list Jira projects.",
      modelId: MODEL,
    }),
    f.deps,
  );
  expect(response.status).toBe(200);
  expect(requests).toHaveLength(4);
  const caps = requests.map(outputCap);
  expect(caps.every((cap) => cap > 0)).toBe(true);
  expect(caps.slice(1).every((cap, index) => cap < (caps[index] ?? 0))).toBe(true);
  expect(f.jiraRequests).toEqual(["GET", "GET"]);
  expect((response.body as GroundedAnswer).content).toContain("[src/Feature.ts:1]");
});

it("charges physical overflow before a tool response and denies a third synthesis attempt", async () => {
  const f = runtime();
  const requests = provider(["overflow", "tool", "uncited", "answer"]);
  const response = await handleGroundedAsk(
    context({
      chatId: f.chatId,
      content: "Explain src/Feature.ts and list Jira projects.",
      modelId: MODEL,
    }),
    f.deps,
  );
  expect(response.status).toBe(200);
  expect(requests).toHaveLength(3);
  expect(f.jiraRequests).toEqual(["GET"]);
  expect((response.body as GroundedAnswer).content).not.toContain("Jira tool result");
});

it("falls back before admission and replays the same mixed canonical turn without a second write", async () => {
  const f = runtime(true);
  const requests = provider(["write", "answer"]);
  const body = {
    chatId: f.chatId,
    projectPath: f.root,
    content: "Explain src/Feature.ts and add the Jira comment.",
    modelId: MODEL,
    clientTurnId: "mixed-once",
  };
  const stream = await handleSendDesktopChatStream(context(body), f.deps);
  expect(stream).toMatchObject({ status: 400, body: { error: { code: "STREAMING_UNSUPPORTED" } } });
  expect(requests).toHaveLength(0);
  expect(f.jiraRequests).toHaveLength(0);
  expect(f.deps.store.listMessages(f.chatId)).toHaveLength(0);
  const response = await handleSendDesktopChat(context(body), f.deps);
  expect(response.status).toBe(200);
  expect(requests).toHaveLength(2);
  expect(f.jiraRequests.filter((method) => method !== "GET")).toEqual(["POST"]);
  const messages = f.deps.store.listMessages(f.chatId);
  expect(messages).toHaveLength(2);
  expect(messages[0]?.toolTranscript?.exchanges[0]?.mutationOutcome).toBe("succeeded");
  expect((await handleSendDesktopChat(context(body), f.deps)).status).toBe(200);
  expect(requests).toHaveLength(2);
  expect(f.jiraRequests.filter((method) => method !== "GET")).toEqual(["POST"]);
  expect(f.deps.store.listMessages(f.chatId)).toHaveLength(2);
});

it("uses the existing local Data-Pod evidence pack with Jira and keeps its numeric citations", async () => {
  const f = runtime();
  const store = openKnowledgeStore({
    dbPath: resolveKnowledgeStorePath({ runtimeStateDir: dirname(f.deps.uiDbPath ?? "") }),
  });
  try {
    const pod = await seedCapsuleWithVectors(store, {
      displayName: "Synthetic Data Pod",
      text: "Feature returns true. Feature is a function.",
    });
    updateCapsuleState(store, pod.capsuleId, "ready");
    f.deps.store.updateChat(f.chatId, {
      connectedScope: null,
      localKnowledgeScopes: [{ kind: "capsule", capsuleId: pod.capsuleId, connectedAtMs: 1 }],
    });
  } finally {
    store.close();
  }
  const requests = provider();
  const result = await handleGroundedAsk(
    context({
      chatId: f.chatId,
      content: "What does Feature return? Also list Jira projects.",
      modelId: MODEL,
    }),
    f.deps,
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(f.jiraRequests).toEqual(["GET"]);
  expect(requests).toHaveLength(2);
  const answer = result.body as GroundedAnswer;
  expect(answer.groundingKind).toBe("local-knowledge");
  expect(answer.content).toContain("Jira tool result");
  expect(answer.citations).toHaveLength(1);
  expect(JSON.stringify(answer.citations)).not.toContain("jira");
});

it("preserves Data-only desktop refusal and tool-free grounded synthesis", async () => {
  const f = runtime();
  f.deps.store.updateChat(f.chatId, { jiraPodId: null });
  const requests = provider(["answer"]);
  const body = {
    chatId: f.chatId,
    projectPath: f.root,
    content: "Explain src/Feature.ts",
    modelId: MODEL,
  };
  expect((await handleSendDesktopChat(context(body), f.deps)).status).toBe(409);
  expect(f.deps.store.listMessages(f.chatId)).toHaveLength(0);
  expect((await handleGroundedAsk(context(body), f.deps)).status).toBe(200);
  expect(requests).toHaveLength(1);
  expect(requests[0]).not.toContain('"tools":');
  expect(f.jiraRequests).toHaveLength(0);
});
