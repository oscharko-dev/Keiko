import { describe, expect, it } from "vitest";
import { classifyDocumentationTarget } from "./documentation-target.js";

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

  it("classifies IPv4-mapped IPv6 loopback and private addresses like their embedded IPv4 form", () => {
    const cases: readonly (readonly [string, DocumentationTargetClass])[] = [
      ["http://[::ffff:127.0.0.1]/docs/index.html", "loopback"],
      ["http://[0:0:0:0:0:ffff:127.0.0.1]/", "loopback"],
      ["http://[::ffff:10.1.2.3]/manual", "intranet-http"],
    ];
    for (const [raw, expectedClass] of cases) {
      const result = classifyDocumentationTarget(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.targetClass).toBe(expectedClass);
    }
  });

  it("classifies private ranges and single-label hosts as intranet", () => {
    for (const raw of [
      "http://10.1.2.3/manual",
      "https://172.16.5.9/handbook",
      "https://192.168.1.20/docs",
      "https://[fd00::1]/manual",
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

  it.each(["fda.gov", "fdroid.org", "fcc.gov"])(
    "does not apply IPv6 private-prefix rules to public named host %s",
    (host) => {
      const result = classifyDocumentationTarget(`https://${host}/manual`);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.targetClass).toBe("external-http");
    },
  );

  it("classifies punycode/IDN homograph hosts as external, not intranet (AUDIT-E1852-004)", () => {
    for (const raw of [
      // Punycode-encoded host, already in the WHATWG-normalized ASCII form.
      "https://xn--e1aybc.example/manual/index.html",
      // Unicode homograph input; the WHATWG URL parser normalizes it to punycode (ToASCII)
      // before classifyHttpHost ever sees it.
      "https://аррӏе.com/manual/index.html",
    ]) {
      const result = classifyDocumentationTarget(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.targetClass).toBe("external-http");
    }
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
