import { realpathSync } from "node:fs";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { canonicalise, redact, sha256Hex } from "@oscharko-dev/keiko-security";
import {
  isPrDescriptionApplicationStatus,
  type PrDescriptionApplicationStatus,
} from "@oscharko-dev/keiko-contracts/runtime/pr-description-application";
import { codingWorkbenchRemoteDigest } from "../coding-context/githubIssueResolution.js";
import { deriveRepositoryId } from "../task-workspace/naming.js";
import { describeError } from "../diagnostics-log.js";
import { processServerLogSink } from "../process-log-sink.js";
import type { ServerLogSink } from "../observability/server-log.js";
import type { PrDescriptionContext } from "./prDescriptionTypes.js";
import type {
  PrDescriptionReceiptRead,
  PrDescriptionReceiptStatusHooks,
  PrDescriptionReceiptStore,
} from "./prDescriptionReceiptTypes.js";
import { validDescriptionContext } from "./prDescriptionPreparation.js";

const PREFIX = "git-pr-description-";
const MAX_BYTES = 8192;
const MAX_REVISION = 1_000_000;
/** Shared ceiling for both the durable receipt document count and the in-process version cache. */
export const MAX_DOCUMENTS = 512;
interface ReceiptDocument {
  readonly schemaVersion: "1";
  readonly scopeDigest: string;
  readonly revision: number;
  readonly status: PrDescriptionApplicationStatus;
}
interface ReceiptScope {
  readonly repositoryId: string;
  readonly remoteDigest: string;
  readonly repository: string;
  readonly prNumber: number;
  readonly digest: string;
}
export interface PrDescriptionReceiptStoreOptions {
  readonly evidenceStore: EvidenceStore;
  readonly redact: (value: string) => string;
  readonly now?: () => number;
  readonly log?: ServerLogSink;
}
class ReceiptFailure extends Error {
  public constructor(public readonly reason: "storage-unavailable" | "receipt-conflict") {
    super(reason);
    this.name = "PrDescriptionReceiptFailure";
  }
}
function scopeFor(context: PrDescriptionContext): ReceiptScope {
  if (!validDescriptionContext(context)) throw new ReceiptFailure("receipt-conflict");
  const fields = {
    repositoryId: deriveRepositoryId(realpathSync(context.workspace.root)),
    remoteDigest: codingWorkbenchRemoteDigest(context.repository),
    repository: context.repository.toLowerCase(),
    prNumber: context.prNumber,
  };
  return {
    ...fields,
    digest: sha256Hex(canonicalise({ domain: "keiko-pr-description-receipt-v1", ...fields })),
  };
}
function statusMatchesScope(status: PrDescriptionApplicationStatus, scope: ReceiptScope): boolean {
  const binding = status.binding;
  return (
    binding.repositoryId === scope.repositoryId &&
    binding.remoteDigest === scope.remoteDigest &&
    binding.repository.toLowerCase() === scope.repository &&
    binding.prNumber === scope.prNumber
  );
}
function documentEnvelope(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 4
  );
}
function validRevision(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_REVISION
  );
}
function documentShape(value: unknown): value is ReceiptDocument {
  if (!documentEnvelope(value)) return false;
  return (
    value.schemaVersion === "1" &&
    typeof value.scopeDigest === "string" &&
    /^[a-f0-9]{64}$/u.test(value.scopeDigest) &&
    validRevision(value.revision) &&
    isPrDescriptionApplicationStatus(value.status)
  );
}
function parseDocument(json: string | undefined, scope: ReceiptScope): ReceiptDocument | undefined {
  if (json === undefined) return undefined;
  if (Buffer.byteLength(json, "utf8") > MAX_BYTES) throw new ReceiptFailure("storage-unavailable");
  const value: unknown = JSON.parse(json);
  if (
    !documentShape(value) ||
    value.scopeDigest !== scope.digest ||
    !statusMatchesScope(value.status, scope)
  )
    throw new ReceiptFailure("storage-unavailable");
  return value;
}
function receiptVersion(value: ReceiptDocument | undefined): string | null {
  return value === undefined ? null : sha256Hex(canonicalise(value));
}
function readResult(value: ReceiptDocument | undefined): PrDescriptionReceiptRead {
  if (value === undefined) return { ok: true, version: null };
  return {
    ok: true,
    version: sha256Hex(canonicalise(value)),
    status: structuredClone(value.status),
  };
}
function validateTransition(
  previous: ReceiptDocument | undefined,
  next: PrDescriptionApplicationStatus,
): void {
  if (previous === undefined) {
    if (next.reason !== "recovery-required" || next.effect !== "uncertain")
      throw new ReceiptFailure("receipt-conflict");
    return;
  }
  if (
    Date.parse(next.observedAt) < Date.parse(previous.status.observedAt) ||
    next.binding.prExternalId !== previous.status.binding.prExternalId
  )
    throw new ReceiptFailure("receipt-conflict");
  const same = canonicalise(next.binding) === canonicalise(previous.status.binding);
  if ((previous.status.effect === "uncertain" || next.effect !== "uncertain") && !same)
    throw new ReceiptFailure("receipt-conflict");
}
function checkedStatus(
  options: PrDescriptionReceiptStoreOptions,
  scope: ReceiptScope,
  status: PrDescriptionApplicationStatus,
  now: number,
): PrDescriptionApplicationStatus {
  if (!isPrDescriptionApplicationStatus(status) || !statusMatchesScope(status, scope))
    throw new ReceiptFailure("receipt-conflict");
  if (Date.parse(status.observedAt) > now || Date.parse(status.expiresAt) <= now)
    throw new ReceiptFailure("receipt-conflict");
  const json = JSON.stringify(status);
  if (
    Buffer.byteLength(json, "utf8") > MAX_BYTES ||
    options.redact(json) !== json ||
    redact(json) !== json
  )
    throw new ReceiptFailure("storage-unavailable");
  return structuredClone(status);
}
function nextDocument(
  options: PrDescriptionReceiptStoreOptions,
  scope: ReceiptScope,
  status: PrDescriptionApplicationStatus,
  expected: string | null,
  existing: string | undefined,
): ReceiptDocument {
  const previous = parseDocument(existing, scope);
  if (receiptVersion(previous) !== expected) throw new ReceiptFailure("receipt-conflict");
  validateTransition(previous, status);
  if (
    previous === undefined &&
    options.evidenceStore.list().filter((id) => id.startsWith(PREFIX)).length >= MAX_DOCUMENTS
  )
    throw new ReceiptFailure("storage-unavailable");
  const revision = (previous?.revision ?? 0) + 1;
  if (revision > MAX_REVISION) throw new ReceiptFailure("storage-unavailable");
  return { schemaVersion: "1", scopeDigest: scope.digest, revision, status };
}
function failure(
  options: PrDescriptionReceiptStoreOptions,
  context: PrDescriptionContext,
  phase: "read" | "record",
  error: unknown,
): PrDescriptionReceiptRead {
  const reason = error instanceof ReceiptFailure ? error.reason : "storage-unavailable";
  (options.log ?? processServerLogSink()).write({
    category: "process",
    op: "git.pr-description.receipt",
    correlationId: context.correlationId,
    level: "warn",
    errorKind: "internal",
    extra: { phase, reason, ...describeError(error) },
  });
  return { ok: false, reason };
}
export function createPrDescriptionReceiptStore(
  options: PrDescriptionReceiptStoreOptions,
): PrDescriptionReceiptStore {
  return {
    readStatus: (context) => readReceipt(options, context),
    recordStatus: (context, status, expected) => recordReceipt(options, context, status, expected),
  };
}
function readReceipt(
  options: PrDescriptionReceiptStoreOptions,
  context: PrDescriptionContext,
): PrDescriptionReceiptRead {
  try {
    if (options.evidenceStore.update === undefined) throw new ReceiptFailure("storage-unavailable");
    const scope = scopeFor(context);
    const document = parseDocument(options.evidenceStore.get(PREFIX + scope.digest), scope);
    if (!validDescriptionContext(context)) throw new ReceiptFailure("receipt-conflict");
    return readResult(document);
  } catch (error) {
    return failure(options, context, "read", error);
  }
}
function recordReceipt(
  options: PrDescriptionReceiptStoreOptions,
  context: PrDescriptionContext,
  supplied: PrDescriptionApplicationStatus,
  expected: string | null,
): PrDescriptionReceiptRead {
  try {
    const update = options.evidenceStore.update;
    if (update === undefined) throw new ReceiptFailure("storage-unavailable");
    const scope = scopeFor(context);
    const now = (options.now ?? Date.now)();
    const status = checkedStatus(options, scope, supplied, now);
    let committed: ReceiptDocument | undefined;
    update.call(options.evidenceStore, PREFIX + scope.digest, (previous) => {
      if (!validDescriptionContext(context)) throw new ReceiptFailure("receipt-conflict");
      committed = nextDocument(options, scope, status, expected, previous);
      const json = JSON.stringify(committed);
      if (Buffer.byteLength(json, "utf8") > MAX_BYTES)
        throw new ReceiptFailure("storage-unavailable");
      return json;
    });
    if (committed === undefined || !validDescriptionContext(context))
      throw new ReceiptFailure("receipt-conflict");
    const result = readResult(committed);
    (options.log ?? processServerLogSink()).write({
      category: "process",
      op: "git.pr-description.receipt",
      correlationId: context.correlationId,
      extra: {
        phase: "record",
        revision: committed.revision,
        state: committed.status.state,
        scopeDigest: scope.digest,
      },
    });
    return result;
  } catch (error) {
    return failure(options, context, "record", error);
  }
}
/**
 * Bridges the durable, expected-version CAS receipt store into the plain boolean/undefined
 * `recordStatus`/`readStatus` hook shape `PrDescriptionServiceOptions` expects, so the
 * application service persists across restarts instead of the fixture-only in-memory field it
 * previously depended on. The expected version for a write is served from an in-process cache
 * (populated by the last read or write this instance observed) rather than a fresh read on every
 * call, so a write made through a stale cache — another instance having advanced the receipt in
 * the meantime — surfaces as a rejected compare-and-swap instead of silently overwriting it. A
 * cache miss (a fresh instance, e.g. after a restart) falls back to one read of the underlying
 * store to recover the current version before writing; a failed read leaves the write refused
 * (fail closed) rather than guessing "absent".
 */
