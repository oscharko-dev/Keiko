// The secret-shape detectors live in this import-free module so the first-load desktop shell, which
// only needs looksLikeSecretShape, does not pull the whole memory validation module into the initial
// bundle. memory-validation.ts re-exports both detectors, so every existing importer is unchanged.

// ─── Unsafe-content heuristics (secret-shape only, no allow/block list) ──────
// Audit-record defence-in-depth: rejects credential-shaped strings on the AUDIT SUMMARY
// path (validateMemoryAuditRecord). The PRIMARY secret-prevention gate is the capture
// layer (#207), which scans candidate memory body/payload before construction. This
// helper is intentionally NOT applied to record.body or proposal.body — body scanning is
// owned end-to-end by the capture layer so callers cannot route around the policy by
// constructing records directly. Shape-based: we test the SHAPE of the string, not a
// list of providers, so the heuristic stays useful across vendor changes.
//
// Pattern coverage — intentionally narrow (high precision over high recall):
//   COVERED:  sk- (OpenAI-style), AKIA (AWS), gh[pousr]_ (GitHub tokens),
//             xox[abporsu]- (Slack), three-part JWTs, PEM private keys,
//             long contiguous digit runs that resemble a payment-card PAN.
//   EXCLUDED: opaque "Bearer <token>" (catches only JWT-encoded bearers),
//             URL-embedded credentials (https://user:pass@host),
//             generic password=, secret=, key= form-encoded values.
//             These classes are intentionally deferred to the capture layer
//             (#207), where context-aware redaction can avoid false positives
//             on legitimate non-secret strings.
const SECRET_SHAPE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bxox[abporsu]-[A-Za-z0-9-]{10,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const PAN_SHAPE_RE = /\b(?:\d[ -]?){13,19}\b/g;

function passesLuhn(value: string): boolean {
  let sum = 0;
  let shouldDouble = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

// Exported so the capture layer's write-time scanner composes THIS detector instead of carrying a
// second, naive digit-run regex: two independent "parity" implementations drifted apart once
// already (GEN-DUP-DUPLICATION-004), and the primary boundary ended up weaker than the audit-time
// check it claimed to match.
export function hasPaymentCardPanShape(value: string): boolean {
  for (const match of value.matchAll(PAN_SHAPE_RE)) {
    const candidate = match[0].replaceAll(/[ -]/g, "");
    if (candidate.length >= 13 && candidate.length <= 19 && passesLuhn(candidate)) {
      return true;
    }
  }
  return false;
}

export function looksLikeSecretShape(value: string): boolean {
  for (const re of SECRET_SHAPE_PATTERNS) {
    if (re.test(value)) {
      return true;
    }
  }
  return hasPaymentCardPanShape(value);
}
