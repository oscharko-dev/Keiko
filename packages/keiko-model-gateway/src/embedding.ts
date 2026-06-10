// Embedding capability verification + identity compatibility for the Local
// Knowledge Connector. Decides whether a configured embedding model is reachable
// and whether its vector space remains compatible with a previously stored
// embedding identity. Every failure path produces a `safeMessage` string that
// MUST NOT contain API keys, full URLs, raw provider bodies, IPs, or the
// user-supplied input. Probes are pure-ish: I/O is encapsulated in the injected
// adapter function.

import type { EmbeddingModelIdentity, EmbeddingVectorMetric } from "@oscharko-dev/keiko-contracts";
import type {
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
  | "invalid-response"
  | "incompatible-with-stored-identity";

export interface EmbeddingIdentityWarning {
  readonly code: "model-revision-changed";
  readonly safeMessage: string;
  readonly previousRevision?: string;
  readonly currentRevision?: string;
}

export type EmbeddingCapabilityCheck =
  | {
      readonly ok: true;
      readonly identity: EmbeddingModelIdentity;
      readonly warning?: EmbeddingIdentityWarning;
    }
  | { readonly ok: false; readonly reason: EmbeddingFailureReason; readonly safeMessage: string };

export interface EmbeddingProbeOptions {
  readonly modelId: string;
  readonly provider: string;
  readonly vectorMetric: EmbeddingVectorMetric;
  readonly expectedDimensions?: number;
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
}

const PROBE_INPUT = "ping" as const;

const SAFE_MESSAGES: Readonly<Record<EmbeddingFailureReason, string>> = Object.freeze({
  "missing-credentials": "model gateway credentials are not configured",
  unavailable: "model gateway is not reachable",
  "wrong-header": "model gateway rejected the request — check API key configuration",
  "rate-limited": "model gateway is rate-limited — retry after the configured backoff",
  "dimension-mismatch": "embedding vector dimensions do not match the expected value",
  timeout: "embedding probe timed out",
  cancelled: "embedding probe was cancelled by the caller",
  "unsupported-model": "embedding model is not available on the configured gateway",
  "invalid-response": "embedding response was malformed",
  "incompatible-with-stored-identity":
    "embedding model identity changed — existing capsules are no longer compatible",
});

function fail(reason: EmbeddingFailureReason): EmbeddingCapabilityCheck {
  return { ok: false, reason, safeMessage: SAFE_MESSAGES[reason] };
}

function reasonFromAdapter(kind: OpenAIEmbeddingErrorKind): EmbeddingFailureReason {
  switch (kind) {
    case "wrong-header":
      return "wrong-header";
    case "rate-limited":
      return "rate-limited";
    case "unsupported-model":
      return "unsupported-model";
    case "timeout":
      return "timeout";
    case "cancelled":
      return "cancelled";
    case "invalid-response":
      return "invalid-response";
    case "transport":
      return "unavailable";
  }
}

function hasCredentials(adapter: OpenAIEmbeddingAdapter): boolean {
  return adapter.apiKey.trim().length > 0;
}

function buildIdentity(
  options: EmbeddingProbeOptions,
  detectedModelId: string,
  detectedDimensions: number,
  modelRevision: string | undefined,
): EmbeddingModelIdentity {
  return {
    provider: options.provider,
    modelId: detectedModelId,
    vectorDimensions: detectedDimensions,
    vectorMetric: options.vectorMetric,
    ...(modelRevision !== undefined ? { modelRevision } : {}),
  };
}

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
  return {
    ok: true,
    identity: buildIdentity(options, outcome.value.modelId, detected, outcome.value.modelRevision),
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

export function assertCompatibleEmbeddingIdentity(
  stored: EmbeddingModelIdentity,
  current: EmbeddingModelIdentity,
): EmbeddingCapabilityCheck {
  if (!structuralFieldsEqual(stored, current)) {
    return fail("incompatible-with-stored-identity");
  }
  if (revisionDiffers(stored, current)) {
    // Return the CURRENT identity (not stored) so the caller can persist the new revision
    // and avoid a permanent warning on every subsequent compatibility check. The warning
    // carries the previous revision for diagnostics. #192 Copilot finding.
    return { ok: true, identity: current, warning: buildRevisionWarning(stored, current) };
  }
  return { ok: true, identity: stored };
}
