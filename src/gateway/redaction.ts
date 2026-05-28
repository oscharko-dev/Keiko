// Secret redaction at the boundary. Every provider-derived string passes through
// redact() before it can reach an error message, log call, or serialised artefact.

const REDACTED = "[REDACTED]";

// Bearer <token>: keep the scheme, drop the credential.
const BEARER_PATTERN = /\bBearer\s+[\w.\-+/=]+/gi;

// OpenAI-style keys (sk-, sk-proj-, etc.): a prefix followed by >= 16 secret chars.
const API_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{16,}/g;

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
  for (const secret of additionalSecrets) {
    if (secret.length === 0) {
      continue;
    }
    output = output.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
  }
  return output;
}
