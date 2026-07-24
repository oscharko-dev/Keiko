import { describe, expect, it } from "vitest";
import {
  isCanonicalWorkspaceRoot,
  isPortableWorkspaceRelativePath,
  isWorkspaceContentDigest,
  isWorkspaceFact,
  isWorkspaceHistoryEntryRef,
  isWorkspaceIsoInstant,
  isWorkspaceManifestDigest,
  isWorkspaceManifestRef,
  isWorkspacePathDigest,
  isWorkspaceProfileRef,
  isWorkspaceRootIdentityDigest,
  isWorkspaceRootRef,
  isWorkspaceTrustBasisDigest,
  isWorkspaceVaultEntryRef,
  workspaceCanonicalRootsDoNotOverlap,
} from "./workspace-contract-primitives.js";

describe("workspace contract primitives", () => {
  it.each([
    ["root-primary", isWorkspaceRootRef],
    ["manifest-primary", isWorkspaceManifestRef],
    ["profile-primary", isWorkspaceProfileRef],
    ["history-primary", isWorkspaceHistoryEntryRef],
    ["vault-primary", isWorkspaceVaultEntryRef],
  ] as const)("validates branded opaque reference %s", (value, guard) => {
    expect(guard(value)).toBe(true);
    expect(guard("../escape")).toBe(false);
  });

  it("bounds opaque references and rejects ambiguous characters", () => {
    expect(isWorkspaceRootRef("abc")).toBe(true);
    expect(isWorkspaceRootRef("ab")).toBe(false);
    expect(isWorkspaceRootRef(`a${"b".repeat(95)}`)).toBe(true);
    expect(isWorkspaceRootRef(`a${"b".repeat(96)}`)).toBe(false);
    expect(isWorkspaceRootRef("root:primary")).toBe(false);
    expect(isWorkspaceRootRef(42)).toBe(false);
  });

  it.each([
    isWorkspaceRootIdentityDigest,
    isWorkspaceManifestDigest,
    isWorkspaceTrustBasisDigest,
    isWorkspaceContentDigest,
    isWorkspacePathDigest,
  ])("accepts only exact lowercase SHA-256 values", (guard) => {
    expect(guard("a".repeat(64))).toBe(true);
    expect(guard("A".repeat(64))).toBe(false);
    expect(guard("a".repeat(63))).toBe(false);
  });

  it("validates canonical UTC instants without calendar rollover", () => {
    expect(isWorkspaceIsoInstant("2026-07-18T12:00:00.000Z")).toBe(true);
    expect(isWorkspaceIsoInstant("2026-02-31T12:00:00.000Z")).toBe(false);
    expect(isWorkspaceIsoInstant("2026-07-18T12:00:00Z")).toBe(false);
  });

  it("requires explicit tagged fact outcomes", () => {
    expect(isWorkspaceFact({ outcome: "known", value: "root-primary" }, isWorkspaceRootRef)).toBe(
      true,
    );
    for (const outcome of ["unknown", "unavailable", "absent"] as const) {
      expect(isWorkspaceFact({ outcome }, isWorkspaceRootRef)).toBe(true);
      expect(isWorkspaceFact({ outcome, value: "root-primary" }, isWorkspaceRootRef)).toBe(false);
    }
    expect(isWorkspaceFact(undefined, isWorkspaceRootRef)).toBe(false);
    expect(
      isWorkspaceFact({ outcome: "known", value: "root-primary", extra: true }, isWorkspaceRootRef),
    ).toBe(false);
    expect(isWorkspaceFact({ outcome: "future" }, isWorkspaceRootRef)).toBe(false);
  });

  it("fails closed without throwing for hostile fact objects", () => {
    const hostile = Object.defineProperty({}, "outcome", {
      get(): never {
        throw new Error("hostile getter");
      },
    });
    expect(() => isWorkspaceFact(hostile, isWorkspaceRootRef)).not.toThrow();
    expect(isWorkspaceFact(hostile, isWorkspaceRootRef)).toBe(false);
  });

  it("separates server-private canonical roots from portable relative paths", () => {
    expect(isCanonicalWorkspaceRoot("/")).toBe(true);
    expect(isCanonicalWorkspaceRoot("C:\\")).toBe(true);
    expect(isCanonicalWorkspaceRoot("/work/keiko")).toBe(true);
    expect(isCanonicalWorkspaceRoot("C:\\work\\keiko")).toBe(true);
    expect(isCanonicalWorkspaceRoot("/work/../escape")).toBe(false);
    expect(isCanonicalWorkspaceRoot("/work\\..\\escape")).toBe(false);
    expect(isCanonicalWorkspaceRoot("C:\\work/../escape")).toBe(false);
    expect(isCanonicalWorkspaceRoot("C:\\work/child")).toBe(false);
    for (const path of [
      "//work/keiko",
      "/work//keiko",
      "/work/keiko/",
      "C:\\\\work",
      "C:\\work\\\\keiko",
      "C:\\work\\keiko\\",
    ]) {
      expect(isCanonicalWorkspaceRoot(path)).toBe(false);
    }
    expect(isPortableWorkspaceRelativePath("src/main.ts")).toBe(true);
    for (const path of ["/etc/passwd", "../escape", "C:\\repo", "\\\\host\\share", "a\\b"]) {
      expect(isPortableWorkspaceRelativePath(path)).toBe(false);
    }
    for (const path of ["", "relative/root", "/work/./child", `/work/${"x".repeat(4097)}`]) {
      expect(isCanonicalWorkspaceRoot(path)).toBe(false);
    }
    for (const path of ["", "a//b", "./a", "a/../b", `a/${"é".repeat(2049)}`]) {
      expect(isPortableWorkspaceRelativePath(path)).toBe(false);
    }
  });

  it("distinguishes nested roots from path-prefix siblings", () => {
    expect(workspaceCanonicalRootsDoNotOverlap(["/work/app", "/work/application"])).toBe(true);
    expect(workspaceCanonicalRootsDoNotOverlap(["/work/app", "/work/app/packages/ui"])).toBe(false);
    expect(workspaceCanonicalRootsDoNotOverlap(["C:\\work", "C:\\work\\child"])).toBe(false);
    expect(workspaceCanonicalRootsDoNotOverlap(["C:\\work", "C:\\work/child"])).toBe(false);
    expect(workspaceCanonicalRootsDoNotOverlap(["C:\\Work", "c:\\work\\child"])).toBe(false);
    expect(workspaceCanonicalRootsDoNotOverlap(["/work/app", "/work/app"])).toBe(false);
    expect(workspaceCanonicalRootsDoNotOverlap(["/work/app", "/work//app/child"])).toBe(false);
    expect(workspaceCanonicalRootsDoNotOverlap(["C:\\work\\app", "C:\\work\\\\app\\child"])).toBe(
      false,
    );
    expect(workspaceCanonicalRootsDoNotOverlap(["/work/app", "relative/root"])).toBe(false);
    expect(workspaceCanonicalRootsDoNotOverlap(["/work/app", "C:\\work\\app"])).toBe(true);
  });

  it("folds POSIX case in overlap comparison so one directory cannot split trust bindings (#2615)", () => {
    // macOS APFS/HFS+ and case-insensitive Linux mounts open one filesystem directory under many
    // case variants. Without case folding here a manifest could list `[/Users/Alice/proj,
    // /users/alice/proj]` as distinct canonical roots and mint two independent trust states over
    // the same directory. Case-sensitive Linux paths that legitimately differ only in case lose
    // nothing by being rejected as overlapping — the failure closes trust.
    expect(workspaceCanonicalRootsDoNotOverlap(["/Users/Alice/proj", "/users/alice/proj"])).toBe(
      false,
    );
    expect(
      workspaceCanonicalRootsDoNotOverlap(["/Users/Alice/proj", "/USERS/ALICE/PROJ/child"]),
    ).toBe(false);
    expect(workspaceCanonicalRootsDoNotOverlap(["/work/App", "/work/app/child"])).toBe(false);
    // Distinct paths that only share a case-fold on a proper prefix are still allowed: one root
    // ends the prefix at a segment boundary, the other does not.
    expect(workspaceCanonicalRootsDoNotOverlap(["/work/App", "/work/application"])).toBe(true);
  });

  it("rejects Win32 trailing-dot / trailing-space segment aliases that CreateFile strips (#2285)", () => {
    // CreateFile strips a trailing `.` or space from each path segment: `C:\work\app` and
    // `C:\work\app.` open the same directory, and so do `C:\work\app` and `C:\work\app `.
    // A hostile manifest can otherwise pair `[C:\work\app, C:\work\app.\child]` and split
    // trust bindings on a single filesystem directory. The validator must fail the alias
    // before overlap checking is even consulted.
    expect(isCanonicalWorkspaceRoot("C:\\work\\app.")).toBe(false);
    expect(isCanonicalWorkspaceRoot("C:\\work\\app ")).toBe(false);
    expect(isCanonicalWorkspaceRoot("C:\\work\\app.\\child")).toBe(false);
    expect(isCanonicalWorkspaceRoot("C:\\work\\app \\child")).toBe(false);
    expect(workspaceCanonicalRootsDoNotOverlap(["C:\\work\\app", "C:\\work\\app.\\child"])).toBe(
      false,
    );
    expect(workspaceCanonicalRootsDoNotOverlap(["C:\\work\\app", "C:\\work\\app \\child"])).toBe(
      false,
    );
    // POSIX segments containing a trailing dot remain legal — dots are meaningful there
    // (dotfiles, hidden dirs) and no analogous alias exists in the POSIX open path.
    expect(isCanonicalWorkspaceRoot("/work/app.")).toBe(true);
    expect(isCanonicalWorkspaceRoot("/work/app./child")).toBe(true);
  });
});
