import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  classifyAttachmentMime,
  MAX_ATTACHMENT_BYTES,
  normalizeAttachmentMime,
} from "@oscharko-dev/keiko-contracts";
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
// Attachment refs are transient authority artifacts. Callers may shorten this window (the test
// seam does), but neither configuration changes nor persisted data may extend it beyond 30 minutes.
const MAX_ATTACHMENT_TTL_MS = DEFAULT_TTL_MS;
const DEFAULT_TOTAL_BYTES = 32 * 1024 * 1024;
// The byte quota bounds content volume; this independent cap bounds per-entry envelope/decryption
// work even when every attachment is tiny. A normal conversation cannot approach 256 live images.
const MAX_LIVE_ENTRIES = 256;
const MAX_CONTENT_BASE64_LENGTH = 4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3);

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

function isCanonicalStoredImageMime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    normalizeAttachmentMime(value) === value &&
    classifyAttachmentMime(value) === "image"
  );
}

function isStoredSha256(value: unknown): value is string {
  return typeof value === "string" && SHA_PATTERN.test(value);
}

function isBoundedStoredBase64(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_CONTENT_BASE64_LENGTH;
}

function hasStoredAttachmentStrings(record: Record<string, unknown>): boolean {
  return (
    typeof record.sessionId === "string" &&
    typeof record.projectPath === "string" &&
    typeof record.chatId === "string" &&
    isCanonicalStoredImageMime(record.mimeType) &&
    isStoredSha256(record.sha256) &&
    isBoundedStoredBase64(record.contentBase64)
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function hasValidStoredTimeline(createdAt: unknown, expiresAt: unknown): boolean {
  return (
    isNonNegativeSafeInteger(createdAt) &&
    isPositiveSafeInteger(expiresAt) &&
    expiresAt > createdAt &&
    expiresAt - createdAt <= MAX_ATTACHMENT_TTL_MS
  );
}

function hasStoredAttachmentNumbers(record: Record<string, unknown>): boolean {
  return (
    isNonNegativeSafeInteger(record.sessionRotationCount) &&
    isPositiveSafeInteger(record.sizeBytes) &&
    record.sizeBytes <= MAX_ATTACHMENT_BYTES &&
    hasValidStoredTimeline(record.createdAt, record.expiresAt)
  );
}

function isStoredAttachment(value: unknown, ref: string): value is StoredAttachment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    REF_PATTERN.test(ref) &&
    record.schemaVersion === 1 &&
    hasStoredAttachmentStrings(record) &&
    hasStoredAttachmentNumbers(record)
  );
}

function encodedBase64Length(sizeBytes: number): number {
  return 4 * Math.ceil(sizeBytes / 3);
}

function decodeVerified(stored: StoredAttachment): Buffer {
  if (stored.contentBase64.length !== encodedBase64Length(stored.sizeBytes)) {
    throw new ConversationAttachmentStoreError();
  }
  const bytes = Buffer.from(stored.contentBase64, "base64");
  if (
    bytes.length !== stored.sizeBytes ||
    bytes.toString("base64") !== stored.contentBase64 ||
    sha256(bytes) !== stored.sha256
  ) {
    throw new ConversationAttachmentStoreError();
  }
  return bytes;
}

interface VerifiedStoredAttachment {
  readonly stored: StoredAttachment;
  readonly bytes: Buffer;
}

function readStored(vault: LocalSecretVault, ref: string): VerifiedStoredAttachment {
  const raw = vault.get(ref);
  let parsed: unknown;
  try {
    parsed = raw === undefined ? undefined : JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ConversationAttachmentStoreError();
    throw error;
  }
  if (!isStoredAttachment(parsed, ref)) throw new ConversationAttachmentStoreError();
  return { stored: parsed, bytes: decodeVerified(parsed) };
}

function readStoredForScan(
  vault: LocalSecretVault,
  ref: string,
): VerifiedStoredAttachment | undefined {
  try {
    return readStored(vault, ref);
  } catch (error) {
    if (error instanceof ConversationAttachmentStoreError) return undefined;
    throw error;
  }
}

