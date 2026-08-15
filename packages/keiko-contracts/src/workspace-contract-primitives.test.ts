import { describe, expect, it } from "vitest";
import {
  WORKSPACE_POLICY_VERSION_PATTERN,
  hasWorkspaceControlCharacter,
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
  isWorkspaceRevision,
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

  it("folds POSIX case in overlap comparison so one directory cannot split trust bindings (#2615)", (): void => {
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

// KEIKO-0162: isWorkspaceRevision, hasWorkspaceControlCharacter, and WORKSPACE_POLICY_VERSION_PATTERN
// used to be re-implemented independently in workspace-manifest.ts, workspace-profile.ts, and (for
// the pattern) workspace-trust.ts -- the revision guard under two different names, the
// control-character guard twice verbatim, and the pattern character-for-character identical to
// this file's own (private) OPAQUE_REF_PATTERN under a different name. All three consumers now
// import the shared definitions asserted here.
describe("isWorkspaceRevision / hasWorkspaceControlCharacter / WORKSPACE_POLICY_VERSION_PATTERN (KEIKO-0162)", () => {
  it("accepts only safe-integer revisions >= 0", () => {
    expect(isWorkspaceRevision(0)).toBe(true);
    expect(isWorkspaceRevision(42)).toBe(true);
    expect(isWorkspaceRevision(-1)).toBe(false);
    expect(isWorkspaceRevision(1.5)).toBe(false);
    expect(isWorkspaceRevision(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(isWorkspaceRevision("1")).toBe(false);
    expect(isWorkspaceRevision(undefined)).toBe(false);
  });

  it("flags C0 control characters and DEL, not ordinary or non-ASCII text", () => {
    expect(hasWorkspaceControlCharacter("ordinary name")).toBe(false);
    expect(hasWorkspaceControlCharacter("")).toBe(false);
    expect(hasWorkspaceControlCharacter("tab\there")).toBe(true);
    expect(hasWorkspaceControlCharacter("new\nline")).toBe(true);
    expect(hasWorkspaceControlCharacter(`del${String.fromCharCode(0x7f)}here`)).toBe(true);
    expect(hasWorkspaceControlCharacter("emoji\u{1f600}ok")).toBe(false);
  });

  it("is the exact opaque-ref syntax rule, kept in sync by value rather than re-derived (pin)", () => {
    expect(WORKSPACE_POLICY_VERSION_PATTERN.source).toBe("^[a-z0-9][a-z0-9._-]{2,95}$");
    expect(WORKSPACE_POLICY_VERSION_PATTERN.test("v1.2.3")).toBe(true);
    expect(WORKSPACE_POLICY_VERSION_PATTERN.test("release_2026-08")).toBe(true);
    expect(WORKSPACE_POLICY_VERSION_PATTERN.test("ab")).toBe(false);
    expect(WORKSPACE_POLICY_VERSION_PATTERN.test("Policy-1")).toBe(false);
    expect(WORKSPACE_POLICY_VERSION_PATTERN.test("a".repeat(97))).toBe(false);
  });

  // KfQ thread 3788742105 raised a shared-mutable-RegExp-state concern: that a consumer mutating
  // `.lastIndex` on this exported pattern could corrupt matching elsewhere. That mechanism requires
  // the `g` or `y` flag -- without either, `.test()` never reads or writes `.lastIndex` at all, so
  // this pin is what makes the concern inapplicable, not merely commentary about it: if either flag
  // were ever added here, this test would fail before the mutation risk became real.
  it("carries neither the global nor sticky flag, so .lastIndex is inert for .test()", () => {
    expect(WORKSPACE_POLICY_VERSION_PATTERN.global).toBe(false);
    expect(WORKSPACE_POLICY_VERSION_PATTERN.sticky).toBe(false);
    WORKSPACE_POLICY_VERSION_PATTERN.lastIndex = 999_999;
    expect(WORKSPACE_POLICY_VERSION_PATTERN.test("v1.2.3")).toBe(true);
    WORKSPACE_POLICY_VERSION_PATTERN.lastIndex = 0;
  });
});
