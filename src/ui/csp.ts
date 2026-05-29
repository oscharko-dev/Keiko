// Hash-based Content-Security-Policy support (ADR-0011 D5, risk #1). The Next static export emits
// inline RSC-bootstrap `<script>` blocks (`self.__next_f.push(...)`). The BFF serves
// `script-src 'self'` with NO `'unsafe-inline'`, so each distinct inline script must be allowed by
// its SHA-256 hash. `extractInlineScriptHashes` computes those hashes from exported HTML at build
// time; `buildCspHeader` folds them into the policy the BFF sets on every response.

import { createHash } from "node:crypto";

// Case-insensitive so no executable inline script is missed — an unmatched script would be
// CSP-blocked at runtime. The `i` flag covers `<SCRIPT>` and mixed-case variants. `\s*` before
// the closing `>` tolerates optional whitespace in `</script >` forms.
const INLINE_SCRIPT_PATTERN = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const SRC_ATTRIBUTE_PATTERN = /\bsrc\s*=/i;

// An inline script is a `<script>` element with a non-empty body and no `src` attribute.
function isInlineScript(attributes: string, body: string): boolean {
  return !SRC_ATTRIBUTE_PATTERN.test(attributes) && body.length > 0;
}

function sha256Base64(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("base64");
}

// Returns the distinct `'sha256-...'` CSP source tokens for every inline script across the given
// HTML documents, in stable sorted order so the generated policy is deterministic.
export function extractInlineScriptHashes(htmlDocuments: readonly string[]): readonly string[] {
  const tokens = new Set<string>();
  for (const html of htmlDocuments) {
    INLINE_SCRIPT_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = INLINE_SCRIPT_PATTERN.exec(html)) !== null) {
      const attributes = match[1] ?? "";
      const body = match[2] ?? "";
      if (isInlineScript(attributes, body)) {
        tokens.add(`'sha256-${sha256Base64(body)}'`);
      }
    }
  }
  return [...tokens].sort();
}

// Builds the full CSP header value. `scriptHashes` are folded into `script-src` alongside `'self'`.
// `style-src` keeps `'unsafe-inline'` for Tailwind's injected styles (the only permitted inline
// source); `script-src` never receives `'unsafe-inline'` or `'unsafe-eval'`.
export function buildCspHeader(scriptHashes: readonly string[]): string {
  const scriptSrc = ["'self'", ...scriptHashes].join(" ");
  return [
    "default-src 'none'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}
