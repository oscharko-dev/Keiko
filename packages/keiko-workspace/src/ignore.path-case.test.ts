import { afterEach, describe, expect, it, vi } from "vitest";
import { compileIgnore, compileWorkspaceIgnore, isDenied, isIgnored } from "./ignore.js";

// #4436: Git for Windows defaults to core.ignorecase=true, so `.gitignore` rules must apply to
// every letter-case spelling of a path there, and a repository's explicit setting must win.
const RULES = ["build/", "*.log", "/Secrets.txt", "docs/**/draft*", "!keep.LOG"];

function stubPlatform(platform: NodeJS.Platform): void {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
}

describe("compileIgnore letter case", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ignores every case spelling under the case-insensitive rule", () => {
    const matcher = compileIgnore(RULES, "case-insensitive");
    expect(isIgnored(matcher, "Build", true)).toBe(true);
    expect(isIgnored(matcher, "BUILD/out.js", false)).toBe(true);
    expect(isIgnored(matcher, "logs/Server.LOG", false)).toBe(true);
    expect(isIgnored(matcher, "secrets.TXT", false)).toBe(true);
    expect(isIgnored(matcher, "Docs/a/DRAFT-1.md", false)).toBe(true);
    // Negation folds too: `!keep.LOG` re-includes `Keep.log`.
    expect(isIgnored(matcher, "Keep.log", false)).toBe(false);
    // Folding changes case only: a dir-only rule still spares a same-named file, an anchored rule
    // still binds to the root, and an unrelated name stays visible.
    expect(isIgnored(matcher, "BUILD", false)).toBe(false);
    expect(isIgnored(matcher, "nested/SECRETS.txt", false)).toBe(false);
    expect(isIgnored(matcher, "src/builder.ts", false)).toBe(false);
  });

  it("keeps exact case under the case-sensitive rule", () => {
    const matcher = compileIgnore(RULES, "case-sensitive");
    expect(isIgnored(matcher, "build/out.js", false)).toBe(true);
    expect(isIgnored(matcher, "Build/out.js", false)).toBe(false);
    expect(isIgnored(matcher, "logs/Server.LOG", false)).toBe(false);
    expect(isIgnored(matcher, "Secrets.txt", false)).toBe(true);
    expect(isIgnored(matcher, "secrets.TXT", false)).toBe(false);
    expect(isIgnored(matcher, "keep.LOG", false)).toBe(false);
  });

  it("defaults to the platform rule", () => {
    stubPlatform("win32");
    expect(isIgnored(compileIgnore(["build/"]), "Build/out.js", false)).toBe(true);
    stubPlatform("linux");
    expect(isIgnored(compileIgnore(["build/"]), "Build/out.js", false)).toBe(false);
  });

  it("lets a workspace's explicit repository rule override the platform", () => {
    stubPlatform("win32");
    const sensitive = compileWorkspaceIgnore({
      ignoreLines: ["*.log"],
      pathCase: "case-sensitive",
    });
    expect(isIgnored(sensitive, "a.LOG", false)).toBe(false);
    stubPlatform("linux");
    const insensitive = compileWorkspaceIgnore({
      ignoreLines: ["*.log"],
      pathCase: "case-insensitive",
    });
    expect(isIgnored(insensitive, "a.LOG", false)).toBe(true);
    expect(isIgnored(compileWorkspaceIgnore({ ignoreLines: ["*.log"] }), "a.LOG", false)).toBe(
      false,
    );
  });

  it("treats regex metacharacters in a rule as literals under either rule", () => {
    for (const pathCase of ["case-insensitive", "case-sensitive"] as const) {
      const matcher = compileIgnore(["a+(b)|[c].TXT", "x$^{2}"], pathCase);
      expect(isIgnored(matcher, "a+(b)|[c].TXT", false)).toBe(true);
      expect(isIgnored(matcher, "aab|c.TXT", false)).toBe(false);
      expect(isIgnored(matcher, "x$^{2}", false)).toBe(true);
    }
    const folded = compileIgnore(["a+(b)|[c].TXT"], "case-insensitive");
    expect(isIgnored(folded, "A+(B)|[C].txt", false)).toBe(true);
  });

  it("never lets the case rule weaken the deny list", () => {
    stubPlatform("linux");
    expect(isDenied(".ENV")).toBe(true);
    expect(isDenied("ID_RSA")).toBe(true);
    // An ignore negation cannot re-include a denied path either.
    const matcher = compileIgnore(["!.env"], "case-sensitive");
    expect(isIgnored(matcher, ".ENV", false)).toBe(false);
    expect(isDenied(".ENV")).toBe(true);
  });
});
