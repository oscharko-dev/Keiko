// The error-kind gate used to be declared three times — once per package that writes
// activity-log events: keiko-server, keiko-model-gateway, keiko-local-knowledge. It was pinned
// only by a test that diffed the three declarations against each other
// (error-kind-pattern-drift.test.mjs, retired in the same change that added this file). That pin
// could only ever catch drift AFTER one copy relaxed; it could never stop a fourth copy, in a
// fourth package, from being declared tomorrow with a wider character class.
//
// ADR-0173 D11 consolidates the pattern into `packages/keiko-contracts/src/observability.ts` — the
// leaf every other package already depends on inward toward (ADR-0019) — as the one declaration
// every writer imports. This is the STRONGER pin the relocation buys: it does not compare copies
// to each other, it asserts there is exactly ONE declaration in the entire tracked source tree.
// A future package that reintroduces its own local declaration of the pattern — instead of
// importing the shared one — fails this test immediately, rather than waiting for a second copy
// to diverge from a first.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const CANONICAL_FILE = "packages/keiko-contracts/src/observability.ts";

// A source-level DECLARATION, not an import or a re-export of the shared const. `const`, `let`
// and `var` all introduce a local binding, so a pattern that matched only the `const` keyword would
// let a future `let`- or `var`-form declaration of the shared pattern name reintroduce a second copy
// without tripping this gate; `\b` keeps an identifier merely ending in a declaration keyword (e.g.
// a hypothetical "somevar" immediately preceding the name) from matching. An `export`-prefixed
// declaration still matches, because the keyword itself appears as its own token regardless of
// what precedes it. Matched as text across every tracked file rather than by importing known
// packages, because the invariant is about how many places declare the pattern — importing would
// only prove that whatever a module re-exports still works, and would miss a brand-new file nobody
// wired an import check for.
export const DECLARATION_PATTERN = /\b(?:const|let|var)\s+ERROR_KIND_PATTERN\s*=/;

// The invariant this gate enforces is about TypeScript/JavaScript syntax only, so binary assets,
// fixtures, and lockfiles carry no risk of a hidden declaration and are excluded from the scan.
export const SOURCE_EXTENSION_PATTERN = /\.(?:ts|mts|cts|tsx|js|mjs|cjs)$/;

// `--cached` (tracked) UNION `--others --exclude-standard` (untracked, non-ignored): this test
// must see a brand-new file the moment it is written, not only once a future commit stages it —
// the canonical file this consolidation adds is itself untracked until that commit happens.
function repositoryFiles() {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split("\0")
    .filter((path) => path.length > 0);
}

// A path `git ls-files` reports may already be removed from the working tree by an uncommitted
// `git rm`-free delete (exactly what retiring the old drift test does before this file is staged),
// may name a directory (a submodule gitlink, which `readFileSync` rejects with EISDIR), or may
// otherwise not be a regular file — every one of those is "does not declare the pattern", never a
// crash. Takes an absolute path and is exported so a test can drive this exact detector — the
// production entry point for the gate — against a temp fixture file instead of restating the
// regex.
export function declaresErrorKindPattern(absolutePath) {
  let stats;
  try {
    stats = statSync(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!stats.isFile()) return false;
  let content;
  try {
    content = readFileSync(absolutePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  return DECLARATION_PATTERN.test(content);
}

function filesDeclaringErrorKindPattern() {
  return repositoryFiles()
    .filter((path) => SOURCE_EXTENSION_PATTERN.test(path))
    .filter((path) => declaresErrorKindPattern(resolve(REPO_ROOT, path)));
}

describe("error-kind pattern has exactly one declaration (ADR-0173 D11)", () => {
  it("declares ERROR_KIND_PATTERN only in packages/keiko-contracts/src/observability.ts", () => {
    expect(filesDeclaringErrorKindPattern()).toStrictEqual([CANONICAL_FILE]);
  });

  it("the canonical declaration still gates the shapes the guard exists for", () => {
    const source = readFileSync(resolve(REPO_ROOT, CANONICAL_FILE), "utf8");
    const match = /ERROR_KIND_PATTERN = (\/[^\n]*\/);/.exec(source);
    expect(match).not.toBeNull();
    const literal = match[1];
    const pattern = new RegExp(literal.slice(1, literal.lastIndexOf("/")));

    // An identifier passes.
    expect(pattern.test("EMBEDDING_ADAPTER_FAILED")).toBe(true);
    expect(pattern.test("http-error")).toBe(true);
    // A sentence — the shape that can carry the rejected input — does not.
    expect(pattern.test("Setting {'encoding_format': 'float'} is not supported")).toBe(false);
    expect(pattern.test("token sk-proj-abc is invalid")).toBe(false);
    // Neither does an over-long run that could hide a payload.
    expect(pattern.test(`E${"x".repeat(200)}`)).toBe(false);
  });
});

describe("declaresErrorKindPattern detects every declaration form", () => {
  let fixtureDir;

  beforeEach(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), "error-kind-pattern-fixture-"));
  });

  afterEach(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  // Assembled from parts at runtime rather than written as a contiguous literal anywhere in THIS
  // file's own source: a literal keyword immediately followed by "ERROR_KIND_PATTERN =" here would
  // make this very test file match its own DECLARATION_PATTERN under the whole-repository scan
  // above, since that scan reads source text, not parsed syntax.
  function writeDeclarationFixture(fileName, keyword) {
    const patternName = ["ERROR", "KIND", "PATTERN"].join("_");
    const fixturePath = join(fixtureDir, fileName);
    writeFileSync(fixturePath, `${keyword} ${patternName} = /x/;\n`, "utf8");
    return fixturePath;
  }

  it("detects a let-form declaration, which a const-only pattern would miss", () => {
    expect(declaresErrorKindPattern(writeDeclarationFixture("let-form.ts", "let"))).toBe(true);
  });

  it("detects a var-form declaration, which a const-only pattern would miss", () => {
    expect(declaresErrorKindPattern(writeDeclarationFixture("var-form.ts", "var"))).toBe(true);
  });

  it("still detects an exported const-form declaration", () => {
    const fixturePath = writeDeclarationFixture("export-const-form.ts", "export const");
    expect(declaresErrorKindPattern(fixturePath)).toBe(true);
  });

  it("does not match an identifier that merely ends in a declaration keyword", () => {
    // Without the `\b` boundary, the keyword alternation would find a "var"-shaped match as a bare
    // substring of a longer identifier like "somevar" immediately preceding the pattern name below.
    const fixturePath = writeDeclarationFixture("decoy.ts", "const somevar");
    expect(declaresErrorKindPattern(fixturePath)).toBe(false);
  });

  it("degrades to false instead of crashing (EISDIR) when the path is a directory", () => {
    // Approximates the submodule-gitlink case `git ls-files` can report: a tracked path whose
    // on-disk entry is a directory, not a regular file.
    expect(() => declaresErrorKindPattern(fixtureDir)).not.toThrow();
    expect(declaresErrorKindPattern(fixtureDir)).toBe(false);
  });
});
