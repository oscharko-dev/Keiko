// Sensitivity classification + per-call policy decisions for keiko-memory-capture.
//
// Sensitivity is a SOURCE-side label (lives on MemoryProvenance per ADR-0019 contracts) — once
// assigned, the audit and retention layers honour it without re-classifying. This module's job
// is therefore two-fold:
//
//   1. Pick the right initial sensitivity for a body based on heuristic signals
//      (contact data, explicit markers).
//   2. Decide whether the resulting candidate must be gated behind explicit user approval before
//      it can land in storage. ANY non-public sensitivity flips the approval flag — `confidential`
//      requires a confirmation prompt; `restricted` is rejected upstream (see capture.ts).
//
// The heuristics are deliberately narrow (high precision over high recall) so the layer does not
// reject benign user memories. The wider secret-rejection net lives in secret-patterns.ts; this
// module's classifier covers PII-shaped content the secret scanner doesn't catch (email,
// phone-shape numbers, marker words like "confidential").

import type { MemorySensitivity } from "@oscharko-dev/keiko-contracts/memory";

// Linear single-character-class patterns; no nesting. The phone-shape pattern accepts an optional
// leading +, then 7–14 digits with separators (space, dash, dot) so the total digit run isn't
// long enough to trip the secret scanner's PAN detector. The email pattern is a conservative
// local@host shape — anything resembling a routable address triggers `confidential`.
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const PHONE_RE = /\+?\d[\d\s.-]{6,14}\d/;
const CONFIDENTIAL_MARKER_RE = /\b(confidential|internal\s+only|internal[:\s]|private[:\s])/i;

interface ApplyPolicyInput {
  readonly defaultSensitivity?: MemorySensitivity;
}

export interface PolicyDecision {
  readonly sensitivity: MemorySensitivity;
  readonly requiresApproval: boolean;
}

// Returns the sensitivity class for `body`. `defaultSensitivity` is the floor for benign text —
// it never DEMOTES a body that triggered a marker. `"restricted"` is intentionally NOT a valid
// default: a deployment that wants every capture to require approval should pass
// `"confidential"`. `applyPolicy` enforces this with a thrown CaptureRejection-style error.
export function classifySensitivity(
  body: string,
  defaultSensitivity: MemorySensitivity = "public",
): MemorySensitivity {
  if (CONFIDENTIAL_MARKER_RE.test(body) || EMAIL_RE.test(body) || PHONE_RE.test(body)) {
    return "confidential";
  }
  return defaultSensitivity;
}

// Returns the policy decision for `body`: sensitivity + whether downstream must show an approval
// prompt. `restricted` is reserved for caller-side rejection (see capture.ts) — passing it as
// the default would silently swallow the rejection path here, so we throw a programmer-error.
export function applyPolicy(body: string, options: ApplyPolicyInput = {}): PolicyDecision {
  if (options.defaultSensitivity === "restricted") {
    throw new Error(
      "policy.defaultSensitivity must not be 'restricted'; capture rejects restricted candidates upstream",
    );
  }
  const sensitivity = classifySensitivity(body, options.defaultSensitivity);
  return { sensitivity, requiresApproval: sensitivity !== "public" };
}
