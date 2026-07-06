import { describe, expect, it } from "vitest";
import {
  buildDocumentationNavigationResult,
  classifyDocumentationTarget,
  DOCUMENTATION_BROWSER_SCHEMA_VERSION,
  DOCUMENTATION_NAVIGATION_REASON_SEVERITY,
  DOCUMENTATION_NAVIGATION_REASONS,
  DOCUMENTATION_TARGET_CLASSES,
  DOCUMENTATION_TARGET_MAX_LENGTH,
  mapBrowserErrorToDocumentationReason,
  parseDocumentationNavigationRequest,
  resolveDocumentationNavigationReason,
  type DocumentationNavigationReason,
} from "./documentation-browser.js";

describe("documentation-browser constants", () => {
  it("pins the schema version", () => {
    expect(DOCUMENTATION_BROWSER_SCHEMA_VERSION).toBe("1");
  });

  it("enumerates target classes in a fixed order", () => {
    expect(DOCUMENTATION_TARGET_CLASSES).toEqual([
      "local-file",
      "loopback",
      "intranet-http",
      "external-http",
      "unsupported-scheme",
    ]);
  });

  it("assigns a severity to every navigation reason", () => {
    for (const reason of DOCUMENTATION_NAVIGATION_REASONS) {
      expect(DOCUMENTATION_NAVIGATION_REASON_SEVERITY[reason]).toMatch(
        /^(ready|limitation|error)$/u,
      );
    }
  });

  it("marks only preview-available as ready", () => {
    const ready = DOCUMENTATION_NAVIGATION_REASONS.filter(
      (reason) => DOCUMENTATION_NAVIGATION_REASON_SEVERITY[reason] === "ready",
    );
    expect(ready).toEqual(["preview-available"]);
  });
});

describe("classifyDocumentationTarget — accepted", () => {
  it("classifies a file target without exposing the path", () => {
    const result = classifyDocumentationTarget("file:///home/user/private/manual.html");
    expect(result).toEqual({
      ok: true,
      targetClass: "local-file",
      originSummary: "local file",
      pathSummary: null,
    });
  });

  it("classifies loopback http targets", () => {
    for (const raw of [
      "http://127.0.0.1:8080/docs",
      "http://localhost:3000/",
      "http://[::1]:9000/",
    ]) {
      const result = classifyDocumentationTarget(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.targetClass).toBe("loopback");
    }
  });

  it("classifies private ranges and single-label hosts as intranet", () => {
    for (const raw of [
      "http://10.1.2.3/manual",
      "https://172.16.5.9/handbook",
      "https://192.168.1.20/docs",
      "http://intranet/handbook",
      "https://wiki.corp/page",
    ]) {
      const result = classifyDocumentationTarget(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.targetClass).toBe("intranet-http");
    }
  });

  it("classifies public hosts as external", () => {
    const result = classifyDocumentationTarget("https://example.com/manual");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.targetClass).toBe("external-http");
  });

  it("summarises the path shape without leaking the real path", () => {
    const root = classifyDocumentationTarget("https://example.com/");
    const deep = classifyDocumentationTarget("https://example.com/secret/report.html?token=abc");
    expect(root.ok && root.pathSummary).toBe("/");
    expect(deep.ok && deep.pathSummary).toBe("/…");
    // The secret path segment and the token query must never appear in the summary.
    if (deep.ok) {
      expect(deep.originSummary).toBe("https://example.com");
      expect(JSON.stringify(deep)).not.toContain("secret");
      expect(JSON.stringify(deep)).not.toContain("token");
    }
  });
});

describe("classifyDocumentationTarget — rejected (fail closed)", () => {
  it("rejects credentials embedded in the target", () => {
    const result = classifyDocumentationTarget("https://user:pass@example.com/manual");
    expect(result).toEqual({ ok: false, reason: "credentials-in-target" });
  });

  it("rejects unsupported schemes", () => {
    for (const raw of [
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
      "ftp://host/file",
      "mailto:a@b.c",
    ]) {
      expect(classifyDocumentationTarget(raw)).toEqual({ ok: false, reason: "unsupported-scheme" });
    }
  });

  it("rejects empty and unparseable input", () => {
    expect(classifyDocumentationTarget("")).toEqual({ ok: false, reason: "invalid-target" });
    expect(classifyDocumentationTarget("   ")).toEqual({ ok: false, reason: "invalid-target" });
    expect(classifyDocumentationTarget("not a url")).toEqual({
      ok: false,
      reason: "invalid-target",
    });
    expect(classifyDocumentationTarget(42)).toEqual({ ok: false, reason: "invalid-target" });
  });
});

