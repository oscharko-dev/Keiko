import { scryptSync } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ModelProviderConfig } from "@oscharko-dev/keiko-model-gateway";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import {
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSink,
} from "./diagnostics-log.js";
import { readOwnerPrivateFile } from "./ownerPrivateStateFile.js";
import { savePrivateJson } from "./private-json.js";

/**
 * Remembers which chat models a person activated (ADR-0171 D2, amended 2026-11-28, owner decision).
 *
 * An activation is the model's basic-chat readiness proof. It used to live in the server process
 * only, so every restart cost every person a re-activation. This module keeps the fact in a private
 * file beside `keiko.config.json` and gives it back at the next start WITHOUT sending a request
 * (startup loads no model): the record is trusted only while its whole binding still holds.
 *
 *  - the installation: the record carries a digest of this installation's identity;
 *  - the product: the record carries the product version it was made under, so an update discards
 *    every record, because an update can change what a model needs to answer;
 *  - the configuration of the model: a digest of its endpoint, provider protocol and model id;
 *  - the credential: a digest salted with the installation identity, never the credential itself.
 *
 * Any mismatch discards the record and the model is inactive until a person activates it again.
 * The file holds digests and times only: no credential, endpoint, model id or path.
 */

export const MODEL_ACTIVATION_FILE = "model-activations.json";
// Version 2: the credential hash is a memory-hard scrypt derivation, not a plain SHA-256. A
// version 1 record is discarded whole and never migrated.
const SCHEMA_VERSION = 2;
const PREVIOUS_SCHEMA_VERSION = 1;
const MAX_FILE_BYTES = 262_144;
const MAX_ENTRIES = 512;

export const ACTIVATION_DISCARD_REASONS = [
  "first-start",
  "unreadable",
  "format-changed",
  "foreign-installation",
  "product-changed",
  "configuration-changed",
  "credential-changed",
  "deactivated",
  "invalidated",
] as const;
export type ActivationDiscardReason = (typeof ACTIVATION_DISCARD_REASONS)[number];

/** Why the activated set shrank while the server was running. */
export type ActivationRemovalReason = Extract<
  ActivationDiscardReason,
  "deactivated" | "invalidated" | "configuration-changed"
>;

const ACTIVATION_CHANGES = ["restored", "discarded", "saved"] as const;

const MODEL_ACTIVATION_PERSISTENCE_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.activation.persistence",
  category: "gateway",
  owner: "keiko-server",
  emitter: "model-activation-memory.logActivationChange",
  fields: {
    change: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ACTIVATION_CHANGES,
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ACTIVATION_DISCARD_REASONS,
    },
    count: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["gateway-readiness"],
  proofIds: ["gateway.activation.persistence.line"],
  releaseImpact: "patch",
});

interface StoredActivation {
  /** Digest of the model id salted with the installation identity; the id itself is never stored. */
  readonly modelDigest: string;
  readonly configurationDigest: string;
  readonly credentialDigest: string;
  readonly activatedAt: string;
}

export interface ActivatedModel {
  readonly provider: ModelProviderConfig;
  readonly activatedAt: string;
}

export interface RestoredActivation {
  readonly modelId: string;
  readonly activatedAt: string;
}

export interface ModelActivationMemory {
  /** Reads the record once at start and returns the activations whose binding still holds. */
  readonly restore: (
    providers: readonly ModelProviderConfig[],
    correlationId: string,
  ) => readonly RestoredActivation[];
  /** Brings the record in line with the activated set; `reason` names why a model left it. */
  readonly sync: (
    activated: readonly ActivatedModel[],
    reason: ActivationRemovalReason,
    correlationId: string,
    /** A model's own reason, when one change removed models for different reasons (by model id). */
    removalReasons?: ReadonlyMap<string, ActivationRemovalReason>,
  ) => void;
  /**
   * Whether the durable record equals the activated set the last `sync` was given. False after a
   * write that failed: the old record may still hold a model a person took out of use, and the
   * next `sync` (or `settle`) tries again.
   */
  readonly recorded: () => boolean;
  /** Retries a record that could not be written; true when the durable record is now in line. */
  readonly settle: (reason: ActivationRemovalReason, correlationId: string) => boolean;
}

export interface ModelActivationMemoryOptions {
  readonly path: string;
  /** The installation's identity; without one nothing is remembered or restored. */
  readonly installationId: string;
  readonly productVersion: string;
  readonly log: ServerLogSink;
  readonly diagnostics?: ServerDiagnosticSink | undefined;
  readonly now?: () => number;
}

function installationDigest(installationId: string): string {
  return sha256Hex(canonicalise({ purpose: "model-activation-installation", installationId }));
}

