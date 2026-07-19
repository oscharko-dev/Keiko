import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
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

export function memoryCapturePolicyForDeps(
  deps: UiHandlerDeps,
  base: CapturePolicyOptions = {},
): CapturePolicyOptions {
  const matchers = [
    ...(base.customerIdentifierMatchers ?? []),
    ...memoryCaptureCustomerMatchers(deps),
  ];
  return matchers.length === 0 ? base : { ...base, customerIdentifierMatchers: matchers };
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
// autonomy-capable surface under ADR-0129; the mode is the validated, server-owned coding-runtime
// deployment ceiling, and an unset ceiling fails closed to the most restrictive mode (ADR-0124 D2 /
// ADR-0138). No memory-local autonomy type is introduced — the canonical CodingWorkbenchMode is
// reused directly.
export function resolveMemoryCaptureAutonomyMode(deps: UiHandlerDeps): CodingWorkbenchMode {
  return deps.codingRuntimeDeploymentCeiling ?? "governed-assist";
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
