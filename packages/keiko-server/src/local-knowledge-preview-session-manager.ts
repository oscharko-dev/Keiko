import { createHash, randomUUID } from "node:crypto";

import type { PdfCitationPreviewSelection } from "@oscharko-dev/keiko-contracts";

import type { UiHandlerDeps } from "./deps.js";
import type { PdfCitationPreviewAuthority } from "./local-knowledge-preview-service.js";
import type { PdfCitationPreviewSource } from "./local-knowledge-preview-delivery.js";

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const SETTLED_RETENTION_MS = 10 * 60_000;

export interface PdfCitationPreviewSessionManagerOptions {
  readonly autoSweep?: boolean;
  readonly now?: () => number;
  readonly sweepIntervalMs?: number;
  readonly ttlMs?: number;
}

export interface PdfCitationPreviewSession {
  readonly authority: PdfCitationPreviewAuthority;
  readonly context: PdfCitationPreviewSelection;
  readonly documentKey: string;
  readonly expiresAt: string;
  readonly handle: string;
  readonly source: PdfCitationPreviewSource;
  readonly state: "closed" | "expired" | "open";
}

export interface OpenPdfCitationPreviewSessionResult {
  readonly session: PdfCitationPreviewSession;
  readonly reused: boolean;
}

export type PdfCitationPreviewSessionLookup =
  | { readonly kind: "missing" }
  | { readonly kind: "closed"; readonly session: PdfCitationPreviewSession }
  | { readonly kind: "expired"; readonly session: PdfCitationPreviewSession }
  | { readonly kind: "open"; readonly session: PdfCitationPreviewSession };

export interface PdfCitationPreviewSessionManager {
  beginSessionUse(handle: string): PdfCitationPreviewSessionLookup;
  closeSession(handle: string): boolean;
  dispose(): void;
  endSessionUse(handle: string): void;
  lookupOpenSession(
    authority: PdfCitationPreviewAuthority,
  ): OpenPdfCitationPreviewSessionResult | undefined;
  lookupSession(handle: string): PdfCitationPreviewSessionLookup;
  openSession(
    authority: PdfCitationPreviewAuthority,
    source: PdfCitationPreviewSource,
    context: PdfCitationPreviewSelection,
  ): OpenPdfCitationPreviewSessionResult;
  sweep(): void;
}

interface MutableSessionRecord {
  authority: PdfCitationPreviewAuthority;
  activeUses: number;
  context: PdfCitationPreviewSelection;
  documentKey: string;
  expiresAtMs: number;
  handle: string;
  settledAtMs?: number;
  source: PdfCitationPreviewSource;
  state: "closed" | "expired" | "open";
}

