// Security headers (ADR-0011 D5) applied to every BFF response. The CSP is precomputed once from
// the static export's inline-script hashes (see csp.ts) and reused for all responses.

import type { ServerResponse } from "node:http";

// Headers set on every response regardless of route. The Permissions-Policy microphone directive is
// computed separately (see applySecurityHeaders) because Issue #495 scopes it to voice-capable
// deployments; every other directive is fixed.
const BASE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

export interface SecurityHeaderOptions {
  // Issue #495 — when true the Permissions-Policy microphone directive is scoped to the app's own
  // origin (`microphone=(self)`) so the capability-gated composer can call getUserMedia after an
  // explicit user gesture. When false (the default, and every no-voice deployment) the strict
  // `microphone=()` is kept. The directive is never widened beyond `(self)`.
  readonly allowMicrophone?: boolean | undefined;
}

function permissionsPolicy(allowMicrophone: boolean): string {
  const microphone = allowMicrophone ? "microphone=(self)" : "microphone=()";
  return `camera=(), geolocation=(), ${microphone}, payment=(), usb=()`;
}

// Applies the CSP and the base security headers, plus `Cache-Control: no-store` for API responses
// (the contract requires it on every `/api/*` response; D5). The microphone directive is relaxed only
// when `options.allowMicrophone` is true (ADR-0100 D6 / docs/voice/privacy-contract.md).
export function applySecurityHeaders(
  res: ServerResponse,
  csp: string,
  isApiPath: boolean,
  options: SecurityHeaderOptions = {},
): void {
  res.setHeader("Content-Security-Policy", csp);
  for (const [name, value] of Object.entries(BASE_SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
  res.setHeader("Permissions-Policy", permissionsPolicy(options.allowMicrophone === true));
  if (isApiPath) {
    res.setHeader("Cache-Control", "no-store");
  }
}
