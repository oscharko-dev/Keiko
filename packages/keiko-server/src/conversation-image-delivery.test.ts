import { afterEach, describe, expect, it, vi } from "vitest";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import type { GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import {
  DEFAULT_CONTEXT_PROFILE,
  deriveContextProfile,
} from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { MAX_ATTACHMENT_MIME_BYTES } from "@oscharko-dev/keiko-contracts/runtime/bff-wire";
import { buildRedactor } from "./index.js";
import { createRunRegistry } from "./runs.js";
import { createInMemoryUiStore } from "./store/index.js";
import {
  assemblyWithConversationImages,
  buildGatewayAssembly,
  type GatewayTurnSnapshot,
  conversationImageDeliveries,
  type SendDesktopChatRequest,
} from "./chat-handlers.js";
import { selectGatewayPromptAssembly, type GatewayPromptAssembly } from "./chat-prompt-budget.js";
import { ConversationAttachmentStoreError } from "./conversation-attachment-store.js";
import type { UiHandlerDeps } from "./deps.js";

const IMAGE_ID = "d9428888-122b-4b3e-a23f-123456789abc";
const IMAGE_BYTES = Buffer.from("safe-image", "utf8");

function config(): GatewayConfig {
  return {
    providers: [],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 1_000, halfOpenProbes: 1 },
    capabilities: [
      {
        id: "vision-chat",
        kind: "chat",
        contextWindow: 64_000,
        maxOutputTokens: 4_096,
        toolCalling: false,
        structuredOutput: false,
        streaming: true,
        supportsImageInput: true,
        supportsDocumentInput: false,
        workflowEligible: false,
        costClass: "medium",
        latencyClass: "standard",
        throughputHint: "test",
        preferredUseCases: [],
        knownLimitations: [],
      },
    ],
  };
}

function fixture(revalidate = true): {
  readonly deps: UiHandlerDeps;
  readonly request: SendDesktopChatRequest;
  readonly resolve: ReturnType<typeof vi.fn>;
} {
  const store = createInMemoryUiStore();
  const projectPath = realpathSync(mkdtempSync(join(tmpdir(), "keiko-image-delivery-")));
  store.createProject(projectPath, "Project");
  const chat = store.createChat(projectPath, "Chat", "vision-chat");
  const resolve = vi.fn(() => IMAGE_BYTES);
  const deps: UiHandlerDeps = {
    config: config(),
    configPresent: true,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
    conversationAttachmentStore: {
      put: () => ({ ref: "", expiresAt: 0 }),
      resolve,
      deleteBound: () => undefined,
      deleteForChat: () => undefined,
    },
  };
  return {
    deps,
    resolve,
    request: {
      chatId: chat.id,
      projectPath: chat.projectPath,
      content: "inspect the image",
      modelId: "vision-chat",
      documentContext: [],
      attachments: [
        {
          id: IMAGE_ID,
          kind: "image",
          mimeType: "image/png",
          sizeBytes: IMAGE_BYTES.length,
          attachmentRef: `chat-attachment:${"a".repeat(64)}`,
          sha256: "b".repeat(64),
        },
      ],
      memory: undefined,
      discussionMode: undefined,
      attachmentIntent: "deliver-images-to-selected-model",
      attachmentAuthority: {
        sessionId: "session-1",
        sessionRotationCount: 2,
        revalidate: () => revalidate,
      },
    },
  };
}

function assembly(): GatewayPromptAssembly {
  const built = selectGatewayPromptAssembly({
    historyPrefix: [],
    historyTurnCount: 0,
    request: { content: "inspect the image", discussionMode: undefined },
    profile: DEFAULT_CONTEXT_PROFILE,
    memoryEntries: [],
    documentContext: [],
    redactionSecrets: [],
  });
  if (built === undefined) throw new Error("gateway assembly fixture exceeded its profile");
  return built;
}