export function createPrDescriptionReceiptStatusHooks(
  store: PrDescriptionReceiptStore,
): PrDescriptionReceiptStatusHooks {
  const versions = new Map<string, string | null>();
  return {
    readStatus: (context) => readHookStatus(store, versions, context),
    recordStatus: (context, status) => recordHookStatus(store, versions, context, status),
  };
}
function hookScopeKey(context: PrDescriptionContext): string | undefined {
  try {
    return scopeFor(context).digest;
  } catch {
    return undefined;
  }
}
/**
 * Bounds the in-process version cache the same way approvalStore.ts bounds its map: once the
 * cache exceeds MAX_DOCUMENTS distinct repo+PR scopes, the oldest entry by insertion order is
 * evicted (Map iteration order is insertion order, and `set` on an existing key never moves it).
 * A dropped entry is not silently unsafe — a subsequent write for it is a cache miss, which
 * `expectedVersionFor` recovers with one fresh read of the underlying store before writing.
 */
function setCachedVersion(
  versions: Map<string, string | null>,
  key: string,
  version: string | null,
): void {
  versions.set(key, version);
  while (versions.size > MAX_DOCUMENTS) {
    const oldest = versions.keys().next().value;
    if (oldest === undefined) break;
    versions.delete(oldest);
  }
}
function expectedVersionFor(
  store: PrDescriptionReceiptStore,
  versions: Map<string, string | null>,
  key: string,
  context: PrDescriptionContext,
): string | null | undefined {
  const cached = versions.get(key);
  if (cached !== undefined) return cached;
  const read = store.readStatus(context);
  if (!read.ok) return undefined;
  setCachedVersion(versions, key, read.version);
  return read.version;
}
function readHookStatus(
  store: PrDescriptionReceiptStore,
  versions: Map<string, string | null>,
  context: PrDescriptionContext,
): PrDescriptionApplicationStatus | undefined {
  const read = store.readStatus(context);
  if (!read.ok) return undefined;
  const key = hookScopeKey(context);
  if (key !== undefined) setCachedVersion(versions, key, read.version);
  return read.version === null ? undefined : structuredClone(read.status);
}
function recordHookStatus(
  store: PrDescriptionReceiptStore,
  versions: Map<string, string | null>,
  context: PrDescriptionContext,
  status: PrDescriptionApplicationStatus,
): boolean {
  const key = hookScopeKey(context);
  if (key === undefined) {
    // The scope digest could not be derived (e.g. an invalid/revoked context). Forward to the
    // store anyway — its own scopeFor validation rejects the same context and logs the failure
    // via failure(), the same way readHookStatus always calls store.readStatus first. Without
    // this, an invalid context short-circuited here and never reached the store's logging.
    store.recordStatus(context, status, null);
    return false;
  }
  const expected = expectedVersionFor(store, versions, key, context);
  if (expected === undefined) return false;
  const result = store.recordStatus(context, status, expected);
  if (!result.ok) {
    versions.delete(key);
    return false;
  }
  setCachedVersion(versions, key, result.version);
  return true;
}
