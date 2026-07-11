import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  MANAGED_LSP_LANGUAGES,
  parseManagedLspEvidence,
  parseManagedLspRuntimeConfiguration,
  type ManagedLspEvidence,
  type ManagedLspActivationReasonCode,
  type ManagedLspEffectiveState,
  type ManagedLspLanguage,
  type ManagedLspRuntimeConfiguration,
  type ManagedLspWorkspaceActivationSetting,
} from "@oscharko-dev/keiko-contracts";
import { containsPath } from "@oscharko-dev/keiko-git";

import { assertNoSymlinkedPathSegments, savePrivateJson } from "../../private-json.js";

const STORE_SCHEMA_VERSION = "1" as const;
const MAX_RECORD_BYTES = 1_048_576;
const MAX_EVIDENCE_RECORDS = 128;
const MAX_IDEMPOTENCY_RECORDS = 64;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export interface ManagedLspPersistedLanguageState {
  readonly activation: ManagedLspWorkspaceActivationSetting;
  readonly configuration?: ManagedLspRuntimeConfiguration | undefined;
}

export interface ManagedLspPersistedLanguageEntry extends ManagedLspPersistedLanguageState {
  readonly previous?: ManagedLspPersistedLanguageState | undefined;
}

export interface ManagedLspIdempotencyRecord {
  readonly keyHash: string;
  readonly requestHash: string;
  readonly resultKind: "ok" | "denied";
  readonly changed: boolean;
  readonly revision: number;
  readonly state: ManagedLspEffectiveState;
  readonly reasonCode: ManagedLspActivationReasonCode;
  readonly policyResult: "allowed" | "denied";
}

export interface ManagedLspWorkspaceRecord {
  readonly schemaVersion: typeof STORE_SCHEMA_VERSION;
  readonly workspaceFingerprint: string;
  readonly revision: number;
  readonly languages: Readonly<
    Partial<Record<ManagedLspLanguage, ManagedLspPersistedLanguageEntry>>
  >;
  readonly evidence: readonly ManagedLspEvidence[];
  readonly idempotency: readonly ManagedLspIdempotencyRecord[];
}

export type ManagedLspStoreState = "absent" | "ready" | "unavailable";

export interface ManagedLspStoreLoadResult {
  readonly state: ManagedLspStoreState;
  readonly record: ManagedLspWorkspaceRecord;
}

export interface ManagedLspActivationStore {
  readonly stateDir: string;
  readonly load: (realRoot: string) => ManagedLspStoreLoadResult;
  readonly commit: (realRoot: string, record: ManagedLspWorkspaceRecord) => void;
}

export interface ManagedLspActivationStoreOptions {
  readonly stateDir: string;
  readonly save?: ((path: string, value: Record<string, unknown>) => void) | undefined;
  readonly read?: ((path: string) => string) | undefined;
  readonly size?: ((path: string) => number) | undefined;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function managedLspWorkspaceFingerprint(realRoot: string): string {
  return sha256(realRoot);
}

export function managedLspActivationRecordPath(stateDir: string, realRoot: string): string {
  return join(stateDir, `managed-lsp-${managedLspWorkspaceFingerprint(realRoot)}.json`);
}

export function emptyManagedLspWorkspaceRecord(realRoot: string): ManagedLspWorkspaceRecord {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    workspaceFingerprint: managedLspWorkspaceFingerprint(realRoot),
    revision: 0,
    languages: {},
    evidence: [],
    idempotency: [],
  };
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseLanguageState(value: unknown): ManagedLspPersistedLanguageState | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["activation", "configuration"])) return undefined;
  if (value.activation !== "enabled" && value.activation !== "disabled") return undefined;
  if (value.configuration === undefined) return { activation: value.activation };
  const parsed = parseManagedLspRuntimeConfiguration(value.configuration);
  return parsed.ok ? { activation: value.activation, configuration: parsed.value } : undefined;
}

function parseLanguageEntry(value: unknown): ManagedLspPersistedLanguageEntry | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["activation", "configuration", "previous"])) {
    return undefined;
  }
  const current = parseLanguageState({
    activation: value.activation,
    ...(value.configuration === undefined ? {} : { configuration: value.configuration }),
  });
  if (current === undefined) return undefined;
  if (value.previous === undefined) return current;
  const previous = parseLanguageState(value.previous);
  return previous === undefined ? undefined : { ...current, previous };
}

function parseLanguages(
  value: unknown,
): Readonly<Partial<Record<ManagedLspLanguage, ManagedLspPersistedLanguageEntry>>> | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, MANAGED_LSP_LANGUAGES)) return undefined;
  const result: Partial<Record<ManagedLspLanguage, ManagedLspPersistedLanguageEntry>> = {};
  for (const language of MANAGED_LSP_LANGUAGES) {
    const raw = value[language];
    if (raw === undefined) continue;
    const parsed = parseLanguageEntry(raw);
    if (parsed === undefined) return undefined;
    result[language] = parsed;
  }
  return result;
}

