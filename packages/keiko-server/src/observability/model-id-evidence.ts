// The one owning projection from a candidate model id to Activity Log evidence (#3557 review).
//
// A request-supplied model id must never be logged as-is: it is caller-controlled content, and the
// Activity Log's generic opaque-id redactor only recognises a handful of known SHAPES (an email
// address, an absolute path, a few credential patterns) — it has no way to know a value is, say, a
// person's name, so an unconfigured id such as "patient-Alice-Jones" passed the redactor and was
// logged verbatim on `chat.creation.rejected` (finding A). The only evidence-safe test of a caller
// value is whether the effective capability source actually configures a model by that id — the
// SAME test the create/send/regenerate admission and the readiness provider selection already
// apply (`resolvedModelCapability`), reused here so evidence and business decisions can never
// disagree about what counts as "configured". A candidate no gateway configures is still evidence
// of what was refused, so it is logged as a one-way digest: two refused candidates stay apart, and
// a retried one reads as the same (#3557 review).
//
// A configured id that passes the opaque-id check is logged raw under the same data class the
// Model Gateway records it with on every call (`gateway.chat.*`, `gateway.stream.*`), so a
// rejection or readiness line joins those lines directly. A configured id can still fail the
// opaque-id shape check — nothing stops an operator from naming a provider entry
// "alice@example.com". `activityLogEvent` rejects the WHOLE event on one bad field, so logging it
// raw would silently drop the entire rejection or readiness line instead of just that one field
// (the follow-up finding). This projection falls back to a one-way digest instead, so the line is
// always written and stays joinable without ever carrying the raw id. `modelId` and
// `modelIdDigest` are mutually exclusive: at most one is ever present in the fields this returns.

import {
  findCapability,
  findConfiguredCapability,
  type ModelCapability,
} from "@oscharko-dev/keiko-model-gateway";
import { isActivityLogOpaqueIdValue } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { sha256Hex } from "@oscharko-dev/keiko-security/hashing";

import { currentGatewayConfig, type UiHandlerDeps } from "../deps.js";

// The bound every `modelId` field in the Activity Log registrations this module feeds declares.
export const MAX_MODEL_ID_EVIDENCE_CHARS = 240;

// A truncated sha-256 (16 hex characters, 64 bits): collision-free across every model a single
// process configures, short enough to read at the start of a line, and — being a one-way digest —
// carries nothing back about the id it stands for. Matches the existing `modelIdDigest` convention
// (`keiko-local-knowledge/src/indexing/preflight-activity-log.ts`).
const MODEL_ID_DIGEST_LENGTH = 16;

export interface ModelIdEvidence {
  readonly modelId?: string;
  readonly modelIdDigest?: string;
}

/**
 * Resolves a candidate model id against the effective capability source: the configured gateway
 * when one exists, the built-in default registry otherwise. Exported so a caller that also needs
 * the capability itself (e.g. its `kind`, as `chat-handlers.ts`'s `chatCapability` does) shares
 * this exact resolution rather than re-deriving it — evidence and business decisions can then never
 * drift apart on what counts as "configured".
 */
export function resolvedModelCapability(
  deps: UiHandlerDeps,
  modelId: string,
): ModelCapability | undefined {
  const config = currentGatewayConfig(deps);
  return config === undefined ? findCapability(modelId) : findConfiguredCapability(config, modelId);
}

/**
 * Projects a candidate model id to Activity Log evidence. `undefined` or an empty string yields
 * none. A configured id is logged raw only when it fits `MAX_MODEL_ID_EVIDENCE_CHARS` and satisfies
 * the SAME opaque-id validation `activityLogEvent` applies. Anything else — a candidate no gateway
 * configures, or a configured id outside that shape — is logged as a digest of the WHOLE id, never
 * the raw value: a truncated raw id would let two long ids sharing a prefix collide in the log
 * (#3557 review).
 */
export function modelIdEvidence(deps: UiHandlerDeps, modelId: string | undefined): ModelIdEvidence {
  if (modelId === undefined || modelId.length === 0) return {};
  const configured = resolvedModelCapability(deps, modelId) !== undefined;
  return configured && isActivityLogOpaqueIdValue(modelId, MAX_MODEL_ID_EVIDENCE_CHARS)
    ? { modelId }
    : { modelIdDigest: sha256Hex(modelId).slice(0, MODEL_ID_DIGEST_LENGTH) };
}
