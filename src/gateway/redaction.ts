// Secret redaction at the boundary. Every provider-derived string passes through
// redact() before it can reach an error message, log call, or serialised artefact.

const REDACTED = "[REDACTED]";

// Bearer <token>: keep the scheme, drop the credential.
const BEARER_PATTERN = /\bBearer\s+[\w.\-+/=]+/gi;

// OpenAI-style keys (sk-, sk-proj-, etc.): a prefix followed by >= 16 secret chars.
const API_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{16,}/g;

// Common third-party credential shapes. Each is a single linear character class with one
// bounded/open quantifier (no nesting), so none can backtrack catastrophically — this keeps
// CodeQL js/polynomial-redos satisfied while scrubbing non-OpenAI secrets from tool output.
const GITHUB_TOKEN_PATTERN = /\bgh[pousr]_[A-Za-z0-9]{20,}/g;
const AWS_ACCESS_KEY_PATTERN = /\bAKIA[0-9A-Z]{16}\b/g;
const SLACK_TOKEN_PATTERN = /\bxox[baprs]-[A-Za-z0-9-]{10,}/g;
const GOOGLE_API_KEY_PATTERN = /\bAIza[0-9A-Za-z_-]{20,}/g;
const PEM_PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;

const BUILTIN_PATTERNS: readonly RegExp[] = [
  GITHUB_TOKEN_PATTERN,
  AWS_ACCESS_KEY_PATTERN,
  SLACK_TOKEN_PATTERN,
  GOOGLE_API_KEY_PATTERN,
  PEM_PRIVATE_KEY_PATTERN,
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Strips known secret shapes and any caller-supplied literal secrets from `input`.
// `additionalSecrets` lets the gateway pass the exact apiKey/baseUrl values it holds
// so even non-standard key formats are scrubbed.
export function redact(input: string, additionalSecrets: readonly string[] = []): string {
  let output = input
    .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
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
