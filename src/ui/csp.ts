// Hash-based Content-Security-Policy support (ADR-0011 D5, risk #1). The Next static export emits
// inline RSC-bootstrap `<script>` blocks (`self.__next_f.push(...)`). The BFF serves
// `script-src 'self'` with NO `'unsafe-inline'`, so each distinct inline script must be allowed by
// its SHA-256 hash. `extractInlineScriptHashes` computes those hashes from exported HTML at build
// time; `buildCspHeader` folds them into the policy the BFF sets on every response.

import { createHash } from "node:crypto";

// `/\bsrc\s*=/i` matches an attribute key only — no `<`/`>` involved, so it does not trigger
// CodeQL js/bad-tag-filter (which fires on regexes that structurally match HTML tags).
const SRC_ATTRIBUTE_PATTERN = /\bsrc\s*=/i;

function sha256Base64(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("base64");
}

// Finds the next inline-script body starting at cursor `i`, using a case-insensitive indexOf scan
// rather than a tag-matching regex (eliminates the CodeQL js/bad-tag-filter class entirely). Body
// is sliced from original-case `html` so the SHA-256 matches what the browser executes.
function nextInlineScript(
  html: string,
  lower: string,
  i: number,
): { openTag: string; body: string; next: number } | null {
  const open = lower.indexOf("<script", i);
  if (open === -1) return null;
  const openEnd = lower.indexOf(">", open);
  if (openEnd === -1) return null;
  const close = lower.indexOf("</script", openEnd + 1);
  if (close === -1) return null;
  const closeEnd = lower.indexOf(">", close);
  const next = closeEnd === -1 ? close + 8 : closeEnd + 1;
  return { openTag: html.slice(open, openEnd + 1), body: html.slice(openEnd + 1, close), next };
}

// Returns the distinct `'sha256-...'` CSP source tokens for every inline script across the given
// HTML documents, in stable sorted order so the generated policy is deterministic.
export function extractInlineScriptHashes(htmlDocuments: readonly string[]): readonly string[] {
  const tokens = new Set<string>();
  for (const html of htmlDocuments) {
    const lower = html.toLowerCase();
    let i = 0;
    for (;;) {
      const found = nextInlineScript(html, lower, i);
      if (found === null) break;
      const { openTag, body, next } = found;
      if (!SRC_ATTRIBUTE_PATTERN.test(openTag) && body.length > 0) {
        tokens.add(`'sha256-${sha256Base64(body)}'`);
      }
      i = next;
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
