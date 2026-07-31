import { mkdtempSync, realpathSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRedactor } from "./index.js";
import { createRunRegistry } from "./runs.js";
import { createInMemoryUiStore } from "./store/index.js";
import { createCodingAppSessionChannel } from "./coding-app-session/sessionChannel.js";
import { createSessionRegistry } from "./coding-app-session/sessionRegistry.js";
import { APP_SESSION_COOKIE_NAME } from "./coding-app-session/sessionCookie.js";
import {
  createFakeSessionPairingPort,
  fakePairingRequestBody,
} from "./coding-app-session/_support.js";
import {
  handleDeleteConversationAttachment,
  handleUploadConversationAttachment,
} from "./conversation-attachment-routes.js";
import {
  ConversationAttachmentStoreError,
  type ConversationAttachmentStore,
} from "./conversation-attachment-store.js";
import type { UiHandlerDeps } from "./deps.js";
import type { RouteContext, RouteResult } from "./routes.js";

const CORRELATION_ID = "attachment-route-test";
const ATTACHMENT_REF = `chat-attachment:${"a".repeat(64)}`;
const UNAVAILABLE_RESPONSE = {
  status: 404,
  body: {
    error: {
      code: "NOT_FOUND",
      message: "Conversation attachment is unavailable.",
      correlationId: CORRELATION_ID,
    },
  },
} satisfies RouteResult;

class FailingIncomingMessage extends IncomingMessage {
  private failed = false;

  public override _read(_size: number): void {
    if (this.failed) return;
    this.failed = true;
    this.emit("error", new Error("transport read failed"));
  }
}

function setCookie(req: IncomingMessage, cookie?: string): void {
  if (cookie !== undefined) req.headers.cookie = cookie;
}

function failingRequest(cookie?: string): IncomingMessage {
  const req = new FailingIncomingMessage(new Socket());
  setCookie(req, cookie);
  return req;
}

function request(rawBody: string, cookie?: string): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  setCookie(req, cookie);
  req.push(rawBody);
  req.push(null);
  return req;
}

function context(req: IncomingMessage): RouteContext {
  return {
    req,
    res: new ServerResponse(req),
    params: {},
    url: new URL("http://localhost/api/desktop/chat/attachments"),
    correlationId: CORRELATION_ID,
  };
}

interface AttachmentRouteFixture {
  readonly deps: UiHandlerDeps;
  readonly cookie: string;
  readonly projectPath: string;
  readonly chatId: string;
  readonly attachmentStore: ConversationAttachmentStore;
}

