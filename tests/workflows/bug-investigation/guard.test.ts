import { describe, expect, it } from "vitest";
import {
  isElevatedReviewPath,
  isSensitivePath,
} from "../../../src/workflows/bug-investigation/guard.js";

describe("isSensitivePath (AC #9 patch handling / D6 scope guard)", () => {
  it("rejects an absolute path (fail-closed traversal)", () => {
    expect(isSensitivePath("/etc/passwd")).toBe(true);
  });

  it("rejects a `..` traversal segment (fail-closed)", () => {
    expect(isSensitivePath("tests/../.github/workflows/ci.yml")).toBe(true);
    expect(isSensitivePath("../outside.ts")).toBe(true);
  });

  it("rejects anything under .github/ (CI/CD supply-chain)", () => {
    expect(isSensitivePath(".github/workflows/ci.yml")).toBe(true);
    expect(isSensitivePath(".github")).toBe(true);
  });

  it("rejects a case-variant .GitHub/ on case-insensitive filesystems", () => {
    expect(isSensitivePath(".GitHub/workflows/ci.yml")).toBe(true);
  });

  it("rejects anything under .husky/ (git-hook RCE vector)", () => {
    expect(isSensitivePath(".husky/pre-commit")).toBe(true);
    expect(isSensitivePath(".HUSKY/pre-push")).toBe(true);
  });

  it("rejects lockfiles by basename, case-insensitively", () => {
    expect(isSensitivePath("package-lock.json")).toBe(true);
    expect(isSensitivePath("Package-Lock.json")).toBe(true);
    expect(isSensitivePath("npm-shrinkwrap.json")).toBe(true);
    expect(isSensitivePath("yarn.lock")).toBe(true);
    expect(isSensitivePath("pnpm-lock.yaml")).toBe(true);
    expect(isSensitivePath("frontend/yarn.lock")).toBe(true);
  });

  it("allows ordinary source and test paths", () => {
    expect(isSensitivePath("src/buggy.ts")).toBe(false);
    expect(isSensitivePath("tests/buggy.test.ts")).toBe(false);
    expect(isSensitivePath("src/sub/dir/file.ts")).toBe(false);
  });

  it("allows manifest/config edits (they are flagged, not denied)", () => {
    expect(isSensitivePath("package.json")).toBe(false);
    expect(isSensitivePath("tsconfig.json")).toBe(false);
  });

  it("handles backslash path separators", () => {
    expect(isSensitivePath(".github\\workflows\\ci.yml")).toBe(true);
  });

  it("rejects sensitive paths hidden behind ./ and // prefixes (C1 bypass)", () => {
    // #6 resolveWithinWorkspace collapses ./ and // and would write the REAL protected file, so the
    // guard must normalize before the dir/basename checks.
    expect(isSensitivePath("./.husky/pre-commit")).toBe(true);
    expect(isSensitivePath(".//.github/workflows/ci.yml")).toBe(true);
    expect(isSensitivePath("./.GITHUB/x")).toBe(true);
    expect(isSensitivePath(".//package-lock.json")).toBe(true);
    expect(isSensitivePath("./.github")).toBe(true);
    expect(isSensitivePath("./src/../.husky/pre-commit")).toBe(true); // .. still fail-closes
  });

  it("still allows legitimate paths with a ./ prefix (no false positive)", () => {
    expect(isSensitivePath("./src/foo.ts")).toBe(false);
    expect(isSensitivePath(".//src/foo.ts")).toBe(false);
  });
});

describe("isElevatedReviewPath (D6 manifest/config surfacing)", () => {
  it("flags a ./-prefixed manifest identically to the bare form (C1 normalization)", () => {
    expect(isElevatedReviewPath("./package.json")).toBe(true);
    expect(isElevatedReviewPath(".//tsconfig.json")).toBe(true);
  });

  it("flags manifest and tsconfig edits", () => {
    expect(isElevatedReviewPath("package.json")).toBe(true);
    expect(isElevatedReviewPath("tsconfig.json")).toBe(true);
    expect(isElevatedReviewPath("tsconfig.build.json")).toBe(true);
    expect(isElevatedReviewPath("packages/app/package.json")).toBe(true);
  });

  it("does not flag ordinary source", () => {
    expect(isElevatedReviewPath("src/buggy.ts")).toBe(false);
    expect(isElevatedReviewPath("tests/buggy.test.ts")).toBe(false);
  });
});
