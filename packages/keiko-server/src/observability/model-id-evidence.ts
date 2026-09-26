// The one owning projection from a candidate model id to Activity Log evidence (#3557 review).
//
// A model id reaches these lines only as a one-way digest, never raw. A request-supplied id is
// caller-controlled content, and even a configured one is operator-chosen text: neither the
// configured-model check nor the opaque-id shape check proves that it is body-free (an operator
// can name a provider entry "patient-Alice-Jones"). The Activity Log's generic redactor only
// recognises a handful of known SHAPES, so it cannot make that decision either. The digest keeps
// every rejection and readiness line joinable: two refused candidates stay apart, a retried one
// reads as the same, and a reader who holds the configuration can recompute it.

import {
  findCapability,
  findConfiguredCapability,
  type ModelCapability,
} from "@oscharko-dev/keiko-model-gateway";
import { sha256Hex } from "@oscharko-dev/keiko-security/hashing";

import { currentGatewayConfig, type UiHandlerDeps } from "../deps.js";

// A truncated sha-256 (16 hex characters, 64 bits): collision-free across every model a single
// process configures, short enough to read at the start of a line, and — being a one-way digest —
// carries nothing back about the id it stands for. Matches the existing `modelIdDigest` convention
// (`keiko-local-knowledge/src/indexing/preflight-activity-log.ts`).
const MODEL_ID_DIGEST_LENGTH = 16;

export interface ModelIdEvidence {
  readonly modelIdDigest?: string;
}

/**
 * Resolves a candidate model id against the effective capability source: the configured gateway
 * when one exists, the built-in default registry otherwise (`chat-handlers.ts`'s
 * `chatCapability`, the create/send/regenerate admission).
 */
export function resolvedModelCapability(
  deps: UiHandlerDeps,
  modelId: string,
): ModelCapability | undefined {
  const config = currentGatewayConfig(deps);
  return config === undefined ? findCapability(modelId) : findConfiguredCapability(config, modelId);
}

/**
 * Projects a candidate model id to Activity Log evidence: the digest of the WHOLE id, never the
 * raw value. `undefined` or an empty string yields none.
 */
export function modelIdEvidence(modelId: string | undefined): ModelIdEvidence {
  if (modelId === undefined || modelId.length === 0) return {};
  return { modelIdDigest: sha256Hex(modelId).slice(0, MODEL_ID_DIGEST_LENGTH) };
}
