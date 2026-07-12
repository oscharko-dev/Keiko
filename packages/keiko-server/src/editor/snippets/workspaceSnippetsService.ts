import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  EDITOR_M7_SNIPPET_COLLECTION_VERSION,
  compileEditorM7SnippetBody,
  matchingEditorM7Snippets,
  parseEditorM7WorkspaceSnippetCollection,
  type EditorM7ReasonCode,
  type EditorM7SnippetCompletion,
  type EditorM7WorkspaceSnippet,
  type EditorM7WorkspaceSnippetInput,
  type EditorM7WorkspaceSnippetMutationResult,
  type EditorM7WorkspaceSnippetSnapshot,
} from "@oscharko-dev/keiko-contracts";

import { assertNoSymlinkedPathSegments, savePrivateJson } from "../../private-json.js";
import type { WorkspaceMutexRegistry } from "../../task-workspace/mutex.js";

const MAX_RECORD_BYTES = 512 * 1024;
const MAX_IDEMPOTENCY_RECORDS = 64;

export type WorkspaceSnippetsStoreState = "absent" | "ready" | "unavailable";

export interface WorkspaceSnippetCompletionRequest {
  readonly realRoot: string;
  readonly languageId: string;
  readonly relativePath: string;
  readonly prefix: string;
  readonly insertionSafe: boolean;
  readonly signal?: AbortSignal | undefined;
}

export interface WorkspaceSnippetMutation {
  readonly realRoot: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly action: "replace" | "reset";
  readonly snippets?: readonly EditorM7WorkspaceSnippetInput[] | undefined;
}

export interface WorkspaceSnippetsService {
  readonly stateDir: string;
  readonly read: (realRoot: string) => EditorM7WorkspaceSnippetSnapshot;
  readonly mutate: (
    mutation: WorkspaceSnippetMutation,
  ) => Promise<EditorM7WorkspaceSnippetMutationResult>;
  readonly completions: (
    request: WorkspaceSnippetCompletionRequest,
  ) => readonly EditorM7SnippetCompletion[];
  readonly subscribe: (listener: WorkspaceSnippetsEventListener) => () => void;
}

export interface WorkspaceSnippetsServiceOptions {
  readonly stateDir: string;
  readonly mutex: WorkspaceMutexRegistry;
  readonly save?: ((path: string, value: Record<string, unknown>) => void) | undefined;
  readonly read?: ((path: string) => string) | undefined;
  readonly size?: ((path: string) => number) | undefined;
}

export interface WorkspaceSnippetsChangeEvent {
  readonly schemaVersion: typeof EDITOR_M7_SNIPPET_COLLECTION_VERSION;
  readonly sequence: number;
  readonly workspaceFingerprint: string;
  readonly revision: number;
  readonly action: "replace" | "reset";
  readonly snippetCount: number;
}

export type WorkspaceSnippetsEventListener = (event: WorkspaceSnippetsChangeEvent) => void;

interface IdempotencyRecord {
  readonly keyHash: string;
  readonly requestHash: string;
  readonly changed: boolean;
  readonly revision: number;
}

interface StoredSnippetRecord {
  readonly kind: "workspace-snippets";
  readonly schemaVersion: typeof EDITOR_M7_SNIPPET_COLLECTION_VERSION;
  readonly workspaceFingerprint: string;
  readonly revision: number;
  readonly snippets: readonly EditorM7WorkspaceSnippet[];
  readonly idempotency: readonly IdempotencyRecord[];
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function workspaceSnippetsFingerprint(realRoot: string): string {
  return sha256(realRoot);
}

function recordPath(stateDir: string, realRoot: string): string {
  return join(stateDir, `editor-snippets-${workspaceSnippetsFingerprint(realRoot)}.json`);
}

function emptyRecord(realRoot: string): StoredSnippetRecord {
  return {
    kind: "workspace-snippets",
    schemaVersion: EDITOR_M7_SNIPPET_COLLECTION_VERSION,
    workspaceFingerprint: workspaceSnippetsFingerprint(realRoot),
    revision: 0,
    snippets: [],
    idempotency: [],
  };
}

function etag(record: StoredSnippetRecord): string {
  return `"edsn-${record.revision.toString()}-${record.workspaceFingerprint.slice(0, 24)}"`;
}

function snapshot(
  state: WorkspaceSnippetsStoreState,
  record: StoredSnippetRecord,
): EditorM7WorkspaceSnippetSnapshot {
  return {
    schemaVersion: EDITOR_M7_SNIPPET_COLLECTION_VERSION,
    storeState: state,
    revision: record.revision,
    etag: etag(record),
    workspaceFingerprint: record.workspaceFingerprint,
    snippets: record.snippets,
  };
}

function validIdempotency(value: unknown): value is readonly IdempotencyRecord[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_IDEMPOTENCY_RECORDS &&
    value.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "keyHash" in entry &&
        "requestHash" in entry &&
        "changed" in entry &&
        "revision" in entry,
    )
  );
}

