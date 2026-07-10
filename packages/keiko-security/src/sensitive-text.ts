// Generic, content-free sensitive-text classifier shared by memory capture and feedback egress.
// Patterns are bounded/linear; callers receive a closed signal only, never the matched substring.

import {
  containsCredentialDetection,
  containsFeedbackCredentialDetection,
} from "./credential-spans.js";

export const SENSITIVE_TEXT_SIGNALS = [
  "credential-shape",
  "private-credential-path",
  "provider-base-url",
  "raw-log-content",
  "customer-identifier",
] as const;
export type SensitiveTextSignal = (typeof SENSITIVE_TEXT_SIGNALS)[number];

const CREDENTIAL_SHAPE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bxox[abporsu]-[A-Za-z0-9-]{10,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b\d{13,19}\b/,
];

const CREDENTIAL_PATH_PATTERNS: readonly RegExp[] = [
  /\.ssh\/id_[A-Za-z0-9_-]+/i,
  /\.aws\/credentials\b/i,
  /(^|[\s/])\.npmrc\b/i,
  /(^|[\s/])\.env(\.[A-Za-z0-9_-]+)?\b/i,
];

const URL_CANDIDATE_RE = /\bhttps?:\/\/[^\s"'`<>]+/gi;
const PROVIDER_CONTEXT_RE =
  /\b(provider|gateway|base\s+url|base-url|api\s+endpoint|endpoint|openai-compatible)\b/i;
const ISO_LOG_TIMESTAMP_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z\b/;
const LOG_SEVERITY_RE = /\b(trace|debug|info|warn(?:ing)?|error|fatal)\b/i;
const STACK_TRACE_MARKER_RE = /\b(stack trace|traceback|exception stack)\b/i;
const STACK_FRAME_RE = /\bat\s+[A-Za-z_$][\w.$<>]*(?:\s+\[[^\]]+\])?\s*\([^)\n]*\)/g;
const GERMAN_IBAN_RE = /\bDE\d{2}(?:[ ]?\d{4}){4}[ ]?\d{2}\b/i;
const GERMAN_TAX_ID_CANDIDATE_RE = /\b\d(?:[ -]?\d){10}\b/;
const GERMAN_PHONE_RE = /(?:\+49|0049)(?:[ -]?\d){7,13}\b|\b0\d{1,4}(?:[ -]?\d){5,12}\b/;

function matchesAny(value: string, patterns: readonly RegExp[]): boolean {
  let matched = false;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    if (!matched) matched = pattern.test(value);
    pattern.lastIndex = 0;
  }
  return matched;
}

function looksLikeProviderBaseUrl(value: string): boolean {
  for (const match of value.matchAll(URL_CANDIDATE_RE)) {
    const raw = match[0];
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    const normalizedPath = parsed.pathname.replace(/\/+$/u, "");
    const openAiPath =
      normalizedPath === "/v1" ||
      normalizedPath === "/openai/v1" ||
      normalizedPath.endsWith("/openai/v1");
    const index = match.index;
    const snippet = value.slice(
      Math.max(0, index - 48),
      Math.min(value.length, index + raw.length + 24),
    );
    if (PROVIDER_CONTEXT_RE.test(snippet) || openAiPath) return true;
  }
  return false;
}

function looksLikeRawLog(value: string): boolean {
  const stackFrameCount = value.match(STACK_FRAME_RE)?.length ?? 0;
  const timestampedSeverity = LOG_SEVERITY_RE.test(value) && ISO_LOG_TIMESTAMP_RE.test(value);
  const explicitStack = STACK_TRACE_MARKER_RE.test(value) && stackFrameCount >= 1;
  return timestampedSeverity || explicitStack || stackFrameCount >= 2;
}

function hasAtLeastTwoDifferentDigits(value: string): boolean {
  return new Set(value.replace(/\D/gu, "")).size >= 2;
}

function looksLikeGermanTaxId(value: string): boolean {
  const match = GERMAN_TAX_ID_CANDIDATE_RE.exec(value);
  if (match === null) return false;
  const digits = match[0].replace(/\D/gu, "");
  if (digits.length !== 11 || !hasAtLeastTwoDifferentDigits(digits)) return false;
  const snippet = value.slice(Math.max(0, match.index - 32), match.index + match[0].length + 32);
  return /\b(steuer(?:-|\s*)id|steueridentifikationsnummer|steuer\s*identifikationsnummer|tax\s*id)\b/iu.test(
    snippet,
  );
}

export function looksLikeEuDePii(value: string): boolean {
  return GERMAN_IBAN_RE.test(value) || looksLikeGermanTaxId(value) || GERMAN_PHONE_RE.test(value);
}

function scanWithCredentialPolicy(
  value: string,
  customerIdentifierMatchers: readonly RegExp[],
  containsCredential: (input: string) => boolean,
): SensitiveTextSignal | null {
  if (containsCredential(value) || matchesAny(value, CREDENTIAL_SHAPE_PATTERNS)) {
    return "credential-shape";
  }
  if (matchesAny(value, CREDENTIAL_PATH_PATTERNS)) return "private-credential-path";
  if (looksLikeProviderBaseUrl(value)) return "provider-base-url";
  if (looksLikeRawLog(value)) return "raw-log-content";
  if (matchesAny(value, customerIdentifierMatchers)) return "customer-identifier";
  return null;
}

export function scanSensitiveText(
  value: string,
  // Caller matchers are supported for governed memory-capture policy. Feedback egress never passes
  // caller-controlled regexes: its policy is the closed built-in classifier above.
  customerIdentifierMatchers: readonly RegExp[] = [],
): SensitiveTextSignal | null {
  return scanWithCredentialPolicy(value, customerIdentifierMatchers, containsCredentialDetection);
}

export function scanFeedbackSensitiveText(value: string): SensitiveTextSignal | null {
  return scanWithCredentialPolicy(value, [], containsFeedbackCredentialDetection);
}
