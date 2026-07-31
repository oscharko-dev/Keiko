import { mkdtempSync, realpathSync } from "node:fs";
import { type IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
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
import { handleUploadConversationAttachment } from "./conversation-attachment-routes.js";
import type { UiHandlerDeps } from "./deps.js";
import type { RouteContext } from "./routes.js";

function failingRequest(cookie?: string): IncomingMessage {
  const stream = new Readable({
    read(): void {
      this.destroy(new Error("transport read failed"));
    },
  });
  Object.defineProperty(stream, "headers", {
    value: cookie === undefined ? {} : { cookie },
  });
  return stream as IncomingMessage;
}

function context(req: IncomingMessage): RouteContext {
  return {
    req,
    res: new ServerResponse(req),
    params: {},
    url: new URL("http://localhost/api/desktop/chat/attachments"),
    correlationId: "attachment-route-test",
  };
}

function fixture(): { readonly deps: UiHandlerDeps; readonly cookie: string } {
  const channel = createCodingAppSessionChannel({
    registry: createSessionRegistry(),
    pairingPort: createFakeSessionPairingPort(),
  });
  const paired = channel.pair(fakePairingRequestBody());
  if (!paired.paired) throw new Error("pairing fixture failed");
  const store = createInMemoryUiStore();
  const projectPath = realpathSync(mkdtempSync(join(tmpdir(), "keiko-attachment-route-")));
  store.createProject(projectPath, "Project");
  store.createChat(projectPath, "Chat", "model");
  return {
    cookie: `${APP_SESSION_COOKIE_NAME}=${paired.cookieToken}`,
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
      conversationAttachmentStore: {
        put: () => ({ ref: `chat-attachment:${"a".repeat(64)}`, expiresAt: 1 }),
        resolve: () => Buffer.alloc(0),
        deleteBound: () => undefined,
        deleteForChat: () => undefined,
      },
    },
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
    ).resolves.toMatchObject({
      status: 404,
    });
  });
});
