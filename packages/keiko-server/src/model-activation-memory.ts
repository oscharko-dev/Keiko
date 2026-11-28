import { existsSync } from "node:fs";
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
const SCHEMA_VERSION = 1;
const MAX_FILE_BYTES = 262_144;
const MAX_ENTRIES = 512;

export const ACTIVATION_DISCARD_REASONS = [
  "first-start",
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
  readonly modelId: string;
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
  ) => void;
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

function credentialDigest(installationId: string, provider: ModelProviderConfig): string {
  return sha256Hex(
    canonicalise({
      purpose: "model-activation-credential",
      installationId,
      apiKey: provider.apiKey,
    }),
  );
}

function bindingOf(
  installationId: string,
  provider: ModelProviderConfig,
  activatedAt: string,
): StoredActivation {
  return {
    modelId: provider.modelId,
    configurationDigest: configurationDigest(provider),
    credentialDigest: credentialDigest(installationId, provider),
    activatedAt,
  };
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function parseEntry(value: unknown): StoredActivation | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const { modelId, activatedAt } = record;
  if (typeof modelId !== "string" || modelId.length === 0 || modelId.length > 256) return undefined;
  if (typeof activatedAt !== "string" || Number.isNaN(Date.parse(activatedAt))) return undefined;
  if (!isDigest(record["configurationDigest"]) || !isDigest(record["credentialDigest"]))
    return undefined;
  return {
    modelId,
    activatedAt,
    configurationDigest: record["configurationDigest"],
    credentialDigest: record["credentialDigest"],
  };
}

interface StoredFile {
  readonly productVersion: string;
  readonly entries: readonly StoredActivation[];
}

type ReadOutcome = { readonly kind: "none" } | { readonly kind: "unusable" } | StoredFileOutcome;
interface StoredFileOutcome {
  readonly kind: "file";
  readonly file: StoredFile;
}

function parseFile(raw: Buffer, installation: string): StoredFileOutcome | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record["schemaVersion"] !== SCHEMA_VERSION || record["installation"] !== installation)
    return undefined;
  const { productVersion, entries } = record;
  if (typeof productVersion !== "string" || !Array.isArray(entries)) return undefined;
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

export function createModelActivationMemory(
  options: ModelActivationMemoryOptions,
): ModelActivationMemory {
  return new FileModelActivationMemory(options);
}

class FileModelActivationMemory implements ModelActivationMemory {
  private current = new Map<string, StoredActivation>();
  private readonly installation: string;

  public constructor(private readonly options: ModelActivationMemoryOptions) {
    this.installation = installationDigest(options.installationId);
  }

  public restore(
    providers: readonly ModelProviderConfig[],
    correlationId: string,
  ): readonly RestoredActivation[] {
    const outcome = this.read(correlationId);
    const counts = new Map<ActivationDiscardReason, number>();
    const restored: StoredActivation[] = [];
    if (outcome.kind !== "file") counts.set("first-start", 0);
    else if (outcome.file.productVersion !== this.options.productVersion)
      counts.set("product-changed", outcome.file.entries.length);
    else
      for (const entry of outcome.file.entries) {
        const reason = this.verdict(entry, providers);
        if (reason === undefined) restored.push(entry);
        else counts.set(reason, (counts.get(reason) ?? 0) + 1);
      }
    this.current = new Map(restored.map((entry) => [entry.modelId, entry]));
    this.logChange("restored", undefined, restored.length, correlationId);
    for (const [reason, count] of counts) this.logChange("discarded", reason, count, correlationId);
    if (outcome.kind !== "none") this.write(correlationId);
    return restored.map(({ modelId, activatedAt }) => ({ modelId, activatedAt }));
  }

  public sync(
    activated: readonly ActivatedModel[],
    reason: ActivationRemovalReason,
    correlationId: string,
  ): void {
    const next = new Map<string, StoredActivation>();
    let saved = 0;
    for (const model of activated) {
      const known = this.current.get(model.provider.modelId);
      const entry = bindingOf(this.options.installationId, model.provider, model.activatedAt);
      if (known !== undefined && sameBinding(known, entry)) next.set(entry.modelId, known);
      else {
        next.set(entry.modelId, entry);
        saved += 1;
      }
    }
    const removed = [...this.current.keys()].filter((modelId) => !next.has(modelId)).length;
    if (saved === 0 && removed === 0) return;
    this.current = next;
    if (this.write(correlationId)) {
      if (removed > 0) this.logChange("discarded", reason, removed, correlationId);
      if (saved > 0) this.logChange("saved", undefined, saved, correlationId);
    }
  }

  private verdict(
    entry: StoredActivation,
    providers: readonly ModelProviderConfig[],
  ): ActivationDiscardReason | undefined {
    const provider = providers.find((candidate) => candidate.modelId === entry.modelId);
    if (provider === undefined) return "configuration-changed";
    if (configurationDigest(provider) !== entry.configurationDigest) return "configuration-changed";
    if (credentialDigest(this.options.installationId, provider) !== entry.credentialDigest)
      return "credential-changed";
    return undefined;
  }

  private read(correlationId: string): ReadOutcome {
    if (!existsSync(this.options.path)) return { kind: "none" };
    try {
      const raw = readOwnerPrivateFile(this.options.path, MAX_FILE_BYTES);
      if (raw === undefined) return { kind: "none" };
      return parseFile(raw, this.installation) ?? { kind: "unusable" };
    } catch (error) {
      this.reportFailure("gateway.activation.restore", error, correlationId);
      return { kind: "unusable" };
    }
  }

  private write(correlationId: string): boolean {
    try {
      savePrivateJson(this.options.path, {
        schemaVersion: SCHEMA_VERSION,
        installation: this.installation,
        productVersion: this.options.productVersion,
        entries: [...this.current.values()],
      });
      return true;
    } catch (error) {
      this.reportFailure("gateway.activation.persist", error, correlationId);
      return false;
    }
  }

  private reportFailure(operation: string, error: unknown, correlationId: string): void {
    emitServerDiagnostic(
      this.options.diagnostics,
      serverDiagnosticFromError({
        correlationId,
        operation,
        source: "model-activation-memory",
        error,
        redact: () => "Keiko could not read or write its record of activated models.",
        ...(this.options.now === undefined ? {} : { now: this.options.now }),
      }),
    );
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
