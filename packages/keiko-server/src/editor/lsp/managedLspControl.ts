import { createHash } from "node:crypto";

import {
  MANAGED_LSP_ACTIVATION_SCHEMA_VERSION,
  MANAGED_LSP_EVIDENCE_SCHEMA_VERSION,
  MANAGED_LSP_LANGUAGES,
  parseManagedLspRuntimeConfiguration,
  matchesManagedLspConfigurationPrecondition,
  type ManagedLspActivationResolution,
  type ManagedLspActivationStatus,
  type ManagedLspEvidence,
  type ManagedLspEvidenceAction,
  type ManagedLspEvidenceActorClass,
  type ManagedLspEvidenceOutcome,
  type ManagedLspLanguage,
  type ManagedLspRuntimeConfiguration,
} from "@oscharko-dev/keiko-contracts";

import type { WorkspaceMutexRegistry } from "../../task-workspace/mutex.js";
import type { ManagedLspEvidenceProjector } from "./managedLspEvidenceProjector.js";
import { evaluateManagedLspActivation } from "./managedLspPolicy.js";
import {
  emptyManagedLspWorkspaceRecord,
  managedLspWorkspaceFingerprint,
  type ManagedLspActivationStore,
  type ManagedLspIdempotencyRecord,
  type ManagedLspPersistedLanguageEntry,
  type ManagedLspPersistedLanguageState,
  type ManagedLspStoreState,
  type ManagedLspWorkspaceRecord,
} from "./managedLspActivationStore.js";

const MAX_IDEMPOTENCY_KEY_CHARS = 128;
const MAX_EVIDENCE_RECORDS = 128;
const MAX_IDEMPOTENCY_RECORDS = 64;

export type ManagedLspControlAction =
  "activate" | "deactivate" | "configure" | "reset" | "rollback" | "restart";

export interface ManagedLspControlMutation {
  readonly action: ManagedLspControlAction;
  readonly actorClass: ManagedLspEvidenceActorClass;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly language: ManagedLspLanguage;
  readonly root: string;
  readonly configuration?: ManagedLspRuntimeConfiguration | undefined;
}

export interface ManagedLspControlSnapshot {
  readonly storeState: ManagedLspStoreState;
  readonly revision: number;
  readonly etag: string;
  readonly evidenceCount: number;
  readonly languages: readonly ManagedLspActivationResolution[];
  readonly settings: readonly ManagedLspConfigurationSummary[];
  readonly configurations: readonly ManagedLspRuntimeConfiguration[];
}

export interface ManagedLspConfigurationSummary {
  readonly language: ManagedLspLanguage;
  readonly workspaceActivation: "enabled" | "disabled" | "unset";
  readonly configured: boolean;
  readonly restartRequired: boolean;
  readonly restartFields: readonly ("runtime" | "settings")[];
  readonly provenance: ManagedLspRuntimeConfiguration["provenance"] | null;
}

interface ManagedLspSuccessResult {
  readonly kind: "ok";
  readonly changed: boolean;
  readonly revision: number;
  readonly etag: string;
  readonly status: ManagedLspActivationStatus;
}

interface ManagedLspDeniedResult {
  readonly kind: "denied";
  readonly changed: false;
  readonly revision: number;
  readonly etag: string;
  readonly status: ManagedLspActivationStatus;
}

export type ManagedLspControlResult =
  | ManagedLspSuccessResult
  | ManagedLspDeniedResult
  | { readonly kind: "conflict"; readonly code: "STALE_REVISION"; readonly etag: string }
  | {
      readonly kind: "idempotencyConflict";
      readonly code: "IDEMPOTENCY_KEY_REUSED";
      readonly etag: string;
    }
  | { readonly kind: "invalid"; readonly code: "INVALID_REQUEST" }
  | { readonly kind: "unavailable"; readonly code: "STATE_UNAVAILABLE" };

export interface ManagedLspControlService {
  readonly stateDir: string;
  readonly read: (realRoot: string) => Promise<ManagedLspControlSnapshot>;
  readonly readConfiguration: (
    realRoot: string,
    language: ManagedLspLanguage,
  ) => Promise<ManagedLspRuntimeConfiguration | undefined>;
  readonly mutate: (mutation: ManagedLspControlMutation) => Promise<ManagedLspControlResult>;
}