function configurationDigest(provider: ModelProviderConfig): string {
  const stated: Record<string, string> = {
    modelId: provider.modelId,
    baseUrl: provider.baseUrl,
  };
  const optional = {
    endpointStyle: provider.endpointStyle,
    apiVersion: provider.apiVersion,
    apiKeyHeaderName: provider.apiKeyHeaderName,
    deploymentIdentitySha256: provider.deploymentIdentitySha256,
  };
  for (const [name, value] of Object.entries(optional)) {
    if (value !== undefined) stated[name] = value;
  }
  return sha256Hex(canonicalise(stated));
}

const CREDENTIAL_KDF = { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const CREDENTIAL_MEMO_LIMIT = 256;
// Per process only, never persisted or logged. Keyed by a hash of the KDF input tuple so the
// credential itself is not a map key.
const credentialMemo = new Map<string, string>();

/**
 * The value stored for a credential. The credential may be low-entropy (a gateway's "sk-1234") and
 * the value lands on disk, so it is derived with a memory-hard KDF salted per installation: a plain
 * hash could be brute-forced from the file.
 */
function credentialDigest(installationId: string, provider: ModelProviderConfig): string {
  const salt = canonicalise({ purpose: "model-activation-credential", installationId });
  const memoKey = sha256Hex(canonicalise({ salt, apiKey: provider.apiKey }));
  const known = credentialMemo.get(memoKey);
  if (known !== undefined) return known;
  const derived = scryptSync(provider.apiKey, salt, 32, CREDENTIAL_KDF).toString("hex");
  if (credentialMemo.size >= CREDENTIAL_MEMO_LIMIT) credentialMemo.clear();
  credentialMemo.set(memoKey, derived);
  return derived;
}

function modelDigest(installationId: string, modelId: string): string {
  return sha256Hex(canonicalise({ purpose: "model-activation-model", installationId, modelId }));
}

function bindingOf(
  installationId: string,
  provider: ModelProviderConfig,
  activatedAt: string,
): StoredActivation {
  return {
    modelDigest: modelDigest(installationId, provider.modelId),
    configurationDigest: configurationDigest(provider),
    credentialDigest: credentialDigest(installationId, provider),
    activatedAt,
  };
}

/**
 * Whether a model's connection is the same one an activation was proven against: the same
 * configuration digest and the same credential. A replaced configuration keeps exactly these.
 */
export function sameActivationBinding(
  left: ModelProviderConfig,
  right: ModelProviderConfig,
): boolean {
  return configurationDigest(left) === configurationDigest(right) && left.apiKey === right.apiKey;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function parseEntry(value: unknown): StoredActivation | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const { activatedAt } = record;
  if (!isDigest(record.modelDigest)) return undefined;
  if (typeof activatedAt !== "string" || Number.isNaN(Date.parse(activatedAt))) return undefined;
  if (!isDigest(record.configurationDigest) || !isDigest(record.credentialDigest)) return undefined;
  return {
    modelDigest: record.modelDigest,
    activatedAt,
    configurationDigest: record.configurationDigest,
    credentialDigest: record.credentialDigest,
  };
}

interface StoredFile {
  readonly productVersion: string;
  readonly entries: readonly StoredActivation[];
}

type ReadOutcome =
  | { readonly kind: "none" | "unreadable" | "format-changed" | "foreign-installation" }
  | StoredFileOutcome;
interface StoredFileOutcome {
  readonly kind: "file";
  readonly file: StoredFile;
}

function parseFile(raw: Buffer, installation: string): ReadOutcome {
  // A malformed file throws here; the reader reports it and treats the record as unreadable.
  const parsed: unknown = JSON.parse(raw.toString("utf8"));
  if (typeof parsed !== "object" || parsed === null) return { kind: "unreadable" };
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion === PREVIOUS_SCHEMA_VERSION) return { kind: "format-changed" };
  if (record.schemaVersion !== SCHEMA_VERSION) return { kind: "unreadable" };
  if (record.installation !== installation) return { kind: "foreign-installation" };
  const { productVersion, entries } = record;
  if (typeof productVersion !== "string" || !Array.isArray(entries)) return { kind: "unreadable" };
  const kept = entries
    .slice(0, MAX_ENTRIES)
    .map(parseEntry)
    .filter((entry): entry is StoredActivation => entry !== undefined);
  return { kind: "file", file: { productVersion, entries: kept } };
}

function sameBinding(left: StoredActivation, right: StoredActivation): boolean {
  return (
    left.configurationDigest === right.configurationDigest &&
    left.credentialDigest === right.credentialDigest
  );
}

