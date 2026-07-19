import {
  resolveEffectiveCodingWorkbenchMode,
  type CodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts";
import type {
  CaptureOutcome,
  CapturePolicyOptions,
  RejectionReason,
} from "@oscharko-dev/keiko-memory-capture";
import type { UiHandlerDeps } from "./deps.js";
import { currentRedactionSecrets } from "./deps.js";

export const SENSITIVE_MEMORY_REJECTION_REASON: RejectionReason =
  "sensitive-memory-requires-approval";
export const FORGOTTEN_MEMORY_SUPPRESSION_REASON: RejectionReason = "suppressed-by-forget";
export const SENSITIVE_MEMORY_ACTION_BODY = "Sensitive memory pending review.";

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
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  const deploymentCeiling = deps.codingRuntimeDeploymentCeiling ?? "governed-assist";
  return requestedMode === undefined
    ? deploymentCeiling
    : resolveEffectiveCodingWorkbenchMode(requestedMode, deploymentCeiling);
}

// Whether a capture outcome may be auto-accepted (promoted at capture time) under the given mode.
// The set of modes for which this returns true is upward-closed over CODING_WORKBENCH_MODE_ORDER
// (governed-assist < supervised-coding < autonomous-delivery), so raising the mode never removes
// eligibility. Hard denials stay upstream and mode-invariant: a secret body never becomes a
// candidate, "restricted" is never persistable, and "confidential" carries requiresApproval — none
// of which can be auto-accepted here regardless of mode.
export function memoryCaptureAutoAcceptEligible(
  mode: CodingWorkbenchMode,
  outcome: CaptureOutcome,
): boolean {
  return (
    mode !== "governed-assist" &&
    outcome.kind === "candidate" &&
    !outcome.requiresApproval &&
    outcome.proposal.provenance.sensitivity === "public"
  );
}
