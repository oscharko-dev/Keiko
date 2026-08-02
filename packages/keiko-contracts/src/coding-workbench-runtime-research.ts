import type { CodingWorkbenchValidationResult } from "./coding-workbench.js";
import { isCodeTaskPublicDomain } from "./code-task-auxiliary.js";
import {
  exactKeys,
  invalid,
  isOneOf,
  isRecord,
  result,
  validateSafeId,
  validateStrictUtcInstant,
} from "./coding-workbench-runtime-api-validation.js";
import { CODING_WORKBENCH_RUNTIME_API_ID_MAX_CHARS } from "./coding-workbench-runtime-api.js";
import { stripUnsafeFormatChars } from "./text-safety.js";

/** A DNS name can never exceed 253 characters; anything longer is not a host we would fetch. */
export const CODING_WORKBENCH_RESEARCH_HOST_MAX_CHARS = 253;
/** Bounds the reviewable request line so a hostile URL cannot flood the approval panel. */
export const CODING_WORKBENCH_RESEARCH_REQUEST_LINE_MAX_CHARS = 2_048;

/** Session facet of a channel-carried research payload: the status of the presented cookie only. */
export const CODING_WORKBENCH_RUNTIME_RESEARCH_SESSION_STATES = ["active", "unpaired"] as const;

export type CodingWorkbenchRuntimeResearchSession =
  (typeof CODING_WORKBENCH_RUNTIME_RESEARCH_SESSION_STATES)[number];

/**
 * The outbound request a pending research ask would perform, shown to the operator BEFORE the
 * approval decision (#2387 acceptance criterion: visible sanitized queries).
 *
 * `requestLine` is the sanitized decoded pathname plus visible query — byte-for-byte the same text
 * the minted grant's request-line digest binds and the egress executor re-verifies. Showing exactly
 * that text is what makes the binding meaningful: the operator approves a request line they read,
 * not a hash of one they never saw.
 *
 * Both fields are model-chosen and therefore untrusted: render them as transient text, never as
 * markup, and never write them to durable evidence.
 */
export interface CodingWorkbenchRuntimePendingResearch {
  readonly requestId: string;
  readonly host: string;
  readonly requestLine: string;
  readonly expiresAt: string;
}

/**
 * A live governed research grant. Its domains are model-selected content and therefore travel only
 * over the authenticated research channel, never through a general runtime snapshot (#2644).
 */
export interface CodingWorkbenchRuntimeResearchGrant {
  readonly grantId: string;
  readonly domains: readonly string[];
  readonly expiresAt: string;
}

/**
 * Pending and approved research state as carried over the authenticated app-session channel
 * (#2478, #2644, ADR-0141).
 *
 * This is deliberately NOT on the unauthenticated status or SSE routes: the host and request line
 * are repository/model-derived text, and the epic keeps those surfaces permanently content-free.
 * `session` reflects only whether the caller's own presented cookie is a valid app session — never
 * the existence of a run or of a pending ask — so an unpaired browser renders an honest re-pair
 * state instead of a silent "nothing pending", and the payload is not an existence oracle.
 */
export interface CodingWorkbenchRuntimeResearchChannelPayload {
  readonly session: CodingWorkbenchRuntimeResearchSession;
  readonly pending?: CodingWorkbenchRuntimePendingResearch | undefined;
  readonly grant?: CodingWorkbenchRuntimeResearchGrant | undefined;
}

/**
 * The single source of the constant content-free projection every unauthenticated caller of the
 * research route receives (ADR-0141 D6): independent of run existence, runtime configuration, and
 * pending-ask state.
 */
export function unpairedCodingWorkbenchRuntimeResearchChannelPayload(): CodingWorkbenchRuntimeResearchChannelPayload {
  return { session: "unpaired" };
}

/**
 * Validate a channel-carried research payload: exact keys, a valid session facet, bounded
 * model-selected text, strict UTC expiries, and the invariant that an `unpaired` payload carries
 * neither pending nor approved research state.
 */
export function validateCodingWorkbenchRuntimeResearchChannelPayload(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeResearchChannelPayload> {
  if (!isRecord(value)) return invalid("research channel payload must be an object");
  const errors = exactKeys(value, ["session", "pending", "grant"], "researchChannelPayload");
  if (!isOneOf(value.session, CODING_WORKBENCH_RUNTIME_RESEARCH_SESSION_STATES)) {
    errors.push("researchChannelPayload.session is invalid");
  }
  if (value.session === "unpaired" && (value.pending !== undefined || value.grant !== undefined)) {
    errors.push(
      "researchChannelPayload research state must be absent when the session is unpaired",
    );
  }
  if (value.pending !== undefined) validatePendingResearch(value.pending, errors);
  if (value.grant !== undefined) validateResearchGrant(value.grant, errors);
  return result(value, errors);
}

function validatePendingResearch(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("researchChannelPayload.pending must be an object");
    return;
  }
  errors.push(
    ...exactKeys(value, ["requestId", "host", "requestLine", "expiresAt"], "pendingResearch"),
  );
  validateSafeId(
    value.requestId,
    "pendingResearch.requestId",
    errors,
    CODING_WORKBENCH_RUNTIME_API_ID_MAX_CHARS,
  );
  if (!isCodeTaskPublicDomain(value.host)) {
    errors.push("pendingResearch.host must be a canonical public domain");
  }
  // The request line for a bare root fetch is legitimately empty, so only the upper bound applies.
  if (
    typeof value.requestLine !== "string" ||
    value.requestLine.length > CODING_WORKBENCH_RESEARCH_REQUEST_LINE_MAX_CHARS
  ) {
    errors.push("pendingResearch.requestLine must be a bounded string");
  } else if (stripUnsafeFormatChars(value.requestLine) !== value.requestLine) {
    errors.push("pendingResearch.requestLine contains unsafe format characters");
  }
  validateStrictUtcInstant(value.expiresAt, "pendingResearch.expiresAt", errors);
}

function validateResearchGrant(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("researchChannelPayload.grant must be an object");
    return;
  }
  errors.push(...exactKeys(value, ["grantId", "domains", "expiresAt"], "researchGrant"));
  validateSafeId(
    value.grantId,
    "researchGrant.grantId",
    errors,
    CODING_WORKBENCH_RUNTIME_API_ID_MAX_CHARS,
  );
  if (
    !Array.isArray(value.domains) ||
    value.domains.length === 0 ||
    !value.domains.every((domain) => isCodeTaskPublicDomain(domain))
  ) {
    errors.push("researchGrant.domains must be a non-empty list of public domains");
  }
  validateStrictUtcInstant(value.expiresAt, "researchGrant.expiresAt", errors);
}
