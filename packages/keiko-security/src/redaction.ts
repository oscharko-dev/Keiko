// Secret redaction at the boundary. Every provider-derived string passes through
// redact() before it can reach an error message, log call, or serialised artefact.
//
// ReDoS-safe by construction: every built-in pattern is a single linear character class with one
// bounded or open quantifier (no nesting), so none can backtrack catastrophically. Caller-supplied
// literals are escaped via escapeRegExp before any RegExp is built, so no caller-controlled
// metacharacter reaches the regex engine. This keeps the CodeQL js/polynomial-redos required
// gate green (ADR-0002).

import type { AuditRedactionConfig } from "@oscharko-dev/keiko-contracts";

const REDACTED = "[REDACTED]";

// Bearer <token>: keep the scheme, drop the credential.
const BEARER_PATTERN = /\bBearer\s+[\w.\-+/=]+/gi;
const BASIC_AUTH_PATTERN = /\bBasic\s+[\w.\-+/=]+/gi;

// OpenAI-style keys (sk-, sk-proj-, etc.): a prefix followed by >= 16 secret chars.
const API_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{16,}/g;

// Common third-party credential shapes. Each is a single linear character class with one
// bounded/open quantifier (no nesting), so none can backtrack catastrophically — this keeps
// CodeQL js/polynomial-redos satisfied while scrubbing non-OpenAI secrets from tool output.
const GITHUB_TOKEN_PATTERN = /\bgh[pousr]_[A-Za-z0-9]{20,}/g;
const AWS_ACCESS_KEY_PATTERN = /\bAKIA[0-9A-Z]{16}\b/g;
const SLACK_TOKEN_PATTERN = /\bxox[baprs]-[A-Za-z0-9-]{10,}/g;
const GOOGLE_API_KEY_PATTERN = /\bAIza[0-9A-Za-z_-]{20,}/g;
const STRIPE_KEY_PATTERN = /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g;
const PEM_PRIVATE_KEY_BLOCK_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const PEM_PRIVATE_KEY_HEADER_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const GENERIC_API_KEY_HEADER_PATTERN = /\b(x-api-key\s*:\s*)[^\s"'`,;]+/gi;
const GENERIC_API_KEY_ASSIGNMENT_PATTERN = /\b(api[_-]?key\s*[=:]\s*)[^\s"'`,;&]+/gi;

// Key-name-based value redaction (Epic #532 security audit H1). Connected-folder browsing and
// grounded answers can now surface arbitrary files whose secrets do not match a known token SHAPE
// (gcloud refresh_token, service-account client_secret, generic password/secret fields, AWS secret
// access key, DB passwords). This scrubs the VALUE assigned to a well-known secret KEY in JSON
// ("client_secret": "x"), INI/env (db_password=x), or YAML (secret: x) shape — keeping the key and
// separator, dropping the value. ReDoS-safe: alternation of literals + one linear value class.
const SECRET_KEY_NAMES =
  "passwd|password|api_?token|token|secret_key|secret|client_secret|refresh_token|access_token|id_token|private_key|aws_secret_access_key|secret_access_key|sas_token|jwt_secret|db_password|connection_?string|credential";
const SECRET_KEY_VALUE_PATTERN = new RegExp(
  `(?<![A-Za-z0-9])(${SECRET_KEY_NAMES})(["']?\\s*[:=]\\s*["']?)[^\\s"'\`,;&]+`,
  "gi",
);

// scheme://user:password@host — strip the userinfo credentials from any URL or DSN. One linear
// userinfo class on each side of the ':' and bounded by '@', so no catastrophic backtracking.
const URL_CREDENTIALS_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s:@/]+@/gi;

const BUILTIN_PATTERNS: readonly RegExp[] = [
  GITHUB_TOKEN_PATTERN,
  AWS_ACCESS_KEY_PATTERN,
  SLACK_TOKEN_PATTERN,
  GOOGLE_API_KEY_PATTERN,
  STRIPE_KEY_PATTERN,
  PEM_PRIVATE_KEY_BLOCK_PATTERN,
  PEM_PRIVATE_KEY_HEADER_PATTERN,
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Strips known secret shapes and any caller-supplied literal secrets from `input`.
// `additionalSecrets` lets the caller pass exact apiKey/baseUrl/env values it holds
// so even non-standard key formats are scrubbed.
export function redact(input: string, additionalSecrets: readonly string[] = []): string {
  let output = input
    .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
    .replace(BASIC_AUTH_PATTERN, `Basic ${REDACTED}`)
    .replace(GENERIC_API_KEY_HEADER_PATTERN, `$1${REDACTED}`)
    .replace(GENERIC_API_KEY_ASSIGNMENT_PATTERN, `$1${REDACTED}`)
    .replace(SECRET_KEY_VALUE_PATTERN, `$1$2${REDACTED}`)
    .replace(URL_CREDENTIALS_PATTERN, `$1${REDACTED}@`)
    .replace(API_KEY_PATTERN, REDACTED);
  for (const pattern of BUILTIN_PATTERNS) {
    output = output.replace(pattern, REDACTED);
  }
  for (const secret of additionalSecrets) {
    if (secret.length === 0) {
      continue;
    }
    output = output.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
  }
  return output;
}

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

// Returns a function string -> string applying redact() with the union of all literal secrets
// (additionalSecrets ∪ resolved env values ∪ sensitiveLiterals). Idempotent: redact() over already-
// redacted text is a no-op on the redacted tokens (ADR-0010 D3 audit-redaction layer).
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

// Recursively re-applies a redactor to EVERY STRING LEAF of a plain-JSON value, rebuilding
// arrays/objects so the input is never mutated and the JSON structure is preserved exactly. Bounded
// by the (finite) nesting depth of an EvidenceManifest. Idempotent (redact over already-redacted
// text is a no-op), so it is safe to apply at build time AND again as defense in depth at persist
// time. This is what makes the audit builder truly redacted-by-construction even for embedded
// summaries that the audit redactor would otherwise miss.
export function deepRedactStrings(
  value: unknown,
  redactString: (input: string) => string,
): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepRedactStrings(item, redactString));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = deepRedactStrings(child, redactString);
    }
    return out;
  }
  return value;
}