function sameBinding(stored: StoredAttachment, binding: ConversationAttachmentBinding): boolean {
  const storedMimeType = normalizeAttachmentMime(stored.mimeType);
  return (
    storedMimeType !== undefined &&
    stored.sessionId === binding.sessionId &&
    stored.sessionRotationCount === binding.sessionRotationCount &&
    stored.projectPath === binding.projectPath &&
    stored.chatId === binding.chatId &&
    storedMimeType === normalizeAttachmentMime(binding.mimeType) &&
    stored.sizeBytes === binding.sizeBytes &&
    stored.sha256 === binding.sha256
  );
}

function validatePut(input: ConversationAttachmentPut): string {
  const mimeType = normalizeAttachmentMime(input.mimeType);
  if (
    mimeType === undefined ||
    classifyAttachmentMime(input.mimeType) !== "image" ||
    input.bytes.length === 0 ||
    input.bytes.length > MAX_ATTACHMENT_BYTES ||
    !isNonNegativeSafeInteger(input.sessionRotationCount) ||
    input.sizeBytes !== input.bytes.length ||
    !SHA_PATTERN.test(input.sha256) ||
    sha256(input.bytes) !== input.sha256
  ) {
    throw new ConversationAttachmentStoreError();
  }
  return mimeType;
}

interface LiveAttachmentUsage {
  readonly bytes: number;
  readonly entries: number;
}

function currentLiveUsage(vault: LocalSecretVault, now: number): LiveAttachmentUsage {
  let bytes = 0;
  let entries = 0;
  for (const ref of vault.list()) {
    const verified = readStoredForScan(vault, ref);
    if (verified === undefined) {
      // This dedicated vault cannot safely resolve a malformed record. Remove it without logging
      // body-bearing parse context so it can neither consume quota nor block later valid uploads.
      vault.delete(ref);
      continue;
    }
    const { stored } = verified;
    if (stored.expiresAt <= now) {
      vault.delete(ref);
    } else {
      // A wall-clock rollback can make a valid record appear future-created. It remains live and
      // authority-bound; the byte and cardinality caps bound its quota impact until expiry.
      bytes += stored.sizeBytes;
      entries += 1;
    }
  }
  return { bytes, entries };
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
  const mimeType = validatePut(input);
  const createdAt = runtime.now();
  const expiresAt = createdAt + runtime.ttlMs;
  if (!hasValidStoredTimeline(createdAt, expiresAt)) {
    throw new ConversationAttachmentStoreError();
  }
  const usage = currentLiveUsage(vault, createdAt);
  if (usage.entries >= MAX_LIVE_ENTRIES || usage.bytes + input.sizeBytes > runtime.totalBytes) {
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
    mimeType,
    sizeBytes: input.sizeBytes,
    sha256: input.sha256,
    createdAt,
    expiresAt,
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
  const { stored, bytes } = readStored(vault, ref);
  const now = runtime.now();
  if (stored.expiresAt <= now) {
    vault.delete(ref);
    throw new ConversationAttachmentStoreError();
  }
  // A clock rollback makes a valid record appear future-created. Keep it quota-bound and sealed,
  // but do not release its bytes until the clock again reaches the original authority start.
  if (stored.createdAt > now) throw new ConversationAttachmentStoreError();
  if (!sameBinding(stored, binding)) throw new ConversationAttachmentStoreError();
  return bytes;
}

function deleteBoundAttachment(
  runtime: AttachmentStoreRuntime,
  ref: string,
  binding: ConversationAttachmentBinding,
): void {
  const vault = runtime.getVault();
  if (!REF_PATTERN.test(ref)) throw new ConversationAttachmentStoreError();
  const { stored } = readStored(vault, ref);
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
  const refsToDelete: string[] = [];
  for (const ref of vault.list()) {
    const verified = readStoredForScan(vault, ref);
    // This dedicated vault contains only attachment custody. A malformed record has no binding
    // that can be trusted or recovered, so include it in the same two-phase purge used for the
    // selected chat. Collection finishes before deletion, preserving fail-closed behavior for
    // genuine vault failures while ensuring corrupt custody cannot block a hard purge forever.
    if (verified === undefined) {
      refsToDelete.push(ref);
      continue;
    }
    const { stored } = verified;
    if (stored.projectPath === projectPath && stored.chatId === chatId) refsToDelete.push(ref);
  }
  for (const ref of refsToDelete) vault.delete(ref);
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
