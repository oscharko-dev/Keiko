// Tests for redactDiagnosticMessage — defense-in-depth around parser_diagnostics.message.
// Parsers should already produce short, path-free messages; this layer pins that with three
// structural guarantees: no raw home paths, no control characters, hard length cap.

import { describe, expect, it } from "vitest";

import { redactDiagnosticMessage } from "./diagnostic-redactor.js";

describe("redactDiagnosticMessage", () => {
  it("rewrites a home-prefixed path to the ~ form", () => {
    const out = redactDiagnosticMessage(
      "failed to parse /Users/victim/docs/secret.pdf at offset 42",
      "/Users/victim",
    );
    // Anything that survives the prefix rewrite must not contain the raw home path.
    expect(out).not.toContain("/Users/victim");
    // The rewritten form must still describe the failure so the user can act on it.
    expect(out).toContain("offset 42");
  });

  it("strips ASCII control characters", () => {
    const withControl = `parse error at line 3${String.fromCharCode(7)}${String.fromCharCode(27)}bytes`;
    const out = redactDiagnosticMessage(withControl, "/Users/victim");
    expect(out).not.toContain(String.fromCharCode(7));
    expect(out).not.toContain(String.fromCharCode(27));
  });

  it("caps the output at 1024 characters", () => {
    const long = "x".repeat(5000);
    const out = redactDiagnosticMessage(long, "/Users/victim");
    expect(out.length).toBeLessThanOrEqual(1024);
  });

  it("returns the empty string for non-string input", () => {
    // Defense-in-depth: parsers should never hand us non-strings, but if the contract
    // ever drifts we collapse to the empty string rather than serialising whatever came in.
    expect(redactDiagnosticMessage(undefined as unknown as string, "/Users/victim")).toBe("");
  });

  it("is idempotent — applying twice returns the same value", () => {
    const once = redactDiagnosticMessage(
      "parse error in /Users/victim/secret.pdf",
      "/Users/victim",
    );
    const twice = redactDiagnosticMessage(once, "/Users/victim");
    expect(twice).toBe(once);
  });

  it("passes through a path-free, short message unchanged", () => {
    expect(redactDiagnosticMessage("unsupported media type", "/Users/victim")).toBe(
      "unsupported media type",
    );
  });

  it("redacts non-home absolute POSIX paths embedded in prose", () => {
    expect(
      redactDiagnosticMessage(
        "failed to parse /srv/project/secret.pdf at offset 42",
        "/Users/victim",
      ),
    ).toBe("failed to parse <path>/secret.pdf at offset 42");
  });

  it("redacts Windows and UNC paths embedded in prose", () => {
    expect(
      redactDiagnosticMessage(
        "failed in C:\\Secrets\\plan.docx and \\\\server\\share\\raw.txt",
        "/Users/victim",
      ),
    ).toBe("failed in <drive>/plan.docx and <unc>/raw.txt");
  });

  it("redacts home paths when parser messages quote them", () => {
    const out = redactDiagnosticMessage(
      'failed open("/Users/victim/docs/secret.pdf")',
      "/Users/victim",
    );
    expect(out).toBe('failed open("~/docs/secret.pdf")');
    expect(out).not.toContain("/Users/victim");
  });

  it("redacts Windows home paths when parser messages quote them", () => {
    const out = redactDiagnosticMessage(
      'path="C:\\Users\\victim\\docs\\secret.pdf"',
      "C:\\Users\\victim",
    );
    expect(out).toBe('path="~/docs/secret.pdf"');
    expect(out).not.toContain("C:\\Users\\victim");
    expect(out).not.toContain("C:/Users/victim");
  });

  it("redacts comma-adjacent paths from compact parser diagnostics", () => {
    const out = redactDiagnosticMessage("failed,/Users/victim/docs/secret.pdf", "/Users/victim");
    expect(out).toBe("failed,~/docs/secret.pdf");
    expect(out).not.toContain("/Users/victim");
  });
});
