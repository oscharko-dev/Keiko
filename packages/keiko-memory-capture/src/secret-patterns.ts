// Secret + private-data rejection scanner for keiko-memory-capture (Epic #204 child #207).
//
// This module is the WIDE secret-rejection net: it extends the narrow audit-summary heuristic
// `looksLikeSecretShape` (keiko-contracts/memory-validation.ts) with patterns the capture layer
// owns — opaque Bearer tokens, URL-embedded credentials, form-encoded password/secret/api_key/
// token assignments, and well-known credential-store file paths. The wider net is appropriate
// HERE (write-side gate, false positives reject a memory which the user can rephrase) but NOT
// at audit-time (where a false positive would unnecessarily mask an audit summary).
//
// ReDoS safety: every pattern is a single linear character class with one bounded or open
// quantifier — no nesting, no `(a+)+` style. Matches CodeQL js/polynomial-redos conventions
// followed in keiko-security/redaction.ts.
//
// The return value is the typed RejectionReason class. The matched substring is intentionally
// NOT returned: the rejection path itself must not leak the candidate's content (capture is the
// PRIMARY secret-prevention boundary; even the rejection notice is a redaction-sensitive
// surface). Callers render a generic "this looked like a credential" message keyed off the
// reason class.

import type { RejectionReason } from "./errors.js";

// ─── Credential-shape patterns (extends looksLikeSecretShape) ────────────────
const CREDENTIAL_SHAPE_PATTERNS: readonly RegExp[] = [
  // Parity with looksLikeSecretShape: sk-, AKIA, gh[pousr]_, xox[abporsu]-, JWT, PEM, digit runs.
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bxox[abporsu]-[A-Za-z0-9-]{10,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b\d{13,19}\b/,
  // Capture-layer extensions:
  // Opaque Bearer tokens (any non-whitespace token after "Bearer "). looksLikeSecretShape
  // intentionally skips this because audit summaries may legitimately mention the word "Bearer"
  // with a placeholder; capture is stricter because a real Bearer in a memory body is almost
  // never legitimate.
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/i,
  // URL-embedded basic-auth credentials.
  /\bhttps?:\/\/[^\s/:@]+:[^\s/:@]+@/i,
  // Form-encoded credential assignments. Each is a single non-nested capture; the value run
  // stops at whitespace or common delimiters so the quantifier can't backtrack.
  /\bpassword\s*[=:]\s*[^\s,;"'`&]+/i,
  /\bsecret\s*[=:]\s*[^\s,;"'`&]+/i,
  /\bapi[_-]?key\s*[=:]\s*[^\s,;"'`&]+/i,
  /\btoken\s*[=:]\s*[^\s,;"'`&]+/i,
];

// ─── Credential-store file paths ─────────────────────────────────────────────
// Conservative, case-insensitive, anchored on the credential-store basename (after the last
// slash). A bare mention of a path like `~/.ssh/id_rsa` or `.env.production` is a strong signal
// the user is pasting an artefact they shouldn't be memorising.
const CREDENTIAL_PATH_PATTERNS: readonly RegExp[] = [
  // SSH private keys: id_rsa, id_ed25519, id_ecdsa, id_dsa, id_<custom>. Match any path segment.
  /\.ssh\/id_[A-Za-z0-9_-]+/i,
  // AWS credentials file.
  /\.aws\/credentials\b/i,
  // npm rc (auth tokens), gcloud credentials, k8s configs, common dotfile credential stores.
  /(^|[\s/])\.npmrc\b/i,
  // .env and .env.<environment>.
  /(^|[\s/])\.env(\.[A-Za-z0-9_-]+)?\b/i,
];

const URL_CANDIDATE_RE = /\bhttps?:\/\/[^\s"'`<>]+/gi;
const PROVIDER_CONTEXT_RE =
  /\b(provider|gateway|base\s+url|base-url|api\s+endpoint|endpoint|openai-compatible)\b/i;
const ISO_LOG_TIMESTAMP_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z\b/;
const LOG_SEVERITY_RE = /\b(trace|debug|info|warn(?:ing)?|error|fatal)\b/i;
const STACK_TRACE_MARKER_RE = /\b(stack trace|traceback|exception stack)\b/i;
const STACK_FRAME_RE = /\bat\s+[A-Za-z_$][\w.$<>]*(?:\s+\[[^\]]+\])?\([^)\n]*\)/g;

function matchesAny(value: string, patterns: readonly RegExp[]): boolean {
  for (const pattern of patterns) {
    if (pattern.test(value)) {
      return true;
    }
  }
  return false;
}

function looksLikeProviderBaseUrl(value: string): boolean {
  for (const match of value.matchAll(URL_CANDIDATE_RE)) {
    const raw = match[0];
    const index = match.index;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      continue;
    }
    const normalizedPath = parsed.pathname.replace(/\/+$/u, "");
    const hasOpenAiBasePath =
      normalizedPath === "/v1" ||
      normalizedPath === "/openai/v1" ||
      normalizedPath.endsWith("/openai/v1");
    const snippet = value.slice(
      Math.max(0, index - 48),
      Math.min(value.length, index + raw.length + 24),
    );
    if (PROVIDER_CONTEXT_RE.test(snippet) || hasOpenAiBasePath) {
      return true;
    }
  }
  return false;
}

function looksLikeRawLog(value: string): boolean {
  const stackFrameCount = value.match(STACK_FRAME_RE)?.length ?? 0;
  const hasSeverityWithTimestamp = LOG_SEVERITY_RE.test(value) && ISO_LOG_TIMESTAMP_RE.test(value);
  const hasExplicitStackTrace = STACK_TRACE_MARKER_RE.test(value) && stackFrameCount >= 1;
  return hasSeverityWithTimestamp || hasExplicitStackTrace || stackFrameCount >= 2;
}

// Returns the typed rejection class if `value` looks like a secret, credential-store path, or
// customer-identifier match — otherwise `null`. The scan is total: it runs every pattern class
// in a fixed precedence (credential-shape > credential-path > customer-identifier) so two
// patterns firing on the same string produce a deterministic reason class.
export function scanForSecrets(
  value: string,
  customerIdentifierMatchers: readonly RegExp[] = [],
): RejectionReason | null {
  if (matchesAny(value, CREDENTIAL_SHAPE_PATTERNS)) {
    return "credential-shape";
  }
  if (matchesAny(value, CREDENTIAL_PATH_PATTERNS)) {
    return "private-credential-path";
  }
  if (looksLikeProviderBaseUrl(value)) {
    return "provider-base-url";
  }
  if (looksLikeRawLog(value)) {
    return "raw-log-content";
  }
  if (matchesAny(value, customerIdentifierMatchers)) {
    return "customer-identifier";
  }
  return null;
}
