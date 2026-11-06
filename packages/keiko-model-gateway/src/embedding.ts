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
import type { ModelGatewayLogContext } from "./observability.js";
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
  | "http-error"
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
  readonly logContext?: ModelGatewayLogContext;
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
  // Deliberately distinct from `unavailable` ("not reachable"): the gateway ANSWERED, with an
  // HTTP error status. Collapsing the two once misdirected a connectivity investigation while
  // the true failure was a rejected request. The status-carrying variant is built in
  // `failureMessage` below.
  "http-error": "model gateway answered the embedding request with an HTTP error status",
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
    "http-error": "http-error",
    transport: "unavailable",
  });

// An HTTP status code is content-free operator telemetry (no body, no endpoint, no key material),
// so it rides along in the redacted safe message of EVERY answered failure — 401/404/429 name
// their cause, but the exact status is the one number an operator can grep in the gateway logs.
function failureMessage(reason: EmbeddingFailureReason, status: number | undefined): string {
  if (status === undefined) return SAFE_MESSAGES[reason];
  if (reason === "http-error") {
    return `model gateway answered the embedding request with HTTP ${String(status)}`;
  }
  return `${SAFE_MESSAGES[reason]} (HTTP ${String(status)})`;
}

function fail(reason: EmbeddingFailureReason, status?: number): EmbeddingCapabilityCheck {
  return { ok: false, reason, safeMessage: failureMessage(reason, status) };
}

function failFingerprint(
  reason: EmbeddingFailureReason,
  status?: number,
): EmbeddingFingerprintCheck {
  return { ok: false, reason, safeMessage: failureMessage(reason, status) };
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
  if (vectors.length === 0 || vectors.some((vector) => !validProbeVector(vector))) {
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
    ...(options.logContext !== undefined ? { logContext: options.logContext } : {}),
  };
  return adapter.request(request);
}

async function requestProbeEmbeddingBatch(
  adapter: OpenAIEmbeddingAdapter,
  options: EmbeddingProbeOptions,
): Promise<OpenAIEmbeddingBatchOutcome> {
  if (adapter.requestBatch === undefined) {
    return { ok: false, kind: "invalid-response" };
  }
  const request: OpenAIEmbeddingBatchRequest = {
    endpoint: adapter.endpoint,
    apiKey: adapter.apiKey,
    ...(adapter.apiKeyHeaderName !== undefined
      ? { apiKeyHeaderName: adapter.apiKeyHeaderName }
      : {}),
    ...(adapter.egress !== undefined ? { egress: adapter.egress } : {}),
    modelId: options.modelId,
    inputs: [PROBE_INPUT, ...EMBEDDING_SPACE_PROBE_INPUTS],
    ...(options.dimensionsParam !== undefined ? { dimensions: options.dimensionsParam } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.logContext !== undefined ? { logContext: options.logContext } : {}),
  };
  return adapter.requestBatch(request);
}

function fingerprintFromBatch(
  outcome: Extract<OpenAIEmbeddingBatchOutcome, { readonly ok: true }>,
  expectedDimensions: number,
): EmbeddingFingerprintCheck {
  const vectors = outcome.value.slice(1).map((entry) => entry.vector);
  if (
    vectors.length !== EMBEDDING_SPACE_PROBE_INPUTS.length ||
    vectors.some((vector) => vector.length !== expectedDimensions)
  ) {
    return failFingerprint("dimension-mismatch");
  }
  const fingerprint = embeddingSpaceFingerprintForVectors(vectors);
  return fingerprint === undefined
    ? failFingerprint("invalid-response")
    : { ok: true, fingerprint };
}

function validProbeVector(vector: Float32Array): boolean {
  const norm = vectorL2Norm(vector);
  return vector.length > 0 && Number.isFinite(norm) && norm > 0;
}

