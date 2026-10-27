import { redact, redactSecretLiterals } from "./redaction.js";
import { createSecretSpellingStreamRedactor } from "./redaction-spelling.js";
import type { EnvSource } from "./secrets.js";

/** Deployment-owned content policy. Only the exact opt-out disables heuristic redaction.
 * Diagnostics, audit evidence and credentials continue using the unconditional redactor. */
export function contentRedactionEnabled(env: EnvSource = process.env): boolean {
  return env.KEIKO_CONTENT_REDACTION !== "off";
}

/** Authorized document/model content, never diagnostics or exported evidence. */
export function redactContent(
  input: string,
  secrets: readonly string[] = [],
  options: Parameters<typeof redact>[2] = {},
): string {
  if (contentRedactionEnabled()) return redact(input, secrets, options);
  if (secrets.length === 0) return input;
  const exact = redactSecretLiterals(input, secrets);
  const spellings = createSecretSpellingStreamRedactor(
    secrets.filter((secret) => /^[\x20-\x7E]*$/u.test(secret)),
  );
  return spellings.push(exact) + spellings.finish();
}
