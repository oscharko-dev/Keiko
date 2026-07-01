// Quality Intelligence connector error shapes (Epic #270, Issue #278).
//
// Safe error JSON for the QI connector routes. Bodies NEVER carry credentials, raw
// payloads, endpoint URLs, header values, or anything that could be mistaken for a
// secret. Every error message is a fixed string keyed by a stable code.
//
// The shape matches the existing BFF `ApiError` envelope (`{ error: { code, message } }`)
// so the gateway/router serialises it consistently with the other route groups.

export type QiConnectorErrorCode =
  | "QI_BAD_REQUEST"
  | "QI_CONNECTOR_DISABLED"
  | "QI_FORBIDDEN_PAYLOAD"
  | "QI_INVALID_ENVELOPE_SELECTION"
  | "QI_INTERNAL";

export interface QiConnectorErrorBody {
  readonly error: { readonly code: QiConnectorErrorCode; readonly message: string };
}

const SAFE_MESSAGES: Readonly<Record<QiConnectorErrorCode, string>> = {
  QI_BAD_REQUEST: "The request body is not a valid Quality Intelligence connector payload.",
  QI_CONNECTOR_DISABLED:
    "The requested connector is disabled. Enable it explicitly in the gateway configuration to send a dry-run.",
  QI_FORBIDDEN_PAYLOAD:
    "The request body contained a forbidden field. Connector payloads may not carry credentials, headers, or URLs.",
  QI_INVALID_ENVELOPE_SELECTION: "One or more selected envelope ids are not well-formed.",
  QI_INTERNAL: "The Quality Intelligence connector route could not service the request.",
};

export const qiConnectorErrorBody = (code: QiConnectorErrorCode): QiConnectorErrorBody => ({
  error: { code, message: SAFE_MESSAGES[code] },
});

/**
 * Defence-in-depth scrub: detect substrings that would indicate the caller is trying to
 * smuggle credentials or a header pair through a connector payload. Pure, no IO.
 *
 * Comparison is case-insensitive so that variants like "BEARER ", "API_KEY", or
 * "AUTHORIZATION:" are detected regardless of casing (prior case-variant list was
 * incomplete and bypassed by non-listed casings — Issue #281).
 */
const FORBIDDEN_SUBSTRINGS: readonly string[] = [
  "authorization:",
  "bearer ",
  "basic ",
  "apikey",
  "api_key",
  "cookie:",
  "set-cookie",
  "x-api-key",
];

const FORBIDDEN_SECRET_PATTERNS: readonly RegExp[] = [
  /AKIA[0-9A-Z]{12,}/u,
  /(?:ghp_|gho_|github_pat_)[A-Za-z0-9_]{20,}/u,
  /xox[baprs]-[A-Za-z0-9-]{10,}/u,
  /sk-[A-Za-z0-9]{16,}/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
];

export const containsForbiddenSecretShape = (value: string): boolean => {
  const lower = value.toLowerCase();
  for (const forbidden of FORBIDDEN_SUBSTRINGS) {
    if (lower.includes(forbidden)) return true;
  }
  for (const pattern of FORBIDDEN_SECRET_PATTERNS) {
    if (pattern.test(value)) return true;
  }
  return false;
};

/**
 * Scan a plain-object payload's string leaves for credential-shaped
 * substrings. Returns true if any value matches. Used by the dry-run routes BEFORE the
 * payload is even processed so a leaky client gets a 400 with a generic message.
 */
const valueContainsForbiddenSecretShape = (value: unknown, seen: WeakSet<object>): boolean => {
  if (typeof value === "string") return containsForbiddenSecretShape(value);
  if (typeof value !== "object" || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => valueContainsForbiddenSecretShape(entry, seen));
  }
  return Object.values(value as Readonly<Record<string, unknown>>).some((entry) =>
    valueContainsForbiddenSecretShape(entry, seen),
  );
};

export const payloadContainsForbiddenSecretShape = (
  payload: Readonly<Record<string, unknown>>,
): boolean => valueContainsForbiddenSecretShape(payload, new WeakSet());
