import { createHash, randomUUID } from "node:crypto";

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
  closeSession(handle: string): boolean;
  dispose(): void;
  lookupSession(handle: string): PdfCitationPreviewSessionLookup;
  openSession(
    authority: PdfCitationPreviewAuthority,
    source: PdfCitationPreviewSource,
  ): OpenPdfCitationPreviewSessionResult;
  sweep(): void;
}

interface MutableSessionRecord {
  authority: PdfCitationPreviewAuthority;
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

function documentKey(authority: PdfCitationPreviewAuthority): string {
  const current = authority.current;
  const citation = authority.citation;
  return sha256Hex(
    JSON.stringify({
      capsuleId: citation.lineage.capsuleId,
      documentId: citation.lineage.documentId,
      mediaType: current?.documentMediaType ?? citation.documentMediaType,
      sourceId: citation.lineage.sourceId,
      storedContentHash: citation.documentContentHash,
    }),
  ).slice(0, 32);
}

function toSession(record: MutableSessionRecord): PdfCitationPreviewSession {
  return {
    authority: record.authority,
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

function sweepRecords(state: ManagerState): void {
  const nowMs = state.now();
  for (const [handle, record] of state.byHandle) {
    if (record.state === "open" && nowMs >= record.expiresAtMs) {
      settleRecord(state, record, "expired");
      continue;
    }
    if (
      record.state !== "open" &&
      record.settledAtMs !== undefined &&
      nowMs - record.settledAtMs >= SETTLED_RETENTION_MS
    ) {
      state.byHandle.delete(handle);
    }
  }
}

function lookupOpenRecord(
  state: ManagerState,
  authority: PdfCitationPreviewAuthority,
): MutableSessionRecord | undefined {
  const key = documentKey(authority);
  const handle = state.byDocumentKey.get(key);
  if (handle === undefined) return undefined;
  const record = state.byHandle.get(handle);
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
  sweepRecords(state);
  return state.byHandle.get(handle);
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
): OpenPdfCitationPreviewSessionResult {
  sweepRecords(state);
  const existing = lookupOpenRecord(state, authority);
  const expiresAtMs = state.now() + state.ttlMs;
  if (existing !== undefined) {
    existing.authority = authority;
    existing.expiresAtMs = expiresAtMs;
    existing.source = source;
    return { reused: true, session: toSession(existing) };
  }
  const record: MutableSessionRecord = {
    authority,
    documentKey: documentKey(authority),
    expiresAtMs,
    handle: randomUUID(),
    source,
    state: "open",
  };
  state.byHandle.set(record.handle, record);
  state.byDocumentKey.set(record.documentKey, record.handle);
  return { reused: false, session: toSession(record) };
}

function lookupSessionResult(state: ManagerState, handle: string): PdfCitationPreviewSessionLookup {
  const record = lookupSessionRecord(state, handle);
  if (record === undefined) return { kind: "missing" };
  if (record.state === "closed") return { kind: "closed", session: toSession(record) };
  if (record.state === "expired") return { kind: "expired", session: toSession(record) };
  return { kind: "open", session: toSession(record) };
}

export function createPdfCitationPreviewSessionManager(
  options: PdfCitationPreviewSessionManagerOptions = {},
): PdfCitationPreviewSessionManager {
  const state = createManagerState(options);
  const sweepTimer = createSweepTimer(options, state);
  return {
    closeSession: (handle): boolean => closeSessionRecord(state, handle),
    dispose(): void {
      if (sweepTimer !== undefined) {
        clearInterval(sweepTimer);
      }
      state.byDocumentKey.clear();
      state.byHandle.clear();
    },
    lookupSession: (handle): PdfCitationPreviewSessionLookup => lookupSessionResult(state, handle),
    openSession: (authority, source): OpenPdfCitationPreviewSessionResult =>
      openSessionRecord(state, authority, source),
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
