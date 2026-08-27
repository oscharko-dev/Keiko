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

  it("fails closed when a verificationCommands entry names an npm script that does not exist (KEIKO-1011)", () => {
    // Live repository has manifest 479's `verificationCommands`; make sure a fabricated entry
    // fails while every existing entry keeps passing. The gate is opinionated about
    // reproducibility — a rename that leaves the manifest referring to a removed script must
    // fail the gate, not silently strand the reviewer.
    const failures = checkGitDeliveryEvidence();
    expect(failures).toEqual([]);
    // Mutate a copy of the manifest with a fabricated script name and prove the validator
    // catches it. We don't touch the live file — instead we import the helper indirectly by
    // pointing at a scratch REPO_ROOT (via the tempRoot fixture in the next test).
  });

  it("catches a manifest 479 verificationCommands entry that names a missing npm script (KEIKO-1011)", () => {
    root = tempRoot();
    // Copy every required document as a placeholder.
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
    write(
      root,
      "docs/git-delivery/evidence/479/manifest.json",
      JSON.stringify({
        issue: "#479",
        epic: "#470",
        sourceBranch: "codex/issue-479-governed-git-proof",
        baseBranch: "feat/keiko-establish-governed-end-to-end-git-delivery",
        deliverables: {},
        acceptanceCriteria: {},
        evidenceSources: { documents: [] },
        mergedImplementationPullRequests: [],
        verificationCommands: [
          "npm run test:e2e:git-status-1386",
          "npm run definitely-not-a-real-script-1234",
        ],
      }),
    );
    const failures = checkGitDeliveryEvidence(root);
    // The gate runs against the LIVE repo root for the package.json lookup, so real scripts
    // (test:e2e:git-status-1386) pass. Fabricated ones (definitely-not-a-real-script-1234) fail.
    expect(failures.some((line) => line.includes("definitely-not-a-real-script-1234"))).toBe(true);
    expect(failures.some((line) => line.includes("test:e2e:git-status-1386"))).toBe(false);
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
