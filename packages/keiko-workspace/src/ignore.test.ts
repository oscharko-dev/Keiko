import { describe, expect, it } from "vitest";
import { compileIgnore, DEFAULT_DENY_PATTERNS, isDenied, isIgnored } from "./ignore.js";

describe("DEFAULT_DENY_PATTERNS", () => {
  it("is a frozen, non-empty list", () => {
    expect(Object.isFrozen(DEFAULT_DENY_PATTERNS)).toBe(true);
    expect(DEFAULT_DENY_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe("isDenied (always-on security)", () => {
  for (const denied of [
    ".env",
    ".env.local",
    ".env.production",
    "config/.env",
    "secrets/server.pem",
    "keys/server.key",
    "id_rsa",
    "id_ed25519",
    "id_ecdsa",
    "id_dsa",
    "cert.p12",
    "cert.pfx",
    ".npmrc",
    "node_modules",
    "node_modules/left-pad/index.js",
    "dist",
    "dist/index.js",
    "build/output.js",
    "out/main.js",
    "coverage/lcov.info",
    ".cache/x",
    ".next/server",
    ".turbo/cache",
    ".git",
    ".git/config",
    "app.log",
    "logs/error.log",
    ".DS_Store",
    "sub/.DS_Store",
  ]) {
    it(`denies ${denied}`, () => {
      expect(isDenied(denied)).toBe(true);
    });
  }

  for (const allowed of [
    ".env.example",
    "src/index.ts",
    "README.md",
    "package.json",
    "src/env.ts",
    "documentation.md",
    "envoy.config.ts",
  ]) {
    it(`does not deny ${allowed}`, () => {
      expect(isDenied(allowed)).toBe(false);
    });
  }

  it("denies regardless of leading ./ and backslashes", () => {
    expect(isDenied("./node_modules/x")).toBe(true);
    expect(isDenied("node_modules\\x\\y")).toBe(true);
  });

  it("denies case-only variants (case-insensitive filesystems must not bypass)", () => {
    expect(isDenied(".ENV")).toBe(true);
    expect(isDenied("Node_Modules/pkg/index.js")).toBe(true);
    expect(isDenied("keys/server.PEM")).toBe(true);
    expect(isDenied("DIST/out.js")).toBe(true);
    expect(isDenied(".ds_store")).toBe(true);
  });

  it("still allows .env.example regardless of case", () => {
    expect(isDenied(".env.example")).toBe(false);
    expect(isDenied(".ENV.EXAMPLE")).toBe(false);
  });
});

describe("compileIgnore + isIgnored (.gitignore subset)", () => {
  it("ignores blank lines and comments", () => {
    const m = compileIgnore(["", "   ", "# a comment", "*.tmp"]);
    expect(isIgnored(m, "x.tmp", false)).toBe(true);
    expect(isIgnored(m, "x.ts", false)).toBe(false);
  });

  it("matches a plain name anywhere", () => {
    const m = compileIgnore(["TODO"]);
    expect(isIgnored(m, "TODO", false)).toBe(true);
    expect(isIgnored(m, "sub/TODO", false)).toBe(true);
    expect(isIgnored(m, "TODOLIST", false)).toBe(false);
  });

  it("matches an extension glob", () => {
    const m = compileIgnore(["*.log"]);
    expect(isIgnored(m, "a.log", false)).toBe(true);
    expect(isIgnored(m, "deep/dir/a.log", false)).toBe(true);
    expect(isIgnored(m, "a.logger", false)).toBe(false);
  });

  it("matches a directory pattern for the dir and its contents but not a same-named file", () => {
    const m = compileIgnore(["tmp/"]);
    expect(isIgnored(m, "tmp", true)).toBe(true);
    expect(isIgnored(m, "tmp/file.ts", false)).toBe(true);
    expect(isIgnored(m, "tmp", false)).toBe(false);
  });

  it("anchors a leading-slash pattern to the root", () => {
    const m = compileIgnore(["/buildx"]);
    expect(isIgnored(m, "buildx", false)).toBe(true);
    expect(isIgnored(m, "buildx/x", false)).toBe(true);
    expect(isIgnored(m, "sub/buildx", false)).toBe(false);
  });

  it("supports ** segments", () => {
    const m = compileIgnore(["docs/**/draft.md"]);
    expect(isIgnored(m, "docs/a/b/draft.md", false)).toBe(true);
    expect(isIgnored(m, "docs/draft.md", false)).toBe(true);
    expect(isIgnored(m, "other/draft.md", false)).toBe(false);
  });

  it("supports negation overriding an earlier match", () => {
    const m = compileIgnore(["*.log", "!keep.log"]);
    expect(isIgnored(m, "x.log", false)).toBe(true);
    expect(isIgnored(m, "keep.log", false)).toBe(false);
  });

  it("applies later patterns with precedence over earlier ones", () => {
    const m = compileIgnore(["scratch/", "!scratch/keep", "scratch/keep/nested"]);
    expect(isIgnored(m, "scratch/keep", true)).toBe(false);
    expect(isIgnored(m, "scratch/keep/nested", false)).toBe(true);
  });

  it("does not hang on adversarial long input (no ReDoS)", () => {
    const m = compileIgnore([`${"*".repeat(50)}.tmp`]);
    const start = Date.now();
    isIgnored(m, `${"a".repeat(10_000)}.tmp`, false);
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it("normalizes backslash separators in the tested path", () => {
    const m = compileIgnore(["tmp/"]);
    expect(isIgnored(m, "tmp\\file.ts", false)).toBe(true);
  });
});

describe("normalize trailing-slash handling (ReDoS regression)", () => {
  it("denies node_modules/ and node_modules///// identically", () => {
    expect(isDenied("node_modules/")).toBe(true);
    expect(isDenied("node_modules/////")).toBe(true);
  });

  it("isIgnored treats src/a/ and src/a///// as the same path", () => {
    const m = compileIgnore(["src/a"]);
    expect(isIgnored(m, "src/a/", false)).toBe(isIgnored(m, "src/a/////", false));
  });

  it("does not catastrophically backtrack on many trailing slashes (no ReDoS)", () => {
    const pathological = "a".repeat(1_000) + "/".repeat(100_000);
    const start = Date.now();
    isDenied(pathological);
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