export interface ManagedLspControlServiceOptions {
  readonly store: ManagedLspActivationStore;
  readonly processEnv: Readonly<Record<string, string | undefined>>;
  readonly provisioning: (realRoot: string, language: ManagedLspLanguage) => boolean;
  readonly disposePoolEntry: (realRoot: string, language: ManagedLspLanguage) => Promise<void>;
  readonly runtimeApproved: (language: ManagedLspLanguage, runtimeId: string) => boolean;
  readonly configurationSafe: (
    root: string,
    configuration: ManagedLspRuntimeConfiguration,
  ) => boolean;
  readonly projectEvidence: ManagedLspEvidenceProjector;
  readonly mutex: WorkspaceMutexRegistry;
  readonly now?: (() => number) | undefined;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function languageToken(language: ManagedLspLanguage): string {
  return language.toUpperCase();
}

function trueLike(value: string): boolean {
  return ["1", "true", "on", "yes", "enabled", "allow", "allowed"].includes(
    value.trim().toLowerCase(),
  );
}

function deploymentPolicy(
  env: Readonly<Record<string, string | undefined>>,
  language: ManagedLspLanguage,
): "allowed" | "denied" {
  const value = env[`KEIKO_EDITOR_LSP_POLICY_${languageToken(language)}`];
  if (value === undefined) return "allowed";
  return trueLike(value) ? "allowed" : "denied";
}

function legacyEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  language: ManagedLspLanguage,
): "enabled" | "disabled" | "unset" {
  const value = env[`KEIKO_EDITOR_LSP_${languageToken(language)}`];
  if (value === undefined) return "unset";
  if (trueLike(value)) return "enabled";
  return "disabled";
}

function unavailableActivation(
  language: ManagedLspLanguage,
  revision: number,
): ManagedLspActivationStatus {
  return {
    ok: true,
    schemaVersion: MANAGED_LSP_ACTIVATION_SCHEMA_VERSION,
    language,
    configurationRevision: revision,
    state: "disabled",
    reasonCode: "STATE_UNAVAILABLE",
    policyResult: "denied",
  };
}

function activationFor(
  realRoot: string,
  record: ManagedLspWorkspaceRecord,
  storeState: ManagedLspStoreState,
  language: ManagedLspLanguage,
  options: ManagedLspControlServiceOptions,
): ManagedLspActivationResolution {
  if (storeState === "unavailable") return unavailableActivation(language, record.revision);
  if (storeState === "absent") {
    return evaluateManagedLspActivation({
      schemaVersion: MANAGED_LSP_ACTIVATION_SCHEMA_VERSION,
      language,
      configurationRevision: 0,
      productSupport: "supported",
      deploymentPolicy: deploymentPolicy(options.processEnv, language),
      provisioning: "provisioned",
      workspaceActivation: "unset",
      legacyEnvironment: legacyEnvironment(options.processEnv, language),
      negotiation: "notStarted",
      runtimeHealth: "unknown",
      restartRequired: false,
    });
  }
  const entry = record.languages[language];
  return evaluateManagedLspActivation({
    schemaVersion: MANAGED_LSP_ACTIVATION_SCHEMA_VERSION,
    language,
    configurationRevision: record.revision,
    productSupport: "supported",
    deploymentPolicy: deploymentPolicy(options.processEnv, language),
    provisioning: options.provisioning(realRoot, language) ? "provisioned" : "notProvisioned",
    workspaceActivation: entry?.activation ?? "unset",
    legacyEnvironment: legacyEnvironment(options.processEnv, language),
    negotiation: "notStarted",
    runtimeHealth: "unknown",
    restartRequired: entry?.configuration?.restartRequired ?? false,
  });
}

function etag(realRoot: string, revision: number): string {
  return `"lspcfg-${String(revision)}-${managedLspWorkspaceFingerprint(realRoot).slice(0, 24)}"`;
}

function snapshot(
  realRoot: string,
  storeState: ManagedLspStoreState,
  record: ManagedLspWorkspaceRecord,
  options: ManagedLspControlServiceOptions,
): ManagedLspControlSnapshot {
  return {
    storeState,
    revision: record.revision,
    etag: etag(realRoot, record.revision),
    evidenceCount: record.evidence.length,
    languages: MANAGED_LSP_LANGUAGES.map((language) =>
      activationFor(realRoot, record, storeState, language, options),
    ),
    settings: MANAGED_LSP_LANGUAGES.map((language) => configurationSummary(record, language)),
    configurations: MANAGED_LSP_LANGUAGES.flatMap((language) => {
      const configuration = record.languages[language]?.configuration;
      return configuration === undefined ? [] : [configuration];
    }),
  };
}