function parseRecord(value: unknown, realRoot: string): StoredSnippetRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind !== "workspace-snippets") return undefined;
  if (typeof value.workspaceFingerprint !== "string") return undefined;
  if (!validIdempotency(value.idempotency)) return undefined;
  const parsed = parseEditorM7WorkspaceSnippetCollection({
    schemaVersion: value.schemaVersion,
    revision: value.revision,
    snippets: value.snippets,
  });
  if (!parsed.ok) return undefined;
  if (value.workspaceFingerprint !== workspaceSnippetsFingerprint(realRoot)) return undefined;
  return {
    kind: "workspace-snippets",
    schemaVersion: EDITOR_M7_SNIPPET_COLLECTION_VERSION,
    workspaceFingerprint: value.workspaceFingerprint,
    revision: parsed.value.revision,
    snippets: parsed.value.snippets,
    idempotency: value.idempotency,
  };
}

function loadRecord(
  realRoot: string,
  options: WorkspaceSnippetsServiceOptions,
): { readonly state: WorkspaceSnippetsStoreState; readonly record: StoredSnippetRecord } {
  const empty = emptyRecord(realRoot);
  const path = recordPath(options.stateDir, realRoot);
  try {
    assertNoSymlinkedPathSegments(path);
    if (!existsSync(path)) return { state: "absent", record: empty };
    const size = options.size?.(path) ?? statSync(path).size;
    if (size > MAX_RECORD_BYTES) return { state: "unavailable", record: empty };
    const raw = JSON.parse(options.read?.(path) ?? readFileSync(path, "utf8")) as unknown;
    const record = parseRecord(raw, realRoot);
    return record === undefined
      ? { state: "unavailable", record: empty }
      : { state: "ready", record };
  } catch {
    return { state: "unavailable", record: empty };
  }
}

function normalizeSnippet(
  input: EditorM7WorkspaceSnippetInput,
  revision: number,
  realRoot: string,
): EditorM7WorkspaceSnippet {
  return {
    ...input,
    revision,
    provenance: {
      source: "workspace",
      workspaceFingerprint: workspaceSnippetsFingerprint(realRoot),
    },
  };
}

function normalizeSnippets(
  inputs: readonly EditorM7WorkspaceSnippetInput[],
  revision: number,
  realRoot: string,
): readonly EditorM7WorkspaceSnippet[] {
  return inputs.map((input) => normalizeSnippet(input, revision, realRoot));
}

function validateNextSnippets(
  snippets: readonly EditorM7WorkspaceSnippet[],
  revision: number,
): EditorM7ReasonCode | undefined {
  const parsed = parseEditorM7WorkspaceSnippetCollection({
    schemaVersion: EDITOR_M7_SNIPPET_COLLECTION_VERSION,
    revision,
    snippets,
  });
  if (!parsed.ok) return parsed.reasonCode;
  for (const snippet of snippets) {
    const compiled = compileEditorM7SnippetBody(snippet.body);
    if (!compiled.ok) return compiled.reasonCode;
  }
  return undefined;
}

function requestHash(mutation: WorkspaceSnippetMutation): string {
  return sha256(
    JSON.stringify({
      action: mutation.action,
      expectedRevision: mutation.expectedRevision,
      root: workspaceSnippetsFingerprint(mutation.realRoot),
      snippets: mutation.snippets ?? null,
    }),
  );
}

function replay(
  mutation: WorkspaceSnippetMutation,
  record: StoredSnippetRecord,
): EditorM7WorkspaceSnippetMutationResult | undefined {
  const keyHash = sha256(mutation.idempotencyKey);
  const existing = record.idempotency.find((entry) => entry.keyHash === keyHash);
  if (existing === undefined) return undefined;
  if (existing.requestHash !== requestHash(mutation)) {
    return {
      kind: "idempotencyConflict",
      code: "IDEMPOTENCY_KEY_REUSED",
      etag: etag(record),
    };
  }
  return {
    kind: "ok",
    changed: existing.changed,
    revision: record.revision,
    etag: etag(record),
    snapshot: snapshot("ready", record),
  };
}

function nextRecord(
  mutation: WorkspaceSnippetMutation,
  record: StoredSnippetRecord,
): StoredSnippetRecord | { readonly invalid: EditorM7ReasonCode } {
  const revision = record.revision + 1;
  const snippets =
    mutation.action === "reset"
      ? []
      : normalizeSnippets(mutation.snippets ?? [], revision, mutation.realRoot);
  const invalid = validateNextSnippets(snippets, revision);
  if (invalid !== undefined) return { invalid };
  const changed = JSON.stringify(snippets) !== JSON.stringify(record.snippets);
  const nextRevision = changed ? revision : record.revision;
  return {
    ...record,
    revision: nextRevision,
    snippets,
    idempotency: [
      ...record.idempotency,
      {
        keyHash: sha256(mutation.idempotencyKey),
        requestHash: requestHash(mutation),
        changed,
        revision: nextRevision,
      },
    ].slice(-MAX_IDEMPOTENCY_RECORDS),
  };
}

