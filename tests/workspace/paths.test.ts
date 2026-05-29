import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PathEscapeError } from "../../src/workspace/errors.js";
import { isWithinWorkspace, resolveWithinWorkspace } from "../../src/workspace/paths.js";

const ROOT = "/repo/root";
const NUL = "\u0000";

describe("resolveWithinWorkspace", () => {
  it("resolves a simple relative path inside the root", () => {
    expect(resolveWithinWorkspace(ROOT, "src/index.ts")).toBe(join(ROOT, "src/index.ts"));
  });

  it("normalizes redundant segments that stay inside", () => {
    expect(resolveWithinWorkspace(ROOT, "src/./x/../index.ts")).toBe(join(ROOT, "src/index.ts"));
  });

  it("resolves the root itself when given empty or dot", () => {
    expect(resolveWithinWorkspace(ROOT, ".")).toBe(ROOT);
    expect(resolveWithinWorkspace(ROOT, "")).toBe(ROOT);
  });

  it("accepts an absolute path that is inside the root", () => {
    expect(resolveWithinWorkspace(ROOT, join(ROOT, "src/index.ts"))).toBe(
      join(ROOT, "src/index.ts"),
    );
  });

  for (const traversal of [
    "..",
    "../etc/passwd",
    "../../etc/passwd",
    "src/../../escape",
    "a/b/../../../c",
    "./../sibling",
  ]) {
    it(`rejects traversal escape: ${traversal}`, () => {
      expect(() => resolveWithinWorkspace(ROOT, traversal)).toThrow(PathEscapeError);
    });
  }

  it("rejects an absolute path outside the root", () => {
    expect(() => resolveWithinWorkspace(ROOT, "/etc/passwd")).toThrow(PathEscapeError);
  });

  it("rejects a sibling directory that shares a prefix", () => {
    expect(() => resolveWithinWorkspace("/repo/root", "/repo/root-sibling/x")).toThrow(
      PathEscapeError,
    );
  });

  it("rejects a NUL byte in the candidate", () => {
    expect(() => resolveWithinWorkspace(ROOT, `src/${NUL}evil`)).toThrow(PathEscapeError);
  });

  it("rejects a NUL byte in the root", () => {
    expect(() => resolveWithinWorkspace(`/repo${NUL}`, "x")).toThrow(PathEscapeError);
  });
});

describe("isWithinWorkspace", () => {
  it("returns true for an inside path", () => {
    expect(isWithinWorkspace(ROOT, "src/index.ts")).toBe(true);
  });

  it("returns true for the root itself", () => {
    expect(isWithinWorkspace(ROOT, ".")).toBe(true);
  });

  it("returns false for traversal escapes", () => {
    expect(isWithinWorkspace(ROOT, "../escape")).toBe(false);
  });

  it("returns false for absolute escapes", () => {
    expect(isWithinWorkspace(ROOT, "/etc/passwd")).toBe(false);
  });

  it("returns false for a NUL byte", () => {
    expect(isWithinWorkspace(ROOT, `a${NUL}b`)).toBe(false);
  });

  it("returns false for bare ..", () => {
    expect(isWithinWorkspace(ROOT, "..")).toBe(false);
  });
});
