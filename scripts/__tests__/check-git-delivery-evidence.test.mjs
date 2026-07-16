import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  checkGitDeliveryEvidence,
  markdownAnchors,
  markdownLinks,
} from "../check-git-delivery-evidence.mjs";

function tempRoot() {
  return mkdtempCompat("git-delivery-evidence-");
}

function mkdtempCompat(prefix) {
  const root = resolve(tmpdir(), `${prefix}${process.pid.toString()}-${Date.now().toString()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function write(root, relPath, contents) {
  const target = join(root, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

describe("checkGitDeliveryEvidence", () => {
  let root;

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("passes on the live repository evidence set", () => {
    expect(checkGitDeliveryEvidence()).toEqual([]);
  });

  it("fails closed when the issue 479 evidence manifest is absent", () => {
    root = tempRoot();
    for (const doc of [
      "README.md",
      "verification-matrix.md",
      "operator-runbook.md",
      "policy-pack-guidance.md",
      "epic-470-closeout.md",
    ]) {
      write(root, `docs/git-delivery/${doc}`, "# Placeholder\n");
    }
    write(root, "docs/git-delivery/evidence/479/README.md", "# Placeholder\n");

    const failures = checkGitDeliveryEvidence(root);
    expect(failures).toContain(
      "missing evidence manifest docs/git-delivery/evidence/479/manifest.json",
    );
  });
});

// Regression coverage for the S8786 backtracking fixes: both regexes used to combine an
// unanchored/lazy unbounded quantifier with an overlapping-class successor, so a long
// non-matching run forced an O(n^2) retry-at-every-position scan.
describe("markdownAnchors / markdownLinks — bounded regex safety (S8786)", () => {
  it("still slugs a heading with trailing whitespace and no closing markers", () => {
    expect(markdownAnchors("## Some Heading   \n")).toEqual(new Set(["some-heading"]));
  });

  it("still extracts non-image link targets and skips images/external/anchor links", () => {
    const markdown = [
      "[ok](./relative/doc.md)",
      "![not a link](./image.png)",
      "[external](https://example.invalid/x)",
      "[anchor-only](#section)",
    ].join("\n");
    expect(markdownLinks(markdown)).toEqual(["./relative/doc.md"]);
  });

  it("slugs a heading built from a pathologically long line without catastrophic backtracking", () => {
    // Shape that made the previous `(.+?)\s*$` superlinear: a long whitespace run followed by more
    // non-whitespace content, so `\s*$` cannot succeed until `.+?` has grown past the whole run.
    const line = `## a${" ".repeat(20000)}b`;
    const start = Date.now();
    const anchors = markdownAnchors(line);
    expect(Date.now() - start).toBeLessThan(300);
    expect(anchors).toEqual(new Set(["a-b"]));
  });

  it("scans a pathologically link-shaped line without catastrophic backtracking", () => {
    // Shape that made the previous `[^\]]+`/`[^)]+` superlinear: many repeated `[` characters, none
    // of which ever closes, forcing a full O(n) consume-then-backtrack at every position.
    const markdown = "[".repeat(20000);
    const start = Date.now();
    const links = markdownLinks(markdown);
    expect(Date.now() - start).toBeLessThan(300);
    expect(links).toEqual([]);
  });
});
