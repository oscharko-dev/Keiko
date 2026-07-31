import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { classifyAttachmentMime, MAX_ATTACHMENT_BYTES } from "@oscharko-dev/keiko-contracts";
import {
  createShardedLocalSecretVault,
  resolveLocalVaultKey,
  type LocalSecretVault,
} from "@oscharko-dev/keiko-security/secret-vault";

const STORE_DIR = "conversation-attachments";
const KEY_ENV = "KEIKO_CONVERSATION_ATTACHMENT_KEY";
const KEY_SERVICE = "keiko-conversation-attachment-vault";
const KEY_FILE = "conversation-attachment-vault.key";
const REF_PATTERN = /^chat-attachment:[0-9a-f]{64}$/u;
const SHA_PATTERN = /^[0-9a-f]{64}$/u;
const DEFAULT_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_TOTAL_BYTES = 32 * 1024 * 1024;

export interface ConversationAttachmentBinding {
  readonly sessionId: string;
  readonly sessionRotationCount: number;
  readonly projectPath: string;
  readonly chatId: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface ConversationAttachmentPut extends ConversationAttachmentBinding {
  readonly bytes: Buffer;
}

interface StoredAttachment extends ConversationAttachmentBinding {
  readonly schemaVersion: 1;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly contentBase64: string;
}

export interface ConversationAttachmentStore {
  readonly put: (input: ConversationAttachmentPut) => {
    readonly ref: string;
    readonly expiresAt: number;
  };
  readonly resolve: (ref: string, binding: ConversationAttachmentBinding) => Buffer;
  readonly deleteBound: (ref: string, binding: ConversationAttachmentBinding) => void;
  readonly deleteForChat: (projectPath: string, chatId: string) => void;
}

export interface CreateConversationAttachmentStoreOptions {
  readonly runtimeStateDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly vault?: LocalSecretVault | undefined;
  readonly now?: (() => number) | undefined;
  readonly mintRef?: (() => string) | undefined;
  readonly ttlMs?: number | undefined;
  readonly totalBytes?: number | undefined;
}

export class ConversationAttachmentStoreError extends Error {
  public constructor() {
    super("Conversation attachment is unavailable or no longer authorized.");
    this.name = "ConversationAttachmentStoreError";
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hasStoredAttachmentStrings(record: Record<string, unknown>): boolean {
  return (
    typeof record.sessionId === "string" &&
    typeof record.projectPath === "string" &&
    typeof record.chatId === "string" &&
    typeof record.mimeType === "string" &&
    typeof record.sha256 === "string" &&
    typeof record.contentBase64 === "string"
  );
}

function hasStoredAttachmentNumbers(record: Record<string, unknown>): boolean {
  return (
    typeof record.sessionRotationCount === "number" &&
    typeof record.sizeBytes === "number" &&
    typeof record.createdAt === "number" &&
    typeof record.expiresAt === "number"
  );
}

function isStoredAttachment(value: unknown): value is StoredAttachment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    hasStoredAttachmentStrings(record) &&
    hasStoredAttachmentNumbers(record)
  );
}

function readStored(vault: LocalSecretVault, ref: string): StoredAttachment {
  try {
    const raw = vault.get(ref);
    const parsed: unknown = raw === undefined ? undefined : JSON.parse(raw);
    if (!isStoredAttachment(parsed)) throw new ConversationAttachmentStoreError();
    return parsed;
  } catch (error) {
    if (error instanceof ConversationAttachmentStoreError) throw error;
    throw new ConversationAttachmentStoreError();
  }
}

function sameBinding(stored: StoredAttachment, binding: ConversationAttachmentBinding): boolean {
  return (
    stored.sessionId === binding.sessionId &&
    stored.sessionRotationCount === binding.sessionRotationCount &&
    stored.projectPath === binding.projectPath &&
    stored.chatId === binding.chatId &&
    stored.mimeType === binding.mimeType &&
    stored.sizeBytes === binding.sizeBytes &&
    stored.sha256 === binding.sha256
  );
}

function validatePut(input: ConversationAttachmentPut): void {
  if (
    classifyAttachmentMime(input.mimeType) !== "image" ||
    input.bytes.length === 0 ||
    input.bytes.length > MAX_ATTACHMENT_BYTES ||
    input.sizeBytes !== input.bytes.length ||
    !SHA_PATTERN.test(input.sha256) ||
    sha256(input.bytes) !== input.sha256
  ) {
    throw new ConversationAttachmentStoreError();
  }
}

function currentLiveBytes(vault: LocalSecretVault, now: number): number {
  let total = 0;
  for (const ref of vault.list()) {
    const stored = readStored(vault, ref);
    if (stored.expiresAt <= now) {
      vault.delete(ref);
    } else {
      total += stored.sizeBytes;
    }
  }
  return total;
}

function decodeVerified(stored: StoredAttachment): Buffer {
  const bytes = Buffer.from(stored.contentBase64, "base64");
  if (bytes.length !== stored.sizeBytes || sha256(bytes) !== stored.sha256) {
    throw new ConversationAttachmentStoreError();
  }
  return bytes;
}

interface AttachmentStoreRuntime {
  readonly getVault: () => LocalSecretVault;
  readonly now: () => number;
  readonly ttlMs: number;
  readonly totalBytes: number;
  readonly mintRef: () => string;
}

function putAttachment(
  runtime: AttachmentStoreRuntime,
  input: ConversationAttachmentPut,
): { readonly ref: string; readonly expiresAt: number } {
  const vault = runtime.getVault();
  validatePut(input);
  const createdAt = runtime.now();
  if (currentLiveBytes(vault, createdAt) + input.sizeBytes > runtime.totalBytes) {
    throw new ConversationAttachmentStoreError();
  }
  const ref = runtime.mintRef();
  if (!REF_PATTERN.test(ref) || vault.has(ref)) throw new ConversationAttachmentStoreError();
  const stored: StoredAttachment = {
    schemaVersion: 1,
    sessionId: input.sessionId,
    sessionRotationCount: input.sessionRotationCount,
    projectPath: input.projectPath,
    chatId: input.chatId,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    sha256: input.sha256,
    createdAt,
    expiresAt: createdAt + runtime.ttlMs,
    contentBase64: input.bytes.toString("base64"),
  };
  vault.set(ref, JSON.stringify(stored));
  return { ref, expiresAt: stored.expiresAt };
}

function resolveAttachment(
  runtime: AttachmentStoreRuntime,
  ref: string,
  binding: ConversationAttachmentBinding,
): Buffer {
  const vault = runtime.getVault();
  if (!REF_PATTERN.test(ref)) throw new ConversationAttachmentStoreError();
  const stored = readStored(vault, ref);
  if (stored.expiresAt <= runtime.now()) {
    vault.delete(ref);
    throw new ConversationAttachmentStoreError();
  }
  if (!sameBinding(stored, binding)) throw new ConversationAttachmentStoreError();
  return decodeVerified(stored);
}

function deleteBoundAttachment(
  runtime: AttachmentStoreRuntime,
  ref: string,
  binding: ConversationAttachmentBinding,
): void {
  const vault = runtime.getVault();
  if (!REF_PATTERN.test(ref)) throw new ConversationAttachmentStoreError();
  const stored = readStored(vault, ref);
  if (stored.expiresAt <= runtime.now() || !sameBinding(stored, binding)) {
    throw new ConversationAttachmentStoreError();
  }
  vault.delete(ref);
}

function deleteChatAttachments(
  runtime: AttachmentStoreRuntime,
  projectPath: string,
  chatId: string,
): void {
  const vault = runtime.getVault();
  for (const ref of vault.list()) {
    const stored = readStored(vault, ref);
    if (stored.projectPath === projectPath && stored.chatId === chatId) vault.delete(ref);
  }
}

export function createConversationAttachmentStore(
  options: CreateConversationAttachmentStoreOptions,
): ConversationAttachmentStore {
  let cachedVault = options.vault;
  const getVault = (): LocalSecretVault => {
    cachedVault ??= createShardedLocalSecretVault({
      key: resolveLocalVaultKey({
        env: options.env,
        vaultDir: join(options.runtimeStateDir, STORE_DIR),
        envVarName: KEY_ENV,
        keychainService: KEY_SERVICE,
        keyfileName: KEY_FILE,
      }).key,
      storeDir: join(options.runtimeStateDir, STORE_DIR),
    });
    return cachedVault;
  };
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const totalBytes = options.totalBytes ?? DEFAULT_TOTAL_BYTES;
  const mintRef =
    options.mintRef ?? ((): string => `chat-attachment:${randomBytes(32).toString("hex")}`);
  const runtime: AttachmentStoreRuntime = { getVault, now, ttlMs, totalBytes, mintRef };

  return {
    put: (input): { readonly ref: string; readonly expiresAt: number } =>
      putAttachment(runtime, input),
    resolve: (ref, binding): Buffer => resolveAttachment(runtime, ref, binding),
    deleteBound: (ref, binding): void => {
      deleteBoundAttachment(runtime, ref, binding);
    },
    deleteForChat: (projectPath, chatId): void => {
      deleteChatAttachments(runtime, projectPath, chatId);
    },
  };
}