describe("mapBrowserErrorToDocumentationReason", () => {
  const cases: readonly [string, DocumentationNavigationReason][] = [
    ["BROWSER_UNAVAILABLE", "browser-backend-unavailable"],
    ["CHROME_UNREACHABLE", "browser-backend-unavailable"],
    ["ORIGIN_NOT_ALLOWED", "unsupported-external-target"],
    ["SCHEME_NOT_ALLOWED", "unsupported-scheme"],
    ["NAV_TIMEOUT", "request-timed-out"],
    ["PAYLOAD_TOO_LARGE", "content-too-large"],
    ["ENOTFOUND", "host-unreachable"],
    ["ECONNREFUSED", "proxy-or-firewall-blocked"],
    ["ETIMEDOUT", "request-timed-out"],
  ];

  it.each(cases)("maps %s to %s", (code, reason) => {
    expect(mapBrowserErrorToDocumentationReason(code)).toBe(reason);
  });

  it("maps auth-shaped HTTP statuses", () => {
    expect(mapBrowserErrorToDocumentationReason(401)).toBe("authentication-required");
    expect(mapBrowserErrorToDocumentationReason(403)).toBe("authentication-required");
    expect(mapBrowserErrorToDocumentationReason(413)).toBe("content-too-large");
  });

  it("fails closed on unknown or missing codes", () => {
    expect(mapBrowserErrorToDocumentationReason("SOMETHING_NEW")).toBe("navigation-failed");
    expect(mapBrowserErrorToDocumentationReason(500)).toBe("navigation-failed");
    expect(mapBrowserErrorToDocumentationReason(null)).toBe("navigation-failed");
    expect(mapBrowserErrorToDocumentationReason(undefined)).toBe("navigation-failed");
    expect(mapBrowserErrorToDocumentationReason("")).toBe("navigation-failed");
  });
});

describe("resolveDocumentationNavigationReason", () => {
  it("offers preview only for loopback with a backend", () => {
    expect(resolveDocumentationNavigationReason("loopback", true)).toBe("preview-available");
    expect(resolveDocumentationNavigationReason("loopback", false)).toBe(
      "browser-backend-unavailable",
    );
  });

  it("defers rendering for local and intranet targets regardless of backend", () => {
    expect(resolveDocumentationNavigationReason("local-file", true)).toBe("rendering-deferred");
    expect(resolveDocumentationNavigationReason("intranet-http", false)).toBe("rendering-deferred");
  });

  it("declines external and unsupported targets", () => {
    expect(resolveDocumentationNavigationReason("external-http", true)).toBe(
      "unsupported-external-target",
    );
    expect(resolveDocumentationNavigationReason("unsupported-scheme", true)).toBe(
      "unsupported-scheme",
    );
  });
});

describe("parseDocumentationNavigationRequest", () => {
  it("accepts a minimal request and pins the schema version", () => {
    const parsed = parseDocumentationNavigationRequest({ target: "https://intranet/manual" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.schemaVersion).toBe("1");
    expect(parsed.value.cdpPort).toBeUndefined();
  });

  it("accepts an optional loopback preview port", () => {
    const parsed = parseDocumentationNavigationRequest({
      target: "http://127.0.0.1:8080/",
      cdpPort: 9222,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.cdpPort).toBe(9222);
  });

  it("reports one error per failed invariant", () => {
    const parsed = parseDocumentationNavigationRequest({ target: "", cdpPort: 10 });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toEqual(
      expect.arrayContaining([
        "target must be a non-empty string",
        "cdpPort must be an integer in the range 1024-65535",
      ]),
    );
  });

  it("rejects an over-long target", () => {
    const parsed = parseDocumentationNavigationRequest({
      target: `https://x/${"a".repeat(DOCUMENTATION_TARGET_MAX_LENGTH)}`,
    });
    expect(parsed.ok).toBe(false);
  });

  it("rejects a non-object body", () => {
    expect(parseDocumentationNavigationRequest(null).ok).toBe(false);
    expect(parseDocumentationNavigationRequest("https://x").ok).toBe(false);
    expect(parseDocumentationNavigationRequest([]).ok).toBe(false);
  });
});

describe("buildDocumentationNavigationResult", () => {
  it("derives preview capability and severity from the reason", () => {
    const result = buildDocumentationNavigationResult({
      targetClass: "loopback",
      originSummary: "http://127.0.0.1:8080",
      pathSummary: "/…",
      reason: "preview-available",
      backendAvailable: true,
    });
    expect(result.capability).toEqual({
      previewAvailable: true,
      backendAvailable: true,
      indexingProposalAvailable: false,
    });
    expect(result.severity).toBe("ready");
  });

  it("never reports a preview for a limitation reason", () => {
    const result = buildDocumentationNavigationResult({
      targetClass: "intranet-http",
      originSummary: "https://intranet",
      pathSummary: "/…",
      reason: "rendering-deferred",
      backendAvailable: true,
    });
    expect(result.capability.previewAvailable).toBe(false);
    expect(result.capability.indexingProposalAvailable).toBe(false);
  });

  it("redacts a path-shaped origin summary and strips format-spoofing code points", () => {
    const result = buildDocumentationNavigationResult({
      targetClass: "local-file",
      originSummary: "leak /etc/secret/passwd‮control",
      pathSummary: null,
      reason: "rendering-deferred",
      backendAvailable: false,
    });
    expect(result.originSummary).toContain("[REDACTED_PATH]");
    expect(result.originSummary).not.toContain("passwd");
    expect(result.originSummary).not.toContain("‮");
  });
});
