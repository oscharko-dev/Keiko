import { describe, expect, it } from "vitest";
import { GIT_DELIVERY_PATHSPEC_CONTROL_CHAR, isContainedPathspec } from "./requestGuards.js";

describe("isContainedPathspec", () => {
  it("accepts contained relative pathspecs", () => {
    expect(isContainedPathspec("src/index.ts")).toBe(true);
    expect(isContainedPathspec("a/b/c.txt")).toBe(true);
    expect(isContainedPathspec("file.with.dots")).toBe(true);
    expect(isContainedPathspec("dir/my file.txt")).toBe(true); // a literal space is a valid filename char
  });

  it("rejects C0 control characters (TAB, LF, CR)", () => {
    expect(isContainedPathspec("src/\tindex.ts")).toBe(false);
    expect(isContainedPathspec("src/index.ts\n")).toBe(false);
    expect(isContainedPathspec("src\r/index.ts")).toBe(false);
  });

  it("rejects the NUL byte and DEL alongside other C0 controls", () => {
    expect(isContainedPathspec("src/\0index.ts")).toBe(false);
    expect(isContainedPathspec("src/\x7findex.ts")).toBe(false);
    expect(isContainedPathspec("\x01\x02\x1f")).toBe(false);
  });

  it("keeps rejecting the pre-existing unsafe shapes", () => {
    expect(isContainedPathspec("")).toBe(false);
    expect(isContainedPathspec("-flag")).toBe(false);
    expect(isContainedPathspec("/absolute")).toBe(false);
    expect(isContainedPathspec("C:\\windows")).toBe(false);
    expect(isContainedPathspec("C:drive-relative")).toBe(false);
    expect(isContainedPathspec("\\windows-rooted")).toBe(false);
    expect(isContainedPathspec("\\\\server\\share\\file.txt")).toBe(false);
    expect(isContainedPathspec("../escape")).toBe(false);
    expect(isContainedPathspec(42)).toBe(false);
  });

  it("matches the C0 control range symmetrically with the network-ref guard", () => {
    expect(GIT_DELIVERY_PATHSPEC_CONTROL_CHAR.test("\t")).toBe(true);
    expect(GIT_DELIVERY_PATHSPEC_CONTROL_CHAR.test("\n")).toBe(true);
    expect(GIT_DELIVERY_PATHSPEC_CONTROL_CHAR.test("\r")).toBe(true);
    expect(GIT_DELIVERY_PATHSPEC_CONTROL_CHAR.test("\x00")).toBe(true);
    expect(GIT_DELIVERY_PATHSPEC_CONTROL_CHAR.test("\x7f")).toBe(true);
    expect(GIT_DELIVERY_PATHSPEC_CONTROL_CHAR.test("ok")).toBe(false);
  });
});