function capabilityFromBatch(
  options: EmbeddingProbeOptions,
  outcome: OpenAIEmbeddingBatchOutcome,
): EmbeddingCapabilityCheck {
  if (!outcome.ok) return fail(reasonFromAdapter(outcome.kind), outcome.status);
  const primary = outcome.value[0];
  if (primary === undefined || !validProbeVector(primary.vector)) return fail("invalid-response");
  const detected = primary.vector.length;
  if (options.expectedDimensions !== undefined && options.expectedDimensions !== detected) {
    return fail("dimension-mismatch");
  }
  const fingerprint = fingerprintFromBatch(outcome, detected);
  if (!fingerprint.ok) return fingerprint;
  return {
    ok: true,
    identity: buildIdentity(
      options,
      primary.modelId,
      detected,
      primary.modelRevision,
      fingerprint.fingerprint,
    ),
  };
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
      return failFingerprint(reasonFromAdapter(outcome.kind), outcome.status);
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

// Connection-owned verification replaces the retrieval-only ten-minute preflight cache. A
// stable adapter belongs to one accepted gateway configuration; changing the connection replaces
// the adapter. Startup, explicit Settings verification and retrieval share this same proof.
interface EmbeddingCapabilityEntry {
  readonly modelId: string;
  readonly promise: Promise<EmbeddingCapabilityCheck>;
  state: "pending" | "ready" | "failed";
}
const EMBEDDING_CAPABILITY_CACHES = new WeakMap<
  OpenAIEmbeddingAdapter,
  Map<string, EmbeddingCapabilityEntry>
>();
const EMBEDDING_CAPABILITY_CACHE_MAX = 64;

function capabilityCacheKey(options: EmbeddingProbeOptions): string {
  return JSON.stringify([
    options.provider,
    options.modelId,
    options.vectorMetric,
    options.dimensionsParam ?? null,
    options.normalization ?? EMBEDDING_NORMALIZATION,
    options.instructionVersion ?? EMBEDDING_INSTRUCTION_VERSION,
    options.includeSpaceFingerprint === true,
  ]);
}

function capabilityCacheFor(
  adapter: OpenAIEmbeddingAdapter,
): Map<string, EmbeddingCapabilityEntry> {
  let cache = EMBEDDING_CAPABILITY_CACHES.get(adapter);
  if (cache === undefined) {
    cache = new Map();
    EMBEDDING_CAPABILITY_CACHES.set(adapter, cache);
  }
  return cache;
}

/** A real request failure invalidates its connection's proof without starting a passive re-probe. */
export function invalidateEmbeddingCapability(
  adapter: OpenAIEmbeddingAdapter,
  modelId: string,
): void {
  const cache = EMBEDDING_CAPABILITY_CACHES.get(adapter);
  if (cache === undefined) return;
  for (const [key, entry] of cache) {
    if (entry.modelId === modelId)
      cache.set(key, {
        modelId,
        promise: Promise.resolve(fail("unavailable")),
        state: "failed",
      });
  }
}

function dimensionChecked(
  checked: EmbeddingCapabilityCheck,
  expectedDimensions: number | undefined,
): EmbeddingCapabilityCheck {
  return checked.ok &&
    expectedDimensions !== undefined &&
    expectedDimensions !== checked.identity.vectorDimensions
    ? fail("dimension-mismatch")
    : checked;
}

async function awaitCapabilityProof(
  promise: Promise<EmbeddingCapabilityCheck>,
  signal: AbortSignal | undefined,
): Promise<EmbeddingCapabilityCheck> {
  if (signal === undefined) return promise;
  if (signal.aborted) return fail("cancelled");
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<EmbeddingCapabilityCheck>((resolve) => {
    onAbort = (): void => {
      resolve(fail("cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function clearFailedModelProofs(
  cache: Map<string, EmbeddingCapabilityEntry>,
  modelId: string,
): void {
  for (const [key, entry] of cache)
    if (entry.modelId === modelId && entry.state === "failed") cache.delete(key);
}

function settleCapabilityProof(
  cache: Map<string, EmbeddingCapabilityEntry>,
  key: string,
  entry: EmbeddingCapabilityEntry,
  checked: EmbeddingCapabilityCheck,
  refresh: boolean,
): EmbeddingCapabilityCheck {
  entry.state = checked.ok ? "ready" : "failed";
  if (cache.get(key) !== entry) return checked.ok ? fail("unavailable") : checked;
  // Cancellation is the caller's decision, never evidence that a provider is unavailable.
  if (!checked.ok && checked.reason === "cancelled") cache.delete(key);
  else if (checked.ok && refresh) clearFailedModelProofs(cache, entry.modelId);
  return checked;
}

async function runCapabilityProbe(
  adapter: OpenAIEmbeddingAdapter,
  options: EmbeddingProbeOptions,
  onProbeStart: (() => (checked?: EmbeddingCapabilityCheck) => void) | undefined,
  admit?: (checked: EmbeddingCapabilityCheck) => EmbeddingCapabilityCheck,
): Promise<EmbeddingCapabilityCheck> {
  // Budget/admission reservations belong to physical work, never a cached read or joiner.
  const settle = onProbeStart?.();
  let checked: EmbeddingCapabilityCheck | undefined;
  try {
    checked = await verifyEmbeddingCapabilityUncached(adapter, options);
    checked = admit?.(checked) ?? checked;
    return checked;
  } finally {
    settle?.(checked);
  }
}

/** A refused local start observes no provider; keep the earlier proof, if there was one. */
function rememberCapabilityFailure(
  cache: Map<string, EmbeddingCapabilityEntry>,
  key: string,
  entry: EmbeddingCapabilityEntry,
  previous: EmbeddingCapabilityEntry | undefined,
  startRefused: boolean,
): void {
  entry.state = "failed";
  if (cache.get(key) !== entry) return;
  if (startRefused) {
    if (previous === undefined) cache.delete(key);
    else cache.set(key, previous);
    return;
  }
  cache.set(key, {
    modelId: entry.modelId,
    state: "failed",
    promise: Promise.resolve(fail("unavailable")),
  });
}

function clearCancelledCapabilityProof(
  cache: Map<string, EmbeddingCapabilityEntry>,
  key: string,
  entry: EmbeddingCapabilityEntry,
  checked: EmbeddingCapabilityCheck,
): void {
  if (!checked.ok && checked.reason === "cancelled" && cache.get(key) === entry) cache.delete(key);
}

/** Explicit verification renews a settled proof; concurrent startup/read requests join one probe. */
export async function verifyEmbeddingCapability(
  adapter: OpenAIEmbeddingAdapter,
  options: EmbeddingProbeOptions,
  reuse?: "connection" | "refresh",
  onProbeStart?: () => (checked?: EmbeddingCapabilityCheck) => void,
): Promise<EmbeddingCapabilityCheck> {
  if (reuse === undefined) return runCapabilityProbe(adapter, options, onProbeStart);
  if (options.signal?.aborted === true) return fail("cancelled");
  const cache = capabilityCacheFor(adapter);
  const key = capabilityCacheKey(options);
  const cached = cache.get(key);
  if (cached !== undefined && (reuse === "connection" || cached.state === "pending"))
    return dimensionChecked(
      await awaitCapabilityProof(cached.promise, options.signal),
      options.expectedDimensions,
    );
  // Every pod checks its stored dimension locally against the shared actual observation.
  const { expectedDimensions, ...probeOptions } = options;
  if (cache.size >= EMBEDDING_CAPABILITY_CACHE_MAX && !cache.has(key)) cache.clear();
  let startRefused = false;
  const start =
    onProbeStart === undefined
      ? undefined
      : (): ((checked?: EmbeddingCapabilityCheck) => void) => {
          try {
            return onProbeStart();
          } catch (error) {
            startRefused = true;
            throw error;
          }
        };
  const entry: EmbeddingCapabilityEntry = {
    modelId: options.modelId,
    state: "pending",
    promise: Promise.resolve()
      .then(() =>
        runCapabilityProbe(adapter, probeOptions, start, (checked) =>
          settleCapabilityProof(cache, key, entry, checked, reuse === "refresh"),
        ),
      )
      .catch((error: unknown) => {
        rememberCapabilityFailure(cache, key, entry, cached, startRefused);
        throw error;
      }),
  };
  cache.set(key, entry);
  const checked = await awaitCapabilityProof(entry.promise, options.signal);
  clearCancelledCapabilityProof(cache, key, entry, checked);
  return dimensionChecked(checked, expectedDimensions);
}

async function verifyEmbeddingCapabilityUncached(
  adapter: OpenAIEmbeddingAdapter,
  options: EmbeddingProbeOptions,
): Promise<EmbeddingCapabilityCheck> {
  if (!hasCredentials(adapter)) {
    return fail("missing-credentials");
  }
  if (options.includeSpaceFingerprint === true && adapter.requestBatch !== undefined) {
    return capabilityFromBatch(options, await requestProbeEmbeddingBatch(adapter, options));
  }
  const outcome = await requestProbeEmbedding(adapter, options, PROBE_INPUT);
  if (!outcome.ok) {
    return fail(reasonFromAdapter(outcome.kind), outcome.status);
  }

  const detected = outcome.value.vector.length;
  if (!validProbeVector(outcome.value.vector)) {
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
