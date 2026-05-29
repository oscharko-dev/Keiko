import { resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveContainedPath } from "../../src/ui/static.js";

const ROOT = resolve("/var/app/dist/ui/static");

describe("resolveContainedPath", () => {
  it("resolves a normal nested asset within the root", () => {
    const result = resolveContainedPath(ROOT, "/_next/static/chunk.js");
    expect(result).toBe(resolve(ROOT, "_next/static/chunk.js"));
  });

  it("resolves the index document", () => {
    expect(resolveContainedPath(ROOT, "/index.html")).toBe(resolve(ROOT, "index.html"));
  });

  it("clamps a parent-directory traversal inside the root (never escapes)", () => {
    const result = resolveContainedPath(ROOT, "/../../etc/passwd");
    expect(result).toBeDefined();
    expect(result?.startsWith(ROOT + sep)).toBe(true);
    expect(result).not.toBe(resolve("/etc/passwd"));
  });

  it("clamps an encoded traversal (%2e%2e) inside the root", () => {
    const result = resolveContainedPath(ROOT, "/%2e%2e/%2e%2e/etc/passwd");
    expect(result).toBeDefined();
    expect(result?.startsWith(ROOT + sep)).toBe(true);
  });

  it("rejects an embedded NUL byte", () => {
    expect(resolveContainedPath(ROOT, "/index.html%00.png")).toBeUndefined();
  });

  it("rejects a malformed percent-encoding", () => {
    expect(resolveContainedPath(ROOT, "/%zz")).toBeUndefined();
  });

  it("clamps a sibling-directory traversal inside the root", () => {
    // A `../static-evil` attempt is neutralized: the leading `..` collapses against root, so the
    // result stays inside the contained root rather than reaching the sibling directory.
    const result = resolveContainedPath(ROOT, "/../static-evil/secret");
    expect(result).toBeDefined();
    expect(result?.startsWith(ROOT + sep)).toBe(true);
  });

  it("keeps the root itself contained", () => {
    const result = resolveContainedPath(ROOT, "/");
    expect(result).toBe(ROOT);
  });

  it("contained results never leave the root", () => {
    const result = resolveContainedPath(ROOT, "/a/b/c.css");
    expect(result?.startsWith(ROOT + sep)).toBe(true);
  });
});
