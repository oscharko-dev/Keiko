// Embedding capability verification + identity compatibility for the Local
// Knowledge Connector. Decides whether a configured embedding model is reachable
// and whether its vector space remains compatible with a previously stored
// embedding identity. Every failure path produces a `safeMessage` string that
// MUST NOT contain API keys, full URLs, raw provider bodies, IPs, or the
// user-supplied input. Probes are pure-ish: I/O is encapsulated in the injected
// adapter function.

import { createHash } from "node:crypto";
import type {
  EmbeddingModelIdentity,
  EmbeddingVectorMetric,
  EmbeddingVectorNormalization,
} from "@oscharko-dev/keiko-contracts";
import type {
  OpenAIEmbeddingBatchOutcome,
  OpenAIEmbeddingBatchRequest,
  OpenAIEmbeddingErrorKind,
  OpenAIEmbeddingRequest,
  OpenAIEmbeddingOutcome,
} from "./openai-embedding-adapter.js";
import type { OutboundHttpEgressConfig } from "./types.js";

// ─── Failure taxonomy ─────────────────────────────────────────────────────────
export type EmbeddingFailureReason =
  | "missing-credentials"
  | "unavailable"
  | "wrong-header"
  | "rate-limited"
  | "dimension-mismatch"
  | "timeout"
  | "cancelled"
  | "unsupported-model"
  | "proxy-unreachable"
  | "proxy-auth-required"
  | "proxy-egress-failed"
  | "proxy-blocked-by-policy"
  | "tls-ca-failure"
  | "invalid-response"
  | "incompatible-with-stored-identity";

export interface EmbeddingIdentityWarning {
  readonly code:
    "model-revision-changed" | "embedding-space-unverified" | "embedding-space-fingerprint-drift";
  readonly safeMessage: string;
  readonly previousRevision?: string;
  readonly currentRevision?: string;
  readonly previousFingerprint?: string;
  readonly currentFingerprint?: string;
}

export type EmbeddingCapabilityCheck =
  | {
      readonly ok: true;
      readonly identity: EmbeddingModelIdentity;
      readonly warning?: EmbeddingIdentityWarning;
    }
  | { readonly ok: false; readonly reason: EmbeddingFailureReason; readonly safeMessage: string };

type EmbeddingFingerprintCheck =
  | { readonly ok: true; readonly fingerprint: string }
  | { readonly ok: false; readonly reason: EmbeddingFailureReason; readonly safeMessage: string };