interface ManagerState {
  readonly byDocumentKey: Map<string, string>;
  readonly byHandle: Map<string, MutableSessionRecord>;
  readonly now: () => number;
  readonly ttlMs: number;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sourceKey(source: PdfCitationPreviewSource): Record<string, string | number | undefined> {
  if (source.kind === "blob") {
    return {
      kind: source.kind,
      byteLength: source.byteLength,
      contentHash: source.contentHash,
      documentId: source.documentId,
      sourceId: source.sourceId,
      storageKind: source.storageKind,
    };
  }
  return {
    kind: source.kind,
    absolutePath: source.absolutePath,
    byteLength: source.byteLength,
    contentHash: source.contentHash,
    documentId: source.documentId,
    sourceId: source.sourceId,
    sourceRoot: source.sourceRoot,
  };
}

function documentKey(
  authority: PdfCitationPreviewAuthority,
  source: PdfCitationPreviewSource,
): string {
  const current = authority.current;
  const citation = authority.citation;
  return sha256Hex(
    JSON.stringify({
      capsuleId: citation.lineage.capsuleId,
      documentId: citation.lineage.documentId,
      mediaType: current?.documentMediaType ?? citation.documentMediaType,
      source: sourceKey(source),
      sourceId: citation.lineage.sourceId,
      storedContentHash: citation.documentContentHash,
    }),
  ).slice(0, 32);
}

function authorityKey(authority: PdfCitationPreviewAuthority): string {
  const citation = authority.citation;
  return sha256Hex(
    JSON.stringify({
      stableId: citation.stableId,
      markerIndex: citation.markerIndex,
      capsuleId: citation.lineage.capsuleId,
      sourceId: citation.lineage.sourceId,
      documentId: citation.lineage.documentId,
      chunkId: citation.lineage.chunkId,
      documentMediaType: citation.documentMediaType,
      documentContentHash: citation.documentContentHash,
    }),
  );
}

function sameAuthority(
  left: PdfCitationPreviewAuthority,
  right: PdfCitationPreviewAuthority,
): boolean {
  return authorityKey(left) === authorityKey(right);
}

function toSession(record: MutableSessionRecord): PdfCitationPreviewSession {
  return {
    authority: record.authority,
    context: record.context,
    documentKey: record.documentKey,
    expiresAt: new Date(record.expiresAtMs).toISOString(),
    handle: record.handle,
    source: record.source,
    state: record.state,
  };
}

function settleRecord(
  state: ManagerState,
  record: MutableSessionRecord,
  next: "closed" | "expired",
): void {
  record.state = next;
  record.settledAtMs = state.now();
  state.byDocumentKey.delete(record.documentKey);
}

function touchOpenRecord(state: ManagerState, record: MutableSessionRecord): void {
  if (record.state !== "open") return;
  record.expiresAtMs = state.now() + state.ttlMs;
}

function sweepRecords(state: ManagerState): void {
  const nowMs = state.now();
  const recordsToExpire: MutableSessionRecord[] = [];
  const handlesToDelete: string[] = [];
  for (const [handle, record] of state.byHandle) {
    if (record.state === "open" && nowMs >= record.expiresAtMs) {
      if (record.activeUses > 0) {
        continue;
      }
      recordsToExpire.push(record);
      continue;
    }
    if (
      record.state !== "open" &&
      record.settledAtMs !== undefined &&
      nowMs - record.settledAtMs >= SETTLED_RETENTION_MS
    ) {
      handlesToDelete.push(handle);
    }
  }
  for (const record of recordsToExpire) {
    settleRecord(state, record, "expired");
  }
  for (const handle of handlesToDelete) {
    state.byHandle.delete(handle);
  }
}

function expireRecordIfNeeded(state: ManagerState, record: MutableSessionRecord): void {
  if (record.state !== "open" || state.now() < record.expiresAtMs || record.activeUses > 0) {
    return;
  }
  settleRecord(state, record, "expired");
}

function lookupOpenRecord(
  state: ManagerState,
  authority: PdfCitationPreviewAuthority,
  source: PdfCitationPreviewSource | undefined,
): MutableSessionRecord | undefined {
  if (source === undefined) return undefined;
  const key = documentKey(authority, source);
  const handle = state.byDocumentKey.get(key);
  if (handle === undefined) return undefined;
  const record = state.byHandle.get(handle);
  if (record !== undefined) {
    expireRecordIfNeeded(state, record);
  }
  if (record?.state !== "open") {
    state.byDocumentKey.delete(key);
    return undefined;
  }
  return record;
}

function createManagerState(options: PdfCitationPreviewSessionManagerOptions): ManagerState {
  return {
    byDocumentKey: new Map<string, string>(),
    byHandle: new Map<string, MutableSessionRecord>(),
    now: options.now ?? Date.now,
    ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
  };
}

function createSweepTimer(
  options: PdfCitationPreviewSessionManagerOptions,
  state: ManagerState,
): NodeJS.Timeout | undefined {
  if (options.autoSweep === false) return undefined;
  const sweepTimer = setInterval(
    sweepRecords,
    options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
    state,
  );
  sweepTimer.unref();
  return sweepTimer;
}

function lookupSessionRecord(
  state: ManagerState,
  handle: string,
): MutableSessionRecord | undefined {
  const record = state.byHandle.get(handle);
  if (record !== undefined) {
    expireRecordIfNeeded(state, record);
  }
  return record;
}

function closeSessionRecord(state: ManagerState, handle: string): boolean {
  const record = lookupSessionRecord(state, handle);
  if (record?.state !== "open") return false;
  settleRecord(state, record, "closed");
  return true;
}

function openSessionRecord(
  state: ManagerState,
  authority: PdfCitationPreviewAuthority,
  source: PdfCitationPreviewSource,
  context: PdfCitationPreviewSelection,
): OpenPdfCitationPreviewSessionResult {
  const existing = lookupOpenRecord(state, authority, source);
  const expiresAtMs = state.now() + state.ttlMs;
  if (existing !== undefined) {
    existing.authority = authority;
    existing.context = context;
    existing.expiresAtMs = expiresAtMs;
    existing.source = source;
    return { reused: true, session: toSession(existing) };
  }
  const record: MutableSessionRecord = {
    authority,
    activeUses: 0,
    context,
    documentKey: documentKey(authority, source),
    expiresAtMs,
    handle: randomUUID(),
    source,
    state: "open",
  };
  state.byHandle.set(record.handle, record);
  state.byDocumentKey.set(record.documentKey, record.handle);
  return { reused: false, session: toSession(record) };
}

function lookupOpenSessionRecord(
  state: ManagerState,
  authority: PdfCitationPreviewAuthority,
): OpenPdfCitationPreviewSessionResult | undefined {
  for (const record of state.byHandle.values()) {
    expireRecordIfNeeded(state, record);
    if (
      record.state === "open" &&
      record.source.kind === "blob" &&
      sameAuthority(record.authority, authority)
    ) {
      touchOpenRecord(state, record);
      return { reused: true, session: toSession(record) };
    }
  }
  return undefined;
}

function lookupSessionResult(state: ManagerState, handle: string): PdfCitationPreviewSessionLookup {
  const record = lookupSessionRecord(state, handle);
  if (record === undefined) return { kind: "missing" };
  if (record.state === "closed") return { kind: "closed", session: toSession(record) };
  if (record.state === "expired") return { kind: "expired", session: toSession(record) };
  touchOpenRecord(state, record);
  return { kind: "open", session: toSession(record) };
}

function beginSessionUseRecord(
  state: ManagerState,
  handle: string,
): PdfCitationPreviewSessionLookup {
  const record = lookupSessionRecord(state, handle);
  if (record === undefined) return { kind: "missing" };
  if (record.state === "closed") return { kind: "closed", session: toSession(record) };
  if (record.state === "expired") return { kind: "expired", session: toSession(record) };
  record.activeUses += 1;
  touchOpenRecord(state, record);
  return { kind: "open", session: toSession(record) };
}

function endSessionUseRecord(state: ManagerState, handle: string): void {
  const record = state.byHandle.get(handle);
  if (record === undefined || record.activeUses <= 0) return;
  record.activeUses -= 1;
  touchOpenRecord(state, record);
}

export function createPdfCitationPreviewSessionManager(
  options: PdfCitationPreviewSessionManagerOptions = {},
): PdfCitationPreviewSessionManager {
  const state = createManagerState(options);
  const sweepTimer = createSweepTimer(options, state);
  return {
    beginSessionUse: (handle): PdfCitationPreviewSessionLookup =>
      beginSessionUseRecord(state, handle),
    closeSession: (handle): boolean => closeSessionRecord(state, handle),
    dispose(): void {
      if (sweepTimer !== undefined) {
        clearInterval(sweepTimer);
      }
      state.byDocumentKey.clear();
      state.byHandle.clear();
    },
    endSessionUse: (handle): void => { endSessionUseRecord(state, handle); },
    lookupOpenSession: (authority): OpenPdfCitationPreviewSessionResult | undefined =>
      lookupOpenSessionRecord(state, authority),
    lookupSession: (handle): PdfCitationPreviewSessionLookup => lookupSessionResult(state, handle),
    openSession: (authority, source, context): OpenPdfCitationPreviewSessionResult =>
      openSessionRecord(state, authority, source, context),
    sweep(): void {
      sweepRecords(state);
    },
  };
}

const previewSessionManagers = new WeakMap<UiHandlerDeps, PdfCitationPreviewSessionManager>();

export function previewSessionManagerFor(deps: UiHandlerDeps): PdfCitationPreviewSessionManager {
  const injected = deps.pdfCitationPreviewSessions;
  if (injected !== undefined) return injected;
  const existing = previewSessionManagers.get(deps);
  if (existing !== undefined) return existing;
  const created = createPdfCitationPreviewSessionManager();
  previewSessionManagers.set(deps, created);
  return created;
}
