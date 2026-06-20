// Prompt Enhancement redaction wrapper (Issue #1313, ADR-0044 §5).
//
// Runs the authoritative `redact` from `@oscharko-dev/keiko-security` over every string leaf of a
// candidate Prompt Enhancement evidence record, returning the redacted value plus a counts-only
// `redactionSummary` (matched-string count, never the matched text). Topology literals (baseUrl/proxy
// values) are passed through as `additionalSecrets` for substring redaction. Opaque credentials (API
// keys/tokens) are passed through `opaqueSecrets`: if one appears in a string leaf, the whole leaf is
// replaced by a fixed marker before evidence hashing, so the credential value never becomes a hash
// input.

import { redact } from "@oscharko-dev/keiko-security";
import type { PromptEnhancementRedactionSummary } from "./manifestSchema.js";

const REDACTED = "[REDACTED]";

interface CounterState {
  totalStringsScanned: number;
  stringsRedacted: number;
  patternsMatched: Record<string, number>;
}

function createCounter(): CounterState {
  return {
    totalStringsScanned: 0,
    stringsRedacted: 0,
    patternsMatched: { "security-package": 0, "opaque-secret": 0 },
  };
}

function hasOpaqueSecret(input: string, opaqueSecrets: readonly string[]): boolean {
  return opaqueSecrets.some((secret) => secret.length > 0 && input.includes(secret));
}

function redactString(
  input: string,
  additionalSecrets: readonly string[],
  opaqueSecrets: readonly string[],
  counter: CounterState,
): string {
  counter.totalStringsScanned += 1;
  if (hasOpaqueSecret(input, opaqueSecrets)) {
    counter.patternsMatched["opaque-secret"] = (counter.patternsMatched["opaque-secret"] ?? 0) + 1;
    counter.stringsRedacted += 1;
    return REDACTED;
  }
  const redacted = redact(input, additionalSecrets);
  if (redacted !== input) {
    counter.patternsMatched["security-package"] =
      (counter.patternsMatched["security-package"] ?? 0) + 1;
    counter.stringsRedacted += 1;
  }
  return redacted;
}

function deepRedact(
  value: unknown,
  additionalSecrets: readonly string[],
  opaqueSecrets: readonly string[],
  counter: CounterState,
): unknown {
  if (typeof value === "string") {
    return redactString(value, additionalSecrets, opaqueSecrets, counter);
  }
  if (Array.isArray(value)) {
    return value.map((item): unknown =>
      deepRedact(item, additionalSecrets, opaqueSecrets, counter),
    );
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = deepRedact(child, additionalSecrets, opaqueSecrets, counter);
    }
    return out;
  }
  return value;
}

export interface PromptEnhancementRedactionOptions {
  // Caller-supplied literal secrets (apiKey/baseUrl/env values). Passed to `redact` as escaped
  // literals so non-standard shapes still scrub. Strings shorter than the security floor are filtered
  // out there, not here.
  readonly additionalSecrets?: readonly string[] | undefined;
  // Opaque credentials whose exact value must never become part of a redacted evidence fingerprint or
  // integrity hash. If any appears in a string leaf, the whole leaf becomes `[REDACTED]`.
  readonly opaqueSecrets?: readonly string[] | undefined;
}

export interface PromptEnhancementRedactionResult<TValue> {
  readonly redacted: TValue;
  readonly summary: PromptEnhancementRedactionSummary;
}

/**
 * Redact every string leaf of a plain-JSON Prompt Enhancement evidence value. Idempotent: scanning
 * already-redacted text matches no pattern (the `[REDACTED]` marker carries no credential shape), so
 * re-running this over its own output is a no-op modulo the counters. The generic `TValue` is a
 * phantom: callers pass an object shape and get the same shape back (JSON has no class identity).
 */
export function redactPromptEnhancementEvidence<TValue>(
  value: TValue,
  options: PromptEnhancementRedactionOptions = {},
): PromptEnhancementRedactionResult<TValue> {
  const additionalSecrets: readonly string[] = options.additionalSecrets ?? [];
  const opaqueSecrets: readonly string[] = options.opaqueSecrets ?? [];
  const counter = createCounter();
  const redacted = deepRedact(value, additionalSecrets, opaqueSecrets, counter) as TValue;
  const summary: PromptEnhancementRedactionSummary = {
    totalStringsScanned: counter.totalStringsScanned,
    stringsRedacted: counter.stringsRedacted,
    patternsMatched: { ...counter.patternsMatched },
  };
  return { redacted, summary };
}