function fixture(): AttachmentRouteFixture {
  const channel = createCodingAppSessionChannel({
    registry: createSessionRegistry(),
    pairingPort: createFakeSessionPairingPort(),
  });
  const paired = channel.pair(fakePairingRequestBody());
  if (!paired.paired) throw new Error("pairing fixture failed");
  const store = createInMemoryUiStore();
  const projectPath = realpathSync(mkdtempSync(join(tmpdir(), "keiko-attachment-route-")));
  store.createProject(projectPath, "Project");
  const chat = store.createChat(projectPath, "Chat", "model");
  const attachmentStore: ConversationAttachmentStore = {
    put: () => ({ ref: ATTACHMENT_REF, expiresAt: 1 }),
    resolve: () => Buffer.alloc(0),
    deleteBound: () => undefined,
    deleteForChat: () => undefined,
  };
  return {
    cookie: `${APP_SESSION_COOKIE_NAME}=${paired.cookieToken}`,
    projectPath,
    chatId: chat.id,
    attachmentStore,
    deps: {
      config: undefined,
      configPresent: false,
      evidenceStore: {
        put: () => "",
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
      env: {},
      redactor: buildRedactor({}),
      registry: createRunRegistry(),
      modelPortFactory: () => undefined,
      store,
      codingAppSessionChannel: channel,
      conversationAttachmentStore: attachmentStore,
    },
  };
}

function uploadBody(projectPath: string, chatId: string): Record<string, unknown> {
  return {
    projectPath,
    chatId,
    mimeType: "image/png",
    sizeBytes: 1,
    sha256: "b".repeat(64),
    contentBase64: "YQ==",
  };
}

function deleteBody(projectPath: string, chatId: string): Record<string, unknown> {
  return {
    attachmentRef: ATTACHMENT_REF,
    projectPath,
    chatId,
    mimeType: "image/png",
    sizeBytes: 1,
    sha256: "b".repeat(64),
  };
}

describe("conversation attachment route observability", () => {
  it("propagates an unexpected request read failure for correlation diagnostics", async () => {
    const { deps, cookie } = fixture();
    await expect(
      handleUploadConversationAttachment(context(failingRequest(cookie)), deps),
    ).rejects.toThrow("transport read failed");
  });

  it("rejects an unpaired request before consuming its body", async () => {
    const { deps } = fixture();
    await expect(
      handleUploadConversationAttachment(context(failingRequest()), deps),
    ).resolves.toEqual(UNAVAILABLE_RESPONSE);
  });

  it("correlates an upload 404 when attachment storage is unavailable", async () => {
    const { deps, cookie } = fixture();
    await expect(
      handleUploadConversationAttachment(context(failingRequest(cookie)), {
        ...deps,
        conversationAttachmentStore: undefined,
      }),
    ).resolves.toEqual(UNAVAILABLE_RESPONSE);
  });

  it("correlates an upload 404 for an unreadable request body", async () => {
    const { deps, cookie } = fixture();
    await expect(
      handleUploadConversationAttachment(context(request("{", cookie)), deps),
    ).resolves.toEqual(UNAVAILABLE_RESPONSE);
  });

  it("correlates an upload 404 for an unauthorized chat binding", async () => {
    const { deps, cookie, projectPath } = fixture();
    const body = uploadBody(projectPath, "unknown-chat");
    await expect(
      handleUploadConversationAttachment(context(request(JSON.stringify(body), cookie)), deps),
    ).resolves.toEqual(UNAVAILABLE_RESPONSE);
  });

  it("correlates an upload 404 rejected by the attachment store", async () => {
    const { deps, cookie, projectPath, chatId, attachmentStore } = fixture();
    const body = uploadBody(projectPath, chatId);
    await expect(
      handleUploadConversationAttachment(context(request(JSON.stringify(body), cookie)), {
        ...deps,
        conversationAttachmentStore: {
          ...attachmentStore,
          put: () => {
            throw new ConversationAttachmentStoreError();
          },
        },
      }),
    ).resolves.toEqual(UNAVAILABLE_RESPONSE);
  });

  it("correlates a delete 404 for an unpaired request", async () => {
    const { deps } = fixture();
    await expect(
      handleDeleteConversationAttachment(context(failingRequest()), deps),
    ).resolves.toEqual(UNAVAILABLE_RESPONSE);
  });

  it("correlates a delete 404 when attachment storage is unavailable", async () => {
    const { deps, cookie } = fixture();
    await expect(
      handleDeleteConversationAttachment(context(failingRequest(cookie)), {
        ...deps,
        conversationAttachmentStore: undefined,
      }),
    ).resolves.toEqual(UNAVAILABLE_RESPONSE);
  });

  it("correlates a delete 404 for an unreadable request body", async () => {
    const { deps, cookie } = fixture();
    await expect(
      handleDeleteConversationAttachment(context(request("{", cookie)), deps),
    ).resolves.toEqual(UNAVAILABLE_RESPONSE);
  });

  it("correlates a delete 404 for an unauthorized chat binding", async () => {
    const { deps, cookie, projectPath } = fixture();
    const body = deleteBody(projectPath, "unknown-chat");
    await expect(
      handleDeleteConversationAttachment(context(request(JSON.stringify(body), cookie)), deps),
    ).resolves.toEqual(UNAVAILABLE_RESPONSE);
  });

  it("correlates a delete 404 rejected by the attachment store", async () => {
    const { deps, cookie, projectPath, chatId, attachmentStore } = fixture();
    const body = deleteBody(projectPath, chatId);
    await expect(
      handleDeleteConversationAttachment(context(request(JSON.stringify(body), cookie)), {
        ...deps,
        conversationAttachmentStore: {
          ...attachmentStore,
          deleteBound: () => {
            throw new ConversationAttachmentStoreError();
          },
        },
      }),
    ).resolves.toEqual(UNAVAILABLE_RESPONSE);
  });
});