function configurationSummary(
  record: ManagedLspWorkspaceRecord,
  language: ManagedLspLanguage,
): ManagedLspConfigurationSummary {
  const entry = record.languages[language];
  const configuration = entry?.configuration;
  if (configuration === undefined) {
    return {
      language,
      workspaceActivation: entry?.activation ?? "unset",
      configured: false,
      restartRequired: false,
      restartFields: [],
      provenance: null,
    };
  }
  return {
    language,
    workspaceActivation: entry?.activation ?? "unset",
    configured: true,
    restartRequired: configuration.restartRequired,
    restartFields: configuration.restartFields,
    provenance: configuration.provenance,
  };
}

function currentStatus(
  realRoot: string,
  record: ManagedLspWorkspaceRecord,
  language: ManagedLspLanguage,
  options: ManagedLspControlServiceOptions,
): ManagedLspActivationStatus {
  const resolution = activationFor(realRoot, record, "ready", language, options);
  if (resolution.ok) return resolution;
  throw new Error("managed LSP activation invariant failed");
}

function requestHash(mutation: ManagedLspControlMutation): string {
  return hash(
    JSON.stringify({
      action: mutation.action,
      actorClass: mutation.actorClass,
      expectedRevision: mutation.expectedRevision,
      language: mutation.language,
      configuration: mutation.configuration ?? null,
    }),
  );
}

function validMutation(mutation: ManagedLspControlMutation): boolean {
  return (
    Number.isSafeInteger(mutation.expectedRevision) &&
    mutation.expectedRevision >= 0 &&
    mutation.idempotencyKey.length > 0 &&
    mutation.idempotencyKey.length <= MAX_IDEMPOTENCY_KEY_CHARS &&
    !mutation.idempotencyKey.includes("\0") &&
    MANAGED_LSP_LANGUAGES.includes(mutation.language) &&
    (mutation.action === "configure") === (mutation.configuration !== undefined)
  );
}

function replayResult(
  record: ManagedLspIdempotencyRecord,
  language: ManagedLspLanguage,
  realRoot: string,
): ManagedLspSuccessResult | ManagedLspDeniedResult {
  const status: ManagedLspActivationStatus = {
    ok: true,
    schemaVersion: MANAGED_LSP_ACTIVATION_SCHEMA_VERSION,
    language,
    configurationRevision: record.revision,
    state: record.state,
    reasonCode: record.reasonCode,
    policyResult: record.policyResult,
  };
  return {
    kind: record.resultKind,
    changed: record.resultKind === "denied" ? false : record.changed,
    revision: record.revision,
    etag: etag(realRoot, record.revision),
    status,
  } as ManagedLspSuccessResult | ManagedLspDeniedResult;
}

function idempotencyResult(
  record: ManagedLspWorkspaceRecord,
  mutation: ManagedLspControlMutation,
  realRoot: string,
): ManagedLspControlResult | undefined {
  const keyHash = hash(mutation.idempotencyKey);
  const prior = record.idempotency.find((entry) => entry.keyHash === keyHash);
  if (prior === undefined) return undefined;
  return prior.requestHash === requestHash(mutation)
    ? replayResult(prior, mutation.language, realRoot)
    : {
        kind: "idempotencyConflict",
        code: "IDEMPOTENCY_KEY_REUSED",
        etag: etag(realRoot, record.revision),
      };
}

function isDeniedAction(
  mutation: ManagedLspControlMutation,
  status: ManagedLspActivationStatus,
): boolean {
  if (status.policyResult !== "denied") return false;
  return ["activate", "configure", "restart"].includes(mutation.action);
}

function previousState(entry: ManagedLspPersistedLanguageEntry): ManagedLspPersistedLanguageState {
  return {
    activation: entry.activation,
    ...(entry.configuration === undefined ? {} : { configuration: entry.configuration }),
  };
}

function revisionedConfiguration(
  configuration: ManagedLspRuntimeConfiguration,
  revision: number,
  nextEtag: string,
): ManagedLspRuntimeConfiguration | undefined {
  const parsed = parseManagedLspRuntimeConfiguration({
    ...configuration,
    revision,
    etag: nextEtag,
    restartRequired: true,
    restartFields: ["runtime", "settings"],
  });
  return parsed.ok ? parsed.value : undefined;
}

