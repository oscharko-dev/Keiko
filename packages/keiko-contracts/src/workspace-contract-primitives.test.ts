import { describe, expect, expectTypeOf, it, vi } from "vitest";
import * as publicPrimitives from "@oscharko-dev/keiko-contracts/runtime/workspace-contract-primitives";
import * as sourcePrimitives from "./workspace-contract-primitives.js";
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
  WORKSPACE_PORTABLE_PATH_MAX_BYTES,
} from "./workspace-contract-primitives.js";
import { isValidScopePath } from "./connected-context.js";

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

  it("bounds canonical roots in UTF-8 bytes, not UTF-16 code units (KEIKO-0776)", () => {
    // "中" is 3 UTF-8 bytes but a single UTF-16 code unit. 1400 of them is 4200 UTF-8 bytes
    // (> WORKSPACE_PORTABLE_PATH_MAX_BYTES=4096) but only 1400 UTF-16 code units (well below the
    // old bare 4096 .length bound). A bare `.length > 4096` guard accepts this; the sibling
    // isPortableWorkspaceRelativePath already counted bytes correctly.
    const asciiRoot = `/${"a".repeat(4096)}`; // 4097 UTF-8 bytes → must be rejected
    expect(isCanonicalWorkspaceRoot(asciiRoot)).toBe(false);
    const multibyteRoot = `/${"中".repeat(1400)}`; // 4201 UTF-8 bytes, 1401 UTF-16 code units
    expect(isCanonicalWorkspaceRoot(multibyteRoot)).toBe(false);
    const belowBudgetMultibyte = `/${"中".repeat(100)}`; // 301 UTF-8 bytes → still valid
    expect(isCanonicalWorkspaceRoot(belowBudgetMultibyte)).toBe(true);
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

// ─── The ONE workspace-relative path rule ────────────────────────────────────────
//
// This package used to ship TWO predicates for "is this a safe workspace-relative path":
// isPortableWorkspaceRelativePath here, and isValidScopePath in connected-context.ts. They
// disagreed — isValidScopePath accepted a leading `~` and enforced no length bound — so which one
// a validator happened to import silently changed what it accepted. The divergence surfaced during
// audit finding KEIKO-0338: a regression test asserting `~/secrets` is rejected had to be dropped
// because the predicate that validator used allowed it.
//
// isValidScopePath now delegates here. This table is the agreed rule set, asserted through BOTH
// entry points, so the two can never answer differently again — including for `~`, which is the
// case that started this.
describe("workspace-relative path rule (one definition, two entry points)", () => {
  const ACCEPTED: readonly string[] = [
    "src/main.ts",
    "a",
    "src/a/b/c.ts",
    "src/~backup.ts", // a tilde INSIDE the path is an ordinary character
    "file~", // trailing tilde (an editor backup name) is ordinary too
    "dot.files/.eslintrc.json",
    "a".repeat(WORKSPACE_PORTABLE_PATH_MAX_BYTES),
  ];

  const REJECTED: readonly unknown[] = [
    // not a string / empty
    7,
    null,
    undefined,
    "",
    // absolute and platform-qualified roots
    "/etc/passwd",
    "/",
    "C:/secrets.txt",
    "c:secrets.txt",
    "\\\\host\\share",
    // home-relative — the case the two predicates used to disagree on
    "~",
    "~/secrets",
    "~/.ssh/id_rsa",
    // traversal and blank segments
    "../secrets",
    "src/../../escape.ts",
    "src/./a.ts",
    "src//a.ts",
    "a/",
    // separator and NUL smuggling
    "src\\a.ts",
    "a\u0000.ts",
    // over the byte bound
    "a".repeat(WORKSPACE_PORTABLE_PATH_MAX_BYTES + 1),
  ];

  it.each(ACCEPTED)("accepts %j through both entry points", (path) => {
    expect(isPortableWorkspaceRelativePath(path)).toBe(true);
    expect(isValidScopePath(path, { mustBeRelative: true })).toBe(true);
  });

  it.each(REJECTED)("rejects %j through both entry points", (path) => {
    expect(isPortableWorkspaceRelativePath(path)).toBe(false);
    expect(isValidScopePath(path, { mustBeRelative: true })).toBe(false);
  });

  it("bounds the path in UTF-8 BYTES, not UTF-16 code units", () => {
    // 3 UTF-8 bytes per character: under the bound by length, over it by bytes.
    const characters = Math.floor(WORKSPACE_PORTABLE_PATH_MAX_BYTES / 3) + 1;
    const path = "\u4e2d".repeat(characters);
    expect(path.length).toBeLessThan(WORKSPACE_PORTABLE_PATH_MAX_BYTES);
    expect(isPortableWorkspaceRelativePath(path)).toBe(false);
    expect(isValidScopePath(path, { mustBeRelative: true })).toBe(false);
  });

  it("refuses the non-relative mode rather than silently treating it as relative", () => {
    expect(isValidScopePath("src/main.ts", { mustBeRelative: false })).toBe(false);
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

function isNumber(candidate: unknown): candidate is number {
  return typeof candidate === "number";
}

function pinPublicRevision(input: unknown): void {
  if (publicPrimitives.isWorkspaceRevision(input)) {
    expectTypeOf(input).toEqualTypeOf<number>();
  }
}

function pinPublicFact(input: unknown): void {
  if (!publicPrimitives.isWorkspaceFact(input, isNumber)) return;
  expectTypeOf(input.outcome).toEqualTypeOf<"known" | "unknown" | "unavailable" | "absent">();
  if (input.outcome === "known") expectTypeOf(input.value).toEqualTypeOf<number>();
}

describe.each([
  ["source", sourcePrimitives],
  ["public", publicPrimitives],
] as const)("%s workspace primitive preservation", (_entrypoint, primitives) => {
  it.each([0, -0, 42, Number.MAX_SAFE_INTEGER])("accepts native safe revision %s", (value) => {
    expect(primitives.isWorkspaceRevision(value)).toBe(true);
    pinPublicRevision(value);
  });

  it.each([
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    NaN,
    Infinity,
    -Infinity,
    "0",
    null,
    undefined,
    0n,
    Symbol("revision"),
  ])("refuses non-revisions without conversion %s", (value) => {
    expect(primitives.isWorkspaceRevision(value)).toBe(false);
  });

  it("calls the real safe-integer check once before returning", () => {
    const original = Number.isSafeInteger;
    const seen: unknown[] = [];
    const check = vi
      .spyOn(Number, "isSafeInteger")
      .mockImplementation((value: unknown): boolean => {
        seen.push(value);
        return original(value);
      });
    try {
      expect(primitives.isWorkspaceRevision("0")).toBe(false);
      expect(seen).toEqual(["0"]);
    } finally {
      check.mockRestore();
    }
  });

  it("does not coerce objects into numeric revisions", () => {
    const candidate = {
      [Symbol.toPrimitive](): never {
        throw new Error("unexpected coercion");
      },
    };
    expect(primitives.isWorkspaceRevision(candidate)).toBe(false);
    expect(primitives.isWorkspaceRevision(Object(0))).toBe(false);
  });

  it.each(["unknown", "unavailable", "absent"])(
    "preserves the closed fact outcome %s",
    (outcome) => {
      const fact = { outcome };
      expect(primitives.isWorkspaceFact(fact, isNumber)).toBe(true);
      pinPublicFact(fact);
      expect(primitives.isWorkspaceFact({ ...fact, value: undefined }, isNumber)).toBe(false);
    },
  );

  it("does not call the payload guard for non-known or malformed outcomes", () => {
    let calls = 0;
    function guard(_candidate: unknown): _candidate is number {
      calls++;
      return false;
    }
    for (const outcome of ["unknown", "unavailable", "absent"]) {
      expect(primitives.isWorkspaceFact({ outcome }, guard)).toBe(true);
    }
    expect(primitives.isWorkspaceFact({ outcome: "future" }, guard)).toBe(false);
    expect(primitives.isWorkspaceFact({ outcome: 1 }, guard)).toBe(false);
    expect(calls).toBe(0);
    expect(primitives.isWorkspaceFact({ outcome: "known" }, guard)).toBe(false);
    expect(calls).toBe(1);
  });

  it("delegates the known payload once and revalidates mutation", () => {
    const payload = { revision: 0 };
    const fact = { outcome: "known", value: payload };
    const seen: unknown[] = [];
    function guard(candidate: unknown): candidate is { revision: number } {
      seen.push(candidate);
      return (
        primitives.isWorkspaceRecord(candidate) &&
        primitives.isWorkspaceRevision(candidate.revision)
      );
    }
    expect(primitives.isWorkspaceFact(fact, guard)).toBe(true);
    expect(seen).toEqual([payload]);
    expect(seen[0]).toBe(payload);
    payload.revision = -1;
    expect(primitives.isWorkspaceFact(fact, guard)).toBe(false);
    expect(seen).toEqual([payload, payload]);
    expect(primitives.isWorkspaceFact({ outcome: "known", value: "0" }, isNumber)).toBe(false);
    pinPublicFact({ outcome: "known", value: 0 });
  });

  it("keeps key refusal before callback invocation and catches callback throws", () => {
    let calls = 0;
    function guard(_candidate: unknown): _candidate is number {
      calls++;
      throw new Error("callback refusal");
    }
    expect(primitives.isWorkspaceFact({ outcome: "known", value: 0, extra: true }, guard)).toBe(
      false,
    );
    expect(calls).toBe(0);
    expect(primitives.isWorkspaceFact({ outcome: "known", value: 0 }, guard)).toBe(false);
    expect(calls).toBe(1);
  });

  it("retains known getter and own-key read scheduling", () => {
    const reads: string[] = [];
    const fact = new Proxy(
      { outcome: "known", value: 1 },
      {
        get(target, key, receiver): unknown {
          reads.push(String(key));
          return Reflect.get(target, key, receiver);
        },
        ownKeys(target): (string | symbol)[] {
          reads.push("keys");
          return Reflect.ownKeys(target);
        },
      },
    );
    expect(primitives.isWorkspaceFact(fact, isNumber)).toBe(true);
    expect(reads).toEqual(["outcome", "outcome", "keys", "value"]);
  });

  it("preserves separate changing-outcome reads and closed membership dispatch", () => {
    let reads = 0;
    const fact = {
      get outcome(): string {
        reads++;
        return reads === 1 ? "unknown" : reads === 2 ? "absent" : "unavailable";
      },
    };
    expect(primitives.isWorkspaceFact(fact, isNumber)).toBe(true);
    expect(reads).toBe(3);
    expect(primitives.isWorkspaceFact({ outcome: "future" }, isNumber)).toBe(false);
  });

  it("fails closed for getter and ownKeys exceptions", () => {
    const getter = {
      get outcome(): never {
        throw new Error("getter refusal");
      },
    };
    const keys = new Proxy(
      { outcome: "absent" },
      {
        ownKeys(): never {
          throw new Error("keys refusal");
        },
      },
    );
    expect(primitives.isWorkspaceFact(getter, isNumber)).toBe(false);
    expect(primitives.isWorkspaceFact(keys, isNumber)).toBe(false);
  });
});
