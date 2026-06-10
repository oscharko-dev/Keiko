// Top-level capture entry points. extractCandidatesFromUserText and
// extractCandidatesFromWorkflowOutcome are the ONLY surfaces downstream packages should call.
// Internal extractors are composed here in a fixed priority order so the behaviour is one
// deterministic function of `(text, context, policy)`.
//
// Pre-flight order:
//   1. Trim and reject empty input -> `empty-content`.
//   2. Length cap -> `exceeds-length-limit`. The cap is applied BEFORE secret scanning so we do
//      not run the (cheap but unbounded) regex sweep on adversarially-large input.
//   3. Restricted-default short-circuit: if the caller pinned the policy default to
//      `restricted` the request is rejected directly - applyPolicy throws on this combination,
//      so we catch it explicitly upstream and emit a typed reason instead.
//
// Extractor priority:
//   forget > update > correction > remember > ambient identity. The most action-bearing intent
//   wins, and imperative remember/correction paths stay ahead of the narrower ambient fallback.

import { MEMORY_BODY_MAX_CHARS_DEFAULT } from "./_constants.js";
import { tryExtractAmbientIdentity } from "./intent-ambient.js";
import {
  tryExtractCorrection,
  tryExtractForget,
  tryExtractRemember,
  tryExtractUpdate,
} from "./intent-explicit.js";
import { extractWorkflowOutcomeCandidates } from "./intent-workflow.js";
import type {
  CaptureContext,
  CaptureOutcome,
  CapturePolicyOptions,
  WorkflowOutcomeInput,
} from "./types.js";

type Extractor = (
  text: string,
  context: CaptureContext,
  policy: CapturePolicyOptions,
) => CaptureOutcome | null;

// Priority order is intentional: forget > update > correction > remember > ambient identity.
// The most action-bearing intent wins so "forget about X" is never mis-extracted as a remember.
const EXTRACTORS: readonly Extractor[] = [
  tryExtractForget,
  tryExtractUpdate,
  tryExtractCorrection,
  tryExtractRemember,
  tryExtractAmbientIdentity,
];

// Pre-flight guard: returns a rejection outcome when the input is empty or oversize, otherwise
// null. Shared by the user-text and workflow-text entry points so both paths enforce the same
// length and restricted-sensitivity rules before any secret scan runs.
function preflightText(text: string, policy: CapturePolicyOptions): CaptureOutcome | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { kind: "rejected", reason: "empty-content" };
  }
  const max = policy.maxBodyChars ?? MEMORY_BODY_MAX_CHARS_DEFAULT;
  if (trimmed.length > max) {
    return { kind: "rejected", reason: "exceeds-length-limit" };
  }
  if (policy.defaultSensitivity === "restricted") {
    return { kind: "rejected", reason: "restricted-sensitivity" };
  }
  return null;
}

export function extractCandidatesFromUserText(
  text: string,
  context: CaptureContext,
  policy: CapturePolicyOptions = {},
): readonly CaptureOutcome[] {
  const preflight = preflightText(text, policy);
  if (preflight !== null) {
    return [preflight];
  }
  for (const extractor of EXTRACTORS) {
    const outcome = extractor(text, context, policy);
    if (outcome !== null) {
      return [outcome];
    }
  }
  return [];
}

export function extractCandidatesFromWorkflowOutcome(
  outcome: WorkflowOutcomeInput,
  context: CaptureContext,
  policy: CapturePolicyOptions = {},
): readonly CaptureOutcome[] {
  const preflight = preflightText(outcome.structuredReport, policy);
  if (preflight !== null) {
    return [preflight];
  }
  return extractWorkflowOutcomeCandidates(outcome, context, policy);
}