function saveRecord(
  record: StoredSnippetRecord,
  realRoot: string,
  options: WorkspaceSnippetsServiceOptions,
): void {
  const path = recordPath(options.stateDir, realRoot);
  (options.save ?? savePrivateJson)(path, record as unknown as Record<string, unknown>);
}

function readWorkspaceSnippets(
  options: WorkspaceSnippetsServiceOptions,
): WorkspaceSnippetsService["read"] {
  return (realRoot: string): EditorM7WorkspaceSnippetSnapshot => {
    const loaded = loadRecord(realRoot, options);
    return snapshot(loaded.state, loaded.record);
  };
}

function emitChange(
  listeners: ReadonlySet<WorkspaceSnippetsEventListener>,
  sequence: number,
  mutation: WorkspaceSnippetMutation,
  record: StoredSnippetRecord,
): void {
  for (const listener of listeners) {
    listener({
      schemaVersion: EDITOR_M7_SNIPPET_COLLECTION_VERSION,
      sequence,
      workspaceFingerprint: record.workspaceFingerprint,
      revision: record.revision,
      action: mutation.action,
      snippetCount: record.snippets.length,
    });
  }
}

function mutateLocked(
  options: WorkspaceSnippetsServiceOptions,
  listeners: ReadonlySet<WorkspaceSnippetsEventListener>,
  nextSequence: () => number,
  mutation: WorkspaceSnippetMutation,
): EditorM7WorkspaceSnippetMutationResult {
  const loaded = loadRecord(mutation.realRoot, options);
  if (loaded.state === "unavailable") return { kind: "unavailable", code: "STATE_UNAVAILABLE" };
  const prior = replay(mutation, loaded.record);
  if (prior !== undefined) return prior;
  if (loaded.record.revision !== mutation.expectedRevision) {
    return { kind: "conflict", code: "STALE_REVISION", etag: etag(loaded.record) };
  }
  const next = nextRecord(mutation, loaded.record);
  if ("invalid" in next) return { kind: "invalid", code: next.invalid };
  const changed = next.revision !== loaded.record.revision;
  if (changed || next.idempotency.length !== loaded.record.idempotency.length) {
    saveRecord(next, mutation.realRoot, options);
  }
  if (changed) emitChange(listeners, nextSequence(), mutation, next);
  return {
    kind: "ok",
    changed,
    revision: next.revision,
    etag: etag(next),
    snapshot: snapshot("ready", next),
  };
}

function mutateWorkspaceSnippets(
  options: WorkspaceSnippetsServiceOptions,
  listeners: ReadonlySet<WorkspaceSnippetsEventListener>,
  nextSequence: () => number,
): WorkspaceSnippetsService["mutate"] {
  return (mutation: WorkspaceSnippetMutation): Promise<EditorM7WorkspaceSnippetMutationResult> =>
    options.mutex.runExclusive(
      [`editor-snippets:${workspaceSnippetsFingerprint(mutation.realRoot)}`],
      () => mutateLocked(options, listeners, nextSequence, mutation),
    );
}

function completeWorkspaceSnippets(
  options: WorkspaceSnippetsServiceOptions,
): WorkspaceSnippetsService["completions"] {
  return (request: WorkspaceSnippetCompletionRequest): readonly EditorM7SnippetCompletion[] => {
    const loaded = loadRecord(request.realRoot, options);
    return matchingEditorM7Snippets({
      collection: {
        schemaVersion: EDITOR_M7_SNIPPET_COLLECTION_VERSION,
        revision: loaded.record.revision,
        snippets: loaded.record.snippets,
      },
      languageId: request.languageId,
      relativePath: request.relativePath,
      prefix: request.prefix,
      insertionSafe: request.insertionSafe && loaded.state !== "unavailable",
      signal: request.signal,
    });
  };
}

function subscribeWorkspaceSnippets(
  listeners: Set<WorkspaceSnippetsEventListener>,
): WorkspaceSnippetsService["subscribe"] {
  return (listener: WorkspaceSnippetsEventListener): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
}

export function createWorkspaceSnippetsService(
  options: WorkspaceSnippetsServiceOptions,
): WorkspaceSnippetsService {
  const listeners = new Set<WorkspaceSnippetsEventListener>();
  let sequence = 0;
  const nextSequence = (): number => {
    sequence += 1;
    return sequence;
  };
  return {
    stateDir: options.stateDir,
    read: readWorkspaceSnippets(options),
    mutate: mutateWorkspaceSnippets(options, listeners, nextSequence),
    completions: completeWorkspaceSnippets(options),
    subscribe: subscribeWorkspaceSnippets(listeners),
  };
}
