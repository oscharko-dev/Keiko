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
import { looksLikeEuDePii } from "./secret-patterns.js";

// Single-character-class patterns; no nesting. The phone-shape pattern accepts an optional
// leading +, then 7–14 digits with separators (space, dash, dot) so the total digit run isn't
// long enough to trip the secret scanner's PAN detector. The email pattern is a conservative
// local@host shape — anything resembling a routable address triggers `confidential`.
//
// The email pattern starts at the "@" and checks the local part behind it: written as
// `\b[local]+@host`, it read the rest of a text such as "1.1.1." from every position before
// finding no "@", quadratic in the text. A local part ends at an "@" and a host cannot contain
// one, so each run is read once. It accepts exactly what the earlier form accepted.
const EMAIL_RE = /@(?<=\b[A-Za-z0-9._%+-]+@)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const PHONE_RE = /(?:\+\d[\d\s.-]{6,14}\d|\b\d[\d .-]*[ .-]\d[\d .-]{4,12}\d\b)/;
// A calendar date is not a telephone number. "bis 31.12.2027" has the digit-and-separator shape the
// local-number pattern looks for, so a fact with an end date read as confidential and was refused
// (#4206 audit). A standalone date, with a valid day and month and no further digit group on either
// side, is blanked before the telephone check; a dotted number such as "01.23.45.67.89" or
// "030.12.05.2020" is not a date and keeps every digit. The other checks see the full text.
// A date-shaped token is "31.12.2027" or "1/2/26" (day, month, year) or "2026-11-07" (year, month,
// day). Each pattern matches a bounded token, so each replacement reads the text once; the day and
// month are checked in code, which keeps the patterns simple.
const DAY_FIRST_DATE_RE = /(?<![\d./-])(\d{1,2})([./])(\d{1,2})\2(?:\d{4}|\d{2})(?![./-]?\d)/g;
const ISO_DATE_RE = /(?<![\d./-])\d{4}-(\d{1,2})-(\d{1,2})(?![./-]?\d)/g;

function isCalendarDay(day: string, month: string): boolean {
  const dayNumber = Number(day);
  const monthNumber = Number(month);
  return dayNumber >= 1 && dayNumber <= 31 && monthNumber >= 1 && monthNumber <= 12;
}

function blankCalendarDates(body: string): string {
  return body
    .replace(DAY_FIRST_DATE_RE, (token: string, day: string, _separator: string, month: string) =>
      isCalendarDay(day, month) ? " " : token,
    )
    .replace(ISO_DATE_RE, (token: string, month: string, day: string) =>
      isCalendarDay(day, month) ? " " : token,
    );
}

function looksLikeTelephoneNumber(body: string): boolean {
  return PHONE_RE.test(blankCalendarDates(body));
}

const CONFIDENTIAL_MARKER_PATTERNS: readonly RegExp[] = [
  /\b(?:confidential|internal(?=\s+only|[:\s])|private(?=[:\s]))\b/i,
  /\b(?:vertraulich|nur\s+intern|intern(?=[:\s])|privat(?=[:\s])|geheim|nicht\s+speichern)\b/i,
];

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
  if (
    CONFIDENTIAL_MARKER_PATTERNS.some((pattern) => pattern.test(body)) ||
    EMAIL_RE.test(body) ||
    looksLikeTelephoneNumber(body) ||
    looksLikeEuDePii(body)
  ) {
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
