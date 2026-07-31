import { mkdtempSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConversationAttachmentStoreError,
  createConversationAttachmentStore,
  type ConversationAttachmentBinding,
} from "./conversation-attachment-store.js";

const BYTES = Buffer.from("image-body-that-must-stay-sealed", "utf8");
const SHA256 = createHash("sha256").update(BYTES).digest("hex");

function binding(): ConversationAttachmentBinding {
  return {
    sessionId: "session-1",
    sessionRotationCount: 0,
    projectPath: "/workspace/project",
    chatId: "chat-1",
    mimeType: "image/png",
    sizeBytes: BYTES.length,
    sha256: SHA256,
  };
}

describe("conversation attachment store", () => {
  it("seals bytes locally and validates every opaque-reference binding", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-chat-attachments-")));
    const store = createConversationAttachmentStore({
      runtimeStateDir: root,
      env: { KEIKO_CONVERSATION_ATTACHMENT_KEY: Buffer.alloc(32, 7).toString("base64") },
      now: () => 1_000,
      mintRef: () => "chat-attachment:" + "b".repeat(64),
    });

    const uploaded = store.put({ ...binding(), bytes: BYTES });
    expect(store.resolve(uploaded.ref, binding())).toEqual(BYTES);
    expect(() => store.resolve(uploaded.ref, { ...binding(), chatId: "another-chat" })).toThrow(
      ConversationAttachmentStoreError,
    );
    expect(() => {
      store.deleteBound(uploaded.ref, { ...binding(), sessionId: "another-session" });
    }).toThrow(ConversationAttachmentStoreError);
    expect(() => store.resolve(uploaded.ref, { ...binding(), sessionRotationCount: 1 })).toThrow(
      ConversationAttachmentStoreError,
    );
    expect(store.resolve(uploaded.ref, binding())).toEqual(BYTES);

    const sealed = readdirSync(join(root, "conversation-attachments"))
      .map((name) => readFileSync(join(root, "conversation-attachments", name)))
      .map((contents) => contents.toString("utf8"))
      .join("\n");
    expect(sealed).not.toContain(BYTES.toString("utf8"));
    expect(sealed).not.toContain(BYTES.toString("base64"));
  });

  it("fails closed for expired refs and removes every blob bound to a purged chat", () => {
    let now = 1_000;
    const store = createConversationAttachmentStore({
      runtimeStateDir: realpathSync(mkdtempSync(join(tmpdir(), "keiko-chat-attachments-"))),
      env: { KEIKO_CONVERSATION_ATTACHMENT_KEY: Buffer.alloc(32, 8).toString("base64") },
      now: () => now,
      ttlMs: 25,
    });
    const first = store.put({ ...binding(), bytes: BYTES });
    const second = store.put({ ...binding(), bytes: BYTES });
    store.deleteForChat(binding().projectPath, binding().chatId);
    expect(() => store.resolve(first.ref, binding())).toThrow(ConversationAttachmentStoreError);
    expect(() => store.resolve(second.ref, binding())).toThrow(ConversationAttachmentStoreError);

    const expired = store.put({ ...binding(), bytes: BYTES });
    now = 1_026;
    expect(() => store.resolve(expired.ref, binding())).toThrow(ConversationAttachmentStoreError);
  });
});
