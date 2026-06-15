import type {
  CaptureOutcome,
  CapturePolicyOptions,
  RejectionReason,
} from "@oscharko-dev/keiko-memory-capture";
import type { UiHandlerDeps } from "./deps.js";
import { currentRedactionSecrets } from "./deps.js";

export const SENSITIVE_MEMORY_REJECTION_REASON: RejectionReason =
  "sensitive-memory-requires-approval";

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
  return (
    outcome.kind === "candidate" &&
    !outcome.requiresApproval &&
    outcome.proposal.provenance.sensitivity === "public"
  );
}

export function enforcePersistableMemoryOutcome(outcome: CaptureOutcome): CaptureOutcome {
  if (outcome.kind !== "candidate" || isPersistableMemoryCandidate(outcome)) {
    return outcome;
  }
  return { kind: "rejected", reason: SENSITIVE_MEMORY_REJECTION_REASON };
}
