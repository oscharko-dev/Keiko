// QI-specific redaction wrapper (Issue #274, ADR-0023 D8).
//
// Runs the standard `redact` from `@oscharko-dev/keiko-security` over every string leaf of a
// candidate QI evidence record, augmented with a small fixed deny-list of QI-specific patterns.
// Caller-supplied literal secrets (apiKey/baseUrl/env values the gateway already holds) are passed
// through as `additionalSecrets` so the underlying linear escape-then-replace stays ReDoS-safe.
//
// Returns a redacted manifest plus a counts-only `redactionSummary` (matched-string count, not the
// matched text). The summary is what the audit cross-references; redaction is irreversible.

import { redact } from "@oscharko-dev/keiko-security";
import type { QualityIntelligenceRedactionSummary } from "./manifestSchema.js";

const QI_REDACTED = "[REDACTED]";

// QI-extension deny-list. Linear character classes with one bounded/open quantifier only — no
// nesting, no backreferences — so the polynomial-ReDoS gate stays green. Each pattern has a stable
// `id` used as the patternsMatched key in the summary.
interface QualityIntelligenceDenyPattern {
  readonly id: string;
  readonly pattern: RegExp;
}

// JWT shape: header.payload.signature, base64url segments only. Lower bound 8 per segment to avoid
// matching ordinary words; conservative on purpose — the security-package patterns catch the
// concrete OAuth/Bearer cases this pattern would otherwise duplicate.
const JWT_PATTERN = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const PASSWORD_ASSIGNMENT_PATTERN = /\b(password\s*[=:]\s*)[^\s"'`,;&]+/gi;
const TOKEN_ASSIGNMENT_PATTERN = /\b(token\s*[=:]\s*)[^\s"'`,;&]+/gi;

const QI_DENY_PATTERNS: readonly QualityIntelligenceDenyPattern[] = [
  { id: "jwt", pattern: JWT_PATTERN },
  { id: "password-assignment", pattern: PASSWORD_ASSIGNMENT_PATTERN },
  { id: "token-assignment", pattern: TOKEN_ASSIGNMENT_PATTERN },
];

// Per-pattern hit counts plus the security-package "global" bucket (everything `redact` itself
// stripped). The summary is intentionally lossy: matched text is never preserved.
interface QualityIntelligenceCounterState {
  totalStringsScanned: number;
  stringsRedacted: number;
  patternsMatched: Record<string, number>;
}

function createCounter(): QualityIntelligenceCounterState {
  return {
    totalStringsScanned: 0,
    stringsRedacted: 0,
    patternsMatched: {
      "security-package": 0,
      jwt: 0,
      "password-assignment": 0,
      "token-assignment": 0,
    },
  };
}

function applyQiDenyList(input: string, counter: QualityIntelligenceCounterState): string {
  let output = input;
  for (const { id, pattern } of QI_DENY_PATTERNS) {
    // Reset lastIndex defensively in case a global regex was matched against a prior input.
    pattern.lastIndex = 0;
    const matches = output.match(pattern);
    if (matches !== null && matches.length > 0) {
      counter.patternsMatched[id] = (counter.patternsMatched[id] ?? 0) + matches.length;
      output = output.replace(pattern, (match): string => {
        // For assignment patterns we preserve the captured prefix; redact() does the same.
        if (id === "password-assignment" || id === "token-assignment") {
          const eqIndex = match.search(/[=:]/);
          if (eqIndex >= 0) {
            return `${match.slice(0, eqIndex + 1)}${QI_REDACTED}`;
          }
        }
        return QI_REDACTED;
      });
    }
  }
  return output;
}

function redactString(
  input: string,
  additionalSecrets: readonly string[],
  counter: QualityIntelligenceCounterState,
): string {
  counter.totalStringsScanned += 1;
  const securityRedacted = redact(input, additionalSecrets);
  if (securityRedacted !== input) {
    counter.patternsMatched["security-package"] =
      (counter.patternsMatched["security-package"] ?? 0) + 1;
  }
  const qiRedacted = applyQiDenyList(securityRedacted, counter);
  if (qiRedacted !== input) {
    counter.stringsRedacted += 1;
  }
  return qiRedacted;
}

function deepRedact(
  value: unknown,
  additionalSecrets: readonly string[],
  counter: QualityIntelligenceCounterState,
): unknown {
  if (typeof value === "string") {
    return redactString(value, additionalSecrets, counter);
  }
  if (Array.isArray(value)) {
    return value.map((item): unknown => deepRedact(item, additionalSecrets, counter));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = deepRedact(child, additionalSecrets, counter);
    }
    return out;
  }
  return value;
}

export interface QualityIntelligenceRedactionOptions {
  // Caller-supplied literal secrets (apiKey/baseUrl/env values) the workflow holds. Passed to the
  // security-package `redact` as escaped literals so non-standard shapes still scrub. Strings
  // shorter than the security-package floor are filtered out there, not here.
  readonly additionalSecrets?: readonly string[] | undefined;
}

export interface QualityIntelligenceRedactionResult<TValue> {
  readonly redacted: TValue;
  readonly summary: QualityIntelligenceRedactionSummary;
}

// Redacts every string leaf of a plain-JSON QI evidence record. Idempotent: scanning already-
// redacted text matches no pattern (each pattern's REDACTED marker contains no credential shape),
// so re-running this function over its own output is a no-op modulo the counters.
//
// The generic `TValue` is preserved as a phantom — callers pass an object shape, get the same
// shape back. We do NOT promise the runtime value is now an instance of TValue (it cannot — JSON
// has no class identity), only that the structure is preserved.
export function redactQualityIntelligenceEvidence<TValue>(
  value: TValue,
  options: QualityIntelligenceRedactionOptions = {},
): QualityIntelligenceRedactionResult<TValue> {
  const additionalSecrets: readonly string[] = options.additionalSecrets ?? [];
  const counter = createCounter();
  const redacted = deepRedact(value, additionalSecrets, counter) as TValue;
  const summary: QualityIntelligenceRedactionSummary = {
    totalStringsScanned: counter.totalStringsScanned,
    stringsRedacted: counter.stringsRedacted,
    patternsMatched: { ...counter.patternsMatched },
  };
  return { redacted, summary };
}