export interface EmbeddingProbeOptions {
  readonly modelId: string;
  readonly provider: string;
  readonly vectorMetric: EmbeddingVectorMetric;
  readonly expectedDimensions?: number;
  readonly dimensionsParam?: number;
  readonly normalization?: EmbeddingVectorNormalization;
  readonly instructionVersion?: string;
  readonly includeSpaceFingerprint?: boolean;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

// Adapter port: anything that takes a request and resolves to an outcome.
// Decouples verifyEmbeddingCapability from the concrete HTTP adapter so tests
// can substitute a deterministic stub without monkey-patching fetch.
export interface OpenAIEmbeddingAdapter {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly apiKeyHeaderName?: string;
  readonly egress?: OutboundHttpEgressConfig | undefined;
  readonly request: (input: OpenAIEmbeddingRequest) => Promise<OpenAIEmbeddingOutcome>;
  // Optional array-batch port (#189 GRD-004). When present, the indexing batcher embeds
  // many chunks per HTTP round-trip via this method; when absent it falls back to issuing
  // one `request` per chunk, so existing adapters/stubs keep working unchanged.
  readonly requestBatch?: (
    input: OpenAIEmbeddingBatchRequest,
  ) => Promise<OpenAIEmbeddingBatchOutcome>;
}

const PROBE_INPUT = "ping" as const;
const EMBEDDING_SPACE_PROBE_INPUTS = [
  "Keiko embedding space probe: alpha",
  "Keiko embedding space probe: beta",
  "Keiko embedding space probe: gamma",
] as const;
export const EMBEDDING_INSTRUCTION_VERSION = "keiko-embedding-input-v1" as const;
export const EMBEDDING_NORMALIZATION: EmbeddingVectorNormalization = "l2";
const FINGERPRINT_VERSION = "keiko-embedding-space-fingerprint-v1";

const SAFE_MESSAGES: Readonly<Record<EmbeddingFailureReason, string>> = Object.freeze({
  "missing-credentials": "model gateway credentials are not configured",
  unavailable: "model gateway is not reachable",
  "wrong-header": "model gateway rejected the request — check API key configuration",
  "rate-limited": "model gateway is rate-limited — retry after the configured backoff",
  "dimension-mismatch": "embedding vector dimensions do not match the expected value",
  timeout: "embedding probe timed out",
  cancelled: "embedding probe was cancelled by the caller",
  "unsupported-model": "embedding model is not available on the configured gateway",
  "proxy-unreachable": "configured proxy is unreachable",
  "proxy-auth-required": "configured proxy requires authentication",
  "proxy-egress-failed": "configured proxy failed outbound egress",
  "proxy-blocked-by-policy": "configured proxy blocked outbound egress",
  "tls-ca-failure": "TLS certificate verification failed for outbound egress",
  "invalid-response": "embedding response was malformed",
  "incompatible-with-stored-identity":
    "embedding model identity changed — existing capsules are no longer compatible",
});

const ADAPTER_FAILURE_REASONS: Readonly<Record<OpenAIEmbeddingErrorKind, EmbeddingFailureReason>> =
  Object.freeze({
    "wrong-header": "wrong-header",
    "rate-limited": "rate-limited",
    "unsupported-model": "unsupported-model",
    timeout: "timeout",
    cancelled: "cancelled",
    "invalid-response": "invalid-response",
    "proxy-unreachable": "proxy-unreachable",
    "proxy-auth-required": "proxy-auth-required",
    "proxy-egress-failed": "proxy-egress-failed",
    "proxy-blocked-by-policy": "proxy-blocked-by-policy",
    "tls-ca-failure": "tls-ca-failure",
    transport: "unavailable",
  });

function fail(reason: EmbeddingFailureReason): EmbeddingCapabilityCheck {
  return { ok: false, reason, safeMessage: SAFE_MESSAGES[reason] };
}

function failFingerprint(reason: EmbeddingFailureReason): EmbeddingFingerprintCheck {
  return { ok: false, reason, safeMessage: SAFE_MESSAGES[reason] };
}

function reasonFromAdapter(kind: OpenAIEmbeddingErrorKind): EmbeddingFailureReason {
  return ADAPTER_FAILURE_REASONS[kind];
}

function hasCredentials(adapter: OpenAIEmbeddingAdapter): boolean {
  return adapter.apiKey.trim().length > 0;
}

export function vectorL2Norm(vector: Float32Array): number {
  let squared = 0;
  for (const value of vector) {
    squared += value * value;
  }
  return Math.sqrt(squared);
}

export function l2NormalizeVector(vector: Float32Array): Float32Array {
  const normalized = new Float32Array(vector);
  const norm = vectorL2Norm(normalized);
  if (norm <= 0) return normalized;
  for (let i = 0; i < normalized.length; i += 1) {
    const value = normalized[i];
    if (value !== undefined) normalized[i] = value / norm;
  }
  return normalized;
}

function rounded(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function vectorLaneSignature(vector: Float32Array): readonly number[] {
  if (vector.length === 0) return [];
  const normalized = l2NormalizeVector(vector);
  const laneCount = Math.min(16, normalized.length);
  const out: number[] = [];
  for (let i = 0; i < laneCount; i += 1) {
    const index = laneCount === 1 ? 0 : Math.round((i * (normalized.length - 1)) / (laneCount - 1));
    out.push(rounded(normalized[index] ?? 0));
  }
  return out;
}

function cosineOfNormalized(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return dot;
}

export function embeddingSpaceFingerprintForVectors(
  vectors: readonly Float32Array[],
): string | undefined {
  if (vectors.length === 0 || vectors.some((vector) => vector.length === 0)) {
    return undefined;
  }
  const normalized = vectors.map(l2NormalizeVector);
  const signature = {
    version: FINGERPRINT_VERSION,
    dimensions: normalized[0]?.length ?? 0,
    probes: normalized.map(vectorLaneSignature),
    pairwise: normalized.flatMap((left, i) =>
      normalized.slice(i + 1).map((right) => rounded(cosineOfNormalized(left, right))),
    ),
  };
  const digest = createHash("sha256").update(JSON.stringify(signature)).digest("hex").slice(0, 24);
  return `${FINGERPRINT_VERSION}:${digest}`;
}

async function requestProbeEmbedding(
  adapter: OpenAIEmbeddingAdapter,
  options: EmbeddingProbeOptions,
  input: string,
): Promise<OpenAIEmbeddingOutcome> {
  const request: OpenAIEmbeddingRequest = {
    endpoint: adapter.endpoint,
    apiKey: adapter.apiKey,
    ...(adapter.apiKeyHeaderName !== undefined
      ? { apiKeyHeaderName: adapter.apiKeyHeaderName }
      : {}),
    ...(adapter.egress !== undefined ? { egress: adapter.egress } : {}),
    modelId: options.modelId,
    input,
    ...(options.dimensionsParam !== undefined ? { dimensions: options.dimensionsParam } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  };
  return adapter.request(request);
}

async function computeEmbeddingSpaceFingerprint(
  adapter: OpenAIEmbeddingAdapter,
  options: EmbeddingProbeOptions,
  expectedDimensions: number,
): Promise<EmbeddingFingerprintCheck> {
  const vectors: Float32Array[] = [];
  for (const input of EMBEDDING_SPACE_PROBE_INPUTS) {
    const outcome = await requestProbeEmbedding(adapter, options, input);
    if (!outcome.ok) {
      return failFingerprint(reasonFromAdapter(outcome.kind));
    }
    if (outcome.value.vector.length !== expectedDimensions) {
      return failFingerprint("dimension-mismatch");
    }
    vectors.push(outcome.value.vector);
  }
  const fingerprint = embeddingSpaceFingerprintForVectors(vectors);
  if (fingerprint === undefined) return failFingerprint("invalid-response");
  return { ok: true, fingerprint };
}

function buildIdentity(
  options: EmbeddingProbeOptions,
  detectedModelId: string,
  detectedDimensions: number,
  modelRevision: string | undefined,
  embeddingSpaceFingerprint: string | undefined,
): EmbeddingModelIdentity {
  const revision =
    modelRevision ?? (detectedModelId === options.modelId ? undefined : detectedModelId);
  return {
    provider: options.provider,
    modelId: options.modelId,
    vectorDimensions: detectedDimensions,
    vectorMetric: options.vectorMetric,
    ...(revision !== undefined ? { modelRevision: revision } : {}),
    normalization: options.normalization ?? EMBEDDING_NORMALIZATION,
    instructionVersion: options.instructionVersion ?? EMBEDDING_INSTRUCTION_VERSION,
    ...(embeddingSpaceFingerprint !== undefined ? { embeddingSpaceFingerprint } : {}),
    ...(options.dimensionsParam !== undefined ? { dimensionsParam: options.dimensionsParam } : {}),
  };
}

// eslint-disable-next-line complexity
export async function verifyEmbeddingCapability(
  adapter: OpenAIEmbeddingAdapter,
  options: EmbeddingProbeOptions,
): Promise<EmbeddingCapabilityCheck> {
  if (!hasCredentials(adapter)) {
    return fail("missing-credentials");
  }
  const request: OpenAIEmbeddingRequest = {
    endpoint: adapter.endpoint,
    apiKey: adapter.apiKey,
    ...(adapter.apiKeyHeaderName !== undefined
      ? { apiKeyHeaderName: adapter.apiKeyHeaderName }
      : {}),
    ...(adapter.egress !== undefined ? { egress: adapter.egress } : {}),
    modelId: options.modelId,
    input: PROBE_INPUT,
    ...(options.dimensionsParam !== undefined ? { dimensions: options.dimensionsParam } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  };

  const outcome = await adapter.request(request);
  if (!outcome.ok) {
    return fail(reasonFromAdapter(outcome.kind));
  }

  const detected = outcome.value.vector.length;
  if (detected === 0) {
    return fail("invalid-response");
  }
  if (options.expectedDimensions !== undefined && options.expectedDimensions !== detected) {
    return fail("dimension-mismatch");
  }
  let fingerprint: string | undefined;
  if (options.includeSpaceFingerprint === true) {
    const fingerprintResult = await computeEmbeddingSpaceFingerprint(adapter, options, detected);
    if (!fingerprintResult.ok) return fingerprintResult;
    fingerprint = fingerprintResult.fingerprint;
  }
  return {
    ok: true,
    identity: buildIdentity(
      options,
      outcome.value.modelId,
      detected,
      outcome.value.modelRevision,
      fingerprint,
    ),
  };
}

function structuralFieldsEqual(a: EmbeddingModelIdentity, b: EmbeddingModelIdentity): boolean {
  return (
    a.provider === b.provider &&
    a.modelId === b.modelId &&
    a.vectorDimensions === b.vectorDimensions &&
    a.vectorMetric === b.vectorMetric
  );
}

function revisionDiffers(stored: EmbeddingModelIdentity, current: EmbeddingModelIdentity): boolean {
  return stored.modelRevision !== current.modelRevision;
}

export type EmbeddingIdentityHardeningStatus =
  "hardened" | "legacy-unverified" | "normalization-unknown" | "fingerprint-unverified";

export function embeddingIdentityHardeningStatus(
  identity: EmbeddingModelIdentity,
): EmbeddingIdentityHardeningStatus {
  if (identity.normalization === undefined || identity.instructionVersion === undefined) {
    return "legacy-unverified";
  }
  if (identity.normalization !== "l2") {
    return "normalization-unknown";
  }
  if (identity.embeddingSpaceFingerprint === undefined) {
    return "fingerprint-unverified";
  }
  return "hardened";
}

function buildRevisionWarning(
  stored: EmbeddingModelIdentity,
  current: EmbeddingModelIdentity,
): EmbeddingIdentityWarning {
  return {
    code: "model-revision-changed",
    safeMessage:
      "embedding model revision changed — capsules remain compatible but should be re-validated",
    ...(stored.modelRevision !== undefined ? { previousRevision: stored.modelRevision } : {}),
    ...(current.modelRevision !== undefined ? { currentRevision: current.modelRevision } : {}),
  };
}

function buildUnverifiedWarning(): EmbeddingIdentityWarning {
  return {
    code: "embedding-space-unverified",
    safeMessage:
      "embedding identity is compatible but lacks full normalization/fingerprint hardening; re-index to pin the embedding space",
  };
}

function buildFingerprintDriftWarning(
  stored: EmbeddingModelIdentity,
  current: EmbeddingModelIdentity,
): EmbeddingIdentityWarning {
  return {
    code: "embedding-space-fingerprint-drift",
    safeMessage:
      "embedding-space fingerprint changed while structural identity stayed compatible; re-validate retrieval quality and re-index when convenient",
    ...(stored.embeddingSpaceFingerprint !== undefined
      ? { previousFingerprint: stored.embeddingSpaceFingerprint }
      : {}),
    ...(current.embeddingSpaceFingerprint !== undefined
      ? { currentFingerprint: current.embeddingSpaceFingerprint }
      : {}),
  };
}

function bothDefinedAndDifferent<T>(left: T | undefined, right: T | undefined): boolean {
  return left !== undefined && right !== undefined && left !== right;
}

function hardeningFieldsIncompatible(
  stored: EmbeddingModelIdentity,
  current: EmbeddingModelIdentity,
): boolean {
  return (
    bothDefinedAndDifferent(stored.normalization, current.normalization) ||
    bothDefinedAndDifferent(stored.instructionVersion, current.instructionVersion) ||
    bothDefinedAndDifferent(stored.dimensionsParam, current.dimensionsParam)
  );
}

function fingerprintDiffers(
  stored: EmbeddingModelIdentity,
  current: EmbeddingModelIdentity,
): boolean {
  return bothDefinedAndDifferent(
    stored.embeddingSpaceFingerprint,
    current.embeddingSpaceFingerprint,
  );
}

function hardeningNeedsWarning(
  stored: EmbeddingModelIdentity,
  current: EmbeddingModelIdentity,
): boolean {
  const storedStatus = embeddingIdentityHardeningStatus(stored);
  const currentStatus = embeddingIdentityHardeningStatus(current);
  if (storedStatus === "legacy-unverified" && currentStatus === "legacy-unverified") return false;
  return storedStatus !== "hardened" || currentStatus !== "hardened";
}

export function assertCompatibleEmbeddingIdentity(
  stored: EmbeddingModelIdentity,
  current: EmbeddingModelIdentity,
): EmbeddingCapabilityCheck {
  if (!structuralFieldsEqual(stored, current)) {
    return fail("incompatible-with-stored-identity");
  }
  if (hardeningFieldsIncompatible(stored, current)) {
    return fail("incompatible-with-stored-identity");
  }
  if (fingerprintDiffers(stored, current)) {
    return { ok: true, identity: current, warning: buildFingerprintDriftWarning(stored, current) };
  }
  if (hardeningNeedsWarning(stored, current)) {
    return { ok: true, identity: current, warning: buildUnverifiedWarning() };
  }
  if (revisionDiffers(stored, current)) {
    // Return the CURRENT identity (not stored) so the caller can persist the new revision
    // and avoid a permanent warning on every subsequent compatibility check. The warning
    // carries the previous revision for diagnostics. #192 Copilot finding.
    return { ok: true, identity: current, warning: buildRevisionWarning(stored, current) };
  }
  return { ok: true, identity: stored };
}
