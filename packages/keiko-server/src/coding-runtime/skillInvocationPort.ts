// Server-side invocation of an approved skill (Issue #2387, Module B). A skill invocation is the
// strictly-narrower companion to a governed action: it may never mint a grant or widen authority.
// This port admits a `capability: "skill"` request only when the catalog approves the exact
// `id@version` (and, for an implicit invocation, only when the skill permits implicit use), then
// binds the returned outcome to what an injected authority re-evaluator allows — every tool request
// the skill would produce is re-run through the existing authority chain, so a denied
// re-evaluation yields a denied outcome and the invocation can never self-widen. An accepted
// invocation emits the same content-free, visible `skill-invoked` event whether it was explicit or
// implicit; only the retained invocation fact differs. Evidence stays content-free: ids, the
// normalized status, a result digest, and bounded reason codes only.
import type {
  AuxiliaryCapabilityOutcomeV1,
  AuxiliaryCapabilityRequestV1,
  CodeTaskSha256Digest,
  CodingWorkbenchAuxiliaryStatus,
  CodingWorkbenchRuntimeEvent,
} from "@oscharko-dev/keiko-contracts";
import {
  CODE_TASK_AUXILIARY_SCHEMA_VERSION,
  validateAuxiliaryCapabilityRequestV1,
} from "@oscharko-dev/keiko-contracts/runtime/code-task-auxiliary";
import { CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import { isCodeTaskSha256Digest } from "@oscharko-dev/keiko-contracts/runtime/code-task-acceptance";
import { validateCodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-validation";
import type { SkillCatalog } from "./skillCatalog.js";

/** The `capability: "skill"` variant of the auxiliary request this port handles. */
export type SkillInvocationRequest = Extract<AuxiliaryCapabilityRequestV1, { capability: "skill" }>;

// A normalized decision from re-running every tool request the skill would produce through the
// existing authority chain. `allowed` is the only path that can accept; its result digest is
// content-free. `denied` and `unavailable` fail closed and never carry a result.
export type SkillReevaluationDecision =
  | { readonly decision: "allowed"; readonly resultDigest: CodeTaskSha256Digest }
  | { readonly decision: "denied"; readonly reasonCode: string }
  | { readonly decision: "unavailable"; readonly reasonCode: string };

/**
 * Re-runs the tool requests an approved skill would produce through the existing authority chain.
 * Modeled as an injected port so a skill invocation can never bypass or self-widen authority: the
 * outcome is bound to the returned decision. An absent re-evaluator, a thrown re-evaluation, or an
 * `unavailable` decision all yield an `unavailable` outcome (fail closed).
 */
export interface SkillAuthorityReevaluator {
  readonly reevaluate: (request: SkillInvocationRequest) => SkillReevaluationDecision;
}

export interface SkillInvocationPortDeps {
  readonly catalog: SkillCatalog;
  readonly reevaluator?: SkillAuthorityReevaluator | undefined;
  readonly emitEvent: (event: CodingWorkbenchRuntimeEvent) => void;
  readonly now: () => Date;
}

export interface SkillInvocationPort {
  readonly invoke: (request: AuxiliaryCapabilityRequestV1) => AuxiliaryCapabilityOutcomeV1;
}

// Content-free bounded reason code, mirroring the auxiliary-contract rule. A re-evaluator supplied
// code that is not content-free is replaced by a canonical fallback so it can never smuggle text.
const CONTENT_FREE_REASON_CODE = /^[a-z0-9][a-z0-9-]{0,63}$/u;

type RejectedStatus = "denied" | "unavailable";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedReason(code: string, fallback: string): string {
  return CONTENT_FREE_REASON_CODE.test(code) ? code : fallback;
}

function accepted(resultDigest: CodeTaskSha256Digest): AuxiliaryCapabilityOutcomeV1 {
  return {
    schemaVersion: CODE_TASK_AUXILIARY_SCHEMA_VERSION,
    status: "accepted",
    capability: "skill",
    resultDigest: { outcome: "known", value: resultDigest },
    childResultCount: { outcome: "absent" },
  };
}

function rejected(status: RejectedStatus, reasonCode: string): AuxiliaryCapabilityOutcomeV1 {
  return {
    schemaVersion: CODE_TASK_AUXILIARY_SCHEMA_VERSION,
    status,
    capability: "skill",
    reasonCode,
  };
}

// Defensively re-validate a possibly-hostile request and narrow it to the skill variant. A
// structurally invalid request or a non-skill capability fails closed with a bounded reason.
function narrowSkillRequest(
  request: AuxiliaryCapabilityRequestV1,
):
  | { readonly ok: true; readonly value: SkillInvocationRequest }
  | { readonly ok: false; readonly reason: string } {
  const result = validateAuxiliaryCapabilityRequestV1(request);
  if (!result.ok) return { ok: false, reason: "malformed-request" };
  if (result.value.capability !== "skill") return { ok: false, reason: "capability-mismatch" };
  return { ok: true, value: result.value };
}

// Catalog + implicit-policy admission. An unapproved `id@version` or an implicit invocation of a
// skill that does not permit implicit use is rejected before any authority re-evaluation runs.
function admit(
  catalog: SkillCatalog,
  request: SkillInvocationRequest,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (!catalog.has(request.skillId)) return { ok: false, reason: "skill-not-approved" };
  if (request.invocation === "implicit" && !catalog.isImplicitAllowed(request.skillId)) {
    return { ok: false, reason: "implicit-not-permitted" };
  }
  return { ok: true };
}

function isReevaluationDecision(value: unknown): value is SkillReevaluationDecision {
  if (!isRecord(value)) return false;
  if (value.decision === "allowed") return isCodeTaskSha256Digest(value.resultDigest);
  if (value.decision === "denied" || value.decision === "unavailable") {
    return typeof value.reasonCode === "string";
  }
  return false;
}

function safeReevaluate(
  reevaluator: SkillAuthorityReevaluator,
  request: SkillInvocationRequest,
): SkillReevaluationDecision | undefined {
  let decision: SkillReevaluationDecision;
  try {
    decision = reevaluator.reevaluate(request);
  } catch {
    return undefined;
  }
  return isReevaluationDecision(decision) ? decision : undefined;
}

function outcomeForDecision(decision: SkillReevaluationDecision): AuxiliaryCapabilityOutcomeV1 {
  switch (decision.decision) {
    case "allowed":
      return accepted(decision.resultDigest);
    case "denied":
      return rejected("denied", boundedReason(decision.reasonCode, "reevaluation-denied"));
    case "unavailable":
      return rejected("unavailable", boundedReason(decision.reasonCode, "reevaluator-unavailable"));
  }
}

// Bind the outcome to the re-evaluator. An absent re-evaluator or a thrown/malformed re-evaluation
// fails closed to `unavailable`; the outcome can never be accepted without an `allowed` decision.
function evaluate(
  reevaluator: SkillAuthorityReevaluator | undefined,
  request: SkillInvocationRequest,
): AuxiliaryCapabilityOutcomeV1 {
  if (reevaluator === undefined) return rejected("unavailable", "reevaluator-unavailable");
  const decision = safeReevaluate(reevaluator, request);
  if (decision === undefined) return rejected("unavailable", "reevaluator-unavailable");
  return outcomeForDecision(decision);
}

// Emit the single visible, audited `skill-invoked` event for a narrowed invocation, whatever its
// outcome. An accepted invocation is identical for explicit and implicit use except the retained
// `skillInvocation` fact; a denied or unavailable invocation surfaces the SAME content-free event
// with its non-accepted `auxiliaryOutcome`, so catalog-probing and unapproved-id attempts leave an
// audit trail rather than being invisible on the transcript. The event is re-validated content-free
// before emission; an invalid event fails loud rather than leaking a malformed record.
function emitSkillEvent(
  deps: SkillInvocationPortDeps,
  sequence: number,
  request: SkillInvocationRequest,
  auxiliaryOutcome: CodingWorkbenchAuxiliaryStatus,
): void {
  const event: CodingWorkbenchRuntimeEvent = {
    schemaVersion: CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
    eventId: `evt-${String(sequence)}`,
    runId: request.runId,
    occurredAt: deps.now().toISOString(),
    kind: "skill-invoked",
    skillId: request.skillId,
    skillInvocation: request.invocation,
    auxiliaryOutcome,
  };
  if (!validateCodingWorkbenchRuntimeEvent(event).ok) {
    throw new Error("skill-invoked-event-invalid");
  }
  deps.emitEvent(event);
}

/**
 * Create the skill-invocation port. A single request yields a single normalized outcome, and EVERY
 * request that names a trustworthy skill id surfaces a `skill-invoked` event on the parent
 * transcript — accepted, denied by the catalog, and denied or unavailable at re-evaluation alike.
 * Denied probes are deliberately visible: a model repeatedly asking for an unapproved skill is
 * exactly what an operator needs to see. The one event-free path is a structurally malformed
 * request, which carries no skill id worth auditing; the request validator is its audit surface.
 */
export function createSkillInvocationPort(deps: SkillInvocationPortDeps): SkillInvocationPort {
  let sequence = 0;
  const invoke = (request: AuxiliaryCapabilityRequestV1): AuxiliaryCapabilityOutcomeV1 => {
    const narrowed = narrowSkillRequest(request);
    // A structurally malformed request has no trustworthy skillId to audit, so it fails closed
    // without an event; the upstream request validator is its audit surface.
    if (!narrowed.ok) return rejected("denied", narrowed.reason);
    const admission = admit(deps.catalog, narrowed.value);
    if (!admission.ok) {
      sequence += 1;
      emitSkillEvent(deps, sequence, narrowed.value, "denied");
      return rejected("denied", admission.reason);
    }
    const outcome = evaluate(deps.reevaluator, narrowed.value);
    sequence += 1;
    emitSkillEvent(deps, sequence, narrowed.value, outcome.status);
    return outcome;
  };
  return { invoke };
}
