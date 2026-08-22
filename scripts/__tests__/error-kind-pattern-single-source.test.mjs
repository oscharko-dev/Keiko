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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const CANONICAL_FILE = "packages/keiko-contracts/src/observability.ts";

// A source-level DECLARATION, not an import or a re-export of the shared const. Matched as text
// across every tracked file rather than by importing known packages, because the invariant is
// about how many places declare the pattern — importing would only prove that whatever a module
// re-exports still works, and would miss a brand-new file nobody wired an import check for.
const DECLARATION_PATTERN = /const\s+ERROR_KIND_PATTERN\s*=/;

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
// so a missing file is "does not declare the pattern", never a crash.
function declaresErrorKindPattern(path) {
  let content;
  try {
    content = readFileSync(resolve(REPO_ROOT, path), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  return DECLARATION_PATTERN.test(content);
}

function filesDeclaringErrorKindPattern() {
  return repositoryFiles().filter((path) => declaresErrorKindPattern(path));
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