function changedLanguageEntry(
  mutation: ManagedLspControlMutation,
  record: ManagedLspWorkspaceRecord,
  nextRevision: number,
  nextEtag: string,
): ManagedLspPersistedLanguageEntry | undefined {
  const current = record.languages[mutation.language];
  if (mutation.action === "reset") return undefined;
  if (mutation.action === "rollback") return rollbackEntry(current);
  if (mutation.action === "restart") return restartedEntry(current, nextRevision, nextEtag);
  return configuredEntry(mutation, current, nextRevision, nextEtag);
}

function restartedEntry(
  current: ManagedLspPersistedLanguageEntry | undefined,
  nextRevision: number,
  nextEtag: string,
): ManagedLspPersistedLanguageEntry | undefined {
  if (current?.activation !== "enabled") return current;
  const configuration = current.configuration;
  if (configuration === undefined) return current;
  const parsed = parseManagedLspRuntimeConfiguration({
    ...configuration,
    revision: nextRevision,
    etag: nextEtag,
    restartRequired: false,
    restartFields: [],
  });
  return parsed.ok
    ? { ...current, configuration: parsed.value, previous: previousState(current) }
    : current;
}

function rollbackEntry(
  current: ManagedLspPersistedLanguageEntry | undefined,
): ManagedLspPersistedLanguageEntry | undefined {
  if (current?.previous === undefined) return current;
  return { ...current.previous, previous: previousState(current) };
}

function configuredEntry(
  mutation: ManagedLspControlMutation,
  current: ManagedLspPersistedLanguageEntry | undefined,
  nextRevision: number,
  nextEtag: string,
): ManagedLspPersistedLanguageEntry | undefined {
  const activation = mutation.action === "deactivate" ? "disabled" : "enabled";
  if (mutation.configuration === undefined && current?.activation === activation) return current;
  const configuration = nextConfiguration(mutation, current, nextRevision, nextEtag);
  if (mutation.action === "configure" && configuration === undefined) return current;
  return {
    activation,
    ...(configuration === undefined ? {} : { configuration }),
    ...(current === undefined ? {} : { previous: previousState(current) }),
  };
}

function nextConfiguration(
  mutation: ManagedLspControlMutation,
  current: ManagedLspPersistedLanguageEntry | undefined,
  nextRevision: number,
  nextEtag: string,
): ManagedLspRuntimeConfiguration | undefined {
  return mutation.configuration === undefined
    ? current?.configuration
    : revisionedConfiguration(mutation.configuration, nextRevision, nextEtag);
}

function referencedRuntimeIds(configuration: ManagedLspRuntimeConfiguration): readonly string[] {
  const ids = [configuration.runtime.runtimeId];
  if (configuration.language === "python") {
    ids.push(configuration.settings.interpreter.runtimeId);
    if (configuration.settings.venv !== null) ids.push(configuration.settings.venv.runtimeId);
  }
  if (configuration.language === "go") ids.push(configuration.settings.toolchain.runtimeId);
  if (configuration.language === "java") ids.push(configuration.settings.jdk.runtimeId);
  if (configuration.language === "rust") ids.push(configuration.settings.toolchain.runtimeId);
  return ids;
}

function validConfigurationMutation(
  mutation: ManagedLspControlMutation,
  options: ManagedLspControlServiceOptions,
): boolean {
  const configuration = mutation.configuration;
  if (configuration === undefined) return mutation.action !== "configure";
  if (
    configuration.language !== mutation.language ||
    !options.configurationSafe(mutation.root, configuration)
  ) {
    return false;
  }
  if (
    !matchesManagedLspConfigurationPrecondition(configuration, {
      revision: mutation.expectedRevision,
      etag: etag(mutation.root, mutation.expectedRevision),
    })
  ) {
    return false;
  }
  return referencedRuntimeIds(configuration).every((runtimeId) =>
    options.runtimeApproved(mutation.language, runtimeId),
  );
}