function parseEvidence(value: unknown): readonly ManagedLspEvidence[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_RECORDS) return undefined;
  const result: ManagedLspEvidence[] = [];
  for (const raw of value) {
    const parsed = parseManagedLspEvidence(raw);
    if (!parsed.ok) return undefined;
    result.push(parsed.value);
  }
  return result;
}

function parseIdempotencyRecord(value: unknown): ManagedLspIdempotencyRecord | undefined {
  if (!isRecord(value)) return undefined;
  const allowed = [
    "keyHash",
    "requestHash",
    "resultKind",
    "changed",
    "revision",
    "state",
    "reasonCode",
    "policyResult",
  ] as const;
  if (!hasOnlyKeys(value, allowed) || !validIdempotencyFields(value)) return undefined;
  const status = parseManagedLspEvidence({
    schemaVersion: "1",
    kind: "activationChange",
    action: "activate",
    outcome: value.resultKind === "denied" ? "denied" : "accepted",
    actorClass: "system",
    language: "python",
    priorState: value.state,
    effectiveState: value.state,
    reasonCode: value.reasonCode,
    revision: value.revision,
    timestampMs: 0,
    policyResult: value.policyResult,
  });
  if (!status.ok) return undefined;
  return value as unknown as ManagedLspIdempotencyRecord;
}

function validIdempotencyFields(value: UnknownRecord): boolean {
  return [
    typeof value.keyHash === "string" && SHA256_PATTERN.test(value.keyHash),
    typeof value.requestHash === "string" && SHA256_PATTERN.test(value.requestHash),
    value.resultKind === "ok" || value.resultKind === "denied",
    typeof value.changed === "boolean",
    isRevision(value.revision),
  ].every(Boolean);
}

function parseIdempotency(value: unknown): readonly ManagedLspIdempotencyRecord[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_IDEMPOTENCY_RECORDS) return undefined;
  const result = value.map(parseIdempotencyRecord);
  if (result.includes(undefined)) return undefined;
  return result as readonly ManagedLspIdempotencyRecord[];
}

function parseRecord(value: unknown, fingerprint: string): ManagedLspWorkspaceRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !hasOnlyKeys(value, [
      "schemaVersion",
      "workspaceFingerprint",
      "revision",
      "languages",
      "evidence",
      "idempotency",
    ]) ||
    value.schemaVersion !== STORE_SCHEMA_VERSION ||
    value.workspaceFingerprint !== fingerprint ||
    !isRevision(value.revision)
  ) {
    return undefined;
  }
  const languages = parseLanguages(value.languages);
  const evidence = parseEvidence(value.evidence);
  const idempotency = parseIdempotency(value.idempotency);
  if (languages === undefined || evidence === undefined || idempotency === undefined)
    return undefined;
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    workspaceFingerprint: fingerprint,
    revision: value.revision,
    languages,
    evidence,
    idempotency,
  };
}

function loadRecord(
  path: string,
  realRoot: string,
  options: ManagedLspActivationStoreOptions,
): ManagedLspStoreLoadResult {
  const empty = emptyManagedLspWorkspaceRecord(realRoot);
  if (!safeReadLocation(path, realRoot, options.stateDir)) {
    return { state: "unavailable", record: empty };
  }
  if (!existsSync(path)) return { state: "absent", record: empty };
  try {
    const size = options.size?.(path) ?? statSync(path).size;
    if (size > MAX_RECORD_BYTES) return { state: "unavailable", record: empty };
    const parsed: unknown = JSON.parse(options.read?.(path) ?? readFileSync(path, "utf8"));
    const record = parseRecord(parsed, empty.workspaceFingerprint);
    return record === undefined
      ? { state: "unavailable", record: empty }
      : { state: "ready", record };
  } catch {
    return { state: "unavailable", record: empty };
  }
}

function safeReadLocation(path: string, realRoot: string, stateDir: string): boolean {
  if (containsPath(realRoot, stateDir)) return false;
  try {
    assertNoSymlinkedPathSegments(path);
    return true;
  } catch {
    return false;
  }
}

function recordForWrite(record: ManagedLspWorkspaceRecord): Record<string, unknown> {
  return {
    schemaVersion: record.schemaVersion,
    workspaceFingerprint: record.workspaceFingerprint,
    revision: record.revision,
    languages: record.languages,
    evidence: record.evidence,
    idempotency: record.idempotency,
  };
}

export function createManagedLspActivationStore(
  options: ManagedLspActivationStoreOptions,
): ManagedLspActivationStore {
  const save = options.save ?? savePrivateJson;
  return {
    stateDir: options.stateDir,
    load: (realRoot): ManagedLspStoreLoadResult =>
      loadRecord(managedLspActivationRecordPath(options.stateDir, realRoot), realRoot, options),
    commit: (realRoot, record): void => {
      if (containsPath(realRoot, options.stateDir)) {
        throw new Error("managed LSP state directory must remain outside the workspace");
      }
      if (record.workspaceFingerprint !== managedLspWorkspaceFingerprint(realRoot)) {
        throw new Error("managed LSP workspace identity mismatch");
      }
      save(managedLspActivationRecordPath(options.stateDir, realRoot), recordForWrite(record));
    },
  };
}
