import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildCspHeader, extractInlineScriptHashes } from "./csp.js";

function sha256Token(body: string): string {
  return `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`;
}

describe("extractInlineScriptHashes", () => {
  it("hashes an inline script body and emits a sha256 token", () => {
    const body = "self.__next_f.push([0])";
    const html = `<html><body><script>${body}</script></body></html>`;
    expect(extractInlineScriptHashes([html])).toEqual([sha256Token(body)]);
  });

  it("hashes uppercase <SCRIPT>...</SCRIPT> blocks (case-insensitive matching)", () => {
    const body = "self.__next_f.push([1])";
    const html = `<html><body><SCRIPT>${body}</SCRIPT></body></html>`;
    expect(extractInlineScriptHashes([html])).toEqual([sha256Token(body)]);
  });

  it("ignores external scripts that carry a src attribute", () => {
    const html = `<script src="/_next/static/chunk.js"></script>`;
    expect(extractInlineScriptHashes([html])).toEqual([]);
  });

  it("ignores empty inline scripts", () => {
    expect(extractInlineScriptHashes(["<script></script>"])).toEqual([]);
  });

  it("deduplicates identical inline scripts across documents", () => {
    const body = "boot()";
    const doc = `<script>${body}</script>`;
    expect(extractInlineScriptHashes([doc, doc])).toEqual([sha256Token(body)]);
  });

  it("returns hashes in stable sorted order", () => {
    const a = `<script>a()</script>`;
    const b = `<script>bbbb()</script>`;
    const forward = extractInlineScriptHashes([a, b]);
    const reverse = extractInlineScriptHashes([b, a]);
    expect(forward).toEqual(reverse);
    expect([...forward]).toEqual([...forward].sort());
  });

  it("returns no hashes for an empty document set", () => {
    expect(extractInlineScriptHashes([])).toEqual([]);
  });

  it("handles a whitespace/malformed closing tag (</script\\n bar>) via indexOf scan", () => {
    const body = "boot()";
    // indexOf finds `</script` regardless of what follows before the `>`
    const html = `<script>${body}</script\n bar>`;
    expect(extractInlineScriptHashes([html])).toEqual([sha256Token(body)]);
  });
});

describe("buildCspHeader", () => {
  it("keeps script-src as 'self' with no inline when there are no hashes", () => {
    const header = buildCspHeader([]);
    expect(header).toContain("script-src 'self'");
    expect(header).not.toContain("'unsafe-inline'; script");
  });

  it("never permits unsafe-inline or unsafe-eval in script-src", () => {
    const header = buildCspHeader(["'sha256-abc'"]);
    const scriptDirective = header.split("; ").find((d) => d.startsWith("script-src "));
    expect(scriptDirective).toBeDefined();
    expect(scriptDirective).not.toContain("'unsafe-inline'");
    expect(scriptDirective).not.toContain("'unsafe-eval'");
  });

  it("folds the provided hashes into script-src after 'self'", () => {
    const header = buildCspHeader(["'sha256-abc'", "'sha256-def'"]);
    expect(header).toContain("script-src 'self' 'sha256-abc' 'sha256-def'");
  });

  it("permits unsafe-inline only for style-src and locks the framing directives", () => {
    const header = buildCspHeader([]);
    expect(header).toContain("style-src 'self' 'unsafe-inline'");
    expect(header).toContain("default-src 'none'");
    expect(header).toContain("frame-ancestors 'none'");
    expect(header).toContain("base-uri 'none'");
    expect(header).toContain("form-action 'none'");
  });
});
