// Issue #495 — security-header tests, focused on the Permissions-Policy microphone directive that is
// scoped to voice-capable deployments. Every other directive is fixed and asserted here as a guard
// against accidental relaxation.

import { describe, expect, it } from "vitest";
import { applySecurityHeaders } from "./headers.js";
import { mockResponse } from "./_support.js";

// The shared mockResponse() captures setHeader into a lower-cased Map — the same shape this suite's
// hand-rolled fakeResponse() produced before GEN-DX-002.
function fakeResponse(): ReturnType<typeof mockResponse> {
  return mockResponse();
}

const CSP = "default-src 'none'; script-src 'self'";

describe("applySecurityHeaders", () => {
  it("sets the CSP and the fixed hardening headers", () => {
    const { res, headers } = fakeResponse();
    applySecurityHeaders(res, CSP, false);
    expect(headers.get("content-security-policy")).toBe(CSP);
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("x-frame-options")).toBe("DENY");
    expect(headers.get("referrer-policy")).toBe("no-referrer");
    expect(headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });

  it("keeps microphone=() by default (no-voice deployments stay strict)", () => {
    const { res, headers } = fakeResponse();
    applySecurityHeaders(res, CSP, false);
    expect(headers.get("permissions-policy")).toBe(
      "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    );
  });

  it("keeps microphone=() when allowMicrophone is explicitly false", () => {
    const { res, headers } = fakeResponse();
    applySecurityHeaders(res, CSP, false, { allowMicrophone: false });
    expect(headers.get("permissions-policy")).toContain("microphone=()");
  });

  it("scopes microphone to (self) only when allowMicrophone is true (Issue #495 / ADR-0100 D6)", () => {
    const { res, headers } = fakeResponse();
    applySecurityHeaders(res, CSP, false, { allowMicrophone: true });
    expect(headers.get("permissions-policy")).toBe(
      "camera=(), geolocation=(), microphone=(self), payment=(), usb=()",
    );
    // The relaxation is scoped to (self) and never widened to a wildcard.
    expect(headers.get("permissions-policy")).not.toContain("microphone=*");
  });

  it("adds Cache-Control: no-store only on API paths", () => {
    const api = fakeResponse();
    applySecurityHeaders(api.res, CSP, true);
    expect(api.headers.get("cache-control")).toBe("no-store");

    const asset = fakeResponse();
    applySecurityHeaders(asset.res, CSP, false);
    expect(asset.headers.get("cache-control")).toBeUndefined();
  });
});
