import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it } from "vitest";

import { isWithinPath, runEditorDocLinkCheck } from "../check-editor-doc-links.mjs";

// Every sandbox any test in this file creates, swept after each test by the one module-scope hook
// below -- so a describe block that never registers its own cleanup, or a test that builds several
// sandboxes (the growth guards build four), cannot leave pathological fixtures behind in the
// temp directory (Keiko for Quality on #3394: the S8786 block leaked one sandbox per test).
const sandboxes = [];

function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), "editor-doc-links-"));
  sandboxes.push(root);
  const repoRoot = join(root, "repo");
  const outsideRoot = join(root, "outside");
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(outsideRoot, { recursive: true });
  return { repoRoot, outsideRoot };
}

afterEach(() => {
  for (const root of sandboxes.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function write(root, relativePath, content) {
  const absolute = join(root, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
  return absolute;
}

function check(options) {
  return runEditorDocLinkCheck({
    log: () => undefined,
    error: () => undefined,
    ...options,
  });
}

describe("check-editor-doc-links", () => {
  it("accepts in-repository relative links and anchors", () => {
    const { repoRoot } = makeSandbox();
    write(
      repoRoot,
      "packages/keiko-editor/README.md",
      "# Package\n\n[Runbook](../../docs/keiko-editor/runbook.md#operations)\n",
    );
    write(repoRoot, "docs/keiko-editor/runbook.md", "# Runbook\n\n## Operations\n");

    expect(check({ repoRoot, files: ["packages/keiko-editor/README.md"] })).toMatchObject({
      ok: true,
      failures: [],
      fileCount: 1,
    });
  });

  it("rejects relative links that escape the repository", () => {
    const { repoRoot, outsideRoot } = makeSandbox();
    write(outsideRoot, "secret.md", "# Outside\n");
    write(
      repoRoot,
      "docs/keiko-editor/runbook.md",
      "# Runbook\n\n[outside](../../../outside/secret.md)\n",
    );

    const result = check({ repoRoot, files: ["docs/keiko-editor/runbook.md"] });

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([expect.stringContaining("target path escapes repository")]);
  });

  it("rejects repository-local symlinks whose real target escapes", () => {
    const { repoRoot, outsideRoot } = makeSandbox();
    const outsideFile = write(outsideRoot, "secret.md", "# Outside\n");
    symlinkSync(outsideFile, join(repoRoot, "docs-outside.md"));
    write(
      repoRoot,
      "packages/keiko-editor/README.md",
      "# Package\n\n[outside](../../docs-outside.md)\n",
    );

    const result = check({ repoRoot, files: ["packages/keiko-editor/README.md"] });

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      expect.stringContaining("target realpath escapes repository"),
    ]);
  });
});

describe("isWithinPath", () => {
  it("treats sibling prefixes as outside the root", () => {
    expect(isWithinPath("/tmp/repo", "/tmp/repo/docs/a.md")).toBe(true);
    expect(isWithinPath("/tmp/repo", "/tmp/repo-outside/a.md")).toBe(false);
  });
});

// Regression coverage for the S8786 backtracking fixes: both regexes used to combine an
// unanchored/lazy unbounded quantifier with an overlapping-class successor, so a long
// non-matching run forced an O(n^2) (or worse) retry-at-every-position scan.
describe("check-editor-doc-links — bounded regex safety (S8786)", () => {
  it("still resolves an anchor built from a heading with trailing '##' closing markers", () => {
    const { repoRoot } = makeSandbox();
    write(
      repoRoot,
      "packages/keiko-editor/README.md",
      "# Package\n\n[Runbook](../../docs/keiko-editor/runbook.md#operations)\n",
    );
    write(repoRoot, "docs/keiko-editor/runbook.md", "# Runbook\n\n## Operations ##\n");

    expect(check({ repoRoot, files: ["packages/keiko-editor/README.md"] })).toMatchObject({
      ok: true,
      failures: [],
    });
  });

  // Both guards below assert "no catastrophic backtracking" as a GROWTH RATIO -- the check is timed
  // on a pathological input of size n and again at 2n, back-to-back and under the same load, and
  // the larger run must stay under three times the smaller (a linear scan doubles; the superlinear
  // patterns these guard against grew far faster). The previous absolute 300 ms budget inflated with
  // the hosted runner's parallel test load (309 ms in the scripts coverage suite of #3394) and so
  // raced the wall clock instead of measuring the pattern.
  function checkDurationMs(makeCase, size) {
    let best = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { repoRoot, files } = makeCase(size);
      const start = performance.now();
      const result = check({ repoRoot, files });
      best = Math.min(best, performance.now() - start);
      expect(result).toMatchObject({ ok: true, failures: [] });
    }
    return best;
  }

  function expectLinearGrowth(makeCase, size) {
    const small = checkDurationMs(makeCase, size);
    const large = checkDurationMs(makeCase, size * 2);
    // Below ~50 ms a measurement is dominated by timer, I/O and scheduling noise, not by the scan.
    expect(large).toBeLessThan(3 * Math.max(small, 50));
  }

  it("resolves an anchor slugged from a pathologically long heading line without catastrophic backtracking", () => {
    // Shape that made the previous `(.*?)\s*#*\s*$` superlinear: a long whitespace run followed by
    // more non-whitespace content, so `\s*#*\s*$` cannot succeed until `.*?` has grown past it all.
    expectLinearGrowth((size) => {
      const { repoRoot } = makeSandbox();
      write(
        repoRoot,
        "packages/keiko-editor/README.md",
        "# Package\n\n[Runbook](../../docs/keiko-editor/big.md#a-b)\n",
      );
      write(repoRoot, "docs/keiko-editor/big.md", `## a${" ".repeat(size)}b\n`);
      return { repoRoot, files: ["packages/keiko-editor/README.md"] };
    }, 20000);
  });

  it("scans a doc file with a pathologically link-shaped body without catastrophic backtracking", () => {
    // Shape that made the previous `[^\]]*`/`[^)\s]+` superlinear: many repeated `[` characters,
    // none of which ever closes, forcing a full O(n) consume-then-backtrack at every position.
    expectLinearGrowth((size) => {
      const { repoRoot } = makeSandbox();
      write(
        repoRoot,
        "packages/keiko-editor/README.md",
        `${"[".repeat(size)}\n\n[real](../../docs/keiko-editor/runbook.md)\n`,
      );
      write(repoRoot, "docs/keiko-editor/runbook.md", "# Runbook\n");
      return { repoRoot, files: ["packages/keiko-editor/README.md"] };
    }, 20000);
  });
});
