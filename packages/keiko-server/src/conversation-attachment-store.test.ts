import { mkdtempSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_ATTACHMENT_MIME_BYTES } from "@oscharko-dev/keiko-contracts";
import type { LocalSecretVault } from "@oscharko-dev/keiko-security/secret-vault";
import {
  ConversationAttachmentStoreError,
  createConversationAttachmentStore,
  type ConversationAttachmentBinding,
} from "./conversation-attachment-store.js";

const BYTES = Buffer.from("image-body-that-must-stay-sealed", "utf8");
const SHA256 = createHash("sha256").update(BYTES).digest("hex");
const CORRUPT_REF = `chat-attachment:${"c".repeat(64)}`;

class InjectedVaultError extends Error {}

function memoryVault(): {
  readonly vault: LocalSecretVault;
  readonly entries: Map<string, string>;
} {
  const entries = new Map<string, string>();
  const vault: LocalSecretVault = {
    get: (reference): string | undefined => entries.get(reference),
    set: (reference, secret): void => {
      entries.set(reference, secret);
    },
    replaceAll: (replacement): void => {
      entries.clear();
      for (const [reference, secret] of replacement) entries.set(reference, secret);
    },
    delete: (reference): void => {
      entries.delete(reference);
    },
    has: (reference): boolean => entries.has(reference),
    list: (): readonly string[] => [...entries.keys()],
  };
  return { vault, entries };
}

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

function attachmentRef(index: number): string {
  return `chat-attachment:${index.toString(16).padStart(64, "0")}`;
}

function mutateStoredRecord(
  vault: LocalSecretVault,
  ref: string,
  mutate: (record: Record<string, unknown>) => void,
): void {
  const raw = vault.get(ref);
  if (raw === undefined) throw new Error("stored attachment fixture missing");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("stored attachment fixture is not an object");
  }
  const record = parsed as Record<string, unknown>;
  mutate(record);
  vault.set(ref, JSON.stringify(record));
}