function reportActivationFailure(
  options: ModelActivationMemoryOptions,
  operation: string,
  error: unknown,
  correlationId: string,
): void {
  emitServerDiagnostic(
    options.diagnostics,
    serverDiagnosticFromError({
      correlationId,
      operation,
      source: "model-activation-memory",
      error,
      redact: () => "Keiko could not read or write its record of activated models.",
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
  );
}

export function createModelActivationMemory(
  options: ModelActivationMemoryOptions,
): ModelActivationMemory {
  return new FileModelActivationMemory(options);
}

class FileModelActivationMemory implements ModelActivationMemory {
  /** What the file holds now: advanced only by a write that succeeded (or by removing the file). */
  private durable = new Map<string, StoredActivation>();
  /** The activated set the last `sync` asked for, kept so `settle` can retry a failed write. */
  private desired: readonly ActivatedModel[] = [];
  private unrecorded = false;
  private readonly installation: string;

  public constructor(private readonly options: ModelActivationMemoryOptions) {
    this.installation = installationDigest(options.installationId);
  }

  public restore(
    providers: readonly ModelProviderConfig[],
    correlationId: string,
  ): readonly RestoredActivation[] {
    const outcome = this.read(correlationId);
    const { counts, restored } = this.classify(outcome, providers);
    const entries = new Map(restored.map(({ entry }) => [entry.modelDigest, entry]));
    this.durable = entries;
    // What the process now treats as activated, so a settle before the first sync keeps it.
    this.desired = restored.map(({ entry, provider }) => ({
      provider,
      activatedAt: entry.activatedAt,
    }));
    this.logChange("restored", undefined, restored.length, correlationId);
    for (const [reason, count] of counts) this.logChange("discarded", reason, count, correlationId);
    if (outcome.kind !== "none") this.write(entries, correlationId);
    return restored.map(({ entry, provider }) => ({
      modelId: provider.modelId,
      activatedAt: entry.activatedAt,
    }));
  }

  public recorded(): boolean {
    return !this.unrecorded;
  }

  public settle(reason: ActivationRemovalReason, correlationId: string): boolean {
    this.sync(this.desired, reason, correlationId);
    return !this.unrecorded;
  }

  public sync(
    activated: readonly ActivatedModel[],
    reason: ActivationRemovalReason,
    correlationId: string,
    removalReasons?: ReadonlyMap<string, ActivationRemovalReason>,
  ): void {
    this.desired = activated;
    const next = new Map<string, StoredActivation>();
    let saved = 0;
    for (const model of activated) {
      const key = modelDigest(this.options.installationId, model.provider.modelId);
      const known = this.durable.get(key);
      const entry = bindingOf(this.options.installationId, model.provider, model.activatedAt);
      if (known !== undefined && sameBinding(known, entry)) next.set(key, known);
      else {
        next.set(key, entry);
        saved += 1;
      }
    }
    const removed = this.removalsByReason(next, reason, removalReasons);
    const removedCount = [...removed.values()].reduce((sum, count) => sum + count, 0);
    if (saved === 0 && removedCount === 0) {
      this.unrecorded = false;
      return;
    }
    if (this.write(next, correlationId)) {
      this.durable = next;
      this.unrecorded = false;
      this.logRemovals(removed, correlationId);
      if (saved > 0) this.logChange("saved", undefined, saved, correlationId);
    } else if (removedCount > 0) this.withdrawRecord(next, removed, correlationId);
    else this.unrecorded = true;
  }

  /** The stored models the next set drops, counted per reason (a model's own reason, else `reason`). */
  private removalsByReason(
    next: ReadonlyMap<string, StoredActivation>,
    reason: ActivationRemovalReason,
    removalReasons: ReadonlyMap<string, ActivationRemovalReason> | undefined,
  ): Map<ActivationRemovalReason, number> {
    const byKey = new Map<string, ActivationRemovalReason>();
    for (const [modelId, own] of removalReasons ?? [])
      byKey.set(modelDigest(this.options.installationId, modelId), own);
    const counts = new Map<ActivationRemovalReason, number>();
    for (const key of this.durable.keys()) {
      if (next.has(key)) continue;
      const own = byKey.get(key) ?? reason;
      counts.set(own, (counts.get(own) ?? 0) + 1);
    }
    return counts;
  }

  private logRemovals(
    removed: ReadonlyMap<ActivationRemovalReason, number>,
    correlationId: string,
  ): void {
    for (const [reason, count] of removed)
      this.logChange("discarded", reason, count, correlationId);
  }

  /**
   * A removal the file could not take must not come back at the next start. Removing the whole
   * file makes the old record unusable (every activation then needs its re-activation, the safe
   * side); when even that fails the record stays unrecorded and the next change retries. The
   * models that stay activated are written once more right after, so they survive a restart.
   */
  private withdrawRecord(
    next: ReadonlyMap<string, StoredActivation>,
    removed: ReadonlyMap<ActivationRemovalReason, number>,
    correlationId: string,
  ): void {
    try {
      rmSync(this.options.path, { force: true });
    } catch (error) {
      reportActivationFailure(this.options, "gateway.activation.withdraw", error, correlationId);
      this.unrecorded = true;
      return;
    }
    this.durable = new Map();
    this.unrecorded = false;
    this.logRemovals(removed, correlationId);
    if (next.size > 0 && this.write(next, correlationId)) {
      this.durable = new Map(next);
      this.logChange("saved", undefined, next.size, correlationId);
    }
  }

  private classify(
    outcome: ReadOutcome,
    providers: readonly ModelProviderConfig[],
  ): {
    readonly counts: Map<ActivationDiscardReason, number>;
    readonly restored: {
      readonly entry: StoredActivation;
      readonly provider: ModelProviderConfig;
    }[];
  } {
    const counts = new Map<ActivationDiscardReason, number>();
    const restored: { readonly entry: StoredActivation; readonly provider: ModelProviderConfig }[] =
      [];
    if (outcome.kind === "none") counts.set("first-start", 0);
    else if (outcome.kind !== "file") counts.set(outcome.kind, 0);
    else if (outcome.file.productVersion !== this.options.productVersion)
      counts.set("product-changed", outcome.file.entries.length);
    else
      for (const entry of outcome.file.entries) {
        const { reason, provider } = this.verdict(entry, providers);
        if (reason === undefined && provider !== undefined) restored.push({ entry, provider });
        else if (reason !== undefined) counts.set(reason, (counts.get(reason) ?? 0) + 1);
      }
    return { counts, restored };
  }

  private verdict(
    entry: StoredActivation,
    providers: readonly ModelProviderConfig[],
  ): { readonly reason?: ActivationDiscardReason; readonly provider?: ModelProviderConfig } {
    const provider = providers.find(
      (candidate) =>
        modelDigest(this.options.installationId, candidate.modelId) === entry.modelDigest,
    );
    if (provider === undefined) return { reason: "configuration-changed" };
    if (configurationDigest(provider) !== entry.configurationDigest)
      return { reason: "configuration-changed" };
    if (credentialDigest(this.options.installationId, provider) !== entry.credentialDigest)
      return { reason: "credential-changed" };
    return { provider };
  }

  private read(correlationId: string): ReadOutcome {
    if (!existsSync(this.options.path)) return { kind: "none" };
    try {
      const raw = readOwnerPrivateFile(this.options.path, MAX_FILE_BYTES);
      if (raw === undefined) return { kind: "none" };
      return parseFile(raw, this.installation);
    } catch (error) {
      reportActivationFailure(this.options, "gateway.activation.restore", error, correlationId);
      return { kind: "unreadable" };
    }
  }

  private write(entries: ReadonlyMap<string, StoredActivation>, correlationId: string): boolean {
    try {
      savePrivateJson(this.options.path, {
        schemaVersion: SCHEMA_VERSION,
        installation: this.installation,
        productVersion: this.options.productVersion,
        entries: [...entries.values()],
      });
      return true;
    } catch (error) {
      reportActivationFailure(this.options, "gateway.activation.persist", error, correlationId);
      return false;
    }
  }

  private logChange(
    change: (typeof ACTIVATION_CHANGES)[number],
    reason: ActivationDiscardReason | undefined,
    count: number,
    correlationId: string,
  ): void {
    this.options.log.write(
      activityLogEvent(
        MODEL_ACTIVATION_PERSISTENCE_OPERATION,
        { correlationId },
        {
          change,
          ...(reason === undefined ? {} : { reason }),
          count,
          completeness: "complete",
          loss: "none",
        },
      ),
    );
  }
}

interface ObservationLike {
  readonly generation: number;
  readonly checkedAt: string;
  readonly conversationCheckedAt?: string | undefined;
  readonly fields: { readonly conversationReady?: boolean | undefined };
}

/**
 * The activated models of a runtime: a ready observation of the current configuration generation
 * for a model that is still configured. This one rule is what the whole chain (offering, election,
 * admission) already reads, so the record can never disagree with it.
 */
export function activatedModelsOf(
  observations: ReadonlyMap<string, ObservationLike>,
  generation: number,
  providers: readonly ModelProviderConfig[],
): readonly ActivatedModel[] {
  const activated: ActivatedModel[] = [];
  for (const provider of providers) {
    const observation = observations.get(provider.modelId);
    if (observation?.generation !== generation || observation.fields.conversationReady !== true)
      continue;
    activated.push({
      provider,
      activatedAt: observation.conversationCheckedAt ?? observation.checkedAt,
    });
  }
  return activated;
}
