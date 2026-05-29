// The audit redaction surface (ADR-0010 D3). It COMPOSES the gateway redact() (imported, never
// modified) with three additional literal-secret sources, producing one redactor the builder applies
// to every sensitive field before the manifest is constructed (redacted-by-construction).
//
// ReDoS-safe by construction: env values and configured literals are passed to redact() as
// `additionalSecrets`, which escapes each literal via escapeRegExp before building a RegExp. No
// caller-controlled metacharacter reaches the regex engine and NO NEW REGEX is introduced here —
// the layer reuses the gateway's audited linear patterns and the escaped-literal path only. This
// keeps the CodeQL js/polynomial-redos required gate green (ADR-0002).

import { redact } from "../gateway/redaction.js";
import type { AuditRedactionConfig } from "./types.js";

// A literal shorter than this is too generic to scrub safely: redacting a 2-char value would
// over-redact ordinary prose. redact() itself only skips empty strings, so the floor lives here.
const MIN_LITERAL_LENGTH = 4;

// Resolves the VALUES of the named env vars (never the names), keeping only non-empty values long
// enough to be a plausible secret. The builder passes these as escaped literals to redact().
function resolveEnvValues(
  names: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const values: string[] = [];
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.length >= MIN_LITERAL_LENGTH) {
      values.push(value);
    }
  }
  return values;
}

function keepLongEnough(literals: readonly string[]): readonly string[] {
  return literals.filter((literal) => literal.length >= MIN_LITERAL_LENGTH);
}

// Returns a function string -> string applying gateway redact() with the union of all literal
// secrets (additionalSecrets ∪ resolved env values ∪ sensitiveLiterals). Idempotent: redact() over
// already-redacted text is a no-op on the redacted tokens.
export function createAuditRedactor(
  config: AuditRedactionConfig,
  env: Readonly<Record<string, string | undefined>>,
): (input: string) => string {
  const literals = [
    ...keepLongEnough(config.additionalSecrets ?? []),
    ...resolveEnvValues(config.redactEnvValues ?? [], env),
    ...keepLongEnough(config.sensitiveLiterals ?? []),
  ];
  return (input: string): string => redact(input, literals);
}
