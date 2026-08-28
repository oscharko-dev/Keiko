import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import {
  isCodingWorkbenchMode,
  resolveEffectiveCodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import type {
  CaptureOutcome,
  CapturePolicyOptions,
  RejectionReason,
} from "@oscharko-dev/keiko-memory-capture";
import type { MemoryId, MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";
import {
  planMemoryMaintenance,
  type MemoryAccessStatLike,
} from "@oscharko-dev/keiko-memory-governance";
import type { UiHandlerDeps } from "./deps.js";
import { currentRedactionSecrets } from "./deps.js";

// The two ways a capture can be refused because the local human already said "no" to this fact:
// they forgot it, or they rejected the proposal in the review queue. Both suppress a re-capture and
// both record a capture-decision audit event; neither ever echoes the body back.
export type MemoryCaptureSuppressionReason = Extract<
  RejectionReason,
  "suppressed-by-forget" | "suppressed-by-rejection"
>;

export const SENSITIVE_MEMORY_REJECTION_REASON: RejectionReason =
  "sensitive-memory-requires-approval";
export const FORGOTTEN_MEMORY_SUPPRESSION_REASON: MemoryCaptureSuppressionReason =
  "suppressed-by-forget";
export const REJECTED_MEMORY_SUPPRESSION_REASON: MemoryCaptureSuppressionReason =
  "suppressed-by-rejection";
export const SENSITIVE_MEMORY_ACTION_BODY = "Sensitive memory pending review.";

// The posture a memory surface falls back to when nothing narrower is resolvable: ADR-0124 D2 /
// ADR-0138 D2 fail closed to the most restrictive mode, and ADR-0146 D5 restates that for memory.
export const DEFAULT_MEMORY_AUTONOMY_MODE: CodingWorkbenchMode = "governed-assist";
const EMPTY_CAPTURE_ACCESS_STATS: ReadonlyMap<MemoryId, MemoryAccessStatLike> = new Map();

const DEFAULT_MEMORY_DENIED_CATEGORY_MATCHERS: NonNullable<
  CapturePolicyOptions["deniedCategoryMatchers"]
> = [
  {
    category: "health-data",
    matchers: [
      /\bhealth data\b/iu,
      /\bmedical (?:record|history)\b/iu,
      /\bdiagnos(?:is|ed)\b/iu,
      /\b(?:prescription|medication|blood type)\b/iu,
      /\b(?:my|the user's) chronic condition\b/iu,
      /\b(?:my|the user's) allerg(?:y|ies)\b/iu,
      /\b(?:my|the user's) (?:disability|therapy|treatment)\b/iu,
      /\b(?:gesundheitsdaten|diagnose|krankenakte)\b/iu,
      /\bmedikament(?:e|ation)?\b/iu,
    ],
  },
  {
    category: "identifiable-third-party",
    matchers: [
      /\bmy (?:colleague|coworker|manager|client|customer)\b/iu,
      /\bmy (?:partner|spouse|friend|doctor|patient)\b/iu,
      /\bthe user's (?:colleague|coworker|manager|client|customer)\b/iu,
      /\bthe user's (?:partner|spouse|friend|doctor|patient)\b/iu,
      /\bmein(?:e|er|em|en)? (?:kolleg(?:e|in)|chef(?:in)?|kund(?:e|in))\b/iu,
      /\bmein(?:e|er|em|en)? (?:partner(?:in)?|arzt|ärztin|patient(?:in)?)\b/iu,
    ],
  },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function exactMatcherFor(value: string): RegExp | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return new RegExp(escapeRegExp(trimmed));
}

export function memoryCaptureCustomerMatchers(deps: UiHandlerDeps): readonly RegExp[] {
  const literals = new Set<string>([
    ...(deps.redactionSecrets ?? []),
    ...currentRedactionSecrets(deps),
  ]);
  const matchers: RegExp[] = [];
  for (const literal of literals) {
    const matcher = exactMatcherFor(literal);
    if (matcher !== null) {
      matchers.push(matcher);
    }
  }
  return matchers;
}

// Layers deployment-specific denied categories ON TOP of the built-in defaults (health-data,
// identifiable-third-party) by category name, so a deployment that adds one custom category never
// silently drops the built-in protections it didn't mention. A deployment entry whose category
// name matches a default replaces that default's matchers (an intentional, explicit override);
// any other deployment entry is additive.
function mergedDeniedCategoryMatchers(
  deploymentMatchers: NonNullable<CapturePolicyOptions["deniedCategoryMatchers"]>,
): NonNullable<CapturePolicyOptions["deniedCategoryMatchers"]> {
  const deploymentCategories = new Set(deploymentMatchers.map((entry) => entry.category));
  const retainedDefaults = DEFAULT_MEMORY_DENIED_CATEGORY_MATCHERS.filter(
    (entry) => !deploymentCategories.has(entry.category),
  );
  return [...retainedDefaults, ...deploymentMatchers];
}

export function memoryCapturePolicyForDeps(
  deps: UiHandlerDeps,
  base: CapturePolicyOptions = {},
): CapturePolicyOptions {
  const matchers = [
    ...(base.customerIdentifierMatchers ?? []),
    ...memoryCaptureCustomerMatchers(deps),
  ];
  const deniedCategoryMatchers =
    base.deniedCategoryMatchers ??
    (deps.memoryDeniedCategoryMatchers === undefined
      ? DEFAULT_MEMORY_DENIED_CATEGORY_MATCHERS
      : mergedDeniedCategoryMatchers(deps.memoryDeniedCategoryMatchers));
  return {
    ...base,
    deniedCategoryMatchers,
    ...(matchers.length === 0 ? {} : { customerIdentifierMatchers: matchers }),
  };
}

export function isPersistableMemoryCandidate(
  outcome: CaptureOutcome,
): outcome is Extract<CaptureOutcome, { readonly kind: "candidate" }> {
  return outcome.kind === "candidate" && outcome.proposal.provenance.sensitivity !== "restricted";
}

export function enforcePersistableMemoryOutcome(outcome: CaptureOutcome): CaptureOutcome {
  if (outcome.kind !== "candidate" || isPersistableMemoryCandidate(outcome)) {
    return outcome;
  }
  return { kind: "rejected", reason: SENSITIVE_MEMORY_REJECTION_REASON };
}

// The effective autonomy mode for memory capture on this turn. Memory capture is an
// autonomy-capable surface under ADR-0129; a canonical requested mode is bounded by the validated,
// server-owned coding-runtime deployment ceiling. An unset ceiling fails closed to the most
// restrictive mode (ADR-0124 D2 / ADR-0138). Legacy calls without a requested mode retain #2546's
// ceiling-derived behavior. No memory-local autonomy type or ordering is introduced.
export function resolveMemoryCaptureAutonomyMode(
  deps: Pick<UiHandlerDeps, "codingRuntimeDeploymentCeiling">,
  requestedMode?: CodingWorkbenchMode,
): CodingWorkbenchMode {
  const deploymentCeiling = deps.codingRuntimeDeploymentCeiling ?? DEFAULT_MEMORY_AUTONOMY_MODE;
  return requestedMode === undefined
    ? resolveEffectiveCodingWorkbenchMode(deploymentCeiling, deploymentCeiling)
    : resolveEffectiveCodingWorkbenchMode(requestedMode, deploymentCeiling);
}

// The effective posture for the STANDING maintenance sweep. The sweep is not a request, so there is
// no per-call requested mode: the operator's persisted MemoriaViva memory posture (ADR-0146 D1's
// requested-mode surface, the value GET /api/memory/autonomy-policy projects) IS the request, and it
// is bounded by the server-owned deployment ceiling through the same canonical clamp the capture
// path uses. An absent policy row means the operator never widened the posture, which the policy
// projection already reports as `governed-assist` — so the sweep behaves exactly as the mode the UI
// is showing. This may throw if the UI store is unreadable; callers that must not fail a chat turn
// wrap it and fall closed (see resolveMaintenanceAutonomyMode in memory-maintenance-handlers.ts).
export function resolvePersistedMemoryAutonomyMode(
  deps: Pick<UiHandlerDeps, "codingRuntimeDeploymentCeiling" | "store">,
): CodingWorkbenchMode {
  const requestedMode = deps.store.readMemoryAutonomyPolicy()?.requestedMode;
  return resolveMemoryCaptureAutonomyMode(deps, requestedMode ?? DEFAULT_MEMORY_AUTONOMY_MODE);
}

export function resolveMemoryMaintenanceAutonomyMode(
  deps: Pick<UiHandlerDeps, "codingRuntimeDeploymentCeiling" | "store">,
): CodingWorkbenchMode {
  return resolvePersistedMemoryAutonomyMode(deps);
}

// THE lever for "may Keiko make a memory retrievable without the local human accepting it?".
//
// ADR-0146 D2 pins the lowest posture: in `governed-assist` (Ask for approval) a routine, public
// candidate is held as `proposed` for human review. Both auto-accept paths — the at-capture
// promotion below and the standing maintenance sweep in memory-maintenance-handlers.ts — consult
// this ONE predicate, so a mode-gated capture path and a mode-blind sweep can never again promote
// two different sets. The set of modes it admits is upward-closed over CODING_WORKBENCH_MODE_ORDER
// (governed-assist < supervised-coding < autonomous-delivery), so raising the mode never removes
// eligibility (ADR-0138 D2 monotonicity). An absent, unknown, or malformed mode fails closed to
// `governed-assist`, i.e. no unattended acceptance at all (ADR-0124 D2 / ADR-0138 D2).
export function memoryUnattendedAcceptanceAllowed(mode: CodingWorkbenchMode | undefined): boolean {
  return isCodingWorkbenchMode(mode) && mode !== "governed-assist";
}

// Whether a capture outcome may be auto-accepted (promoted at capture time) under the given mode.
// Hard denials stay upstream and mode-invariant: a secret body never becomes a candidate,
// "restricted" is never persistable, and "confidential" carries requiresApproval — none of which
// can be auto-accepted here regardless of mode.
export function memoryCaptureAutoAcceptEligible(
  mode: CodingWorkbenchMode,
  outcome: CaptureOutcome,
): boolean {
  return (
    memoryUnattendedAcceptanceAllowed(mode) &&
    outcome.kind === "candidate" &&
    !outcome.requiresApproval &&
    outcome.proposal.provenance.sensitivity === "public"
  );
}

// Route every mode-eligible capture through the existing governance promotion plan. This keeps
// promotion thresholds and future governance changes identical across all capture surfaces.
export function promoteEligibleMemoryRecord(record: MemoryRecord): MemoryRecord {
  const plan = planMemoryMaintenance([record], EMPTY_CAPTURE_ACCESS_STATS, {
    nowMs: record.createdAt,
  });
  return plan.promote.includes(record.id)
    ? { ...record, status: "accepted", updatedAt: record.createdAt }
    : record;
}