function expectRecordRemovedDuringValidUpload(
  mutate: (record: Record<string, unknown>) => void,
): void {
  const { vault } = memoryVault();
  const seedStore = createConversationAttachmentStore({
    runtimeStateDir: "/unused",
    env: {},
    vault,
    now: () => 1_000,
    mintRef: () => `chat-attachment:${"a".repeat(64)}`,
  });
  const corrupt = seedStore.put({ ...binding(), bytes: BYTES });
  mutateStoredRecord(vault, corrupt.ref, mutate);
  const store = createConversationAttachmentStore({
    runtimeStateDir: "/unused",
    env: {},
    vault,
    now: () => 1_000,
    totalContentBytes: BYTES.length,
    mintRef: () => `chat-attachment:${"b".repeat(64)}`,
  });

  const uploaded = store.put({ ...binding(), bytes: BYTES });

  expect(vault.has(corrupt.ref)).toBe(false);
  expect(store.resolve(uploaded.ref, binding())).toEqual(BYTES);
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

  it("removes expired entries during an upload scan before applying live quotas", () => {
    let now = 1_000;
    const { vault } = memoryVault();
    const refs = [attachmentRef(20), attachmentRef(21)];
    const store = createConversationAttachmentStore({
      runtimeStateDir: "/unused",
      env: {},
      vault,
      now: () => now,
      ttlMs: 25,
      totalContentBytes: BYTES.length,
      mintRef: () => refs.shift() ?? "missing-ref",
    });
    const expired = store.put({ ...binding(), bytes: BYTES });

    now = 1_026;
    const live = store.put({ ...binding(), bytes: BYTES });

    expect(vault.has(expired.ref)).toBe(false);
    expect(store.resolve(live.ref, binding())).toEqual(BYTES);
  });

  it("allows shorter TTL configuration but refuses extending attachment authority past 30 minutes", () => {
    const { vault } = memoryVault();
    const store = createConversationAttachmentStore({
      runtimeStateDir: "/unused",
      env: {},
      vault,
      now: () => 1_000,
      ttlMs: 30 * 60 * 1_000 + 1,
      mintRef: () => `chat-attachment:${"0".repeat(64)}`,
    });

    expect(() => store.put({ ...binding(), bytes: BYTES })).toThrow(
      ConversationAttachmentStoreError,
    );
    expect(vault.list()).toEqual([]);
  });

  it.each([
    { label: "NaN", totalContentBytes: Number.NaN },
    { label: "positive infinity", totalContentBytes: Number.POSITIVE_INFINITY },
    { label: "negative infinity", totalContentBytes: Number.NEGATIVE_INFINITY },
    { label: "zero", totalContentBytes: 0 },
    { label: "a negative value", totalContentBytes: -1 },
    { label: "a fractional byte count", totalContentBytes: 1.5 },
    { label: "an unsafe integer", totalContentBytes: Number.MAX_SAFE_INTEGER + 1 },
  ])("refuses a $label content-byte quota at construction", ({ totalContentBytes }) => {
    expect(() =>
      createConversationAttachmentStore({
        runtimeStateDir: "/unused",
        env: {},
        vault: memoryVault().vault,
        totalContentBytes,
      }),
    ).toThrow(ConversationAttachmentStoreError);
  });

  it("accepts an exact positive content-byte quota boundary", () => {
    const store = createConversationAttachmentStore({
      runtimeStateDir: "/unused",
      env: {},
      vault: memoryVault().vault,
      now: () => 1_000,
      totalContentBytes: BYTES.length,
      mintRef: () => attachmentRef(30),
    });

    const uploaded = store.put({ ...binding(), bytes: BYTES });

    expect(store.resolve(uploaded.ref, binding())).toEqual(BYTES);
  });

  it("stores safe image MIME canonically and refuses parameterized SVG", () => {
    const { vault } = memoryVault();
    const store = createConversationAttachmentStore({
      runtimeStateDir: "/unused",
      env: {},
      vault,
      now: () => 1_000,
      mintRef: () => `chat-attachment:${"f".repeat(64)}`,
    });
    const parameterized = { ...binding(), mimeType: "IMAGE/PNG; profile=safe" };

    const uploaded = store.put({ ...parameterized, bytes: BYTES });

    expect(store.resolve(uploaded.ref, binding())).toEqual(BYTES);
    expect(() =>
      store.put({ ...binding(), mimeType: "IMAGE/SVG+XML; charset=UTF-8", bytes: BYTES }),
    ).toThrow(ConversationAttachmentStoreError);
    const oversizedMime = `image/${"a".repeat(MAX_ATTACHMENT_MIME_BYTES - "image/".length + 1)}`;
    expect(() => store.put({ ...binding(), mimeType: oversizedMime, bytes: BYTES })).toThrow(
      ConversationAttachmentStoreError,
    );
  });

  it("removes corrupt records without losing live-byte quota accounting", () => {
    const { vault } = memoryVault();
    vault.set(CORRUPT_REF, "{not-json");
    const store = createConversationAttachmentStore({
      runtimeStateDir: "/unused",
      env: {},
      vault,
      now: () => 1_000,
      totalContentBytes: BYTES.length * 2 - 1,
      mintRef: () => `chat-attachment:${"d".repeat(64)}`,
    });

    const uploaded = store.put({ ...binding(), bytes: BYTES });
    expect(vault.has(CORRUPT_REF)).toBe(false);
    expect(store.resolve(uploaded.ref, binding())).toEqual(BYTES);

    vault.set(CORRUPT_REF, JSON.stringify({ schemaVersion: 999 }));
    expect(() => store.put({ ...binding(), bytes: BYTES })).toThrow(
      ConversationAttachmentStoreError,
    );
    expect(vault.has(CORRUPT_REF)).toBe(false);
    expect(store.resolve(uploaded.ref, binding())).toEqual(BYTES);
  });

  it("removes an oversized shape-valid record instead of blocking a valid upload", () => {
    expectRecordRemovedDuringValidUpload((record): void => {
      record.sizeBytes = Number.MAX_SAFE_INTEGER;
    });
  });

  it("removes a negative-size record without letting it underflow live-byte quota", () => {
    const { vault } = memoryVault();
    const refs = [`chat-attachment:${"1".repeat(64)}`, `chat-attachment:${"2".repeat(64)}`];
    const seedStore = createConversationAttachmentStore({
      runtimeStateDir: "/unused",
      env: {},
      vault,
      now: () => 1_000,
      mintRef: () => refs.shift() ?? "missing-ref",
    });
    const live = seedStore.put({ ...binding(), bytes: BYTES });
    const corrupt = seedStore.put({ ...binding(), chatId: "chat-corrupt", bytes: BYTES });
    mutateStoredRecord(vault, corrupt.ref, (record): void => {
      record.sizeBytes = -BYTES.length;
    });
    const store = createConversationAttachmentStore({
      runtimeStateDir: "/unused",
      env: {},
      vault,
      now: () => 1_000,
      totalContentBytes: BYTES.length * 2 - 1,
      mintRef: () => `chat-attachment:${"3".repeat(64)}`,
    });

    expect(() => store.put({ ...binding(), bytes: BYTES })).toThrow(
      ConversationAttachmentStoreError,
    );
    expect(vault.has(corrupt.ref)).toBe(false);
    expect(store.resolve(live.ref, binding())).toEqual(BYTES);
  });

  it.each([
    {
      label: "decoded length",
      mutate: (record: Record<string, unknown>): void => {
        record.contentBase64 = Buffer.from("short", "utf8").toString("base64");
      },
    },
    {
      label: "content hash",
      mutate: (record: Record<string, unknown>): void => {
        record.sha256 = "a".repeat(64);
      },
    },
    {
      label: "non-canonical Base64 alphabet",
      mutate: (record: Record<string, unknown>): void => {
        const content = record.contentBase64;
        if (typeof content !== "string") throw new Error("attachment content fixture missing");
        record.contentBase64 = `!${content.slice(1)}`;
      },
    },
  ])("removes a record with inconsistent $label during quota scan", ({ mutate }) => {
    expectRecordRemovedDuringValidUpload(mutate);
  });

  it.each([
    {
      label: "fractional byte count",
      mutate: (record: Record<string, unknown>): void => {
        record.sizeBytes = 1.5;
      },
    },
    {
      label: "non-canonical image MIME",
      mutate: (record: Record<string, unknown>): void => {
        record.mimeType = "IMAGE/PNG";
      },
    },
    {
      label: "negative session rotation",
      mutate: (record: Record<string, unknown>): void => {
        record.sessionRotationCount = -1;
      },
    },
    {
      label: "unordered timestamps",
      mutate: (record: Record<string, unknown>): void => {
        record.expiresAt = record.createdAt;
      },
    },
    {
      label: "implausibly distant expiry",
      mutate: (record: Record<string, unknown>): void => {
        record.expiresAt = Number.MAX_SAFE_INTEGER;
      },
    },
  ])("removes a record with invalid $label metadata", ({ mutate }) => {
    expectRecordRemovedDuringValidUpload(mutate);
  });

  it("keeps a valid future-created record live and quota-binding", () => {
    const { vault } = memoryVault();
    const seedStore = createConversationAttachmentStore({
      runtimeStateDir: "/unused",
      env: {},
      vault,
      now: () => 1_000,
      mintRef: () => attachmentRef(10),
    });
    const future = seedStore.put({ ...binding(), bytes: BYTES });
    mutateStoredRecord(vault, future.ref, (record): void => {
      record.createdAt = Number.MAX_SAFE_INTEGER - 1_000;
      record.expiresAt = Number.MAX_SAFE_INTEGER;
    });
    const store = createConversationAttachmentStore({
      runtimeStateDir: "/unused",
      env: {},
      vault,
      now: () => 1_000,
      totalContentBytes: BYTES.length * 2 - 1,
      mintRef: () => attachmentRef(11),
    });

    expect(() => store.put({ ...binding(), chatId: "chat-2", bytes: BYTES })).toThrow(
      ConversationAttachmentStoreError,
    );
    expect(() => store.resolve(future.ref, binding())).toThrow(ConversationAttachmentStoreError);
    expect(vault.has(future.ref)).toBe(true);
    expect(() => {
      store.deleteBound(future.ref, { ...binding(), chatId: "chat-2" });
    }).toThrow(ConversationAttachmentStoreError);
    expect(vault.has(future.ref)).toBe(true);
    expect(() => {
      store.deleteBound(future.ref, binding());
    }).not.toThrow();
    expect(vault.has(future.ref)).toBe(false);
  });

  it("temporally refuses without deleting another chat attachment after clock rollback", () => {
    let now = 1_000;
    const { vault } = memoryVault();
    const refs = [attachmentRef(12), attachmentRef(13)];
    const store = createConversationAttachmentStore({
      runtimeStateDir: "/unused",
      env: {},
      vault,
      now: () => now,
      mintRef: () => refs.shift() ?? "missing-ref",
    });
    const original = store.put({ ...binding(), bytes: BYTES });

    now = 900;
    const otherBinding = { ...binding(), chatId: "chat-2" };
    const other = store.put({ ...otherBinding, bytes: BYTES });

    expect(() => store.resolve(original.ref, binding())).toThrow(ConversationAttachmentStoreError);
    expect(vault.has(original.ref)).toBe(true);
    expect(store.resolve(other.ref, otherBinding)).toEqual(BYTES);
    expect(() => store.resolve(other.ref, binding())).toThrow(ConversationAttachmentStoreError);

    now = 1_000;
    expect(store.resolve(original.ref, binding())).toEqual(BYTES);
    expect(() => store.resolve(original.ref, otherBinding)).toThrow(
      ConversationAttachmentStoreError,
    );
  });

  it("allows the 256th live entry and refuses a 257th", () => {
    const { vault } = memoryVault();
    const seedStore = createConversationAttachmentStore({
      runtimeStateDir: "/unused",
      env: {},
      vault,
      now: () => 1_000,
      mintRef: () => attachmentRef(0),
    });
    const seed = seedStore.put({ ...binding(), bytes: BYTES });
    const raw = vault.get(seed.ref);
    if (raw === undefined) throw new Error("stored attachment fixture missing");
    for (let index = 1; index < 255; index += 1) vault.set(attachmentRef(index), raw);
    const refs = [attachmentRef(255), attachmentRef(256)];
    const store = createConversationAttachmentStore({
      runtimeStateDir: "/unused",
      env: {},
      vault,
      now: () => 1_000,
      mintRef: () => refs.shift() ?? "missing-ref",
    });

    const boundary = store.put({ ...binding(), bytes: BYTES });

    expect(vault.list()).toHaveLength(256);
    expect(store.resolve(boundary.ref, binding())).toEqual(BYTES);
    expect(() => store.put({ ...binding(), bytes: BYTES })).toThrow(
      ConversationAttachmentStoreError,
    );
    expect(vault.list()).toHaveLength(256);
  });

  it("removes a record whose vault reference violates the attachment-ref contract", () => {
    const { vault } = memoryVault();
    const seedStore = createConversationAttachmentStore({
      runtimeStateDir: "/unused",
      env: {},
      vault,
      now: () => 1_000,
      mintRef: () => `chat-attachment:${"8".repeat(64)}`,
    });
    const seeded = seedStore.put({ ...binding(), bytes: BYTES });
    const raw = vault.get(seeded.ref);
    if (raw === undefined) throw new Error("stored attachment fixture missing");
    vault.delete(seeded.ref);
    vault.set("invalid-attachment-ref", raw);
    const store = createConversationAttachmentStore({
      runtimeStateDir: "/unused",
      env: {},
      vault,
      now: () => 1_000,
      totalContentBytes: BYTES.length,
      mintRef: () => `chat-attachment:${"9".repeat(64)}`,
    });

    const uploaded = store.put({ ...binding(), bytes: BYTES });

    expect(vault.has("invalid-attachment-ref")).toBe(false);
    expect(store.resolve(uploaded.ref, binding())).toEqual(BYTES);
  });

  it("purges corrupt custody with the target chat without deleting another valid chat", () => {
    const { vault } = memoryVault();
    const refs = [`chat-attachment:${"d".repeat(64)}`, `chat-attachment:${"e".repeat(64)}`];
    const store = createConversationAttachmentStore({
      runtimeStateDir: "/unused",
      env: {},
      vault,
      now: () => 1_000,
      mintRef: () => refs.shift() ?? "missing-ref",
    });
    const selected = store.put({ ...binding(), bytes: BYTES });
    const otherBinding = { ...binding(), chatId: "chat-2" };
    const other = store.put({ ...otherBinding, bytes: BYTES });
    vault.set(CORRUPT_REF, "null");

    expect(() => {
      store.deleteForChat(binding().projectPath, binding().chatId);
    }).not.toThrow();

    expect(() => store.resolve(selected.ref, binding())).toThrow(ConversationAttachmentStoreError);
    expect(store.resolve(other.ref, otherBinding)).toEqual(BYTES);
    expect(vault.has(CORRUPT_REF)).toBe(false);
  });

  it("propagates non-domain vault failures before chat deletion mutates custody", () => {
    const { vault } = memoryVault();
    const refs = [`chat-attachment:${"f".repeat(64)}`, `chat-attachment:${"1".repeat(64)}`];
    const seedStore = createConversationAttachmentStore({
      runtimeStateDir: "/unused",
      env: {},
      vault,
      now: () => 1_000,
      mintRef: () => refs.shift() ?? "missing-ref",
    });
    const selected = seedStore.put({ ...binding(), bytes: BYTES });
    const otherBinding = { ...binding(), chatId: "chat-2" };
    const other = seedStore.put({ ...otherBinding, bytes: BYTES });
    vault.set(CORRUPT_REF, "opaque");
    const failingVault: LocalSecretVault = {
      ...vault,
      get: (reference): string | undefined => {
        if (reference === CORRUPT_REF) throw new InjectedVaultError("vault unavailable");
        return vault.get(reference);
      },
    };
    const store = createConversationAttachmentStore({
      runtimeStateDir: "/unused",
      env: {},
      vault: failingVault,
      now: () => 1_000,
    });

    expect(() => store.resolve(CORRUPT_REF, binding())).toThrow(InjectedVaultError);
    expect(() => store.put({ ...binding(), bytes: BYTES })).toThrow(InjectedVaultError);
    expect(() => {
      store.deleteForChat(binding().projectPath, binding().chatId);
    }).toThrow(InjectedVaultError);
    expect(seedStore.resolve(selected.ref, binding())).toEqual(BYTES);
    expect(seedStore.resolve(other.ref, otherBinding)).toEqual(BYTES);
    expect(vault.has(CORRUPT_REF)).toBe(true);
  });
});