function imageConversationHistory(target: ReturnType<typeof fixture>): GatewayTurnSnapshot {
  const { deps, request } = target;
  for (let index = 0; index < 31; index += 1) {
    deps.store.createMessage({
      chatId: request.chatId,
      role: index % 2 === 0 ? "user" : "assistant",
      content: index === 30 ? request.content : "Prior requirement. ".repeat(60),
      timestamp: index,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
  }
  const history = deps.store.listMessages(request.chatId);
  const current = history.at(-1);
  if (current === undefined) throw new Error("Missing fixture turn");
  return { history, currentUserMessageId: current.id };
}

afterEach(resetServerLogger);

describe("conversation image finalization", () => {
  it("reserves image capacity before compacting history without resolving bytes early", () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const target = fixture();
    const profile = deriveContextProfile({
      maxInputTokens: 10_000,
      reservedOutputTokens: 0,
      safetyMarginTokens: 0,
    });
    const deps = { ...target.deps, contextProfile: profile };
    const snapshot = imageConversationHistory(target);
    const built = buildGatewayAssembly(
      deps,
      target.request,
      {
        context: { enabled: false, text: "", memories: [], budget: { tokens: 0, used: 0 } },
        actions: [],
      },
      "vision-chat",
      snapshot,
      "image-selection-before-bytes",
    );
    expect(built.compaction).toBeDefined();
    expect(target.resolve).not.toHaveBeenCalled();
    expect(built.messages.every((message) => message.contentParts === undefined)).toBe(true);
    expect(sink.events.find((event) => event.op === "chat.context.selected")).toMatchObject({
      correlationId: "image-selection-before-bytes",
      extra: {
        imageCount: 1,
        imageReserveTokens:
          built.diagnostics.totalEstimatedTokens -
          countGatewayPromptTokens({ messages: built.messages }, profile.tokenAccounting, {
            contextWindow: profile.maxInputTokens,
          }),
        promptTokens: built.diagnostics.totalEstimatedTokens,
        inputBudget: profile.effectiveInputBudget,
        compactedHistoryMessages: built.compaction?.itemsBefore,
      },
    });
    const delivered = assemblyWithConversationImages(deps, target.request, "vision-chat", built);
    const tokens = countGatewayPromptTokens(
      { messages: delivered.messages },
      profile.tokenAccounting,
      { contextWindow: profile.maxInputTokens },
    );
    expect(tokens).toBeLessThanOrEqual(profile.effectiveInputBudget);
    expect(built.diagnostics.totalEstimatedTokens).toBe(tokens);
    expect(built.diagnostics.lanes.reduce((sum, lane) => sum + lane.estimatedTokens, 0)).toBe(
      tokens,
    );
    expect(target.resolve).toHaveBeenCalledOnce();
  });

  it("revalidates authority and resolves bound bytes only at the gateway boundary", () => {
    const { deps, request, resolve } = fixture();
    const result = assemblyWithConversationImages(deps, request, "vision-chat", assembly());
    expect(resolve).toHaveBeenCalledWith(request.attachments[0]?.attachmentRef, {
      sessionId: "session-1",
      sessionRotationCount: 2,
      projectPath: request.projectPath,
      chatId: request.chatId,
      mimeType: "image/png",
      sizeBytes: IMAGE_BYTES.length,
      sha256: "b".repeat(64),
    });
    expect(result.messages.at(-1)?.contentParts).toEqual([
      { type: "text", text: "inspect the image" },
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${IMAGE_BYTES.toString("base64")}` },
      },
    ]);
  });

  it("uses only the normalized safe base MIME in the provider data URL", () => {
    const { deps, request, resolve } = fixture();
    const image = request.attachments[0];
    if (image === undefined) throw new Error("image fixture missing");
    const parameterized: SendDesktopChatRequest = {
      ...request,
      attachments: [{ ...image, mimeType: "IMAGE/PNG; profile=safe" }],
    };

    const result = assemblyWithConversationImages(deps, parameterized, "vision-chat", assembly());

    expect(resolve).toHaveBeenCalledWith(image.attachmentRef, {
      sessionId: "session-1",
      sessionRotationCount: 2,
      projectPath: request.projectPath,
      chatId: request.chatId,
      mimeType: "image/png",
      sizeBytes: IMAGE_BYTES.length,
      sha256: "b".repeat(64),
    });
    expect(result.messages.at(-1)?.contentParts?.at(-1)).toEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${IMAGE_BYTES.toString("base64")}` },
    });
  });

  it("propagates a temporal store refusal without constructing an image data URL", () => {
    const { deps, request, resolve } = fixture();
    resolve.mockImplementationOnce((): Buffer => {
      throw new ConversationAttachmentStoreError();
    });

    expect(() => assemblyWithConversationImages(deps, request, "vision-chat", assembly())).toThrow(
      ConversationAttachmentStoreError,
    );
    expect(resolve).toHaveBeenCalledOnce();
  });

  it.each([
    "IMAGE/SVG+XML; charset=UTF-8",
    "image/p#ng",
    "image/p%ng",
    "image/p+ng",
    `image/${"a".repeat(MAX_ATTACHMENT_MIME_BYTES - "image/".length + 1)}`,
  ])("rejects unsafe MIME %s before resolving or constructing a data URL", (mimeType) => {
    const { deps, request, resolve } = fixture();
    const image = request.attachments[0];
    if (image === undefined) throw new Error("image fixture missing");
    const hostile: SendDesktopChatRequest = {
      ...request,
      attachments: [{ ...image, mimeType }],
    };

    expect(() => assemblyWithConversationImages(deps, hostile, "vision-chat", assembly())).toThrow(
      ConversationAttachmentStoreError,
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it("fails closed after authority rotation and never echoes a hostile delivery id", () => {
    const rotated = fixture(false);
    expect(() =>
      assemblyWithConversationImages(rotated.deps, rotated.request, "vision-chat", assembly()),
    ).toThrow(ConversationAttachmentStoreError);
    const accepted = fixture(true);
    const image = accepted.request.attachments[0];
    if (image === undefined) throw new Error("image fixture missing");
    const hostile: SendDesktopChatRequest = {
      ...accepted.request,
      attachments: [{ ...image, id: "secret-file-name.png" }],
    };
    expect(conversationImageDeliveries(hostile)).toEqual([]);
    expect(() =>
      assemblyWithConversationImages(accepted.deps, hostile, "vision-chat", assembly()),
    ).toThrow(ConversationAttachmentStoreError);
  });
});
