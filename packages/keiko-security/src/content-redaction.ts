import type { ContentRedactionPolicy } from "@oscharko-dev/keiko-contracts";
import { redact, redactCredentialShapes } from "./redaction.js";
import { createSecretSpellingStreamRedactor } from "./redaction-spelling.js";
import type { EnvSource } from "./secrets.js";

/** The deployment variable that selects the Chat content policy (#4098). */
export const CONTENT_REDACTION_ENV = "KEIKO_CONTENT_REDACTION";

/** How the deployment spelled its content policy; `invalid` resolves to `redact`. */
export type ContentRedactionSetting = "default" | "on" | "off" | "invalid";

export interface ResolvedContentRedactionPolicy {
  readonly policy: ContentRedactionPolicy;
  readonly setting: ContentRedactionSetting;
}

/**
 * Resolves the deployment-owned content policy once, at startup. Owner decision 2026-11-04: Keiko runs
 * on the user's own device and its stores never leave it, so what a person reads and what the model
 * receives lose only the credential floor; an absent or empty value and `off` preserve. The exact
 * value `on` lowers the threshold back to the strict projection, and every other value fails closed
 * to `redact` and is reported as `invalid` so the operator can see the typo.
 */
export function resolveContentRedactionPolicy(env: EnvSource): ResolvedContentRedactionPolicy {
  const value = env[CONTENT_REDACTION_ENV];
  if (value === undefined || value === "") return { policy: "preserve", setting: "default" };
  if (value === "off") return { policy: "preserve", setting: "off" };
  return { policy: "redact", setting: value === "on" ? "on" : "invalid" };
}

/**
 * Projects authorized document or model content under the selected policy, never diagnostics or
 * exported evidence. `redact` is the default heuristic projection. `preserve` keeps personal data,
 * configuration values and code, and still removes configured secrets (with their encoded
 * spellings) and the credential shapes of `redactCredentialShapes`. With
 * `preserveSourceLineBreaks`, a removed multi-line span keeps its line count, so source coordinates
 * stay physical.
 */
export function redactContent(
  input: string,
  policy: ContentRedactionPolicy,
  secrets: readonly string[] = [],
  options: Parameters<typeof redact>[2] = {},
): string {
  if (policy === "redact") return redact(input, secrets, options);
  const exact = redactCredentialShapes(input, secrets, options.preserveSourceLineBreaks === true);
  const spellings = createSecretSpellingStreamRedactor(
    secrets.filter((secret) => secret.length >= 4 && /^[\x20-\x7E]*$/u.test(secret)),
  );
  return spellings.push(exact) + spellings.finish();
}