function languageEntryEqual(
  left: ManagedLspPersistedLanguageEntry | undefined,
  right: ManagedLspPersistedLanguageEntry | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function withLanguage(
  record: ManagedLspWorkspaceRecord,
  language: ManagedLspLanguage,
  entry: ManagedLspPersistedLanguageEntry | undefined,
): ManagedLspWorkspaceRecord["languages"] {
  return Object.fromEntries(
    MANAGED_LSP_LANGUAGES.flatMap((candidate) => {
      const value = candidate === language ? entry : record.languages[candidate];
      return value === undefined ? [] : [[candidate, value]];
    }),
  );
}

function evidenceFor(
  mutation: ManagedLspControlMutation,
  prior: ManagedLspActivationStatus,
  effective: ManagedLspActivationStatus,
  outcome: ManagedLspEvidenceOutcome,
  revision: number,
  now: number,
): ManagedLspEvidence {
  return {
    schemaVersion: MANAGED_LSP_EVIDENCE_SCHEMA_VERSION,
    kind: "activationChange",
    action: mutation.action as ManagedLspEvidenceAction,
    outcome,
    actorClass: mutation.actorClass,
    language: mutation.language,
    priorState: prior.state,
    effectiveState: effective.state,
    reasonCode: effective.reasonCode,
    revision,
    timestampMs: now,
    policyResult: effective.policyResult,
  };
}

function appendBounded<T>(values: readonly T[], value: T, maximum: number): readonly T[] {
  return [...values, value].slice(-maximum);
}

function idempotencyRecord(
  mutation: ManagedLspControlMutation,
  resultKind: "ok" | "denied",
  changed: boolean,
  status: ManagedLspActivationStatus,
): ManagedLspIdempotencyRecord {
  return {
    keyHash: hash(mutation.idempotencyKey),
    requestHash: requestHash(mutation),
    resultKind,
    changed,
    revision: status.configurationRevision,
    state: status.state,
    reasonCode: status.reasonCode,
    policyResult: status.policyResult,
  };
}

function resultFor(
  kind: "ok" | "denied",
  changed: boolean,
  status: ManagedLspActivationStatus,
  root: string,
): ManagedLspSuccessResult | ManagedLspDeniedResult {
  return {
    kind,
    changed: kind === "denied" ? false : changed,
    revision: status.configurationRevision,
    etag: etag(root, status.configurationRevision),
    status,
  } as ManagedLspSuccessResult | ManagedLspDeniedResult;
}

function commitDenied(
  record: ManagedLspWorkspaceRecord,
  mutation: ManagedLspControlMutation,
  status: ManagedLspActivationStatus,
  options: ManagedLspControlServiceOptions,
): ManagedLspDeniedResult {
  const evidence = evidenceFor(
    mutation,
    status,
    status,
    "denied",
    record.revision,
    (options.now ?? Date.now)(),
  );
  const next: ManagedLspWorkspaceRecord = {
    ...record,
    evidence: appendBounded(record.evidence, evidence, MAX_EVIDENCE_RECORDS),
    idempotency: appendBounded(
      record.idempotency,
      idempotencyRecord(mutation, "denied", false, status),
      MAX_IDEMPOTENCY_RECORDS,
    ),
  };
  options.store.commit(mutation.root, next);
  options.projectEvidence(next.workspaceFingerprint, next.evidence);
  return resultFor("denied", false, status, mutation.root) as ManagedLspDeniedResult;
}

function committedRecord(
  record: ManagedLspWorkspaceRecord,
  mutation: ManagedLspControlMutation,
  entry: ManagedLspPersistedLanguageEntry | undefined,
  changed: boolean,
  options: ManagedLspControlServiceOptions,
): { readonly record: ManagedLspWorkspaceRecord; readonly status: ManagedLspActivationStatus } {
  const revision = changed ? record.revision + 1 : record.revision;
  const base: ManagedLspWorkspaceRecord = {
    ...record,
    revision,
    languages: withLanguage(record, mutation.language, entry),
  };
  const prior = currentStatus(mutation.root, record, mutation.language, options);
  const effective = currentStatus(mutation.root, base, mutation.language, options);
  const evidence = evidenceFor(
    mutation,
    prior,
    effective,
    changed ? "accepted" : "noOp",
    revision,
    (options.now ?? Date.now)(),
  );
  return {
    status: effective,
    record: {
      ...base,
      evidence: appendBounded(record.evidence, evidence, MAX_EVIDENCE_RECORDS),
      idempotency: appendBounded(
        record.idempotency,
        idempotencyRecord(mutation, "ok", changed, effective),
        MAX_IDEMPOTENCY_RECORDS,
      ),
    },
  };
}

function projectFailedTransition(
  record: ManagedLspWorkspaceRecord,
  mutation: ManagedLspControlMutation,
  options: ManagedLspControlServiceOptions,
): void {
  const status = currentStatus(mutation.root, record, mutation.language, options);
  const failed = evidenceFor(
    mutation,
    status,
    status,
    "failed",
    record.revision,
    (options.now ?? Date.now)(),
  );
  options.projectEvidence(
    record.workspaceFingerprint,
    appendBounded(record.evidence, failed, MAX_EVIDENCE_RECORDS),
  );
}

async function mutateLocked(
  mutation: ManagedLspControlMutation,
  options: ManagedLspControlServiceOptions,
): Promise<ManagedLspControlResult> {
  if (!validConfigurationMutation(mutation, options)) {
    return { kind: "invalid", code: "INVALID_REQUEST" };
  }
  const loaded = options.store.load(mutation.root);
  if (loaded.state === "unavailable" && mutation.action !== "reset") {
    return { kind: "unavailable", code: "STATE_UNAVAILABLE" };
  }
  const record =
    loaded.state === "unavailable" ? emptyManagedLspWorkspaceRecord(mutation.root) : loaded.record;
  const precondition = mutationPrecondition(record, mutation);
  if (precondition !== undefined) return precondition;
  const prior = currentStatus(mutation.root, record, mutation.language, options);
  if (isDeniedAction(mutation, prior)) {
    try {
      return commitDenied(record, mutation, prior, options);
    } catch {
      projectFailedTransition(record, mutation, options);
      return { kind: "unavailable", code: "STATE_UNAVAILABLE" };
    }
  }
  return commitAccepted(record, mutation, options);
}

function mutationPrecondition(
  record: ManagedLspWorkspaceRecord,
  mutation: ManagedLspControlMutation,
): ManagedLspControlResult | undefined {
  const replay = idempotencyResult(record, mutation, mutation.root);
  if (replay !== undefined) return replay;
  return record.revision === mutation.expectedRevision
    ? undefined
    : { kind: "conflict", code: "STALE_REVISION", etag: etag(mutation.root, record.revision) };
}

async function commitAccepted(
  record: ManagedLspWorkspaceRecord,
  mutation: ManagedLspControlMutation,
  options: ManagedLspControlServiceOptions,
): Promise<ManagedLspControlResult> {
  const nextRevision = record.revision + 1;
  const entry = changedLanguageEntry(
    mutation,
    record,
    nextRevision,
    etag(mutation.root, nextRevision),
  );
  if (mutation.action === "configure" && entry === record.languages[mutation.language]) {
    return { kind: "invalid", code: "INVALID_REQUEST" };
  }
  const restartAccepted =
    mutation.action === "restart" && record.languages[mutation.language]?.activation === "enabled";
  const changed =
    restartAccepted || !languageEntryEqual(record.languages[mutation.language], entry);
  const committed = committedRecord(record, mutation, entry, changed, options);
  try {
    options.store.commit(mutation.root, committed.record);
  } catch {
    projectFailedTransition(record, mutation, options);
    return { kind: "unavailable", code: "STATE_UNAVAILABLE" };
  }
  options.projectEvidence(committed.record.workspaceFingerprint, committed.record.evidence);
  if (changed) await options.disposePoolEntry(mutation.root, mutation.language);
  return resultFor("ok", changed, committed.status, mutation.root);
}

export function createManagedLspControlService(
  options: ManagedLspControlServiceOptions,
): ManagedLspControlService {
  return {
    stateDir: options.store.stateDir,
    read: (realRoot): Promise<ManagedLspControlSnapshot> => {
      const loaded = options.store.load(realRoot);
      return Promise.resolve(snapshot(realRoot, loaded.state, loaded.record, options));
    },
    readConfiguration: (
      realRoot,
      language,
    ): Promise<ManagedLspRuntimeConfiguration | undefined> => {
      const loaded = options.store.load(realRoot);
      if (loaded.state !== "ready") return Promise.resolve(undefined);
      const configuration = loaded.record.languages[language]?.configuration;
      const parsed = parseManagedLspRuntimeConfiguration(configuration);
      return Promise.resolve(parsed.ok ? parsed.value : undefined);
    },
    mutate: (mutation): Promise<ManagedLspControlResult> => {
      if (!validMutation(mutation))
        return Promise.resolve({ kind: "invalid", code: "INVALID_REQUEST" });
      const key = `managed-lsp:${managedLspWorkspaceFingerprint(mutation.root)}:${mutation.language}`;
      return options.mutex.runExclusive([key], () => mutateLocked(mutation, options));
    },
  };
}
