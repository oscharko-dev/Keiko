// Security headers (ADR-0011 D5) applied to every BFF response. The CSP is precomputed once from
// the static export's inline-script hashes (see csp.ts) and reused for all responses.

import type { ServerResponse } from "node:http";

// Headers set on every response regardless of route.
const BASE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
};

// Applies the CSP and the base security headers, plus `Cache-Control: no-store` for API responses
// (the contract requires it on every `/api/*` response; D5).
export function applySecurityHeaders(res: ServerResponse, csp: string, isApiPath: boolean): void {
  res.setHeader("Content-Security-Policy", csp);
  for (const [name, value] of Object.entries(BASE_SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
  if (isApiPath) {
    res.setHeader("Cache-Control", "no-store");
  }
}
