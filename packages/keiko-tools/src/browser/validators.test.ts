// ADR-0017 D2 — URL validation is the first line of defence. Tests cover scheme allowlist,
// loopback-literal enforcement, port-range gate, and the localhost→127.0.0.1 normalization that
// removes the /etc/hosts attack surface before any WebSocket is opened.

import { describe, expect, it } from "vitest";
import { BrowserToolError } from "./errors.js";
import { normalizeCdpPort, normalizeNavigateUrl } from "./validators.js";

describe("normalizeCdpPort", () => {
  it("accepts integers in the [1024, 65535] range", () => {
    expect(normalizeCdpPort(9222)).toBe(9222);
    expect(normalizeCdpPort(1024)).toBe(1024);
    expect(normalizeCdpPort(65535)).toBe(65535);
  });

  it.each([0, 1, 1023, 65536, 70000, -1, 3.14, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects out-of-range or non-integer port %s",
    (value) => {
      expect(() => normalizeCdpPort(value)).toThrow(BrowserToolError);
    },
  );

  it("rejects non-numeric input via the typed error", () => {
    try {
      normalizeCdpPort("9222");
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserToolError);
      expect((error as BrowserToolError).code).toBe("BAD_PORT");
    }
  });
});

describe("normalizeNavigateUrl", () => {
  it("accepts an http loopback URL on a registered port and returns origin + url", () => {
    const result = normalizeNavigateUrl("http://127.0.0.1:5173/some/path?q=1");
    expect(result.url).toBe("http://127.0.0.1:5173/some/path?q=1");
    expect(result.originOnly).toBe("http://127.0.0.1:5173");
    expect(result.host).toBe("127.0.0.1");
  });

  it("normalizes localhost to 127.0.0.1 BEFORE constructing the URL", () => {
    const result = normalizeNavigateUrl("http://localhost:5173/");
    expect(result.host).toBe("127.0.0.1");
    expect(result.url).toBe("http://127.0.0.1:5173/");
    expect(result.originOnly).toBe("http://127.0.0.1:5173");
  });

  it("accepts IPv6 loopback in bracketed authority", () => {
    const result = normalizeNavigateUrl("http://[::1]:5173/");
    expect(result.host).toBe("::1");
    expect(result.originOnly).toBe("http://[::1]:5173");
  });

  it("accepts https loopback", () => {
    const result = normalizeNavigateUrl("https://127.0.0.1:8443/app");
    expect(result.originOnly).toBe("https://127.0.0.1:8443");
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<h1>x</h1>",
    "vbscript:foo",
    "file:///etc/passwd",
  ])("rejects %s before any CDP call", (raw) => {
    try {
      normalizeNavigateUrl(raw);
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserToolError);
      expect((error as BrowserToolError).code).toBe("SCHEME_NOT_ALLOWED");
    }
  });

  it.each([
    "http://example.com:8080/",
    "http://10.0.0.1:8080/",
    "http://192.168.1.1:8080/",
    "http://0.0.0.0:8080/",
  ])("rejects non-loopback host %s", (raw) => {
    try {
      normalizeNavigateUrl(raw);
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserToolError);
      expect((error as BrowserToolError).code).toBe("ORIGIN_NOT_ALLOWED");
    }
  });

  it("rejects malformed input", () => {
    try {
      normalizeNavigateUrl("not a url");
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserToolError);
      expect((error as BrowserToolError).code).toBe("BAD_URL");
    }
  });

  it("rejects loopback URL with no explicit port", () => {
    try {
      normalizeNavigateUrl("http://127.0.0.1/");
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserToolError);
      expect((error as BrowserToolError).code).toBe("BAD_PORT");
    }
  });

  it("rejects loopback URL with port outside [1024, 65535]", () => {
    try {
      normalizeNavigateUrl("http://127.0.0.1:80/");
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserToolError);
      expect((error as BrowserToolError).code).toBe("BAD_PORT");
    }
  });

  it("originOnly never includes path, query, or fragment", () => {
    const result = normalizeNavigateUrl("http://127.0.0.1:5173/x/y/z?a=1#frag");
    expect(result.originOnly).toBe("http://127.0.0.1:5173");
    expect(result.originOnly).not.toContain("/x");
    expect(result.originOnly).not.toContain("?a");
    expect(result.originOnly).not.toContain("#");
  });
});
